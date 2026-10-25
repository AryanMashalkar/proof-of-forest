// Constructor arguments of a recorded deployment, for `hardhat verify --constructor-args`.
// Chain is taken from VERIFY_CHAIN_ID (default Sepolia).
const d = require(`../frontend/public/deployments/${process.env.VERIFY_CHAIN_ID || "11155111"}.json`);
module.exports = [d.deployer, d.oracles, 2, "https://proofofforest.app/api/batch/{id}.json"];
