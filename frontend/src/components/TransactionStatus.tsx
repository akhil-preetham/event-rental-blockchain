import type { ReactNode } from "react";

export type TransactionPhase = "idle" | "preparing" | "waiting" | "submitted" | "confirming" | "confirmed" | "cancelled" | "failed" | "reverted";

export function TransactionStatus({ phase, message, hash }: { phase: TransactionPhase; message?: string; hash?: string }) {
  if (phase === "idle") return null;
  const labels: Record<TransactionPhase, string> = {
    idle: "", preparing: "Preparing", waiting: "Waiting for wallet", submitted: "Transaction submitted",
    confirming: "Confirming", confirmed: "Confirmed", cancelled: "Cancelled", failed: "Failed", reverted: "Reverted",
  };
  return <div className={`transaction-status transaction-${phase}`}><strong>{labels[phase]}</strong>{message && <span>{message}</span>}{hash && <small title={hash}>{hash.slice(0, 10)}...{hash.slice(-8)}</small>}</div>;
}

export function ActionButton({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return <button className="button-primary action-button" disabled={disabled} onClick={onClick}>{children}</button>;
}
