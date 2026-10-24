import { useState, type FormEvent } from "react";
import { createBooking } from "../marketplace/client";

type BookingFormProps = {
  listingId: number;
  dailyFee?: string;
  deposit?: string;
  onCreated: () => void;
};

export function BookingForm({ listingId, dailyFee, deposit, onCreated }: BookingFormProps) {
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [state, setState] = useState<"idle" | "working" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const duration = startTime && endTime ? Math.max(0, Math.ceil((new Date(endTime).getTime() - new Date(startTime).getTime()) / 86400000)) : 0;
  const rentalTotal = dailyFee && duration ? (Number(dailyFee) * duration).toFixed(4) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start <= new Date() || end <= start) {
      setState("error");
      setMessage("Choose future dates with an end time after the start.");
      return;
    }
    setState("working");
    setMessage("");
    try {
      await createBooking(listingId, start.toISOString(), end.toISOString());
      setState("success");
      setMessage("Booking request submitted. The owner must approve it before escrow can begin.");
      onCreated();
    } catch (error) {
      const code = error instanceof Error ? error.message : "request_failed";
      const messages: Record<string, string> = {
        authentication_required: "Sign in before requesting a booking.",
        owner_cannot_book_own_listing: "You cannot book your own listing.",
        dates_unavailable: "Those dates are no longer available.",
        listing_not_available: "This listing is no longer active.",
      };
      setState("error");
      setMessage(messages[code] || "The booking request could not be saved. Try again.");
    }
  }

  return <form className="content-panel booking-form" onSubmit={submit}>
    <h2>Request these dates</h2>
    <p className="auth-intro">This creates an off-chain request. No wallet transaction or deposit is made until the owner approves and you start escrow.</p>
    <div className="form-grid">
      <label>Start date and time<input required type="datetime-local" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
      <label>End date and time<input required type="datetime-local" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label>
    </div>
    {dailyFee && deposit && <div className="detail-prices"><span><small>Rental charge ({duration || 0} day{duration === 1 ? "" : "s"})</small><strong>{rentalTotal || "—"} ETH</strong></span><span><small>Refundable security deposit</small><strong>{deposit} ETH</strong></span><span><small>Due when escrow is funded</small><strong>{rentalTotal ? `${rentalTotal} + ${deposit} ETH` : "Select dates"}</strong></span></div>}
    <button className="button-primary" type="submit" disabled={state === "working"}>{state === "working" ? "Saving request..." : "Request booking"}</button>
    {message && <p className={`message ${state === "error" ? "error" : "success"}`}>{message}</p>}
  </form>;
}
