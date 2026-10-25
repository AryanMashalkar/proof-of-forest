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
from shapely import affinity
from shapely.geometry import mapping, shape
from shapely.ops import transform as shp_transform

from .catalog import Scene, mgrs_tile, scenes
from .raster import ndvi, read_scene

METHOD_ID = "POF-NDVI-DiD-v1.1"


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
    # v1.1 validation: is the result special to this polygon, robust to its exact boundary, and woody?
    placebo_count: int = 200  # random same-shape polygons in the surrounding landscape
    placebo_radius_m: float = 5000.0  # placebo centroids lie within this distance of the project
    max_placebo_p: float = 0.05  # project must out-gain at least 95% of placebos
    boundary_jitter_m: float = 20.0  # +-2 pixels: digitising / GPS error of a submitted boundary
    min_dry_persistence: float = 0.60  # share of monitoring canopy still canopy in the dry season


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
    reach = p.control_outer_m + (p.placebo_radius_m + _radius(poly) if p.placebo_count else 0.0)
    minx, miny, maxx, maxy = poly.buffer(reach + 2 * p.pixel_m).bounds
    minx, miny = math.floor(minx / p.pixel_m) * p.pixel_m, math.floor(miny / p.pixel_m) * p.pixel_m
    maxx, maxy = math.ceil(maxx / p.pixel_m) * p.pixel_m, math.ceil(maxy / p.pixel_m) * p.pixel_m
    width, height = int(round((maxx - minx) / p.pixel_m)), int(round((maxy - miny) / p.pixel_m))
    tr = from_origin(minx, maxy, p.pixel_m, p.pixel_m)
    inside = geometry_mask([mapping(poly)], (height, width), tr, invert=True)
    ring_geom = poly.buffer(p.control_outer_m).difference(poly.buffer(p.control_inner_m))
    ring = geometry_mask([mapping(ring_geom)], (height, width), tr, invert=True)
    return poly, ring_geom, (minx, miny, maxx, maxy), (height, width), tr, inside, ring


def _radius(poly) -> float:
    c = poly.centroid
    return max(c.distance(type(c)(x, y)) for x, y in poly.exterior.coords)


def _masks(poly, shp, tr, p: Params, exclude=None):
    """Inside mask and control-ring mask of a polygon on the analysis grid."""
    inside = geometry_mask([mapping(poly)], shp, tr, invert=True)
    ring = geometry_mask([mapping(poly.buffer(p.control_outer_m).difference(poly.buffer(p.control_inner_m)))], shp, tr, invert=True)
    if exclude is not None:
        ring &= ~exclude
    return inside, ring


def _did(nb, nm, inside, ring, both):
    """Composite difference-in-differences of mean NDVI: (project change) - (control change)."""
    pin, rin = inside & both, ring & both
    if not pin.any() or not rin.any():
        return float("nan"), 0.0
    net = (nm[pin].mean() - nb[pin].mean()) - (nm[rin].mean() - nb[rin].mean())
    return float(net), float(both[inside].mean())


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


def _window(geom_wgs84, year: int, months: list[int], p: Params, grid_cache: dict, want_rgb: bool = True):
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
    comp, rgb, meta, scene_means = _composite(cands[: p.max_scenes * 2], bounds, shp, inside, ring, p, want_rgb)
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

    # --- woody canopy: trees stay green through the dry season, rain-fed grass and crops do not.
    dry = project.get("drySeason") or {"year": m["year"], "months": m["months"]}
    if dry["year"] == m["year"] and sorted(dry["months"]) == sorted(m["months"]):
        nd, meta_d = nm, meta_m
    else:
        _, nd, _, meta_d, _ = _window(g, dry["year"], dry["months"], p, grid_cache, want_rgb=False)
    woody_m = (nm >= p.canopy_ndvi) & (nd >= p.canopy_ndvi)  # NaN compares False: unobserved is not woody
    canopy_now = pin & (nm >= p.canopy_ndvi)
    dry_persistence = float(woody_m[canopy_now].mean()) if canopy_now.any() else 0.0
    wcanopy_m = float(woody_m[pin].mean()) if pin.any() else 0.0
    wccanopy_m = float(woody_m[rin].mean()) if rin.any() else 0.0
    # only canopy that is both new beyond the control trend AND persists in the dry season is credited
    additional_canopy_ha = max(0.0, min((canopy_m - canopy_b) - (ccanopy_m - ccanopy_b), (wcanopy_m - canopy_b) - (wccanopy_m - ccanopy_b)) * area_ha)

    # --- boundary sensitivity: the verdict must not hinge on exactly where the line was drawn
    j = p.boundary_jitter_m
    variants = {
        f"erode{int(j)}m": poly.buffer(-j),
        f"dilate{int(j)}m": poly.buffer(j),
        f"shiftN{int(j)}m": affinity.translate(poly, 0, j),
        f"shiftS{int(j)}m": affinity.translate(poly, 0, -j),
        f"shiftE{int(j)}m": affinity.translate(poly, j, 0),
        f"shiftW{int(j)}m": affinity.translate(poly, -j, 0),
    }
    boundary = {}
    for name, vp in variants.items():
        if vp.is_empty:
            continue
        vi, vr = _masks(vp, shp, tr, p)
        boundary[name] = round(_did(nb, nm, vi, vr, both)[0], 4)
    bvals = [v for v in boundary.values() if math.isfinite(v)]
    boundary_min = min(bvals) if bvals else float("nan")

    # --- placebo test: the same polygon dropped at random elsewhere in the landscape. If random land
    # "gains" as much as the project, the project's gain is not evidence of anything it did.
    placebo_nets = []
    if p.placebo_count:
        seed = int(geometry_hash(geom)[2:18], 16)
        rng = np.random.default_rng(seed)
        keep_out = poly.buffer(p.control_inner_m)
        rad, cx, cy = _radius(poly), poly.centroid.x, poly.centroid.y
        x0, y0, x1, y1 = bounds
        tries = 0
        while len(placebo_nets) < p.placebo_count and tries < p.placebo_count * 20:
            tries += 1
            d = math.sqrt(rng.uniform((p.control_inner_m + 2 * rad) ** 2, (p.placebo_radius_m + rad) ** 2))
            a = rng.uniform(0, 2 * math.pi)
            cand = affinity.rotate(poly, float(rng.uniform(0, 360)), origin="centroid")
            cand = affinity.translate(cand, d * math.cos(a), d * math.sin(a))
            cb_ = cand.buffer(p.control_outer_m).bounds
            if cand.intersects(keep_out) or cb_[0] < x0 or cb_[1] < y0 or cb_[2] > x1 or cb_[3] > y1:
                continue
            ci, cr = _masks(cand, shp, tr, p, exclude=inside)
            net_c, cov_c = _did(nb, nm, ci, cr, both)
            if cov_c >= p.min_coverage and math.isfinite(net_c):
                placebo_nets.append(net_c)
    pl = np.array(placebo_nets)
    placebo_p = float((1 + (pl >= net_gain).sum()) / (1 + len(pl))) if len(pl) else float("nan")
    placebo_fpr = float((pl >= p.min_net_gain).mean()) if len(pl) else float("nan")
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
        {"id": "canopy", "label": "Additional woody canopy area (ha) beyond control trend", "value": round(additional_canopy_ha, 2), "threshold": 1.0, "pass": additional_canopy_ha >= 1.0},
        {"id": "dryPersistence", "label": "New canopy stays green through the dry season (woody, not grass or crops)", "value": round(dry_persistence, 4), "threshold": p.min_dry_persistence, "pass": dry_persistence >= p.min_dry_persistence},
        {"id": "boundary", "label": f"Gain holds if the boundary is shifted, shrunk or grown by {int(j)} m", "value": round(boundary_min, 4), "threshold": p.min_net_gain, "pass": math.isfinite(boundary_min) and boundary_min >= p.min_net_gain},
    ]
    if p.placebo_count:
        checks.append({"id": "placebo", "label": f"Gain beats random copies of the polygon in the landscape (placebo p-value, n={len(pl)})", "value": round(placebo_p, 4), "threshold": p.max_placebo_p, "pass": math.isfinite(placebo_p) and placebo_p <= p.max_placebo_p and len(pl) >= p.placebo_count // 2})
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
            "drySeason": {"year": dry["year"], "months": dry["months"], "scenes": meta_d},
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
        "validation": {
            "drySeasonPersistence": round(dry_persistence, 4),
            "woodyCanopyFracMonitoring": round(wcanopy_m, 4),
            "controlWoodyCanopyFracMonitoring": round(wccanopy_m, 4),
            "boundaryNetGain": boundary,
            "boundaryNetGainMin": round(boundary_min, 4),
            "placeboCount": int(len(pl)),
            "placeboNetGainP50": round(float(np.percentile(pl, 50)), 4) if len(pl) else None,
            "placeboNetGainP95": round(float(np.percentile(pl, 95)), 4) if len(pl) else None,
            "placeboNetGainMax": round(float(pl.max()), 4) if len(pl) else None,
            "placeboPValue": round(placebo_p, 4),
            "placeboFalsePositiveRate": round(placebo_fpr, 4),
            "placeboNetGains": [round(float(x), 4) for x in pl],
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
