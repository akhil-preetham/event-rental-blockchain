import assert from "node:assert/strict";
import { network } from "hardhat";
import { createRentalVerifier, readRentalSnapshot } from "../backend/blockchain.js";

describe("backend blockchain verification against the local Hardhat provider", function () {
  it("verifies the createRental transaction and reconciles later contract state", async function () {
    const { ethers } = await network.connect();
    const [owner, renter, arbitrator] = await ethers.getSigners();
    const rentalEscrow = await ethers.deployContract("RentalEscrow", [arbitrator.address]);
    const startTime = new Date("2030-01-01T10:00:00.000Z");
    const endTime = new Date("2030-01-02T10:00:00.000Z");
    const createTransaction = await rentalEscrow.createRental(
      "listing-1",
      "Camera",
      renter.address,
      ethers.parseEther("0.01"),
      ethers.parseEther("0.05"),
      BigInt(Math.floor(startTime.getTime() / 1000)),
      BigInt(Math.floor(endTime.getTime() / 1000)),
    );
    const receipt = await createTransaction.wait();
    assert(receipt);

    const previousConfirmations = process.env.BLOCKCHAIN_CONFIRMATIONS;
    const previousAddress = process.env.RENTAL_ESCROW_ADDRESS;
    const previousChainId = process.env.BLOCKCHAIN_CHAIN_ID;
    process.env.BLOCKCHAIN_CONFIRMATIONS = "1";
    process.env.BLOCKCHAIN_CHAIN_ID = "31337";
    process.env.RENTAL_ESCROW_ADDRESS = await rentalEscrow.getAddress();
    const expected = {
      bookingId: 1,
      rentalId: "1",
      transactionHash: createTransaction.hash,
      chainId: 31337,
      contractAddress: await rentalEscrow.getAddress(),
      ownerAddress: owner.address,
      renterAddress: renter.address,
      equipmentId: "listing-1",
      equipmentName: "Camera",
      rentalFee: "0.01",
      deposit: "0.05",
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    };
    try {
      const verifier = createRentalVerifier({
        chainId: 31337,
        contractAddress: expected.contractAddress,
        providerFactory: () => ethers.provider,
      });
      const verified = await verifier(expected);
      assert.equal(verified.rentalId, "1");
      assert.equal(verified.blockNumber, receipt.blockNumber);
      assert.equal(verified.blockHash, receipt.blockHash);

      const created = await readRentalSnapshot(expected, { providerFactory: () => ethers.provider });
      assert.equal(created.status, "CREATED");
      await rentalEscrow.connect(renter).fundDeposit(1n, { value: ethers.parseEther("0.05") });
      const funded = await readRentalSnapshot(expected, { providerFactory: () => ethers.provider });
      assert.equal(funded.status, "FUNDED");
      assert.equal(funded.blockHash, receipt.blockHash);
    } finally {
      if (previousConfirmations === undefined) delete process.env.BLOCKCHAIN_CONFIRMATIONS;
      else process.env.BLOCKCHAIN_CONFIRMATIONS = previousConfirmations;
      if (previousAddress === undefined) delete process.env.RENTAL_ESCROW_ADDRESS;
      else process.env.RENTAL_ESCROW_ADDRESS = previousAddress;
      if (previousChainId === undefined) delete process.env.BLOCKCHAIN_CHAIN_ID;
      else process.env.BLOCKCHAIN_CHAIN_ID = previousChainId;
    }
  });
});
