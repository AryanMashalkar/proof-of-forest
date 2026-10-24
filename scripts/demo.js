// One command local demo (works on Windows, macOS, Linux):
//   npm run demo
// Starts a local chain, deploys the contract with the 3 case studies, and serves the dApp.
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const opts = (cwd) => ({ cwd, stdio: "inherit", shell: process.platform === "win32" });

function rpcUp() {
  return new Promise((res) => {
    const req = http.request({ host: "127.0.0.1", port: 8545, method: "POST", headers: { "content-type": "application/json" } }, (r) => res(r.statusCode === 200));
    req.on("error", () => res(false));
    req.end('{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');
  });
}

(async () => {
  const node = spawn(npx, ["hardhat", "node"], { cwd: root, stdio: "ignore", shell: process.platform === "win32" });
  process.on("exit", () => node.kill());
  process.on("SIGINT", () => process.exit());
  while (!(await rpcUp())) await new Promise((r) => setTimeout(r, 500));
  console.log("local chain up on http://127.0.0.1:8545");
  await new Promise((res, rej) => spawn(npx, ["hardhat", "run", "scripts/deploy.ts", "--network", "localhost"], opts(root)).on("exit", (c) => (c ? rej(c) : res())));
  await new Promise((res) => spawn("node", ["scripts/sync-frontend.js"], opts(root)).on("exit", res));
  console.log("\nOpen http://localhost:5173  (Ctrl+C to stop)\n");
  spawn(npx, ["vite", "--port", "5173", "--strictPort"], opts(path.join(root, "frontend")));
})();
