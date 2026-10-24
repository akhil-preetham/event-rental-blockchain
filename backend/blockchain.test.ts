import assert from "node:assert/strict";
import { test } from "node:test";
import { createRentalVerifier, inspectRentalEscrow } from "./blockchain.js";

test("bounds an unavailable RPC verification request", async () => {
  const previousUrl = process.env.BLOCKCHAIN_RPC_URL;
  const previousTimeout = process.env.BLOCKCHAIN_RPC_TIMEOUT_MS;
  process.env.BLOCKCHAIN_RPC_URL = "http://127.0.0.1:1";
  process.env.BLOCKCHAIN_RPC_TIMEOUT_MS = "1000";
  try {
    const verifier = createRentalVerifier({
      chainId: 31337,
      contractAddress: "0x1111111111111111111111111111111111111111",
    });
    await assert.rejects(
      verifier({
        bookingId: 1,
        rentalId: "1",
        transactionHash: `0x${"1".repeat(64)}`,
        chainId: 31337,
        contractAddress: "0x1111111111111111111111111111111111111111",
        ownerAddress: "0x1111111111111111111111111111111111111111",
        renterAddress: "0x2222222222222222222222222222222222222222",
        equipmentId: "listing-1",
        equipmentName: "Camera",
        rentalFee: "0.01",
        deposit: "0.05",
        startTime: "2030-01-01T10:00:00.000Z",
        endTime: "2030-01-02T10:00:00.000Z",
      }),
      (error: unknown) => error instanceof Error && ["rpc_timeout", "ECONNREFUSED", "could not detect network"].some((code) => error.message.includes(code)),
    );
  } finally {
    if (previousUrl === undefined) delete process.env.BLOCKCHAIN_RPC_URL;
    else process.env.BLOCKCHAIN_RPC_URL = previousUrl;
    if (previousTimeout === undefined) delete process.env.BLOCKCHAIN_RPC_TIMEOUT_MS;
    else process.env.BLOCKCHAIN_RPC_TIMEOUT_MS = previousTimeout;
  }
});

test("reports missing and invalid contract configuration without contacting an RPC", async () => {
  const missing = await inspectRentalEscrow({ contractAddress: "" });
  assert.equal(missing.status, "NOT_CONFIGURED");
  assert.equal(missing.address, null);

  const invalid = await inspectRentalEscrow({ contractAddress: "not-an-address" });
  assert.equal(invalid.status, "INVALID_ADDRESS");
  assert.equal(invalid.address, "not-an-address");
});

test("reports chain, address, and bytecode state while ignoring constructor immutables", async () => {
  const inspection = await inspectRentalEscrow({
    chainId: 31337,
    contractAddress: "0x1111111111111111111111111111111111111111",
    expectedRuntimeBytecode: "0x60016000aabbccdd",
    expectedImmutableReferences: { "1": [{ start: 4, length: 2 }] },
    providerFactory: () => ({
      getNetwork: async () => ({ chainId: 31337n }),
      getTransaction: async () => null,
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => 18,
      getBlock: async () => ({ hash: null }),
      getCode: async () => "0x60016000ffffccdd",
    }),
  });

  assert.equal(inspection.status, "OK");
  assert.equal(inspection.actualChainId, 31337);
  assert.equal(inspection.address, "0x1111111111111111111111111111111111111111");
  assert.equal(inspection.latestBlock, 18);
  assert.equal(inspection.bytecodePresent, true);
  assert.equal(inspection.bytecodeBytes, 8);
});
