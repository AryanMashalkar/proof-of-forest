# ProofOfForest dApp

React + Vite + ethers v6. Pages: registry, project evidence and verdict, portfolio (transfer, retire), retirement certificate, public serial/ledger explorer, how it works.

* `npm run demo` (repo root) starts a local chain, deploys, and serves this app on http://localhost:5173 with demo personas.
* On a public testnet it reads `public/deployments/<chainId>.json` and uses MetaMask for transactions.
* `node ../scripts/sync-frontend.js` copies the contract ABI and the verification reports into the app.
