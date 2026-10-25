import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { Contract, Provider, Signer } from "ethers";
import { CaseMeta, DEMO_PERSONAS, Deployment, demoWallet, detectChainId, fetchJson, injectedSigner, pofContract, readProvider } from "./chain";

export type Report = {
  method: string;
  params: Record<string, number>;
  project: { id: string; name: string; geometry: { coordinates: number[][][] }; geometryHash: string; areaHa: number; claim: string };
  data: {
    source: string;
    mgrsTile: string;
    baseline: { year: number; months: number[]; scenes: { id: string; datetime: string; projectClearFraction: number }[] };
    monitoring: { year: number; months: number[]; scenes: { id: string; datetime: string; projectClearFraction: number }[] };
    drySeason?: { year: number; months: number[]; scenes: { id: string; datetime: string; projectClearFraction: number }[] };
  };
  results: Record<string, number | boolean>;
  checks: { id: string; label: string; value: number; threshold: number; pass: boolean }[];
  validation?: {
    drySeasonPersistence: number;
    boundaryNetGain: Record<string, number>;
    boundaryNetGainMin: number;
    placeboCount: number;
    placeboNetGainP95: number;
    placeboNetGainMax: number;
    placeboPValue: number;
    placeboFalsePositiveRate: number;
  };
  passed: boolean;
  evidence: Record<string, { file: string; sha256: string }>;
  reportHash: string;
};

type Ctx = {
  chainId: string;
  deployment?: Deployment;
  cases: CaseMeta[];
  reports: Record<string, Report>;
  provider?: Provider;
  read?: Contract;
  signer?: Signer;
  account?: string;
  persona: string;
  setPersona: (k: string) => void;
  connectWallet: () => Promise<void>;
  demo: boolean;
  tick: number;
  refresh: () => void;
  error?: string;
  toast: (m: string, kind?: "ok" | "err") => void;
  toasts: { id: number; m: string; kind: string }[];
};

const C = createContext<Ctx>(null as never);
export const useApp = () => useContext(C);

export function AppProvider({ children }: { children: ReactNode }) {
  const [chainId, setChainId] = useState("31337");
  const [deployment, setDeployment] = useState<Deployment>();
  const [cases, setCases] = useState<CaseMeta[]>([]);
  const [reports, setReports] = useState<Record<string, Report>>({});
  const [provider, setProvider] = useState<Provider>();
  const [signer, setSigner] = useState<Signer>();
  const [account, setAccount] = useState<string>();
  const [persona, setPersona] = useState<string>(() => localStorageGet("pof.persona") || "developer");
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string>();
  const [toasts, setToasts] = useState<{ id: number; m: string; kind: string }[]>([]);
  const demo = chainId === "31337";

  useEffect(() => {
    (async () => {
      try {
        const cid = await detectChainId();
        setChainId(cid);
        const idx = await fetchJson<CaseMeta[]>("reports/index.json");
        setCases(idx);
        const reps: Record<string, Report> = {};
        await Promise.all(idx.map(async (c) => (reps[c.id] = await fetchJson<Report>(`reports/${c.id}/report.json`))));
        setReports(reps);
        const d = await fetchJson<Deployment>(`deployments/${cid}.json`).catch(() => undefined);
        if (!d) {
          setError(`No ProofOfForest deployment found for chain ${cid}. Run the deploy script for this network.`);
          return;
        }
        setDeployment(d);
        setProvider(readProvider(cid, d));
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  // demo personas on the local chain
  useEffect(() => {
    if (!demo || !provider) return;
    const p = DEMO_PERSONAS.find((x) => x.key === persona) ?? DEMO_PERSONAS[0];
    const w = demoWallet(p.index, provider);
    setSigner(w);
    setAccount(w.address);
    localStorageSet("pof.persona", persona);
  }, [demo, provider, persona]);

  const connectWallet = useCallback(async () => {
    const s = await injectedSigner();
    if (!s) {
      toast("No browser wallet found. Install MetaMask to use a public testnet.", "err");
      return;
    }
    setSigner(s);
    setAccount(await s.getAddress());
  }, []);

  const toast = useCallback((m: string, kind: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, m, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const read = useMemo(() => (deployment && provider ? pofContract(deployment.address, provider) : undefined), [deployment, provider]);
  const value: Ctx = {
    chainId,
    deployment,
    cases,
    reports,
    provider,
    read,
    signer,
    account,
    persona,
    setPersona,
    connectWallet,
    demo,
    tick,
    refresh: () => setTick((t) => t + 1),
    error,
    toast,
    toasts,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** Re-run an async loader whenever the chain state changes. */
export function useChain<T>(fn: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const { tick, read } = useApp();
  const [v, setV] = useState<T>();
  useEffect(() => {
    if (!read) return;
    let live = true;
    fn().then((x) => live && setV(x)).catch((e) => console.warn(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, read, ...deps]);
  return v;
}
