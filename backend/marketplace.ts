import express from "express";
import { parseEther } from "ethers";
import { hashToken, hasUserRole, findSessionUser, type AuthDatabase, type UserRole } from "./db.js";
import { createRentalVerifier, readRentalSnapshot, type RentalVerifier } from "./blockchain.js";

const validText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const MAX_UINT256 = (1n << 256n) - 1n;
const validAmount = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized)) return false;
  try {
    const amount = parseEther(normalized);
    return amount > 0n && amount <= MAX_UINT256;
  } catch {
    return false;
  }
};
const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;

const decodeCookieValue = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const sessionToken = (request: express.Request) => {
  const value = request.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("eventrent_session="));
  return value ? decodeCookieValue(value.slice("eventrent_session=".length)) : null;
};
const currentUser = (database: AuthDatabase, request: express.Request) => {
  const token = sessionToken(request);
  const user = token ? findSessionUser(database, hashToken(token)) : null;
  return user?.email && !user.emailVerified ? null : user;
};
const requireRole = (database: AuthDatabase, userId: number, role: UserRole, response: express.Response): boolean => {
  if (hasUserRole(database, userId, role)) return true;
  response.status(403).json({ error: `${role}_role_required` });
  return false;
};
function parseBookingTime(value: unknown): string | null {
  if (!validText(value, 40)) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

export function createMarketplaceRouter(database: AuthDatabase, options: { verifyRental?: RentalVerifier; reconcileRental?: typeof readRentalSnapshot } = {}): express.Router {
  const router = express.Router();
  const verifyRental = options.verifyRental || createRentalVerifier();
  const reconcileRental = options.reconcileRental || readRentalSnapshot;
  const configuredChainId = Number(process.env.BLOCKCHAIN_CHAIN_ID || 31337);
  router.get("/my/listings", (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    if (!requireRole(database, user.id, "owner", response)) return;
    const listings = database.db.prepare("SELECT id, name, category, description, image_url AS imageUrl, condition, daily_fee AS dailyFee, deposit, location, pickup_details AS pickupDetails, active, created_at AS createdAt, updated_at AS updatedAt FROM listings WHERE owner_id = ? ORDER BY created_at DESC").all(user.id);
    response.json({ listings });
  });
  router.get("/listings", (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
    const category = typeof request.query.category === "string" ? request.query.category.trim() : "";
    const rows = database.db.prepare("SELECT l.id, l.name, l.category, l.description, l.image_url AS imageUrl, l.condition, l.daily_fee AS dailyFee, l.deposit, l.location, l.pickup_details AS pickupDetails, l.active, l.owner_id AS ownerId, COALESCE(u.email, 'EventRent owner') AS ownerName FROM listings l JOIN users u ON u.id = l.owner_id WHERE l.active = 1 AND (? = '' OR l.name LIKE ? OR l.description LIKE ?) AND (? = '' OR l.category = ?) ORDER BY l.created_at DESC LIMIT 50").all(query, `%${query}%`, `%${query}%`, category, category);
    response.json({ listings: rows });
  });
  router.get("/listings/:id", (request, response) => {
    const listingId = Number(request.params.id);
    if (!positiveInteger(listingId)) { response.status(400).json({ error: "invalid_listing_id" }); return; }
    const listing = database.db.prepare("SELECT l.id, l.name, l.category, l.description, l.image_url AS imageUrl, l.condition, l.daily_fee AS dailyFee, l.deposit, l.location, l.pickup_details AS pickupDetails, l.active, l.owner_id AS ownerId, COALESCE(u.email, 'EventRent owner') AS ownerName FROM listings l JOIN users u ON u.id = l.owner_id WHERE l.id = ? AND l.active = 1").get(listingId);
    if (!listing) { response.status(404).json({ error: "listing_not_found" }); return; }
    response.json({ listing });
  });
  router.post("/listings", (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    if (!requireRole(database, user.id, "owner", response)) return;
    const body = request.body || {};
    const fields = ["name", "category", "description", "condition", "dailyFee", "deposit", "location", "pickupDetails"] as const;
    if (fields.some((field) => !validText(body[field], field === "description" ? 2000 : 240)) || !validAmount(body.dailyFee) || !validAmount(body.deposit)) { response.status(400).json({ error: "invalid_listing" }); return; }
    const now = new Date().toISOString();
    const result = database.db.prepare("INSERT INTO listings (owner_id, name, category, description, image_url, condition, daily_fee, deposit, location, pickup_details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(user.id, body.name.trim(), body.category.trim(), body.description.trim(), typeof body.imageUrl === "string" ? body.imageUrl.trim().slice(0, 1000) : null, body.condition.trim(), body.dailyFee.trim(), body.deposit.trim(), body.location.trim(), body.pickupDetails.trim(), now, now);
    response.status(201).json({ listingId: Number(result.lastInsertRowid) });
  });
  router.put("/listings/:id", (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    if (!requireRole(database, user.id, "owner", response)) return;
    const listingId = Number(request.params.id);
    if (!positiveInteger(listingId)) { response.status(400).json({ error: "invalid_listing_id" }); return; }
    const listing = database.db.prepare("SELECT owner_id AS ownerId FROM listings WHERE id = ?").get(listingId) as { ownerId: number } | undefined;
    if (!listing) { response.status(404).json({ error: "listing_not_found" }); return; }
    if (listing.ownerId !== user.id) { response.status(403).json({ error: "listing_owner_required" }); return; }
    const body = request.body || {};
    const current = database.db.prepare("SELECT name, category, description, image_url AS imageUrl, condition, daily_fee AS dailyFee, deposit, location, pickup_details AS pickupDetails, active FROM listings WHERE id = ?").get(listingId) as { name: string; category: string; description: string; imageUrl: string | null; condition: string; dailyFee: string; deposit: string; location: string; pickupDetails: string; active: number };
    const values = {
      name: body.name === undefined ? current.name : body.name,
      category: body.category === undefined ? current.category : body.category,
      description: body.description === undefined ? current.description : body.description,
      imageUrl: body.imageUrl === undefined ? current.imageUrl : body.imageUrl,
      condition: body.condition === undefined ? current.condition : body.condition,
      dailyFee: body.dailyFee === undefined ? current.dailyFee : body.dailyFee,
      deposit: body.deposit === undefined ? current.deposit : body.deposit,
      location: body.location === undefined ? current.location : body.location,
      pickupDetails: body.pickupDetails === undefined ? current.pickupDetails : body.pickupDetails,
      active: body.active === undefined ? current.active === 1 : body.active,
    };
    const hasChanges = Object.keys(body).some((field) => ["name", "category", "description", "imageUrl", "condition", "dailyFee", "deposit", "location", "pickupDetails", "active"].includes(field));
    if (!hasChanges || !validText(values.name, 240) || !validText(values.category, 240) || !validText(values.description, 2000) || !validText(values.condition, 240) || !validAmount(values.dailyFee) || !validAmount(values.deposit) || !validText(values.location, 240) || !validText(values.pickupDetails, 240) || (values.imageUrl !== null && (typeof values.imageUrl !== "string" || values.imageUrl.trim().length > 1000)) || typeof values.active !== "boolean") { response.status(400).json({ error: "invalid_listing" }); return; }
    database.db.prepare("UPDATE listings SET name = ?, category = ?, description = ?, image_url = ?, condition = ?, daily_fee = ?, deposit = ?, location = ?, pickup_details = ?, active = ?, updated_at = ? WHERE id = ?").run(values.name.trim(), values.category.trim(), values.description.trim(), typeof values.imageUrl === "string" ? values.imageUrl.trim() : null, values.condition.trim(), values.dailyFee.trim(), values.deposit.trim(), values.location.trim(), values.pickupDetails.trim(), values.active ? 1 : 0, new Date().toISOString(), listingId);
    response.json({ updated: true });
  });
  router.get("/bookings", (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    const rows = database.db.prepare("SELECT b.id, b.listing_id AS listingId, l.name, l.daily_fee AS dailyFee, l.deposit, b.start_time AS startTime, b.end_time AS endTime, b.status, b.onchain_rental_id AS onchainRentalId, b.transaction_hash AS transactionHash, b.chain_id AS chainId, b.onchain_block_number AS onchainBlockNumber, b.onchain_block_hash AS onchainBlockHash, b.onchain_event_name AS onchainEventName, b.onchain_verified_at AS onchainVerifiedAt, b.onchain_verification_status AS onchainVerificationStatus, b.onchain_rental_status AS onchainRentalStatus, b.onchain_state_checked_at AS onchainStateCheckedAt, r.wallet_address AS renterWalletAddress FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN users r ON r.id = b.renter_id WHERE b.renter_id = ? OR l.owner_id = ? ORDER BY b.created_at DESC LIMIT 50").all(user.id, user.id);
    response.json({ bookings: rows });
  });
  router.post("/bookings", (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    if (!requireRole(database, user.id, "renter", response)) return;
    const { listingId } = request.body || {};
    const startTime = parseBookingTime(request.body?.startTime);
    const endTime = parseBookingTime(request.body?.endTime);
    if (!Number.isInteger(listingId) || !startTime || !endTime || new Date(startTime).getTime() <= Date.now() || new Date(endTime).getTime() <= new Date(startTime).getTime()) { response.status(400).json({ error: "invalid_booking" }); return; }
    const listing = database.db.prepare("SELECT id, owner_id AS ownerId, active FROM listings WHERE id = ?").get(listingId) as { id: number; ownerId: number; active: number } | undefined;
    if (!listing || !listing.active) { response.status(404).json({ error: "listing_not_available" }); return; }
    if (listing.ownerId === user.id) { response.status(400).json({ error: "owner_cannot_book_own_listing" }); return; }
    database.db.exec("BEGIN IMMEDIATE");
    try {
      const overlap = database.db.prepare("SELECT id FROM bookings WHERE listing_id = ? AND status IN ('REQUESTED', 'APPROVED') AND start_time < ? AND end_time > ? LIMIT 1").get(listingId, endTime, startTime);
      if (overlap) {
        database.db.exec("ROLLBACK");
        response.status(409).json({ error: "dates_unavailable" });
        return;
      }
      const result = database.db.prepare("INSERT INTO bookings (listing_id, renter_id, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, 'REQUESTED', ?)").run(listingId, user.id, startTime, endTime, new Date().toISOString());
      database.db.exec("COMMIT");
      response.status(201).json({ bookingId: Number(result.lastInsertRowid), status: "REQUESTED", onchain: false });
    } catch {
      database.db.exec("ROLLBACK");
      response.status(500).json({ error: "booking_creation_failed" });
    }
  });
  router.get("/bookings/:id", (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    const bookingId = Number(request.params.id);
    if (!positiveInteger(bookingId)) { response.status(400).json({ error: "invalid_booking_id" }); return; }
    const booking = database.db.prepare("SELECT b.id, b.listing_id AS listingId, l.name, l.owner_id AS ownerId, b.renter_id AS renterId, b.start_time AS startTime, b.end_time AS endTime, b.status, l.daily_fee AS dailyFee, l.deposit, b.onchain_rental_id AS onchainRentalId, b.transaction_hash AS transactionHash, b.chain_id AS chainId, b.onchain_block_number AS onchainBlockNumber, b.onchain_block_hash AS onchainBlockHash, b.onchain_event_name AS onchainEventName, b.onchain_verified_at AS onchainVerifiedAt, b.onchain_verification_status AS onchainVerificationStatus, b.onchain_rental_status AS onchainRentalStatus, b.onchain_state_checked_at AS onchainStateCheckedAt FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = ?").get(bookingId) as { ownerId: number; renterId: number; [key: string]: unknown } | undefined;
    if (!booking) { response.status(404).json({ error: "booking_not_found" }); return; }
    if (booking.ownerId !== user.id && booking.renterId !== user.id) { response.status(403).json({ error: "booking_access_denied" }); return; }
    response.json({ booking });
  });
  router.patch("/bookings/:id/status", (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    if (!requireRole(database, user.id, "owner", response)) return;
    const desired = request.body?.status;
    if (desired !== "APPROVED" && desired !== "REJECTED") { response.status(400).json({ error: "invalid_booking_status" }); return; }
    const bookingId = Number(request.params.id);
    if (!positiveInteger(bookingId)) { response.status(400).json({ error: "invalid_booking_id" }); return; }
    database.db.exec("BEGIN IMMEDIATE");
    try {
      const booking = database.db.prepare("SELECT b.id, b.listing_id AS listingId, b.start_time AS startTime, b.end_time AS endTime, b.status, l.owner_id AS ownerId FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = ?").get(bookingId) as { id: number; listingId: number; startTime: string; endTime: string; status: string; ownerId: number } | undefined;
      if (!booking) { database.db.exec("ROLLBACK"); response.status(404).json({ error: "booking_not_found" }); return; }
      if (booking.ownerId !== user.id) { database.db.exec("ROLLBACK"); response.status(403).json({ error: "booking_owner_required" }); return; }
      if (booking.status !== "REQUESTED") { database.db.exec("ROLLBACK"); response.status(409).json({ error: "invalid_booking_transition" }); return; }
      if (desired === "APPROVED") {
        const conflict = database.db.prepare("SELECT id FROM bookings WHERE listing_id = ? AND status = 'APPROVED' AND id != ? AND start_time < ? AND end_time > ? LIMIT 1").get(booking.listingId, booking.id, booking.endTime, booking.startTime);
        if (conflict) { database.db.exec("ROLLBACK"); response.status(409).json({ error: "dates_unavailable" }); return; }
      }
      database.db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(desired, bookingId);
      database.db.exec("COMMIT");
      response.json({ bookingId, status: desired });
    } catch {
      database.db.exec("ROLLBACK");
      response.status(500).json({ error: "booking_update_failed" });
    }
  });
  router.patch("/bookings/:id/onchain", async (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    if (!requireRole(database, user.id, "owner", response)) return;
    const bookingId = Number(request.params.id);
    const rentalId = typeof request.body?.rentalId === "string" ? request.body.rentalId.trim() : "";
    const transactionHash = typeof request.body?.transactionHash === "string" ? request.body.transactionHash.trim() : "";
    const chainId = request.body?.chainId;
    if (!positiveInteger(bookingId) || !/^\d+$/.test(rentalId) || !/^0x[a-fA-F0-9]{64}$/.test(transactionHash) || chainId !== configuredChainId) { response.status(400).json({ error: "invalid_onchain_record" }); return; }
    const booking = database.db.prepare("SELECT b.id, b.status, b.onchain_rental_id AS onchainRentalId, b.start_time AS startTime, b.end_time AS endTime, b.renter_id AS renterId, r.wallet_address AS renterAddress, l.id AS listingId, l.name AS equipmentName, l.owner_id AS ownerId, owner.wallet_address AS ownerAddress, l.daily_fee AS rentalFee, l.deposit FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN users r ON r.id = b.renter_id JOIN users owner ON owner.id = l.owner_id WHERE b.id = ?").get(bookingId) as { id: number; status: string; onchainRentalId: string | null; startTime: string; endTime: string; renterId: number; renterAddress: string | null; listingId: number; equipmentName: string; ownerId: number; ownerAddress: string | null; rentalFee: string; deposit: string } | undefined;
    if (!booking) { response.status(404).json({ error: "booking_not_found" }); return; }
    if (booking.ownerId !== user.id) { response.status(403).json({ error: "booking_owner_required" }); return; }
    if (booking.status !== "APPROVED") { response.status(409).json({ error: "booking_not_approved" }); return; }
    if (!booking.ownerAddress || !booking.renterAddress) { response.status(409).json({ error: "wallet_required_for_escrow" }); return; }
    const existingTransaction = database.db.prepare("SELECT booking_id AS bookingId, rental_id AS rentalId, chain_id AS chainId, block_number AS blockNumber, event_name AS eventName FROM verified_onchain_transactions WHERE transaction_hash = ?").get(transactionHash) as { bookingId: number; rentalId: string; chainId: number; blockNumber: number; eventName: string } | undefined;
    if (existingTransaction) {
      if (existingTransaction.bookingId === bookingId && existingTransaction.rentalId === rentalId) {
        response.json({ bookingId, rentalId, transactionHash, chainId, status: "CREATED", verified: true, blockNumber: existingTransaction.blockNumber });
      } else response.status(409).json({ error: "transaction_already_recorded" });
      return;
    }
    if (booking.onchainRentalId) { response.status(409).json({ error: "onchain_record_exists" }); return; }
    let verified;
    try {
      verified = await verifyRental({
        bookingId,
        rentalId,
        transactionHash,
        chainId,
        contractAddress: process.env.RENTAL_ESCROW_ADDRESS || "",
        ownerAddress: booking.ownerAddress,
        renterAddress: booking.renterAddress,
        equipmentId: `listing-${booking.listingId}`,
        equipmentName: booking.equipmentName,
        rentalFee: booking.rentalFee,
        deposit: booking.deposit,
        startTime: booking.startTime,
        endTime: booking.endTime,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "transaction_verification_failed";
      const operational = ["blockchain_not_configured", "wrong_chain", "rpc_unavailable", "rpc_timeout"].includes(code);
      response.status(operational ? 503 : 422).json({ error: code });
      return;
    }
    database.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = database.db.prepare("SELECT booking_id AS bookingId FROM verified_onchain_transactions WHERE transaction_hash = ? OR booking_id = ?").get(transactionHash, bookingId) as { bookingId: number } | undefined;
      if (duplicate) {
        database.db.exec("ROLLBACK");
        if (duplicate.bookingId === bookingId) response.json({ bookingId, rentalId, transactionHash, chainId, status: "CREATED", verified: true });
        else response.status(409).json({ error: "transaction_already_recorded" });
        return;
      }
      const verifiedAt = new Date().toISOString();
      const update =       database.db.prepare("UPDATE bookings SET onchain_rental_id = ?, transaction_hash = ?, chain_id = ?, onchain_block_number = ?, onchain_block_hash = ?, onchain_event_name = ?, onchain_verified_at = ?, onchain_verification_status = 'VERIFIED' WHERE id = ? AND onchain_rental_id IS NULL").run(rentalId, transactionHash, verified.chainId, verified.blockNumber, verified.blockHash, verified.eventName, verifiedAt, bookingId);
      if (update.changes !== 1) { database.db.exec("ROLLBACK"); response.status(409).json({ error: "onchain_record_exists" }); return; }
      database.db.prepare("INSERT INTO verified_onchain_transactions (transaction_hash, booking_id, rental_id, chain_id, block_number, event_name, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(transactionHash, bookingId, rentalId, verified.chainId, verified.blockNumber, verified.eventName, verifiedAt);
      database.db.prepare("UPDATE bookings SET onchain_rental_status = 'CREATED', onchain_state_checked_at = ? WHERE id = ?").run(verifiedAt, bookingId);
      database.db.exec("COMMIT");
      response.json({ bookingId, rentalId, transactionHash, chainId: verified.chainId, status: "CREATED", verified: true, blockNumber: verified.blockNumber });
    } catch {
      database.db.exec("ROLLBACK");
      response.status(500).json({ error: "onchain_record_failed" });
    }
  });
  router.get("/bookings/:id/onchain", (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    const bookingId = Number(request.params.id);
    if (!positiveInteger(bookingId)) { response.status(400).json({ error: "invalid_booking_id" }); return; }
    const booking = database.db.prepare("SELECT b.id, b.onchain_rental_id AS rentalId, b.transaction_hash AS transactionHash, b.chain_id AS chainId, b.onchain_block_number AS blockNumber, b.onchain_block_hash AS blockHash, b.onchain_event_name AS eventName, b.onchain_verified_at AS verifiedAt, b.onchain_verification_status AS verificationStatus, b.onchain_rental_status AS status, b.onchain_state_checked_at AS stateCheckedAt, b.renter_id AS renterId, l.owner_id AS ownerId FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = ?").get(bookingId) as { id: number; renterId: number; ownerId: number; [key: string]: unknown } | undefined;
    if (!booking) { response.status(404).json({ error: "booking_not_found" }); return; }
    if (booking.ownerId !== user.id && booking.renterId !== user.id) { response.status(403).json({ error: "booking_access_denied" }); return; }
    if (!booking.rentalId || !booking.transactionHash) { response.status(404).json({ error: "onchain_record_missing" }); return; }
    response.json({ onchain: { rentalId: booking.rentalId, transactionHash: booking.transactionHash, chainId: booking.chainId, blockNumber: booking.blockNumber, blockHash: booking.blockHash, eventName: booking.eventName, verifiedAt: booking.verifiedAt, verificationStatus: booking.verificationStatus, status: booking.status, stateCheckedAt: booking.stateCheckedAt } });
  });
  router.post("/bookings/:id/onchain/reconcile", async (request, response) => {
    const user = currentUser(database, request);
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    const bookingId = Number(request.params.id);
     const booking = database.db.prepare("SELECT b.id, b.onchain_rental_id AS rentalId, b.transaction_hash AS transactionHash, b.chain_id AS chainId, b.start_time AS startTime, b.end_time AS endTime, b.renter_id AS renterId, r.wallet_address AS renterAddress, owner.wallet_address AS ownerAddress, l.id AS listingId, l.name AS equipmentName, l.owner_id AS ownerId, l.daily_fee AS rentalFee, l.deposit, b.onchain_rental_status AS onchainRentalStatus FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN users r ON r.id = b.renter_id JOIN users owner ON owner.id = l.owner_id WHERE b.id = ?").get(bookingId) as { id: number; rentalId: string | null; transactionHash: string | null; chainId: number | null; startTime: string; endTime: string; renterId: number; renterAddress: string | null; ownerAddress: string | null; listingId: number; equipmentName: string; ownerId: number; rentalFee: string; deposit: string; onchainRentalStatus: string | null } | undefined;
    if (!booking) { response.status(404).json({ error: "booking_not_found" }); return; }
     if (booking.ownerId !== user.id && booking.renterId !== user.id) { response.status(403).json({ error: "booking_access_denied" }); return; }
    if (!booking.rentalId || !booking.transactionHash || !booking.chainId || !booking.ownerAddress || !booking.renterAddress) { response.status(409).json({ error: "onchain_record_missing" }); return; }
    try {
      const expected = { bookingId, rentalId: booking.rentalId, transactionHash: booking.transactionHash, chainId: booking.chainId, contractAddress: process.env.RENTAL_ESCROW_ADDRESS || "", ownerAddress: booking.ownerAddress, renterAddress: booking.renterAddress, equipmentId: `listing-${booking.listingId}`, equipmentName: booking.equipmentName, rentalFee: booking.rentalFee, deposit: booking.deposit, startTime: booking.startTime, endTime: booking.endTime };
       const snapshot = await reconcileRental(expected);
      const verifiedAt = new Date().toISOString();
      database.db.exec("BEGIN IMMEDIATE");
      try {
        database.db.prepare("UPDATE bookings SET chain_id = ?, onchain_block_number = ?, onchain_block_hash = ?, onchain_event_name = 'RentalCreated', onchain_verified_at = ?, onchain_verification_status = 'VERIFIED', onchain_rental_status = ?, onchain_state_checked_at = ? WHERE id = ?").run(booking.chainId, snapshot.blockNumber, snapshot.blockHash, verifiedAt, snapshot.status, verifiedAt, bookingId);
        database.db.prepare("UPDATE verified_onchain_transactions SET block_number = ?, verified_at = ? WHERE transaction_hash = ?").run(snapshot.blockNumber, verifiedAt, booking.transactionHash);
        database.db.exec("COMMIT");
      } catch {
        database.db.exec("ROLLBACK");
        response.status(500).json({ error: "onchain_reconcile_failed" });
        return;
      }
      response.json({ bookingId, rentalId: booking.rentalId, transactionHash: booking.transactionHash, verified: true, status: snapshot.status, blockNumber: snapshot.blockNumber });
    } catch (error) {
      const code = error instanceof Error ? error.message : "transaction_verification_failed";
       if (["transaction_not_found", "receipt_not_found", "transaction_reorged", "wrong_contract", "unexpected_transaction_sender", "unexpected_transaction_call", "rental_state_mismatch", "rental_created_event_missing", "rental_created_event_mismatch"].includes(code)) {
        database.db.prepare("UPDATE bookings SET onchain_verification_status = 'UNVERIFIED', onchain_state_checked_at = ? WHERE id = ?").run(new Date().toISOString(), bookingId);
      }
      response.status(422).json({ error: code });
    }
  });
  return router;
}
