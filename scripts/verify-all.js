// Re-run the satellite verification for every project in projects/ (needs Python deps: pip install -r engine/requirements.txt)
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
for (const f of fs.readdirSync(path.join(root, "projects")).filter((f) => f.endsWith(".json"))) {
  const id = f.replace(/\.json$/, "");
  const r = spawnSync(py, ["-m", "pof_engine", "verify", path.join("projects", f), "--out", path.join("reports", id)], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PYTHONPATH: path.join(root, "engine") },
  });
  if (r.status) process.exit(r.status);
}
