import { BrowserProvider, Contract, JsonRpcProvider, HDNodeWallet, Provider, Signer } from "ethers";
import abi from "./abi.json";

export type SignedCase = {
  id: string;
  projectId: string;
  registerTx: string;
  attestation: Record<string, unknown> & { reportHash: string; passed: boolean; creditTonnes: string };
  signatures: string[];
  signers: string[];
};

export type Deployment = {
  network: string;
  chainId: string;
  address: string;
  deployTx?: string;
  deployer: string;
  oracles: string[];
  threshold: number;
  deployedAt: string;
  rpcUrl?: string;
  explorer?: string;
  cases: SignedCase[];
};

export type CaseMeta = { id: string; name: string; location: string; claim: string; developer: string };

export const NETWORKS: Record<string, { name: string; rpc: string; explorer?: string; currency: string }> = {
  "31337": { name: "Local demo chain", rpc: "http://127.0.0.1:8545", currency: "ETH" },
  "80002": { name: "Polygon Amoy testnet", rpc: "https://rpc-amoy.polygon.technology", explorer: "https://amoy.polygonscan.com", currency: "POL" },
  "11155111": { name: "Ethereum Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io", currency: "ETH" },
  "84532": { name: "Base Sepolia", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", currency: "ETH" },
};

/** Personas used on the local demo chain (well-known Hardhat test keys, worthless outside a dev node). */
const MNEMONIC = "test test test test test test test test test test test junk";
export const DEMO_PERSONAS = [
  { key: "developer", label: "Project developer", sub: "registered the projects", index: 0 },
  { key: "buyer", label: "Acme Steel Ltd", sub: "corporate buyer", index: 1 },
  { key: "relayer", label: "Independent relayer", sub: "anyone may submit proofs", index: 2 },
] as const;

export function demoWallet(index: number, provider: Provider): HDNodeWallet {
  return HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
}

export async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/** Chain to use: ?chain= query param, else the injected wallet's chain, else the local demo chain. */
export async function detectChainId(): Promise<string> {
  const q = new URLSearchParams(location.search).get("chain");
  if (q) return q;
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string }) => Promise<string> } }).ethereum;
  if (eth) {
    try {
      return BigInt(await eth.request({ method: "eth_chainId" })).toString();
    } catch {
      /* fall through */
    }
  }
  // hosted build (e.g. GitHub Pages) without a wallet: show the public testnet deployment read-only
  return ["localhost", "127.0.0.1"].includes(location.hostname) ? "31337" : "80002";
}

export async function switchChain(chainId: string) {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth) return;
  const hex = "0x" + BigInt(chainId).toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch {
    const n = NETWORKS[chainId];
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, chainName: n.name, rpcUrls: [n.rpc], nativeCurrency: { name: n.currency, symbol: n.currency, decimals: 18 }, blockExplorerUrls: n.explorer ? [n.explorer] : [] }],
    });
  }
  location.reload();
}

export function readProvider(chainId: string, d?: Deployment): Provider {
  const rpc = d?.rpcUrl || NETWORKS[chainId]?.rpc || NETWORKS["31337"].rpc;
  return new JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true, polling: true, pollingInterval: 1000 } as never);
}

export function pofContract(address: string, runner: Provider | Signer): Contract {
  return new Contract(address, abi, runner);
}

export async function injectedSigner(): Promise<Signer | null> {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) return null;
  const bp = new BrowserProvider(eth as never);
  await bp.send("eth_requestAccounts", []);
  return bp.getSigner();
}

export const OUTCOME = ["None", "Issued", "Rejected by oracles", "Rejected: gain below policy", "Rejected: low coverage", "Rejected: no credits"];
export const SERIAL_STATUS = ["Does not exist", "Outstanding", "Retired", "Held in buffer pool", "Cancelled (reversal)"];

export const serialLabel = (vintage: number | bigint, projectId: number | bigint, serial: number | bigint) =>
  `POF-${vintage}-P${String(projectId).padStart(3, "0")}-${String(serial).padStart(7, "0")}`;

export const short = (h?: string, n = 6) => (h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : "");

export function decodeError(e: unknown, c: Contract): string {
  const err = e as { data?: string; info?: { error?: { data?: string } }; shortMessage?: string; message?: string; revert?: { name: string; args: unknown[] } };
  if (err.revert) return `${err.revert.name}(${err.revert.args.join(", ")})`;
  const data = err.data || err.info?.error?.data;
  if (data) {
    try {
      const p = c.interface.parseError(data);
      if (p) return `${p.name}(${p.args.join(", ")})`;
    } catch {
      /* ignore */
    }
  }
  return err.shortMessage || err.message || String(e);
}
