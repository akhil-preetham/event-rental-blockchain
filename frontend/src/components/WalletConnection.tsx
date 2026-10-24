type WalletConnectionProps = {
  address: string;
  chainId: bigint | null;
  status: string;
  onConnect: () => void;
};

export function WalletConnection({
  address,
  chainId,
  status,
  onConnect,
}: WalletConnectionProps) {
  return (
    <section className="card wallet-card">
      <div className="section-heading compact">
        <div><p className="eyebrow">ACCOUNT</p><h2>Wallet</h2></div>
        <span className={`status-badge ${address ? "success" : "neutral"}`}>
          <span className="badge-dot" />{address ? "Connected" : "Disconnected"}
        </span>
      </div>
      <div className="wallet-info">
        <div><span className="info-label">Address</span><strong className="address-value">{address || "Not connected"}</strong></div>
        <div><span className="info-label">Network</span><strong>{chainId ? `Hardhat · ${chainId}` : "Not detected"}</strong></div>
      </div>
      <p className="wallet-status">{status}</p>
      <button className="secondary-button full-width" onClick={onConnect}>Connect MetaMask</button>
    </section>
  );
}
