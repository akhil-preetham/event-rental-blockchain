import { Contract, BrowserProvider, JsonRpcSigner } from "ethers";
import artifact from "../../../artifacts/contracts/RentalEscrow.sol/RentalEscrow.json";

export const HARDHAT_CHAIN_ID = BigInt(
  import.meta.env.VITE_HARDHAT_CHAIN_ID || "31337",
);
export const contractAddress =
  import.meta.env.VITE_RENTAL_ESCROW_ADDRESS?.trim() || "";
export const rentalEscrowAbi = artifact.abi;

export function requireContractAddress(): string {
  if (!contractAddress) {
    throw new Error(
      "VITE_RENTAL_ESCROW_ADDRESS is not configured. Deploy RentalEscrow and add its address to frontend/.env.local.",
    );
  }
  return contractAddress;
}

export function getRentalEscrow(
  providerOrSigner: BrowserProvider | JsonRpcSigner,
): Contract {
  return new Contract(requireContractAddress(), rentalEscrowAbi, providerOrSigner);
}
