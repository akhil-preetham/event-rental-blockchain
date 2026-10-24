import fs from "node:fs";
import path from "node:path";
import { inspectRentalEscrow } from "../backend/blockchain.js";

const artifactPath = path.resolve("artifacts", "contracts", "RentalEscrow.sol", "RentalEscrow.json");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { deployedBytecode?: string; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };
const addressArgument = process.argv.find((argument) => argument.startsWith("--address="))?.slice("--address=".length);
const jsonOutput = process.argv.includes("--json");

const inspection = await inspectRentalEscrow({
  contractAddress: addressArgument || process.env.RENTAL_ESCROW_ADDRESS,
  expectedRuntimeBytecode: artifact.deployedBytecode,
  expectedImmutableReferences: artifact.immutableReferences,
});

if (jsonOutput) {
  console.log(JSON.stringify(inspection, null, 2));
} else {
  console.log(`Status: ${inspection.status}`);
  console.log(`Expected chain: ${inspection.expectedChainId}`);
  console.log(`Connected chain: ${inspection.actualChainId ?? "unavailable"}`);
  console.log(`Contract address: ${inspection.address ?? "not configured"}`);
  console.log(`Latest block: ${inspection.latestBlock ?? "unavailable"}`);
  console.log(`Bytecode: ${inspection.bytecodePresent ? `${inspection.bytecodeBytes} bytes` : "missing"}`);
  console.log(`Bytecode hash: ${inspection.bytecodeHash ?? "unavailable"}`);
  if (inspection.expectedBytecodeHash) console.log(`Expected artifact hash: ${inspection.expectedBytecodeHash}`);
  console.log(`Message: ${inspection.message}`);
}

if (inspection.status !== "OK") process.exitCode = 1;
