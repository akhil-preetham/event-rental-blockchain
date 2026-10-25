import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import http from "node:http";
import { createLegacyEmailAuthRouter } from "./auth.js";
import { openAuthDatabase } from "./db.js";
import { createMarketplaceRouter } from "./marketplace.js";
import type { OnchainRentalSnapshot, RentalVerifier } from "./blockchain.js";

async function startServer(verifyRental: RentalVerifier = async (expected) => ({ rentalId: expected.rentalId, transactionHash: expected.transactionHash, chainId: expected.chainId, blockNumber: 12, blockHash: `0x${"1".repeat(64)}`, eventName: "RentalCreated" }), reconcileRental: (expected: Parameters<typeof import("./blockchain.js").readRentalSnapshot>[0]) => Promise<OnchainRentalSnapshot> = async (expected) => ({ rentalId: expected.rentalId, status: "FUNDED", blockNumber: 13, blockHash: `0x${"2".repeat(64)}` })) {
  const database = openAuthDatabase(":memory:");
  const verificationTokens: string[] = [];
  const app = express();
  app.use(express.json());
  app.use("/auth", createLegacyEmailAuthRouter(database, async (_email, url) => { verificationTokens.push(url.match(/[?&]token=([^&]+)/)?.[1] || ""); }));
  app.use("/api", createMarketplaceRouter(database, { verifyRental, reconcileRental }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { database, server, verificationTokens, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl: string, path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin: "http://localhost:5173", ...(init.headers || {}) },
  });
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert(value);
  return value.split(";")[0];
}

async function register(baseUrl: string, email: string, verificationTokens: string[]): Promise<string> {
  const response = await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email, password: "correct horse battery staple" }) });
  assert.equal(response.status, 201);
  const verified = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens.pop() }) });
  const sessionCookie = cookie(verified);
  for (const role of ["renter", "owner"]) {
    assert.equal((await request(baseUrl, "/auth/role", { method: "POST", headers: { cookie: sessionCookie }, body: JSON.stringify({ role }) })).status, 200);
  }
  return sessionCookie;
}

function assignWallets(database: ReturnType<typeof openAuthDatabase>, ownerEmail: string, renterEmail: string): void {
  database.db.prepare("UPDATE users SET wallet_address = ? WHERE email = ?").run("0x1111111111111111111111111111111111111111", ownerEmail);
  database.db.prepare("UPDATE users SET wallet_address = ? WHERE email = ?").run("0x2222222222222222222222222222222222222222", renterEmail);
}

test("creates a renter booking and restores it through the authenticated API", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const ownerCookie = await register(baseUrl, "owner@example.com", verificationTokens);
    const renterCookie = await register(baseUrl, "renter@example.com", verificationTokens);
    const listingResponse = await request(baseUrl, "/api/listings", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ serialId: "CAM-TEST-001", name: "Camera", category: "Capture", description: "A camera kit", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }) });
    assert.equal(listingResponse.status, 201);
    const listingId = (await listingResponse.json() as { listingId: number }).listingId;
    const bookingResponse = await request(baseUrl, "/api/bookings", { method: "POST", headers: { cookie: renterCookie }, body: JSON.stringify({ listingId, startTime: "2030-01-01T10:00:00.000Z", endTime: "2030-01-02T10:00:00.000Z" }) });
    assert.equal(bookingResponse.status, 201);
    const bookings = await request(baseUrl, "/api/bookings", { headers: { cookie: renterCookie } });
    assert.equal(bookings.status, 200);
    assert.equal((await bookings.json() as { bookings: Array<{ status: string }> }).bookings[0].status, "REQUESTED");
  } finally {
    database.close();
    server.close();
  }
});

test("enforces persisted capabilities on protected marketplace mutations", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const registration = await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "capability@example.com", password: "correct horse battery staple" }) });
    assert.equal(registration.status, 201);
    const verified = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[0] }) });
    const sessionCookie = cookie(verified);
    const denied = await request(baseUrl, "/api/listings", { method: "POST", headers: { cookie: sessionCookie }, body: JSON.stringify({ serialId: "CAM-TEST-002", name: "Camera", category: "Capture", description: "A camera kit", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }) });
    assert.equal(denied.status, 403);
    assert.equal((await request(baseUrl, "/auth/role", { method: "POST", headers: { cookie: sessionCookie }, body: JSON.stringify({ role: "owner" }) })).status, 200);
    const allowed = await request(baseUrl, "/api/listings", { method: "POST", headers: { cookie: sessionCookie }, body: JSON.stringify({ serialId: "CAM-TEST-003", name: "Camera", category: "Capture", description: "A camera kit", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }) });
    assert.equal(allowed.status, 201);
  } finally {
    database.close();
    server.close();
  }
});

test("rejects malformed cookies and amounts outside parseEther uint256 bounds", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const malformed = await request(baseUrl, "/api/bookings", { headers: { cookie: "eventrent_session=%E0%A4%A" } });
    assert.equal(malformed.status, 401);

    const ownerCookie = await register(baseUrl, "amount-owner@example.com", verificationTokens);
    for (const [index, dailyFee] of ["Infinity", "1e309", `1${"0".repeat(80)}`].entries()) {
      const invalid = await request(baseUrl, "/api/listings", {
        method: "POST",
        headers: { cookie: ownerCookie },
        body: JSON.stringify({ serialId: `CAM-AMOUNT-${index}`, name: "Camera", category: "Capture", description: "A camera kit", condition: "Good", dailyFee, deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }),
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: "invalid_listing" });
    }
  } finally {
    database.close();
    server.close();
  }
});

test("enforces booking ownership and supports approve/reject transitions", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const ownerCookie = await register(baseUrl, "owner2@example.com", verificationTokens);
    const renterCookie = await register(baseUrl, "renter2@example.com", verificationTokens);
    assignWallets(database, "owner2@example.com", "renter2@example.com");
    const listingResponse = await request(baseUrl, "/api/listings", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ serialId: "PRJ-TEST-001", name: "Projector", category: "Projection", description: "A projector", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }) });
    const listingId = (await listingResponse.json() as { listingId: number }).listingId;
    const bookingResponse = await request(baseUrl, "/api/bookings", { method: "POST", headers: { cookie: renterCookie }, body: JSON.stringify({ listingId, startTime: "2030-02-01T10:00:00.000Z", endTime: "2030-02-02T10:00:00.000Z" }) });
    const bookingId = (await bookingResponse.json() as { bookingId: number }).bookingId;
    assert.equal((await request(baseUrl, `/api/bookings/${bookingId}/status`, { method: "PATCH", headers: { cookie: renterCookie }, body: JSON.stringify({ status: "APPROVED" }) })).status, 403);
    const approved = await request(baseUrl, `/api/bookings/${bookingId}/status`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ status: "APPROVED" }) });
    assert.equal(approved.status, 200);
    const recorded = await request(baseUrl, `/api/bookings/${bookingId}/onchain`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ rentalId: "7", transactionHash: `0x${"a".repeat(64)}`, chainId: 31337 }) });
    assert.equal(recorded.status, 200);
    assert.equal((await recorded.json() as { status: string }).status, "CREATED");
    const retry = await request(baseUrl, `/api/bookings/${bookingId}/onchain`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ rentalId: "7", transactionHash: `0x${"a".repeat(64)}`, chainId: 31337 }) });
    assert.equal(retry.status, 200);
    assert.equal((await request(baseUrl, `/api/bookings/${bookingId}/onchain`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ rentalId: "8", transactionHash: `0x${"b".repeat(64)}`, chainId: 31337 }) })).status, 409);
    assert.equal((await request(baseUrl, `/api/bookings/${bookingId}/status`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ status: "REJECTED" }) })).status, 409);
  } finally {
    database.close();
    server.close();
  }
});

test("does not record a transaction when verification fails and allows a later retry", async () => {
  let attempts = 0;
  const verifier: RentalVerifier = async (expected) => {
    attempts += 1;
    if (attempts === 1) throw new Error("transaction_not_found");
    return { rentalId: expected.rentalId, transactionHash: expected.transactionHash, chainId: expected.chainId, blockNumber: 20, blockHash: `0x${"2".repeat(64)}`, eventName: "RentalCreated" };
  };
  const { server, database, verificationTokens, baseUrl } = await startServer(verifier);
  try {
    const ownerCookie = await register(baseUrl, "retry-owner@example.com", verificationTokens);
    const renterCookie = await register(baseUrl, "retry-renter@example.com", verificationTokens);
    assignWallets(database, "retry-owner@example.com", "retry-renter@example.com");
    const listingResponse = await request(baseUrl, "/api/listings", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ serialId: "MIC-TEST-001", name: "Microphone", category: "Sound", description: "A microphone", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }) });
    const listingId = (await listingResponse.json() as { listingId: number }).listingId;
    const bookingResponse = await request(baseUrl, "/api/bookings", { method: "POST", headers: { cookie: renterCookie }, body: JSON.stringify({ listingId, startTime: "2030-04-01T10:00:00.000Z", endTime: "2030-04-02T10:00:00.000Z" }) });
    const bookingId = (await bookingResponse.json() as { bookingId: number }).bookingId;
    await request(baseUrl, `/api/bookings/${bookingId}/status`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ status: "APPROVED" }) });
    const payload = JSON.stringify({ rentalId: "9", transactionHash: `0x${"c".repeat(64)}`, chainId: 31337 });
    assert.equal((await request(baseUrl, `/api/bookings/${bookingId}/onchain`, { method: "PATCH", headers: { cookie: ownerCookie }, body: payload })).status, 422);
    assert.equal((await request(baseUrl, `/api/bookings/${bookingId}/onchain`, { method: "PATCH", headers: { cookie: ownerCookie }, body: payload })).status, 200);
  } finally {
    database.close();
    server.close();
  }
});

test("rejects overlaps at creation and allows only one concurrent request", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const ownerCookie = await register(baseUrl, "owner3@example.com", verificationTokens);
    const renterCookie = await register(baseUrl, "renter3@example.com", verificationTokens);
    const listingResponse = await request(baseUrl, "/api/listings", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ serialId: "LGT-TEST-001", name: "Lights", category: "Lighting", description: "Stage lights", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }) });
    const listingId = (await listingResponse.json() as { listingId: number }).listingId;
    const payload = JSON.stringify({ listingId, startTime: "2030-03-01T10:00:00.000Z", endTime: "2030-03-02T10:00:00.000Z" });
    const results = await Promise.all([
      request(baseUrl, "/api/bookings", { method: "POST", headers: { cookie: renterCookie }, body: payload }),
      request(baseUrl, "/api/bookings", { method: "POST", headers: { cookie: renterCookie }, body: payload }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  } finally {
    database.close();
    server.close();
  }
});

test("does not disclose inactive listings or another user's booking details", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const ownerCookie = await register(baseUrl, "access-owner@example.com", verificationTokens);
    const renterCookie = await register(baseUrl, "access-renter@example.com", verificationTokens);
    const outsiderCookie = await register(baseUrl, "access-outsider@example.com", verificationTokens);
    const listingResponse = await request(baseUrl, "/api/listings", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({ serialId: "ACC-TEST-001", name: "Access test camera", category: "Capture", description: "Camera", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }),
    });
    const listingId = (await listingResponse.json() as { listingId: number }).listingId;
    const bookingResponse = await request(baseUrl, "/api/bookings", {
      method: "POST",
      headers: { cookie: renterCookie },
      body: JSON.stringify({ listingId, startTime: "2030-05-01T10:00:00.000Z", endTime: "2030-05-02T10:00:00.000Z" }),
    });
    const bookingId = (await bookingResponse.json() as { bookingId: number }).bookingId;
    assert.equal((await request(baseUrl, `/api/bookings/${bookingId}`, { headers: { cookie: outsiderCookie } })).status, 403);
    assert.equal((await request(baseUrl, `/api/bookings/${bookingId}`, { headers: { cookie: renterCookie } })).status, 200);
    database.db.prepare("UPDATE listings SET active = 0 WHERE id = ?").run(listingId);
    assert.equal((await request(baseUrl, `/api/listings/${listingId}`)).status, 404);
  } finally {
    database.close();
    server.close();
  }
});

test("allows only the listing owner to edit listing presentation and availability", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const ownerCookie = await register(baseUrl, "edit-owner@example.com", verificationTokens);
    const outsiderCookie = await register(baseUrl, "edit-outsider@example.com", verificationTokens);
    const listingResponse = await request(baseUrl, "/api/listings", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({ serialId: "EDIT-TEST-001", name: "Editable camera", category: "Capture", description: "Original description", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }),
    });
    const listingId = (await listingResponse.json() as { listingId: number }).listingId;

    const denied = await request(baseUrl, `/api/listings/${listingId}`, {
      method: "PUT",
      headers: { cookie: outsiderCookie },
      body: JSON.stringify({ name: "Hijacked listing", description: "Should not save", active: false }),
    });
    assert.equal(denied.status, 403);

    const updated = await request(baseUrl, `/api/listings/${listingId}`, {
      method: "PUT",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({ name: "Updated camera", description: "Updated description", active: false }),
    });
    assert.equal(updated.status, 200);
    const hidden = await request(baseUrl, `/api/listings/${listingId}`);
    assert.equal(hidden.status, 404);
    const ownerListings = await request(baseUrl, "/api/my/listings", { headers: { cookie: ownerCookie } });
    const listing = (await ownerListings.json() as { listings: Array<{ name: string; description: string; active: number }> }).listings.find((entry) => entry.name === "Updated camera");
    assert.ok(listing);
    assert.equal(listing.description, "Updated description");
    assert.equal(listing.active, 0);
  } finally {
    database.close();
    server.close();
  }
});

test("supports complete listing edits and exposes persisted escrow state to both booking parties", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const ownerCookie = await register(baseUrl, "complete-owner@example.com", verificationTokens);
    const renterCookie = await register(baseUrl, "complete-renter@example.com", verificationTokens);
    assignWallets(database, "complete-owner@example.com", "complete-renter@example.com");
    const created = await request(baseUrl, "/api/listings", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ serialId: "FULL-TEST-001", name: "Original", category: "Capture", description: "Original description", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }) });
    const listingId = (await created.json() as { listingId: number }).listingId;
    const updated = await request(baseUrl, `/api/listings/${listingId}`, { method: "PUT", headers: { cookie: ownerCookie }, body: JSON.stringify({ category: "Video", condition: "Excellent", dailyFee: "0.02", deposit: "0.06", location: "Downtown", pickupDetails: "Bring ID", imageUrl: "https://example.test/camera.jpg" }) });
    assert.equal(updated.status, 200);
    const detail = await request(baseUrl, `/api/listings/${listingId}`);
    assert.equal((await detail.json() as { listing: { category: string; dailyFee: string; pickupDetails: string } }).listing.category, "Video");
    const booking = await request(baseUrl, "/api/bookings", { method: "POST", headers: { cookie: renterCookie }, body: JSON.stringify({ listingId, startTime: "2030-06-01T10:00:00.000Z", endTime: "2030-06-02T10:00:00.000Z" }) });
    const bookingId = (await booking.json() as { bookingId: number }).bookingId;
    await request(baseUrl, `/api/bookings/${bookingId}/status`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ status: "APPROVED" }) });
    const recorded = await request(baseUrl, `/api/bookings/${bookingId}/onchain`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ rentalId: "21", transactionHash: `0x${"d".repeat(64)}`, chainId: 31337 }) });
    assert.equal(recorded.status, 200);
    const state = await request(baseUrl, `/api/bookings/${bookingId}/onchain`, { headers: { cookie: renterCookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json() as { onchain: { status: string } }).onchain.status, "CREATED");
    const reconciled = await request(baseUrl, `/api/bookings/${bookingId}/onchain/reconcile`, { method: "POST", headers: { cookie: renterCookie } });
    assert.equal(reconciled.status, 200);
    assert.equal((await reconciled.json() as { status: string }).status, "FUNDED");
  } finally {
    database.close();
    server.close();
  }
});

test("returns JSON for malformed marketplace identifiers", async () => {
  const { server, database, baseUrl } = await startServer();
  try {
    const response = await request(baseUrl, "/api/listings/not-a-number");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_listing_id" });
  } finally {
    database.close();
    server.close();
  }
});

test("requires a unique serial ID and exposes the uploaded item image to renters", async () => {
  const { server, database, verificationTokens, baseUrl } = await startServer();
  try {
    const ownerCookie = await register(baseUrl, "serial-owner@example.com", verificationTokens);
    const imageUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/";
    const created = await request(baseUrl, "/api/listings", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({ serialId: "PHOTO-TEST-001", name: "Uploaded camera", category: "Capture", description: "Camera with proof image", imageUrl, condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }),
    });
    assert.equal(created.status, 201);
    const listingId = (await created.json() as { listingId: number }).listingId;
    const detail = await request(baseUrl, `/api/listings/${listingId}`);
    const listing = (await detail.json() as { listing: { serialId: string; imageUrl: string } }).listing;
    assert.equal(listing.serialId, "PHOTO-TEST-001");
    assert.equal(listing.imageUrl, imageUrl);

    const duplicate = await request(baseUrl, "/api/listings", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({ serialId: "PHOTO-TEST-001", name: "Duplicate camera", category: "Capture", description: "Duplicate serial", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }),
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "serial_id_already_registered" });

    const missing = await request(baseUrl, "/api/listings", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({ name: "Missing serial", category: "Capture", description: "Missing serial", condition: "Good", dailyFee: "0.01", deposit: "0.05", location: "Local pickup", pickupDetails: "Arrange pickup" }),
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "invalid_serial_id" });
  } finally {
    database.close();
    server.close();
  }
});
