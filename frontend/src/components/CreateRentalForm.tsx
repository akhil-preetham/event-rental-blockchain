import { FormEvent, useState } from "react";
import { Contract, isAddress, parseEther } from "ethers";
import { explainWalletError } from "../blockchain/errors";
import { TransactionStatus, type TransactionPhase } from "./TransactionStatus";

type CreateRentalFormProps = {
  contract: Contract | null;
};

const initialForm = {
  equipmentId: "",
  equipmentName: "",
  renter: "",
  rentalFee: "",
  deposit: "",
  startTime: "",
  endTime: "",
};

export function CreateRentalForm({ contract }: CreateRentalFormProps) {
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [phase, setPhase] = useState<TransactionPhase>("idle");
  const [hash, setHash] = useState("");

  function update(field: keyof typeof initialForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!contract) {
      setMessage("Connect your wallet before creating a rental.");
      return;
    }
    if (!isAddress(form.renter)) {
      setMessage("Enter a valid renter wallet address.");
      return;
    }
    if (!form.rentalFee || !form.deposit || !Number.isFinite(Number(form.rentalFee)) || !Number.isFinite(Number(form.deposit)) || Number(form.rentalFee) <= 0 || Number(form.deposit) <= 0) {
      setMessage("Enter a rental fee and a security deposit greater than zero.");
      return;
    }
    if (!form.startTime || !form.endTime) {
      setMessage("Choose both a start date and an end date.");
      return;
    }
    const start = new Date(form.startTime);
    const end = new Date(form.endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
      setMessage("The end time must be later than the start time.");
      return;
    }
    if (end.getTime() - start.getTime() > 1000 * 60 * 60 * 24 * 365) {
      setMessage("Choose a rental period shorter than one year.");
      return;
    }

    setWorking(true);
    setPhase("preparing");
    setMessage("");
    try {
      setPhase("waiting");
      const transaction = await contract.createRental(
        form.equipmentId,
        form.equipmentName,
        form.renter,
        parseEther(form.rentalFee),
        parseEther(form.deposit),
        BigInt(Math.floor(start.getTime() / 1000)),
        BigInt(Math.floor(end.getTime() / 1000)),
      );
      setHash(transaction.hash);
      setPhase("submitted");
      setPhase("confirming");
      await transaction.wait();
      setPhase("confirmed");
      setMessage("Rental created successfully. Your rental record is ready.");
      setForm(initialForm);
    } catch (error) {
      const translated = explainWalletError(error);
      setPhase(translated.includes("cancelled") ? "cancelled" : translated.includes("state") ? "reverted" : "failed");
      setMessage(translated);
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="card create-card">
      <p className="hint">Set the rental terms below. Rental fee and security deposit use ETH; dates are converted automatically for the rental record.</p>
      <form onSubmit={submit} className="form-grid">
        <div className="form-section-heading"><span>01</span><div><strong>Equipment</strong><small>What is being rented?</small></div></div>
        <label>Equipment ID<input required type="text" value={form.equipmentId} onChange={(event) => update("equipmentId", event.target.value)} /></label>
        <label>Equipment name<input required type="text" value={form.equipmentName} onChange={(event) => update("equipmentName", event.target.value)} /></label>
        <div className="form-section-heading"><span>02</span><div><strong>Renter</strong><small>Who is responsible for the rental?</small></div></div>
        <label className="full-width">Renter wallet address<input required type="text" value={form.renter} onChange={(event) => update("renter", event.target.value)} /></label>
        <div className="form-section-heading"><span>03</span><div><strong>Rental period</strong><small>Choose when the equipment leaves and comes back.</small></div></div>
        <label>Start date and time<input required type="datetime-local" value={form.startTime} onChange={(event) => update("startTime", event.target.value)} /></label>
        <label>End date and time<input required type="datetime-local" value={form.endTime} onChange={(event) => update("endTime", event.target.value)} /></label>
        <div className="form-section-heading"><span>04</span><div><strong>Money</strong><small>Separate the rental fee from the protected deposit.</small></div></div>
        <label>Rental fee (ETH)<input required type="number" step="any" value={form.rentalFee} onChange={(event) => update("rentalFee", event.target.value)} /></label>
        <label>Security deposit (ETH)<input required type="number" step="any" value={form.deposit} onChange={(event) => update("deposit", event.target.value)} /></label>
        <button className="primary-button" type="submit" disabled={working}>
          {working ? "Waiting for wallet..." : "Create rental →"}
        </button>
      </form>
      {message && <p className="message form-message">{message}</p>}
      <TransactionStatus phase={phase} message={phase === "confirmed" ? "The rental was recorded on the local network." : undefined} hash={hash} />
    </section>
  );
}
