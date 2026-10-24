import { useEffect, useState } from "react";
import { useApp } from "./state";
import { Certificate, Explorer, HowItWorks, Portfolio, ProjectPage, Registry } from "./pages";
import { DEMO_PERSONAS, NETWORKS, short, switchChain } from "./chain";

function useRoute() {
  const [h, setH] = useState(location.hash || "#/");
  useEffect(() => {
    const f = () => {
      setH(location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return h.replace(/^#/, "").split("/").filter(Boolean);
}

export default function App() {
  const route = useRoute();
  const { error, deployment, toasts, demo, persona, setPersona, account, connectWallet, chainId } = useApp();
  let page;
  switch (route[0]) {
    case "project":
      page = <ProjectPage id={route[1]} />;
      break;
    case "portfolio":
      page = <Portfolio />;
      break;
    case "certificate":
      page = <Certificate id={route[1]} />;
      break;
    case "explorer":
      page = <Explorer />;
      break;
    case "how":
      page = <HowItWorks />;
      break;
    default:
      page = <Registry />;
  }
  const nav = (r: string, label: string) => (
    <a href={`#/${r}`} className={(route[0] ?? "") === r ? "on" : ""}>
      {label}
    </a>
  );
  return (
    <>
      <header className="top">
        <a className="brand" href="#/">
          <span className="logo-mark" />
          ProofOfForest
        </a>
        <nav>
          {nav("", "Registry")}
          {nav("portfolio", "Portfolio")}
          {nav("explorer", "Explorer")}
          {nav("how", "How it works")}
        </nav>
        <div className="acct">
          <span className="net">
            <i /> {NETWORKS[chainId]?.name ?? `chain ${chainId}`}
          </span>
          {demo ? (
            <select value={persona} onChange={(e) => setPersona(e.target.value)} data-testid="persona" aria-label="Acting as">
              {DEMO_PERSONAS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : account ? (
            <span className="mono small">{short(account)}</span>
          ) : (
            <button className="btn" onClick={connectWallet}>
              Connect wallet
            </button>
          )}
        </div>
      </header>
      <main>
        {error && !deployment ? (
          <div className="page">
            <div className="callout bad">{error}</div>
            <p className="muted">
              Running locally? Start the demo with <code>npm run demo</code>. Using MetaMask? Switch to the network the contract is deployed on:{" "}
              <button className="btn" onClick={() => switchChain("80002")}>
                Switch to Polygon Amoy
              </button>
            </p>
          </div>
        ) : (
          page
        )}
      </main>
      <footer className="foot">
        Imagery: modified Copernicus Sentinel-2 data (ESA), AWS Open Data. Built for the IEEE ClimateChain Global Hackathon. Credit figures are method demonstrations, not certified offsets.
      </footer>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.m}
          </div>
        ))}
      </div>
    </>
  );
}
