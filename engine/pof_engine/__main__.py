"""CLI:  python -m pof_engine verify <project.json> [--out DIR]
       python -m pof_engine check-hash <report.json>
       python -m pof_engine reproduce <report.json>   (what every oracle runs before it signs)"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

from .verify import Params, canonical_json, keccak_hex, verify

# fields that depend on rendering (PNG bytes) or are derived from the hash rather than the science
_NOT_RECOMPUTED = ("reportHash", "attestation", "evidence")


def reproduce(report: dict) -> list[str]:
    """Re-run the method from raw Sentinel-2 data and list every field that differs from `report`."""
    if report.get("params") != asdict(Params()):
        return ["params: report was produced with non-standard method parameters"]
    d = report["data"]
    project = {
        "id": report["project"]["id"],
        "name": report["project"]["name"],
        "claim": report["project"]["claim"],
        "geometry": report["project"]["geometry"],
        "baseline": {"year": d["baseline"]["year"], "months": d["baseline"]["months"]},
        "monitoring": {"year": d["monitoring"]["year"], "months": d["monitoring"]["months"]},
    }
    if "drySeason" in d:
        project["drySeason"] = {"year": d["drySeason"]["year"], "months": d["drySeason"]["months"]}
    mine = verify(project, None)
    diffs = []
    for k in sorted(set(report) | set(mine)):
        if k in _NOT_RECOMPUTED:
            continue
        if canonical_json(report.get(k)) != canonical_json(mine.get(k)):
            sub = report.get(k), mine.get(k)
            if isinstance(sub[0], dict) and isinstance(sub[1], dict):
                diffs += [f"{k}.{kk}: report {sub[0].get(kk)!r} vs recomputed {sub[1].get(kk)!r}" for kk in sorted(set(sub[0]) | set(sub[1])) if canonical_json(sub[0].get(kk)) != canonical_json(sub[1].get(kk))]
            else:
                diffs.append(f"{k}: differs")
    return diffs


def main(argv=None):
    ap = argparse.ArgumentParser(prog="pof_engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("verify", help="run the satellite verification for a project file")
    v.add_argument("project", type=Path)
    v.add_argument("--out", type=Path, default=None)
    h = sub.add_parser("check-hash", help="recompute a published report's hash")
    h.add_argument("report", type=Path)
    r = sub.add_parser("reproduce", help="independently re-run a published report from raw satellite data")
    r.add_argument("report", type=Path)
    a = ap.parse_args(argv)

    if a.cmd == "verify":
        project = json.loads(a.project.read_text())
        out = a.out or Path("reports") / project["id"]
        t = time.time()
        rep = verify(project, out)
        r = rep["results"]
        print(f'{project["name"]}: {"PASSED" if rep["passed"] else "REJECTED"} in {time.time() - t:.0f}s')
        print(f'  NDVI {r["projectNdviBaseline"]:.3f} -> {r["projectNdviMonitoring"]:.3f}  (control {r["controlDelta"]:+.3f})  net gain {r["netGain"]:+.3f}')
        print(f'  coverage {r["coverage"]:.1%}  additional canopy {r["additionalCanopyHa"]} ha  credits {r["creditTonnes"]} tCO2e')
        for c in rep["checks"]:
            print(f'  [{"x" if c["pass"] else " "}] {c["label"]}: {c["value"]} (min {c["threshold"]})')
        print(f'  reportHash {rep["reportHash"]}\n  -> {out / "report.json"}')
    elif a.cmd == "reproduce":
        rep = json.loads(a.report.read_text())
        t = time.time()
        diffs = reproduce(rep)
        if diffs:
            print("NOT REPRODUCED")
            for x in diffs[:40]:
                print("  " + x)
            sys.exit(1)
        print(f'REPRODUCED {rep["project"]["id"]}: every result, check and verdict matches ({time.time() - t:.0f}s)')
    else:
        rep = json.loads(a.report.read_text())
        body = {k: v for k, v in rep.items() if k not in ("reportHash", "attestation")}
        ok = keccak_hex(canonical_json(body)) == rep["reportHash"]
        print("hash OK" if ok else "HASH MISMATCH")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
