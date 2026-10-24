"""Windowed reads of Sentinel-2 COGs: only the pixels around the project are downloaded."""
from __future__ import annotations

import os

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from .catalog import Scene

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "1")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
if os.path.exists("/root/.ccr/ca-bundle.crt"):
    os.environ.setdefault("CURL_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")

# Sentinel-2 Scene Classification Layer classes accepted as a clear view of the ground.
# 4 vegetation, 5 not-vegetated (bare soil), 7 unclassified (low-probability cloud is excluded separately).
# Rejected: 0 no data, 1 saturated, 2 dark/topographic shadow, 3 cloud shadow, 6 water, 8/9 cloud, 10 cirrus, 11 snow.
CLEAR_SCL = (4, 5, 7)


def read_band(scene: Scene, asset: str, bounds, shape, resampling=Resampling.bilinear) -> np.ndarray:
    """Read `asset` of `scene` over UTM `bounds` (left, bottom, right, top) resampled to `shape`."""
    with rasterio.open(scene.hrefs[asset]) as src:
        win = from_bounds(*bounds, transform=src.transform)
        arr = src.read(1, window=win, out_shape=shape, resampling=resampling, boundless=True, fill_value=0)
    return arr


def read_scene(scene: Scene, bounds, shape, rgb: bool = False) -> dict[str, np.ndarray]:
    """Surface reflectance for red/nir (+rgb) and a clear-sky mask on a common grid."""
    out: dict[str, np.ndarray] = {}
    raw_valid = np.ones(shape, bool)
    for asset in ("red", "nir") + (("green", "blue") if rgb else ()):
        dn = read_band(scene, asset, bounds, shape)
        raw_valid &= dn > 0
        scale, offset = scene.scale_offset[asset]
        out[asset] = dn.astype("f4") * scale + offset
    scl = read_band(scene, "scl", bounds, shape, resampling=Resampling.nearest)
    clear = np.isin(scl, CLEAR_SCL) & raw_valid & (out["red"] > 0) & (out["nir"] > 0)
    out["clear"] = clear
    out["scl"] = scl
    return out


def ndvi(red: np.ndarray, nir: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (nir - red) / (nir + red)
    return np.clip(v, -1, 1)
