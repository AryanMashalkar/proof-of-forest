"""ProofOfForest verification method POF-NDVI-DiD v1.

Given a project polygon and two same-season observation windows (baseline, monitoring), measure
whether vegetation inside the polygon grew *more than the surrounding landscape* and translate the
additional canopy area into a conservative tCO2e estimate.

Why difference-in-differences: a wetter monsoon, a regional irrigation scheme or a sensor change
greens (or browns) an entire region. Comparing the project with a control ring around it removes
those shared effects, so only change attributable to the project is credited.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from eth_hash.auto import keccak
from pyproj import Transformer
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from shapely.geometry import mapping, shape
from shapely.ops import transform as shp_transform

from .catalog import Scene, mgrs_tile, scenes
from .raster import ndvi, read_scene

METHOD_ID = "POF-NDVI-DiD-v1"


@dataclass(frozen=True)
class Params:
    pixel_m: float = 10.0
    max_scenes: int = 6
    min_scenes: int = 2
    max_scene_cloud: float = 40.0  # tile-level prefilter, the real test is the per-pixel SCL mask
    control_inner_m: float = 300.0  # gap so edge effects/leakage at the boundary don't contaminate the control
    control_outer_m: float = 1500.0
    canopy_ndvi: float = 0.40  # NDVI above which a 10 m pixel is counted as tree canopy (dry season)
    min_coverage: float = 0.80  # share of polygon pixels with a clear observation in BOTH windows
    min_net_gain: float = 0.05  # DiD NDVI gain required
    min_robust_gain: float = 0.025  # 10th percentile of scene-pair DiD must stay above this
    removal_tco2_ha_yr: float = 7.0  # conservative Tier-1 style default removal factor (configurable per ecozone)
    min_uncertainty_deduction: float = 0.10
    max_uncertainty_deduction: float = 0.50


# ----------------------------------------------------------------------------- canonical hashing

def canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def round_coords(geom: dict, nd: int = 6) -> dict:
    def r(c):
        return [r(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(float(c[0]), nd), round(float(c[1]), nd)]

    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


def geometry_hash(geom: dict) -> str:
    return "0x" + keccak(canonical_json(round_coords(geom))).hex()


def keccak_hex(b: bytes) -> str:
    return "0x" + keccak(b).hex()


# ----------------------------------------------------------------------------- data classes

@dataclass
class WindowResult:
    year: int
    months: list[int]
    scenes: list[dict]
    coverage: float
    project_ndvi: float
    control_ndvi: float
    project_canopy_frac: float
    control_canopy_frac: float
    scene_means: list[tuple[float, float]] = field(default_factory=list)  # (project, control) per scene


# ----------------------------------------------------------------------------- core

def _grid(geom_wgs84, epsg: int, p: Params):
    to_utm = Transformer.from_crs(4326, epsg, always_xy=True).transform
    poly = shp_transform(to_utm, geom_wgs84)
    minx, miny, maxx, maxy = poly.buffer(p.control_outer_m + 2 * p.pixel_m).bounds
    minx, miny = math.floor(minx / p.pixel_m) * p.pixel_m, math.floor(miny / p.pixel_m) * p.pixel_m
    maxx, maxy = math.ceil(maxx / p.pixel_m) * p.pixel_m, math.ceil(maxy / p.pixel_m) * p.pixel_m
    width, height = int(round((maxx - minx) / p.pixel_m)), int(round((maxy - miny) / p.pixel_m))
    tr = from_origin(minx, maxy, p.pixel_m, p.pixel_m)
    inside = geometry_mask([mapping(poly)], (height, width), tr, invert=True)
    ring_geom = poly.buffer(p.control_outer_m).difference(poly.buffer(p.control_inner_m))
    ring = geometry_mask([mapping(ring_geom)], (height, width), tr, invert=True)
    return poly, ring_geom, (minx, miny, maxx, maxy), (height, width), tr, inside, ring


def _composite(scene_list: list[Scene], bounds, shp, inside, ring, p: Params, want_rgb: bool):
    """Median of clear observations per pixel. Scenes are chosen by how clear the *project* is, not the tile."""
    reads = []
    for s in scene_list:
        d = read_scene(s, bounds, shp, rgb=want_rgb)
        clear_frac = float(d["clear"][inside].mean())
        reads.append((clear_frac, s, d))
    reads.sort(key=lambda t: (-t[0], t[1].datetime))
    chosen = [r for r in reads if r[0] >= 0.5][: p.max_scenes]
    if len(chosen) < p.min_scenes:
        chosen = reads[: max(p.min_scenes, len(chosen))]
    stack, rgbs, meta, scene_means = [], [], [], []
    for clear_frac, s, d in chosen:
        v = ndvi(d["red"], d["nir"])
        v = np.where(d["clear"], v, np.nan)
        stack.append(v)
        if want_rgb:
            rgb = np.dstack([d["red"], d["green"], d["blue"]])
            rgb[~d["clear"]] = np.nan
            rgbs.append(rgb)
        pm = float(np.nanmean(v[inside])) if np.isfinite(v[inside]).any() else float("nan")
        cm = float(np.nanmean(v[ring])) if np.isfinite(v[ring]).any() else float("nan")
        scene_means.append((pm, cm))
        meta.append({"id": s.id, "datetime": s.datetime, "tileCloudCover": round(s.cloud_cover, 2), "projectClearFraction": round(clear_frac, 4)})
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            comp = np.nanmedian(np.stack(stack), axis=0)
            rgb = np.nanmedian(np.stack(rgbs), axis=0) if want_rgb else None
    return comp, rgb, meta, scene_means


def _window(geom_wgs84, year: int, months: list[int], p: Params, grid_cache: dict):
    c = geom_wgs84.centroid
    tile = mgrs_tile(c.x, c.y)
    cands = scenes(tile, year, tuple(months), p.max_scene_cloud)
    if not cands:
        raise RuntimeError(f"no Sentinel-2 scenes for tile {tile} in {year} months {months}")
    epsg = cands[0].epsg
    if "grid" not in grid_cache:
        grid_cache["grid"] = _grid(geom_wgs84, epsg, p)
    poly, ring_geom, bounds, shp, tr, inside, ring = grid_cache["grid"]
    # read at most 2x max_scenes of the clearest tiles, then rank by clarity over the polygon
    comp, rgb, meta, scene_means = _composite(cands[: p.max_scenes * 2], bounds, shp, inside, ring, p, True)
    return tile, comp, rgb, meta, scene_means


def verify(project: dict, out_dir: Path | None = None, p: Params = Params()) -> dict:
    geom = round_coords(project["geometry"])
    g = shape(geom)
    grid_cache: dict = {}
    b, m = project["baseline"], project["monitoring"]
    if sorted(b["months"]) != sorted(m["months"]):
        raise ValueError("baseline and monitoring windows must cover the same months (phenology)")
    tile, nb, rgb_b, meta_b, sm_b = _window(g, b["year"], b["months"], p, grid_cache)
    _, nm, rgb_m, meta_m, sm_m = _window(g, m["year"], m["months"], p, grid_cache)
    poly, ring_geom, bounds, shp, tr, inside, ring = grid_cache["grid"]

    both = np.isfinite(nb) & np.isfinite(nm)
    coverage = float(both[inside].mean())
    ctrl_cov = float(both[ring].mean())
    pin, rin = inside & both, ring & both

    def mean(a, msk):
        return float(np.mean(a[msk])) if msk.any() else float("nan")

    pb, pm_, cb, cm = mean(nb, pin), mean(nm, pin), mean(nb, rin), mean(nm, rin)
    project_delta, control_delta = pm_ - pb, cm - cb
    net_gain = project_delta - control_delta

    # robustness: DiD for every (baseline scene, monitoring scene) pair
    pairs = [(pm2 - pb2) - (cm2 - cb2) for (pb2, cb2), (pm2, cm2) in itertools.product(sm_b, sm_m)]
    pairs = [x for x in pairs if math.isfinite(x)]
    p10 = float(np.percentile(pairs, 10)) if pairs else float("nan")
    p50 = float(np.percentile(pairs, 50)) if pairs else float("nan")

    pix_ha = (p.pixel_m * p.pixel_m) / 10_000
    area_ha = float(poly.area / 10_000)
    canopy_b = float((nb[pin] >= p.canopy_ndvi).mean()) if pin.any() else 0.0
    canopy_m = float((nm[pin] >= p.canopy_ndvi).mean()) if pin.any() else 0.0
    ccanopy_b = float((nb[rin] >= p.canopy_ndvi).mean()) if rin.any() else 0.0
    ccanopy_m = float((nm[rin] >= p.canopy_ndvi).mean()) if rin.any() else 0.0
    raw_canopy_gain_ha = (canopy_m - canopy_b) * area_ha
    additional_canopy_ha = max(0.0, ((canopy_m - canopy_b) - (ccanopy_m - ccanopy_b)) * area_ha)
    years = m["year"] - b["year"]

    if math.isfinite(p10) and math.isfinite(p50) and p50 > 0:
        deduction = min(p.max_uncertainty_deduction, max(p.min_uncertainty_deduction, (p50 - p10) / p50))
    else:
        deduction = p.max_uncertainty_deduction
    gross = additional_canopy_ha * p.removal_tco2_ha_yr * years
    credit_tonnes = int(math.floor(gross * (1 - deduction)))

    checks = [
        {"id": "coverage", "label": "Cloud-free coverage of the polygon in both windows", "value": round(coverage, 4), "threshold": p.min_coverage, "pass": coverage >= p.min_coverage},
        {"id": "scenes", "label": "Independent clear scenes per window", "value": min(len(meta_b), len(meta_m)), "threshold": p.min_scenes, "pass": min(len(meta_b), len(meta_m)) >= p.min_scenes},
        {"id": "netGain", "label": "NDVI gain beyond the control area (difference-in-differences)", "value": round(net_gain, 4), "threshold": p.min_net_gain, "pass": net_gain >= p.min_net_gain},
        {"id": "robustness", "label": "Gain holds in the pessimistic 10th percentile of scene pairs", "value": round(p10, 4), "threshold": p.min_robust_gain, "pass": math.isfinite(p10) and p10 >= p.min_robust_gain},
        {"id": "canopy", "label": "Additional canopy area (ha) beyond control trend", "value": round(additional_canopy_ha, 2), "threshold": 1.0, "pass": additional_canopy_ha >= 1.0},
    ]
    passed = all(c["pass"] for c in checks)
    if not passed:
        credit_tonnes = 0

    report = {
        "method": METHOD_ID,
        "params": asdict(p),
        "project": {
            "id": project["id"],
            "name": project["name"],
            "geometry": geom,
            "geometryHash": geometry_hash(geom),
            "areaHa": round(area_ha, 2),
            "claim": project.get("claim", ""),
        },
        "data": {
            "source": "Copernicus Sentinel-2 L2A (ESA), AWS Open Data registry: s3://sentinel-cogs",
            "mgrsTile": tile,
            "baseline": {"year": b["year"], "months": b["months"], "scenes": meta_b},
            "monitoring": {"year": m["year"], "months": m["months"], "scenes": meta_m},
        },
        "results": {
            "coverage": round(coverage, 4),
            "controlCoverage": round(ctrl_cov, 4),
            "projectNdviBaseline": round(pb, 4),
            "projectNdviMonitoring": round(pm_, 4),
            "controlNdviBaseline": round(cb, 4),
            "controlNdviMonitoring": round(cm, 4),
            "projectDelta": round(project_delta, 4),
            "controlDelta": round(control_delta, 4),
            "netGain": round(net_gain, 4),
            "naiveGain": round(project_delta, 4),
            "naiveWouldPass": bool(project_delta >= p.min_net_gain and coverage >= p.min_coverage),
            "scenePairNetGainP10": round(p10, 4),
            "scenePairNetGainP50": round(p50, 4),
            "scenePairs": len(pairs),
            "canopyFracBaseline": round(canopy_b, 4),
            "canopyFracMonitoring": round(canopy_m, 4),
            "controlCanopyFracBaseline": round(ccanopy_b, 4),
            "controlCanopyFracMonitoring": round(ccanopy_m, 4),
            "rawCanopyGainHa": round(raw_canopy_gain_ha, 2),
            "additionalCanopyHa": round(additional_canopy_ha, 2),
            "years": years,
            "grossTonnes": round(gross, 2),
            "uncertaintyDeduction": round(deduction, 4),
            "creditTonnes": credit_tonnes,
        },
        "checks": checks,
        "passed": passed,
    }

    report = _finite(report)
    if out_dir is not None:
        from .evidence import render

        out_dir.mkdir(parents=True, exist_ok=True)
        files = render(out_dir, nb, nm, rgb_b, rgb_m, inside, ring, report)
        report["evidence"] = {name: {"file": name, "sha256": hashlib.sha256((out_dir / name).read_bytes()).hexdigest()} for name in files}
    report["reportHash"] = keccak_hex(canonical_json({k: v for k, v in report.items() if k != "reportHash"}))
    report["attestation"] = to_attestation_fields(report)
    if out_dir is not None:
        (out_dir / "report.json").write_text(json.dumps(report, indent=2))
    return report


def _finite(o):
    """NaN/inf are not valid JSON and would break hash reproducibility: replace them with null."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _finite(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_finite(v) for v in o]
    return o


def to_attestation_fields(report: dict) -> dict:
    """The exact values the oracles sign (EIP-712 `Attestation`, minus projectId/expiry set at signing)."""
    r = report["results"]
    s = lambda x: int(round(x * 10_000))  # noqa: E731
    return {
        "geometryHash": report["project"]["geometryHash"],
        "reportHash": report["reportHash"],
        "baselineYear": report["data"]["baseline"]["year"],
        "monitoringYear": report["data"]["monitoring"]["year"],
        "ndviBaseline": s(r["projectNdviBaseline"]),
        "ndviMonitoring": s(r["projectNdviMonitoring"]),
        "controlDelta": s(r["controlDelta"]),
        "netGain": s(r["netGain"]),
        "validCoverageBps": int(round(r["coverage"] * 10_000)),
        "canopyGainHa100": int(round(r["additionalCanopyHa"] * 100)),
        "creditTonnes": r["creditTonnes"],
        "passed": report["passed"],
    }
