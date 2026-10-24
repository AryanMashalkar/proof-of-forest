"""Scene discovery straight from the public Sentinel-2 L2A COG archive (AWS Open Data, `sentinel-cogs`).

No API keys and no STAC server are required: the bucket is listed directly and each scene's STAC item
JSON (published next to the imagery) supplies cloud statistics and the per-band scale/offset needed to
convert digital numbers into surface reflectance across processing baselines.
"""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import mgrs
import requests

BUCKET = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
PREFIX = "sentinel-s2-l2a-cogs"
CACHE = Path(os.environ.get("POF_CACHE", Path(__file__).resolve().parents[1] / ".cache"))

_session = requests.Session()
if os.path.exists("/root/.ccr/ca-bundle.crt"):
    _session.verify = "/root/.ccr/ca-bundle.crt"


@dataclass(frozen=True)
class Scene:
    id: str
    datetime: str
    tile: str
    cloud_cover: float
    epsg: int
    hrefs: dict  # asset -> url
    scale_offset: dict  # asset -> (scale, offset)


def mgrs_tile(lon: float, lat: float) -> str:
    return mgrs.MGRS().toMGRS(lat, lon, MGRSPrecision=0)


def _list(prefix: str) -> list[str]:
    url = f"{BUCKET}/?list-type=2&prefix={prefix}&delimiter=/"
    r = _session.get(url, timeout=60)
    r.raise_for_status()
    return [p for p in re.findall(r"<Prefix>([^<]*)</Prefix>", r.text) if p != prefix]


def _item(prefix: str) -> dict:
    name = prefix.rstrip("/").split("/")[-1]
    cache = CACHE / "items" / f"{name}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    r = _session.get(f"{BUCKET}/{prefix}{name}.json", timeout=60)
    r.raise_for_status()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(r.text)
    return r.json()


def _scene(item: dict) -> Scene:
    p = item["properties"]
    hrefs, so = {}, {}
    # Processing baseline >= 04.00 adds a +1000 DN offset to L2A reflectance. Earth Search re-harmonises
    # those scenes during COG conversion and flags it; the item's `offset` must then NOT be applied again,
    # otherwise post-2022 reflectance is biased low by 0.1 and NDVI trends become fake.
    harmonised = bool(p.get("earthsearch:boa_offset_applied", False))
    for key in ("red", "green", "blue", "nir", "scl"):
        a = item["assets"][key]
        hrefs[key] = a["href"]
        rb = (a.get("raster:bands") or [{}])[0]
        so[key] = (rb.get("scale", 1.0), 0.0 if harmonised or key == "scl" else rb.get("offset", 0.0))
    return Scene(
        id=item["id"],
        datetime=p["datetime"],
        tile=f'{p["mgrs:utm_zone"]}{p["mgrs:latitude_band"]}{p["mgrs:grid_square"]}',
        cloud_cover=float(p.get("eo:cloud_cover", 100)),
        epsg=int(p["proj:epsg"]),
        hrefs=hrefs,
        scale_offset=so,
    )


@lru_cache(maxsize=256)
def scenes(tile: str, year: int, months: tuple[int, ...], max_cloud: float = 60.0) -> list[Scene]:
    """All L2A scenes of an MGRS tile in the given months, sorted clearest first."""
    zone, band, square = str(int(tile[:-3])), tile[-3], tile[-2:]
    prefixes = [p for m in months for p in _list(f"{PREFIX}/{zone}/{band}/{square}/{year}/{m}/")]
    with ThreadPoolExecutor(16) as ex:
        items = list(ex.map(_item, prefixes))
    out = []
    for it in items:
        p = it["properties"]
        if p.get("s2:nodata_pixel_percentage", 0) > 50:
            continue
        if p.get("eo:cloud_cover", 100) > max_cloud:
            continue
        out.append(_scene(it))
    # the archive can hold several processings of one acquisition (…_0_L2A, …_1_L2A): keep the newest
    latest: dict[str, Scene] = {}
    for sc in sorted(out, key=lambda s: s.id):
        latest[sc.id.rsplit("_", 2)[0]] = sc
    out = sorted(latest.values(), key=lambda s: (s.cloud_cover, s.datetime))
    return out
