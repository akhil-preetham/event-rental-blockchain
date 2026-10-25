import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { network } from "hardhat";
import { createLegacyEmailAuthRouter } from "../backend/auth.js";
import { openAuthDatabase } from "../backend/db.js";
import { createMarketplaceRouter } from "../backend/marketplace.js";
import { createRentalVerifier } from "../backend/blockchain.js";

describe("EventRent backend-to-chain local flow", function () {
  it("creates a booking, verifies escrow creation, and reconciles funding", async function () {
    const { ethers } = await network.connect();
    const [owner, renter, arbitrator] = await ethers.getSigners();
    const escrow = await ethers.deployContract("RentalEscrow", [arbitrator.address]);
    const escrowAddress = await escrow.getAddress();

    const previous = {
      confirmations: process.env.BLOCKCHAIN_CONFIRMATIONS,
      chainId: process.env.BLOCKCHAIN_CHAIN_ID,
      address: process.env.RENTAL_ESCROW_ADDRESS,
    };
    process.env.BLOCKCHAIN_CONFIRMATIONS = "1";
    process.env.BLOCKCHAIN_CHAIN_ID = "31337";
    process.env.RENTAL_ESCROW_ADDRESS = escrowAddress;

    const database = openAuthDatabase(":memory:");
    const verificationTokens: string[] = [];
    const app = express();
    app.use(express.json());
    app.use("/auth", createLegacyEmailAuthRouter(database, async (_email, url) => {
      verificationTokens.push(url.match(/[?&]token=([^&]+)/)?.[1] || "");
    }));
    app.use("/api", createMarketplaceRouter(database, {
      verifyRental: createRentalVerifier({
        chainId: 31337,
        contractAddress: escrowAddress,
        providerFactory: () => ethers.provider,
      }),
      reconcileRental: async (expected) => {
        const { readRentalSnapshot } = await import("../backend/blockchain.js");
        return readRentalSnapshot(expected, { providerFactory: () => ethers.provider });
      },
    }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const request = async (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", origin: "http://localhost:5173", ...(init.headers || {}) },
      });
      const cookie = (response: Response): string => {
        const value = response.headers.get("set-cookie");
        assert(value);
        return value.split(";")[0];
      };
      const register = async (email: string): Promise<string> => {
        assert.equal((await request("/auth/register", { method: "POST", body: JSON.stringify({ email, password: "correct horse battery staple" }) })).status, 201);
        const verified = await request("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens.pop() }) });
        const session = cookie(verified);
        for (const role of ["renter", "owner"]) {
          assert.equal((await request("/auth/role", { method: "POST", headers: { cookie: session }, body: JSON.stringify({ role }) })).status, 200);
        }
        return session;
      };

      const ownerCookie = await register("e2e-owner@example.com");
      const renterCookie = await register("e2e-renter@example.com");
      database.db.prepare("UPDATE users SET wallet_address = ? WHERE email = ?").run(owner.address, "e2e-owner@example.com");
      database.db.prepare("UPDATE users SET wallet_address = ? WHERE email = ?").run(renter.address, "e2e-renter@example.com");

      const listingResponse = await request("/api/listings", {
        method: "POST",
        headers: { cookie: ownerCookie },
        body: JSON.stringify({ serialId: "E2E-CAMERA-001", name: "E2E Camera", category: "Capture", description: "Local integration camera", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "E2E pickup" }),
      });
      assert.equal(listingResponse.status, 201);
      const listingId = (await listingResponse.json() as { listingId: number }).listingId;

      const bookingResponse = await request("/api/bookings", {
        method: "POST",
        headers: { cookie: renterCookie },
        body: JSON.stringify({ listingId, startTime: "2030-01-01T10:00:00.000Z", endTime: "2030-01-02T10:00:00.000Z" }),
      });
      assert.equal(bookingResponse.status, 201);
      const bookingId = (await bookingResponse.json() as { bookingId: number }).bookingId;
      assert.equal((await request(`/api/bookings/${bookingId}/status`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ status: "APPROVED" }) })).status, 200);

      const createTransaction = await escrow.createRental(`listing-${listingId}`, "E2E Camera", renter.address, ethers.parseEther("0.01"), ethers.parseEther("0.05"), 1893492000n, 1893578400n);
      await createTransaction.wait();
      const recordResponse = await request(`/api/bookings/${bookingId}/onchain`, {
        method: "PATCH",
        headers: { cookie: ownerCookie },
        body: JSON.stringify({ rentalId: "1", transactionHash: createTransaction.hash, chainId: 31337 }),
      });
      assert.equal(recordResponse.status, 200);
      assert.equal((await recordResponse.json() as { status: string }).status, "CREATED");

      await escrow.connect(renter).fundDeposit(1n, { value: ethers.parseEther("0.05") });
      const reconcileResponse = await request(`/api/bookings/${bookingId}/onchain/reconcile`, { method: "POST", headers: { cookie: renterCookie } });
      assert.equal(reconcileResponse.status, 200);
      assert.equal((await reconcileResponse.json() as { status: string }).status, "FUNDED");
    } finally {
      database.close();
      server.close();
      if (previous.confirmations === undefined) delete process.env.BLOCKCHAIN_CONFIRMATIONS;
      else process.env.BLOCKCHAIN_CONFIRMATIONS = previous.confirmations;
      if (previous.chainId === undefined) delete process.env.BLOCKCHAIN_CHAIN_ID;
      else process.env.BLOCKCHAIN_CHAIN_ID = previous.chainId;
      if (previous.address === undefined) delete process.env.RENTAL_ESCROW_ADDRESS;
      else process.env.RENTAL_ESCROW_ADDRESS = previous.address;
    }
  });
});
