import { FormEvent, useEffect, useState } from "react";
import { Contract, formatEther } from "ethers";

const statuses = ["CREATED", "FUNDED", "ACTIVE", "RETURNED", "REFUNDED", "DISPUTED", "RESOLVED"];
const labels: Record<string, string> = {
  CREATED: "Rental created", FUNDED: "Deposit protected", ACTIVE: "Currently rented",
  RETURNED: "Ready for settlement", REFUNDED: "Deposit released",
  DISPUTED: "Dispute under review", RESOLVED: "Dispute resolved",
};

type RentalLookupProps = { contract: Contract | null; initialRentalId?: string; detailOnly?: boolean; chainId?: bigint | null; contractAddress?: string };
export type RentalRecord = Record<string, string>;

export function RentalLookup({ contract, initialRentalId = "1", detailOnly = false, chainId, contractAddress, onRentalLoaded }: RentalLookupProps & { onRentalLoaded?: (rental: RentalRecord | null) => void }) {
  const [rentalId, setRentalId] = useState(initialRentalId);
  const [rental, setRental] = useState<Record<string, string> | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function readRental(id: string) {
    if (!contract) {
      setMessage(detailOnly ? "Connect your wallet to view this rental record." : "Connect your wallet before looking up a rental.");
      return;
    }
    if (!/^\d+$/.test(id) || Number(id) < 1) {
      setMessage("Enter a valid rental ID.");
      return;
    }
    setLoading(true);
    try {
      const result = await contract.getRental(BigInt(id));
      if (result.id === 0n) {
        throw new Error("missing rental");
      }
      const loaded = {
        id: result.id.toString(), equipmentId: result.equipmentId, equipmentName: result.equipmentName,
        owner: result.owner, renter: result.renter, rentalFee: result.rentalFee.toString(),
        deposit: result.deposit.toString(), startTime: result.startTime.toString(),
        endTime: result.endTime.toString(), status: statuses[Number(result.status)] || "UNKNOWN",
      };
      setRental(loaded);
      onRentalLoaded?.(loaded);
      setMessage("");
    } catch {
      setRental(null);
      onRentalLoaded?.(null);
      setMessage("That rental record could not be found. Check the ID and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (detailOnly && contract) void readRental(rentalId);
  }, [contract, detailOnly, rentalId]);

  return (
    <section className={`lookup-card ${detailOnly ? "detail-lookup" : "table-card"}`}>
      <div className="section-heading"><div><p className="eyebrow">RENTAL RECORD</p><h2>{detailOnly ? `Rental #${rentalId} details` : "Find a rental"}</h2></div>{!detailOnly && <span className="muted-label">Read from contract</span>}</div>
      {!detailOnly && <form onSubmit={(event: FormEvent) => { event.preventDefault(); void readRental(rentalId); }} className="inline-form"><label><span>Rental ID</span><input value={rentalId} onChange={(event) => setRentalId(event.target.value)} type="number" min="1" /></label><button className="primary-button" type="submit" disabled={loading}>{loading ? "Checking..." : "View rental"}</button></form>}
      {message && <p className="message error">{message}</p>}
      {loading && <div className="rental-skeleton" aria-label="Loading rental" />}
      {rental && <div className="rental-detail-view">
        <div className="rental-title-row"><div><span className="info-label">Rental #{rental.id}</span><h3>{rental.equipmentName}</h3><span className="equipment-id">{rental.equipmentId}</span></div><span className={`status-badge status-${rental.status.toLowerCase()}`}><span className="badge-dot" />{labels[rental.status] || rental.status}</span></div>
        <div className="lifecycle">{["CREATED", "FUNDED", "ACTIVE", "RETURNED", "REFUNDED"].map((status, index) => <div className={`lifecycle-step ${rental.status === status ? "current" : ""}`} key={status}><span className="step-dot">{rental.status === status ? "●" : index < statuses.indexOf(rental.status) ? "✓" : "○"}</span><span>{labels[status]}</span></div>)}</div>
        <div className="dispute-lifecycle"><span>Dispute path</span><strong className={rental.status === "DISPUTED" ? "branch-current" : ""}>Under review</strong><span>→</span><strong className={rental.status === "RESOLVED" ? "branch-current" : ""}>Resolved</strong></div>
        <div className="detail-grid"><Detail label="Owner" value={rental.owner} wide /><Detail label="Renter" value={rental.renter} wide /><Detail label="Rental fee" value={`${formatEther(rental.rentalFee)} ETH · contract metadata`} /><Detail label="Security deposit" value={`${formatEther(rental.deposit)} ETH · escrowed`} /><Detail label="Amount locked" value={formatEther(rental.deposit) + " ETH"} /><Detail label="Start time" value={new Date(Number(rental.startTime) * 1000).toLocaleString()} /><Detail label="End time" value={new Date(Number(rental.endTime) * 1000).toLocaleString()} /></div>
        {(rental.status === "DISPUTED" || rental.status === "RESOLVED") && <div className="dispute-branch">{labels[rental.status]}</div>}
        <details className="blockchain-details"><summary>Blockchain details</summary><div className="detail-grid"><Detail label="Network" value={chainId === 31337n ? "Hardhat Local" : "Connected network"} /><Detail label="Chain ID" value={chainId?.toString() || "Unavailable"} /><Detail label="Contract" value={contractAddress || "Unavailable"} /><Detail label="Raw status" value={rental.status} /><Detail label="Rental ID" value={rental.id} /><Detail label="Owner" value={rental.owner} /><Detail label="Renter" value={rental.renter} /><Detail label="Start timestamp" value={rental.startTime} /><Detail label="End timestamp" value={rental.endTime} /></div></details>
      </div>}
    </section>
  );
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={wide ? "detail-item wide" : "detail-item"}><span className="info-label">{label}</span><strong title={value}>{value}</strong></div>;
}
