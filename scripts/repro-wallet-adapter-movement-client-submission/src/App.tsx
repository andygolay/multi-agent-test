import { MovementWalletAdapterProvider } from "@moveindustries/wallet-adapter-react";
import { MultiAgentTest } from "./MultiAgentTest";
import "./App.css";

function App() {
  return (
    <MovementWalletAdapterProvider
      autoConnect={true}
      optInWallets={["Petra", "Nightly", "Razor Wallet"]}
      onError={(error) => {
        console.error("Wallet error:", error);
      }}
    >
      <div style={{ padding: "20px", fontFamily: "monospace" }}>
        <h1>Multi-Agent Transaction Test (Movement - Client Submission)</h1>
        <p>Testing multi-agent on Movement with SDK client submission (wallet must be on Movement Testnet)</p>
        <hr />
        <MultiAgentTest />
      </div>
    </MovementWalletAdapterProvider>
  );
}

export default App;
