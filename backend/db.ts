import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DbUser = {
  id: number;
  email: string | null;
  walletAddress: string | null;
  emailVerified: boolean;
  roles: UserRole[];
};

export type UserRole = "renter" | "owner";

export type AuthDatabase = {
  db: DatabaseSync;
  close: () => void;
};

export function openAuthDatabase(databasePath = process.env.AUTH_DB_PATH || path.join(process.cwd(), "backend", "eventrent-auth.sqlite")): AuthDatabase {
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      wallet_address TEXT UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_nonces (
      nonce TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('renter', 'owner')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, role)
    );
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      image_url TEXT,
      condition TEXT NOT NULL,
      daily_fee TEXT NOT NULL,
      deposit TEXT NOT NULL,
      location TEXT NOT NULL,
      pickup_details TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      renter_id INTEGER NOT NULL REFERENCES users(id),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'REQUESTED',
      onchain_rental_id TEXT,
      transaction_hash TEXT,
      chain_id INTEGER,
      onchain_block_number INTEGER,
      onchain_block_hash TEXT,
      onchain_event_name TEXT,
      onchain_verified_at TEXT,
      onchain_verification_status TEXT NOT NULL DEFAULT 'VERIFIED',
      onchain_rental_status TEXT,
      onchain_state_checked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookings_listing_dates ON bookings(listing_id, start_time, end_time);
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);
  const verificationColumns = db.prepare("PRAGMA table_info(email_verification_tokens)").all() as Array<{ name: string }>;
  if (!verificationColumns.some((column) => column.name === "created_at")) db.exec("ALTER TABLE email_verification_tokens ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  const bookingColumns = db.prepare("PRAGMA table_info(bookings)").all() as Array<{ name: string }>;
  if (!bookingColumns.some((column) => column.name === "chain_id")) db.exec("ALTER TABLE bookings ADD COLUMN chain_id INTEGER");
  if (!bookingColumns.some((column) => column.name === "onchain_block_number")) db.exec("ALTER TABLE bookings ADD COLUMN onchain_block_number INTEGER");
  if (!bookingColumns.some((column) => column.name === "onchain_block_hash")) db.exec("ALTER TABLE bookings ADD COLUMN onchain_block_hash TEXT");
  if (!bookingColumns.some((column) => column.name === "onchain_event_name")) db.exec("ALTER TABLE bookings ADD COLUMN onchain_event_name TEXT");
  if (!bookingColumns.some((column) => column.name === "onchain_verified_at")) db.exec("ALTER TABLE bookings ADD COLUMN onchain_verified_at TEXT");
  if (!bookingColumns.some((column) => column.name === "onchain_verification_status")) db.exec("ALTER TABLE bookings ADD COLUMN onchain_verification_status TEXT NOT NULL DEFAULT 'VERIFIED'");
  if (!bookingColumns.some((column) => column.name === "onchain_rental_status")) db.exec("ALTER TABLE bookings ADD COLUMN onchain_rental_status TEXT");
  if (!bookingColumns.some((column) => column.name === "onchain_state_checked_at")) db.exec("ALTER TABLE bookings ADD COLUMN onchain_state_checked_at TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS verified_onchain_transactions (
      transaction_hash TEXT PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      rental_id TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      verified_at TEXT NOT NULL
    );
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS verified_onchain_transactions_booking_id ON verified_onchain_transactions(booking_id)");
  const count = db.prepare("SELECT COUNT(*) AS count FROM listings").get() as { count: number };
  if (count.count === 0) {
    const now = new Date().toISOString();
    const demo = db.prepare("SELECT id FROM users WHERE email = ?").get("demo-owner@eventrent.local") as { id: number } | undefined;
    const ownerId = demo?.id ?? Number(db.prepare("INSERT INTO users (email, email_verified, created_at) VALUES (?, 1, ?)").run("demo-owner@eventrent.local", now).lastInsertRowid);
    const insert = db.prepare("INSERT INTO listings (owner_id, name, category, description, image_url, condition, daily_fee, deposit, location, pickup_details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(ownerId, "Compact Speaker System", "Sound", "Paired speakers for ceremonies, small stages, and private events.", null, "Good condition", "0.02", "0.08", "Local pickup", "Pickup details are arranged with the owner.", now, now);
    insert.run(ownerId, "Venue Projector", "Projection", "Bright projection for presentations, screenings, and event visuals.", null, "Good condition", "0.03", "0.10", "Local pickup", "Pickup details are arranged with the owner.", now, now);
  }
  db.exec(`
    INSERT OR IGNORE INTO user_roles (user_id, role, created_at)
    SELECT id, 'renter', created_at FROM users;
    INSERT OR IGNORE INTO user_roles (user_id, role, created_at)
    SELECT id, 'owner', created_at FROM users;
  `);
  return { db, close: () => db.close() };
}

export function findSessionUser(database: AuthDatabase, tokenHash: string): DbUser | null {
  const row = database.db.prepare("SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ?").get(tokenHash) as { userId: number; expiresAt: number } | undefined;
  if (!row || row.expiresAt <= Date.now()) return null;
  const user = database.db.prepare("SELECT id, email, wallet_address AS walletAddress, email_verified AS emailVerified FROM users WHERE id = ?").get(row.userId) as { id: number; email: string | null; walletAddress: string | null; emailVerified: number } | undefined;
  if (!user) return null;
  const roles = database.db.prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role").all(user.id) as Array<{ role: UserRole }>;
  return { ...user, emailVerified: user.emailVerified === 1, roles: roles.map((entry) => entry.role) };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getUserRoles(database: AuthDatabase, userId: number): UserRole[] {
  const rows = database.db.prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role").all(userId) as Array<{ role: UserRole }>;
  return rows.map((row) => row.role);
}

export function hasUserRole(database: AuthDatabase, userId: number, role: UserRole): boolean {
  return Boolean(database.db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?").get(userId, role));
}

export function createPasswordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, expected] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer);
}
