import { useEffect, useState } from "react";
import { Contract, formatEther, parseEther } from "ethers";
import { HARDHAT_CHAIN_ID, contractAddress } from "../blockchain/contract";
import { explainWalletError } from "../blockchain/errors";
import { ActionButton, TransactionStatus, type TransactionPhase } from "./TransactionStatus";
import type { RentalRecord } from "./RentalLookup";

export function RentalActions({ contract, rental, address, chainId, onComplete }: { contract: Contract | null; rental: RentalRecord | null; address: string; chainId: bigint | null; onComplete: () => void }) {
  const [phase, setPhase] = useState<TransactionPhase>("idle");
  const [message, setMessage] = useState("");
  const [claimable, setClaimable] = useState("0");
  const [renterAmount, setRenterAmount] = useState("");
  const [ownerAmount, setOwnerAmount] = useState("");
  const [arbitrator, setArbitrator] = useState("");
  const now = Math.floor(Date.now() / 1000);
  const ready = Boolean(contract && rental && address && chainId === HARDHAT_CHAIN_ID && contractAddress);
  const role = rental && address ? (address.toLowerCase() === rental.renter.toLowerCase() ? "renter" : address.toLowerCase() === rental.owner.toLowerCase() ? "owner" : address.toLowerCase() === arbitrator.toLowerCase() ? "arbitrator" : "none") : "none";

  async function loadClaim() {
    if (!contract || !address) return;
    try { setClaimable((await contract.claimable(address)).toString()); } catch { setClaimable("0"); }
  }
  useEffect(() => { void loadClaim(); if (contract) void contract.arbitrator().then(setArbitrator).catch(() => undefined); }, [contract, address, rental?.status]);

  async function send(action: () => Promise<{ hash: string; wait: () => Promise<unknown> }>) {
    if (!ready) { setMessage(!address ? "Connect your wallet to perform this action." : chainId !== HARDHAT_CHAIN_ID ? "You're connected to the wrong network. Switch to Hardhat Local to continue." : "Contract connection is unavailable."); return; }
    setPhase("preparing"); setMessage("");
    try {
      setPhase("waiting");
      const tx = await action();
      setPhase("submitted"); setPhase("confirming");
      await tx.wait(); setPhase("confirmed"); setMessage("Action completed successfully."); await loadClaim(); onComplete();
    } catch (error) {
      const text = explainWalletError(error);
      setPhase(text.includes("cancelled") ? "cancelled" : text.includes("state") ? "reverted" : "failed");
      setMessage(text);
    }
  }
  if (!rental) return null;
  const id = BigInt(rental.id);
  const canRecover = rental.status === "FUNDED" && role === "renter" && now >= Number(rental.startTime);
  const splitValid = renterAmount !== "" && ownerAmount !== "" && (() => { try { return parseEther(renterAmount) + parseEther(ownerAmount) === BigInt(rental.deposit); } catch { return false; } })();
  return <section className="action-preview action-panel"><span className="eyebrow">NEXT STEP</span><h2>{rental.status === "DISPUTED" ? "Settlement under review" : "Available action"}</h2>
    <div className="claim-box"><span>Claimable balance</span><strong>{formatEther(claimable)} ETH</strong><ActionButton disabled={!ready || claimable === "0" || phase === "confirming"} onClick={() => void send(() => contract!.withdraw())}>Withdraw</ActionButton></div>
    {ready && rental.status === "CREATED" && role === "renter" && <ActionButton disabled={phase === "confirming"} onClick={() => void send(() => contract!.fundDeposit(id, { value: rental.deposit }))}>Protect deposit · {formatEther(rental.deposit)} ETH</ActionButton>}
    {ready && rental.status === "FUNDED" && role === "owner" && <ActionButton disabled={phase === "confirming"} onClick={() => void send(() => contract!.confirmPickup(id))}>Confirm pickup</ActionButton>}
    {ready && canRecover && <ActionButton disabled={phase === "confirming"} onClick={() => void send(() => contract!.recoverUnconfirmedRental(id))}>Recover deposit</ActionButton>}
    {ready && rental.status === "ACTIVE" && role === "renter" && <ActionButton disabled={phase === "confirming"} onClick={() => void send(() => contract!.markReturned(id))}>Mark equipment returned</ActionButton>}
    {ready && rental.status === "ACTIVE" && Number(rental.endTime) <= now && (role === "owner" || role === "renter") && <ActionButton disabled={phase === "confirming"} onClick={() => void send(() => contract!.triggerTimeout(id))}>Trigger timeout</ActionButton>}
    {ready && rental.status === "RETURNED" && role === "owner" && <><ActionButton disabled={phase === "confirming"} onClick={() => void send(() => contract!.approveRefund(id))}>Approve deposit release</ActionButton><ActionButton disabled={phase === "confirming"} onClick={() => void send(() => contract!.raiseDispute(id))}>Raise dispute</ActionButton></>}
    {ready && rental.status === "DISPUTED" && role === "arbitrator" && <div className="settlement-form"><p>Split the {formatEther(rental.deposit)} ETH security deposit.</p><input placeholder="Renter amount (ETH)" value={renterAmount} onChange={(e) => setRenterAmount(e.target.value)} /><input placeholder="Owner amount (ETH)" value={ownerAmount} onChange={(e) => setOwnerAmount(e.target.value)} /><small>{splitValid ? "Split matches the security deposit." : "Renter amount + owner amount must equal the deposit."}</small><ActionButton disabled={!splitValid || phase === "confirming"} onClick={() => void send(() => contract!.resolveDispute(id, parseEther(renterAmount), parseEther(ownerAmount)))}>Resolve dispute</ActionButton></div>}
    {!ready && <p className="action-gate">{!address ? "Connect your wallet to see actions for your role." : chainId !== HARDHAT_CHAIN_ID ? "Switch to Hardhat Local before using rental actions." : "Contract actions are unavailable until the contract is configured."}</p>}
    <TransactionStatus phase={phase} message={message} />
  </section>;
}
