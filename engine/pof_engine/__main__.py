"""CLI:  python -m pof_engine verify <project.json> [--out DIR]
       python -m pof_engine check-hash <report.json>"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .verify import canonical_json, keccak_hex, verify


def main(argv=None):
    ap = argparse.ArgumentParser(prog="pof_engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("verify", help="run the satellite verification for a project file")
    v.add_argument("project", type=Path)
    v.add_argument("--out", type=Path, default=None)
    h = sub.add_parser("check-hash", help="recompute a published report's hash")
    h.add_argument("report", type=Path)
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
    else:
        rep = json.loads(a.report.read_text())
        body = {k: v for k, v in rep.items() if k not in ("reportHash", "attestation")}
        ok = keccak_hex(canonical_json(body)) == rep["reportHash"]
        print("hash OK" if ok else "HASH MISMATCH")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
