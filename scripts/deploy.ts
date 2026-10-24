import { network } from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { inspectRentalEscrow } from "../backend/blockchain.js";

const { ethers } = await network.connect();
const configuredAddress = process.env.RENTAL_ESCROW_ADDRESS?.trim() || "";
const explicitDeployment = ["1", "true", "yes"].includes((process.env.RENTAL_ESCROW_DEPLOY || "").toLowerCase());
const artifactPath = path.resolve("artifacts", "contracts", "RentalEscrow.sol", "RentalEscrow.json");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { deployedBytecode?: string; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };

if (configuredAddress) {
  const inspection = await inspectRentalEscrow({
    chainId: Number(process.env.BLOCKCHAIN_CHAIN_ID || 31337),
    contractAddress: configuredAddress,
    expectedRuntimeBytecode: artifact.deployedBytecode,
    expectedImmutableReferences: artifact.immutableReferences,
    providerFactory: () => ethers.provider,
  });
  console.log(JSON.stringify(inspection, null, 2));
  if (inspection.status === "OK") {
    console.log("RentalEscrow already exists at the configured address; no deployment was performed.");
    process.exit(0);
  }
  if (inspection.status === "BYTECODE_MISMATCH") {
    throw new Error("The configured address contains different bytecode. Refusing to overwrite or redeploy; update configuration only after manually confirming the intended contract.");
  }
  if (["INVALID_ADDRESS", "WRONG_CHAIN", "RPC_UNAVAILABLE"].includes(inspection.status)) {
    throw new Error(`Configured RentalEscrow cannot be safely inspected (${inspection.status}). Refusing to deploy until the address, chain, and RPC configuration are corrected.`);
  }
  if (!explicitDeployment) {
    throw new Error(`Configured RentalEscrow is not usable (${inspection.status}). Refusing to deploy automatically. Set RENTAL_ESCROW_DEPLOY=1 only after confirming the local node and address configuration.`);
  }
}

if (!explicitDeployment) {
  throw new Error("Deployment is disabled by default. Set RENTAL_ESCROW_DEPLOY=1 for an explicit local deployment, then copy the printed address into backend and frontend configuration.");
}

const [arbitrator] = await ethers.getSigners();
const arbitratorAddress = await arbitrator.getAddress();
const rentalEscrow = await ethers.deployContract("RentalEscrow", [
  arbitratorAddress,
]);

await rentalEscrow.waitForDeployment();

console.log("RentalEscrow deployed successfully");
console.log(`Arbitrator: ${arbitratorAddress}`);
const deployedAddress = await rentalEscrow.getAddress();
console.log(`RentalEscrow: ${deployedAddress}`);
console.log("Set this address explicitly before starting the backend/frontend:");
console.log(`  $env:RENTAL_ESCROW_ADDRESS=\"${deployedAddress}\"`);
console.log(`  $env:VITE_RENTAL_ESCROW_ADDRESS=\"${deployedAddress}\"`);
