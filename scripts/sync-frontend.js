// Copy the contract ABI, project definitions and verification reports into the frontend bundle.
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const fe = path.join(root, "frontend");
const art = require(path.join(root, "artifacts/contracts/ProofOfForest.sol/ProofOfForest.json"));
fs.writeFileSync(path.join(fe, "src/abi.json"), JSON.stringify(art.abi, null, 1));
const cases = [];
for (const id of fs.readdirSync(path.join(root, "reports"))) {
  const src = path.join(root, "reports", id);
  const dst = path.join(fe, "public/reports", id);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  const project = JSON.parse(fs.readFileSync(path.join(root, "projects", id + ".json"), "utf8"));
  cases.push({ id, name: project.name, location: project.location, claim: project.claim, developer: project.developer });
}
const order = ["smritivan-bhuj", "hasdeo-claim", "banni-rain"];
cases.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
fs.writeFileSync(path.join(fe, "public/reports/index.json"), JSON.stringify(cases, null, 2));
console.log(`synced ABI and ${cases.length} reports`);
