"""Engine tests on synthetic Sentinel-2 scenes (no network): the method must pass real growth and
reject clearing, region-wide greening (rain), and cloud-covered evidence."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import shape

import importlib

V = importlib.import_module("pof_engine.verify")
from pof_engine.catalog import Scene

GEOM = {"type": "Polygon", "coordinates": [[[77.0, 12.0], [77.01, 12.0], [77.01, 12.008], [77.0, 12.008], [77.0, 12.0]]]}
EPSG = 32643


def project(**kw):
    p = {
        "id": "t",
        "name": "Test",
        "geometry": GEOM,
        "baseline": {"year": 2019, "months": [3, 4]},
        "monitoring": {"year": 2025, "months": [3, 4]},
    }
    p.update(kw)
    return p


def fake_scene(year, i):
    return Scene(id=f"S2A_43PGQ_{year}030{i}_0_L2A", datetime=f"{year}-03-0{i}T05:00:00Z", tile="43PGQ", cloud_cover=1.0, epsg=EPSG, hrefs={}, scale_offset={})


def install(monkeypatch, ndvi_fn, clear_fn=None):
    """ndvi_fn(year, inside_mask, rng) -> NDVI array; reflectances are synthesised from it."""
    _, _, _, shp, _, inside, ring = V._grid(shape(GEOM), EPSG, V.Params())
    rng = np.random.default_rng(7)

    monkeypatch.setattr(V, "scenes", lambda tile, year, months, mc: [fake_scene(year, i) for i in range(1, 5)])

    def read_scene(scene, bounds, shape_, rgb=False):
        year = int(scene.id.split("_")[2][:4])
        v = np.clip(ndvi_fn(year, inside, rng) + rng.normal(0, 0.01, shape_), -0.9, 0.95)
        red = np.full(shape_, 0.08, "f4")
        nir = (red * (1 + v) / (1 - v)).astype("f4")
        clear = np.ones(shape_, bool) if clear_fn is None else clear_fn(year, inside, rng)
        out = {"red": red, "nir": nir, "clear": clear, "scl": np.full(shape_, 4)}
        if rgb:
            out["green"] = red.copy()
            out["blue"] = red.copy()
        return out

    monkeypatch.setattr(V, "read_scene", read_scene)
    return inside


def test_real_growth_passes_and_earns_credits(monkeypatch):
    install(monkeypatch, lambda y, inside, r: np.where(inside & (y == 2025), 0.6, 0.15))
    rep = V.verify(project())
    assert rep["passed"] is True
    assert rep["results"]["netGain"] == pytest.approx(0.45, abs=0.02)
    assert rep["results"]["additionalCanopyHa"] > 50
    assert rep["results"]["creditTonnes"] > 0
    assert rep["attestation"]["netGain"] == round(rep["results"]["netGain"] * 10_000)


def test_clearing_is_rejected(monkeypatch):
    install(monkeypatch, lambda y, inside, r: np.where(inside & (y == 2025), 0.1, 0.6))
    rep = V.verify(project())
    assert rep["passed"] is False
    assert rep["results"]["netGain"] < -0.4
    assert rep["results"]["creditTonnes"] == 0
    assert rep["attestation"]["creditTonnes"] == 0


def test_regional_rain_greening_is_rejected_although_naive_check_passes(monkeypatch):
    install(monkeypatch, lambda y, inside, r: np.full(inside.shape, 0.6 if y == 2025 else 0.15))
    rep = V.verify(project())
    assert rep["results"]["naiveWouldPass"] is True
    assert abs(rep["results"]["netGain"]) < 0.02
    assert rep["passed"] is False


def test_cloud_covered_evidence_is_rejected(monkeypatch):
    def clear(y, inside, r):
        return r.random(inside.shape) > 0.97  # ~3% clear pixels per scene
    install(monkeypatch, lambda y, inside, r: np.where(inside & (y == 2025), 0.6, 0.15), clear)
    rep = V.verify(project())
    cov = next(c for c in rep["checks"] if c["id"] == "coverage")
    assert cov["pass"] is False
    assert rep["passed"] is False


def test_seasons_must_match():
    with pytest.raises(ValueError):
        V.verify(project(monitoring={"year": 2025, "months": [10, 11]}))


def test_geometry_hash_is_canonical():
    h = V.geometry_hash(GEOM)
    noisy = {"type": "Polygon", "coordinates": [[[x + 1e-9, y - 1e-9] for x, y in GEOM["coordinates"][0]]]}
    assert V.geometry_hash(noisy) == h
    moved = {"type": "Polygon", "coordinates": [[[x + 1e-4, y] for x, y in GEOM["coordinates"][0]]]}
    assert V.geometry_hash(moved) != h


def test_uncertainty_deduction_is_bounded(monkeypatch):
    install(monkeypatch, lambda y, inside, r: np.where(inside & (y == 2025), 0.6, 0.15))
    rep = V.verify(project())
    d = rep["results"]["uncertaintyDeduction"]
    p = V.Params()
    assert p.min_uncertainty_deduction <= d <= p.max_uncertainty_deduction
    assert rep["results"]["creditTonnes"] <= rep["results"]["grossTonnes"] * (1 - p.min_uncertainty_deduction)


def test_report_hash_is_reproducible(monkeypatch, tmp_path):
    install(monkeypatch, lambda y, inside, r: np.where(inside & (y == 2025), 0.6, 0.15))
    rep = V.verify(project())
    f = tmp_path / "report.json"
    f.write_text(json.dumps(rep, indent=2))
    ok = subprocess.run([sys.executable, "-m", "pof_engine", "check-hash", str(f)], capture_output=True, text=True, cwd=Path(__file__).parents[1])
    assert ok.returncode == 0, ok.stdout + ok.stderr
    rep["results"]["creditTonnes"] += 1  # tamper
    f.write_text(json.dumps(rep, indent=2))
    bad = subprocess.run([sys.executable, "-m", "pof_engine", "check-hash", str(f)], capture_output=True, text=True, cwd=Path(__file__).parents[1])
    assert bad.returncode == 1
