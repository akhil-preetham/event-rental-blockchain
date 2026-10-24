export function explainWalletError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: number }).code : undefined;
  if (code === 4001 || message.includes("wallet_permission_rejected")) return "Wallet access was rejected. Approve the request in MetaMask or try again.";
  if (code === -32002 || message.includes("already processing")) return "MetaMask is already waiting for a response. Open it and finish or reject the pending request.";
  if (code === 4100 || message.includes("unauthorized")) return "MetaMask has not authorized this site. Connect the account and try again.";
  if (code === 4900 || code === 4901 || message.includes("disconnected")) return "MetaMask is disconnected from the selected network. Reconnect it and try again.";
  if (code === 4902) return "Hardhat Local is not configured in MetaMask. Use Switch Network to add it.";
  if (message.includes("metamask is not installed")) {
    return "A wallet is needed for this action. Install MetaMask or connect an available wallet.";
  }
  if (message.includes("user rejected") || message.includes("user denied") || message.includes("action_rejected")) {
    return "The wallet request was cancelled. No rental changes were made.";
  }
  if (message.includes("insufficient funds")) {
    return "This wallet does not have enough ETH to complete the transaction and network fee.";
  }
  if (message.includes("transferfailed") || message.includes("withdrawal")) {
    return "Withdrawal unsuccessful. The destination wallet rejected the transfer. Your claim remains available.";
  }
  if (message.includes("call_exception") || message.includes("execution reverted") || message.includes("reverted")) {
    return "This action is no longer available because the rental state may have changed. Refresh the rental and try again.";
  }
  if (message.includes("invalid address")) {
    return "Enter a valid Ethereum wallet address.";
  }
  if (message.includes("unauthorized") || message.includes("owner") || message.includes("renter") || message.includes("arbitrator")) {
    return "You don't have permission to perform this action.";
  }
  if (message.includes("invalidrentalstatus") || message.includes("invalid rental status")) {
    return "This action isn't available for the rental's current status.";
  }
  if (message.includes("rentalnotfound") || message.includes("rental not found")) {
    return "This rental could not be found.";
  }
  if (message.includes("invalid_argument") || message.includes("invalid decimal")) {
    return "Check the amount and date fields. Use valid numbers before submitting.";
  }
  return "The transaction could not be completed. Check the rental details and try again.";
}
