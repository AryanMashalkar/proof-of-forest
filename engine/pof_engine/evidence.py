"""Evidence images published with every report (their SHA-256 hashes are inside the signed report)."""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, TwoSlopeNorm  # noqa: E402

NDVI_CMAP = LinearSegmentedColormap.from_list(
    "ndvi", ["#7a4b2a", "#c9a26b", "#e8dca8", "#a8d08d", "#4f9d4a", "#1f6b34", "#0b3d1f"]
)
DELTA_CMAP = LinearSegmentedColormap.from_list("delta", ["#b2182b", "#ef8a62", "#f7f7f7", "#67c47e", "#0b6b2e"])

# matplotlib output is deterministic only with fixed metadata
PNG_META = {"Software": None}


def _edges(mask: np.ndarray, width: int = 1) -> np.ndarray:
    """Pixels of `mask` within `width` pixels of its boundary."""
    m = mask.astype(bool)
    core = m.copy()
    for _ in range(width):
        p = np.pad(core, 1, constant_values=False)
        core = core & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return m & ~core


def _overlay(ax, inside, ring):
    """Vector outlines (contours of the masks) so lines stay crisp at any zoom."""
    ax.contour(ring.astype(float), levels=[0.5], colors=["#4dd9ff"], linewidths=1.4, alpha=0.9)
    ax.contour(inside.astype(float), levels=[0.5], colors=["#ffffff"], linewidths=2.4)
    h, w = inside.shape
    ax.set_xlim(-0.5, w - 0.5)
    ax.set_ylim(h - 0.5, -0.5)


def _save(fig, path: Path):
    fig.savefig(path, dpi=100, pad_inches=0, metadata=PNG_META)
    plt.close(fig)


def _frame(shape):
    h, w = shape
    scale = 960 / max(h, w)
    fig = plt.figure(figsize=(w * scale / 100, h * scale / 100))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    return fig, ax


def _rgb(rgb: np.ndarray) -> np.ndarray:
    x = np.nan_to_num(rgb, nan=0.0)
    x = np.clip(x / 0.30, 0, 1) ** (1 / 1.6)  # fixed stretch so years are comparable
    return x


def _zoom_window(inside: np.ndarray):
    ys, xs = np.where(inside)
    h, w = inside.shape
    cy, cx = (ys.min() + ys.max()) / 2, (xs.min() + xs.max()) / 2
    half = max(ys.max() - ys.min(), xs.max() - xs.min()) * 0.5 * 1.45 + 8
    hy, hx = half * 0.75, half  # 4:3 frame
    y0, y1 = int(max(0, cy - hy)), int(min(h, cy + hy))
    x0, x1 = int(max(0, cx - hx)), int(min(w, cx + hx))
    return slice(y0, y1), slice(x0, x1)


def render(out: Path, nb, nm, rgb_b, rgb_m, inside, ring, report) -> list[str]:
    files = []
    zy, zx = _zoom_window(inside)
    for name, img in (("zoom_baseline_rgb.png", rgb_b), ("zoom_monitoring_rgb.png", rgb_m)):
        fig, ax = _frame(inside[zy, zx].shape)
        ax.imshow(_rgb(img[zy, zx]), interpolation="bicubic")
        _overlay(ax, inside[zy, zx], ring[zy, zx])
        _save(fig, out / name)
        files.append(name)
    for name, img in (("zoom_baseline_ndvi.png", nb), ("zoom_monitoring_ndvi.png", nm)):
        fig, ax = _frame(inside[zy, zx].shape)
        ax.set_facecolor("#1b1b1b")
        ax.imshow(img[zy, zx], cmap=NDVI_CMAP, vmin=0.0, vmax=0.8, interpolation="nearest")
        _overlay(ax, inside[zy, zx], ring[zy, zx])
        _save(fig, out / name)
        files.append(name)
    fig, ax = _frame(inside[zy, zx].shape)
    ax.imshow((nm - nb)[zy, zx], cmap=DELTA_CMAP, norm=TwoSlopeNorm(0, -0.4, 0.4), interpolation="nearest")
    _overlay(ax, inside[zy, zx], ring[zy, zx])
    _save(fig, out / "zoom_ndvi_change.png")
    files.append("zoom_ndvi_change.png")
    for name, img in (("baseline_rgb.png", rgb_b), ("monitoring_rgb.png", rgb_m)):
        fig, ax = _frame(inside.shape)
        ax.imshow(_rgb(img), interpolation="bilinear")
        _overlay(ax, inside, ring)
        _save(fig, out / name)
        files.append(name)
    for name, img in (("baseline_ndvi.png", nb), ("monitoring_ndvi.png", nm)):
        fig, ax = _frame(inside.shape)
        ax.set_facecolor("#1b1b1b")
        ax.imshow(img, cmap=NDVI_CMAP, vmin=0.0, vmax=0.8, interpolation="nearest")
        _overlay(ax, inside, ring)
        _save(fig, out / name)
        files.append(name)
    fig, ax = _frame(inside.shape)
    ax.imshow(nm - nb, cmap=DELTA_CMAP, norm=TwoSlopeNorm(0, -0.4, 0.4), interpolation="nearest")
    _overlay(ax, inside, ring)
    _save(fig, out / "ndvi_change.png")
    files.append("ndvi_change.png")

    # histogram of per-pixel NDVI inside the polygon, both windows
    r = report["results"]
    fig = plt.figure(figsize=(6.4, 3.2))
    ax = fig.add_axes([0.1, 0.18, 0.86, 0.74])
    bins = np.linspace(-0.1, 0.9, 51)
    ax.hist(nb[inside & np.isfinite(nb)], bins=bins, color="#c9a26b", alpha=0.8, label=f'{report["data"]["baseline"]["year"]}')
    ax.hist(nm[inside & np.isfinite(nm)], bins=bins, color="#2e8b57", alpha=0.7, label=f'{report["data"]["monitoring"]["year"]}')
    ax.axvline(report["params"]["canopy_ndvi"], color="#444", ls="--", lw=1)
    ax.set_xlabel("NDVI of 10 m pixels inside the project polygon")
    ax.legend(frameon=False)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.set_title(f'project ΔNDVI {r["projectDelta"]:+.3f}   control ΔNDVI {r["controlDelta"]:+.3f}', fontsize=10)
    _save(fig, out / "ndvi_histogram.png")
    files.append("ndvi_histogram.png")

    # placebo test: the project's net gain against the same polygon dropped at random in the landscape
    v = report.get("validation") or {}
    if v.get("placeboNetGains"):
        fig = plt.figure(figsize=(6.4, 3.2))
        ax = fig.add_axes([0.1, 0.18, 0.86, 0.72])
        pl = np.array(v["placeboNetGains"])
        lo, hi = min(pl.min(), r["netGain"]) - 0.02, max(pl.max(), r["netGain"]) + 0.02
        ax.hist(pl, bins=np.linspace(lo, hi, 41), color="#9aa5b1", label=f"{len(pl)} random placebo polygons")
        ax.axvline(r["netGain"], color="#1f8a4c" if report["passed"] else "#c0392b", lw=2.5, label="this project")
        ax.axvline(report["params"]["min_net_gain"], color="#444", ls="--", lw=1, label="issuance threshold")
        ax.set_xlabel("NDVI gain beyond control ring (difference-in-differences)")
        ax.legend(frameon=False, fontsize=8)
        for s_ in ("top", "right"):
            ax.spines[s_].set_visible(False)
        ax.set_title(f'placebo p = {v["placeboPValue"]:.3f}   random land above gain threshold {v["placeboFalsePositiveRate"]:.1%}', fontsize=10)
        _save(fig, out / "placebo_test.png")
        files.append("placebo_test.png")
    return files
