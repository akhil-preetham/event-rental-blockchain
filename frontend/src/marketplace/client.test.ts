import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchBookings } from "./client";

test("refreshes persisted escrow snapshots before returning bookings", async () => {
  const originalFetch = globalThis.fetch;
  let bookingReads = 0;
  const calls: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push(`${method} ${url}`);

    if (url === "/api/bookings" && method === "GET") {
      bookingReads += 1;
      const status = bookingReads === 1 ? "CREATED" : "REFUNDED";
      return new Response(JSON.stringify({
        bookings: [{
          id: 7,
          listingId: 1,
          name: "Projector",
          startTime: "2030-01-01T00:00:00.000Z",
          endTime: "2030-01-02T00:00:00.000Z",
          status: "APPROVED",
          onchainRentalId: "1",
          transactionHash: `0x${"a".repeat(64)}`,
          onchainVerificationStatus: "VERIFIED",
          onchainRentalStatus: status,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url === "/api/bookings/7/onchain/reconcile" && method === "POST") {
      return new Response(JSON.stringify({ status: "REFUNDED", verified: true }), { status: 200, headers: { "content-type": "application/json" } });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const bookings = await fetchBookings();
    assert.equal(bookings[0]?.onchainRentalStatus, "REFUNDED");
    assert.deepEqual(calls, [
      "GET /api/bookings",
      "POST /api/bookings/7/onchain/reconcile",
      "GET /api/bookings",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
