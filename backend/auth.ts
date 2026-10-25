import crypto from "node:crypto";
import express from "express";
import { getAddress, isAddress, verifyMessage } from "ethers";
import { createPasswordHash, getUserRoles, hashToken, type AuthDatabase, type DbUser, type UserRole, verifyPassword } from "./db.js";
import { createVerificationMailer, type VerificationMailer } from "./email.js";

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = "eventrent_session";
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function configuredOrigin(): string {
  return process.env.APP_ORIGIN?.trim() || "http://localhost:5173";
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 128;
}

function parseAddress(value: unknown): string | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null;
}

function decodeCookieValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function cookieValue(request: express.Request): string | null {
  const header = request.get("cookie") || "";
  const entry = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? decodeCookieValue(entry.slice(SESSION_COOKIE.length + 1)) : null;
}

function setSessionCookie(response: express.Response, token: string): void {
  const secure = process.env.NODE_ENV === "production";
  const attributes = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(response: express.Response): void {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}

function userResponse(user: DbUser) {
  return { id: user.id, email: user.email, walletAddress: user.walletAddress, emailVerified: user.emailVerified, roles: user.roles };
}

function findUser(database: AuthDatabase, id: number): DbUser | null {
  const row = database.db.prepare("SELECT id, email, wallet_address AS walletAddress, email_verified AS emailVerified FROM users WHERE id = ?").get(id) as { id: number; email: string | null; walletAddress: string | null; emailVerified: number } | undefined;
  return row ? { ...row, emailVerified: row.emailVerified === 1, roles: getUserRoles(database, row.id) } : null;
}

function createSession(database: AuthDatabase, userId: number, response: express.Response): void {
  const token = randomToken();
  database.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hashToken(token), userId, Date.now() + SESSION_TTL_MS, new Date().toISOString());
  setSessionCookie(response, token);
}

function getSessionUser(database: AuthDatabase, request: express.Request): DbUser | null {
  const token = cookieValue(request);
  if (!token) return null;
  const row = database.db.prepare("SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ?").get(hashToken(token)) as { userId: number; expiresAt: number } | undefined;
  if (!row || row.expiresAt <= Date.now()) {
    if (row) database.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  return findUser(database, row.userId);
}

function rejectCrossOrigin(request: express.Request, response: express.Response): boolean {
  const origin = request.get("origin");
  if (origin && origin !== configuredOrigin()) {
    response.status(403).json({ error: "origin_not_allowed" });
    return true;
  }
  return false;
}

/**
 * Retained only for compatibility with the historical test fixtures. The
 * application server mounts createAuthRouter below, not this legacy router.
 */
export function createLegacyEmailAuthRouter(database: AuthDatabase, mailer: VerificationMailer = createVerificationMailer()): express.Router {
  const router = express.Router();
  const failedLogins = new Map<string, { count: number; resetAt: number }>();
  const abuseAttempts = new Map<string, { count: number; resetAt: number }>();
  const abuseRateLimit = (request: express.Request, response: express.Response, action: string, limit = 10): boolean => {
    const key = `${action}:${request.ip}`;
    const now = Date.now();
    const current = abuseAttempts.get(key);
    if (current && current.resetAt > now && current.count >= limit) {
      response.status(429).json({ error: "too_many_requests" });
      return true;
    }
    if (!current || current.resetAt <= now) abuseAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    else current.count += 1;
    return false;
  };
  const loginRateLimit = (request: express.Request, response: express.Response): boolean => {
    const key = `${request.ip}:${normalizeEmail(request.body?.email) || "invalid"}`;
    const now = Date.now();
    const current = failedLogins.get(key);
    if (current && current.resetAt > now && current.count >= 10) {
      response.status(429).json({ error: "too_many_attempts" });
      return true;
    }
    return false;
  };
  const recordFailedLogin = (request: express.Request) => {
    const key = `${request.ip}:${normalizeEmail(request.body?.email) || "invalid"}`;
    const now = Date.now();
    const current = failedLogins.get(key);
    if (!current || current.resetAt <= now) failedLogins.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    else current.count += 1;
  };
  const clearFailedLogin = (request: express.Request) => {
    failedLogins.delete(`${request.ip}:${normalizeEmail(request.body?.email) || "invalid"}`);
  };
  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "POST" && rejectCrossOrigin(request, response)) return;
    next();
  });

  router.post("/register", async (request, response) => {
    if (abuseRateLimit(request, response, "register")) return;
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    if (!email || !validPassword(password)) {
      response.status(400).json({ error: "invalid_registration" });
      return;
    }
    try {
      const result = database.db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)").run(email, createPasswordHash(password), new Date().toISOString());
      const user = findUser(database, Number(result.lastInsertRowid));
      if (!user) throw new Error("user_creation_failed");
      const rawToken = randomToken(32);
      const expiresAt = Date.now() + VERIFICATION_TTL_MS;
      database.db.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hashToken(rawToken), user.id, expiresAt, Date.now());
      try {
        await mailer(email, `${configuredOrigin()}/#/verify-email?token=${rawToken}`);
      } catch (mailError) {
        database.db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(user.id);
        database.db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
        if (mailError instanceof Error && mailError.message === "smtp_not_configured") {
          response.status(503).json({ error: "email_delivery_unavailable" });
          return;
        }
        response.status(503).json({ error: "email_delivery_failed" });
        return;
      }
      response.status(201).json({ authenticated: false, verificationRequired: true, user: userResponse(user), expiresAt: new Date(expiresAt).toISOString() });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        response.status(409).json({ error: "email_already_registered" });
        return;
      }
      response.status(500).json({ error: "registration_failed" });
    }
  });

  router.post("/login", (request, response) => {
    if (loginRateLimit(request, response)) return;
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    type LoginRow = { id: number; email: string | null; walletAddress: string | null; passwordHash: string | null; emailVerified: number };
    const row = email ? database.db.prepare("SELECT id, email, password_hash AS passwordHash, wallet_address AS walletAddress, email_verified AS emailVerified FROM users WHERE email = ?").get(email) as LoginRow | undefined : undefined;
    if (!row || !row.passwordHash || typeof password !== "string" || !verifyPassword(password, row.passwordHash)) {
      recordFailedLogin(request);
      response.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const user = findUser(database, row.id);
    if (user?.email && !user.emailVerified) {
      response.status(403).json({ error: "email_not_verified" });
      return;
    }
    clearFailedLogin(request);
    createSession(database, row.id, response);
    if (!user) { response.status(500).json({ error: "authentication_failed" }); return; }
    response.json({ authenticated: true, user: userResponse(user) });
  });

  router.post("/password-reset/request", async (request, response) => {
    if (abuseRateLimit(request, response, "password-reset")) return;
    const email = normalizeEmail(request.body?.email);
    if (!email) {
      response.json({ sent: true });
      return;
    }
    const row = database.db.prepare("SELECT id, email_verified AS emailVerified FROM users WHERE email = ?").get(email) as { id: number; emailVerified: number } | undefined;
    if (!row || row.emailVerified !== 1) {
      response.json({ sent: true });
      return;
    }
    const rawToken = randomToken(32);
    database.db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(row.id);
    database.db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hashToken(rawToken), row.id, Date.now() + PASSWORD_RESET_TTL_MS, Date.now());
    try {
      await mailer(email, `${configuredOrigin()}/#/reset-password?token=${rawToken}`);
    } catch {
      database.db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(row.id);
    }
    response.json({ sent: true });
  });

  router.post("/password-reset/confirm", (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token.trim() : "";
    const password = request.body?.password;
    if (!token || !validPassword(password)) {
      response.status(400).json({ error: "invalid_password_reset" });
      return;
    }
    const record = database.db.prepare("SELECT user_id AS userId, expires_at AS expiresAt FROM password_reset_tokens WHERE token_hash = ?").get(hashToken(token)) as { userId: number; expiresAt: number } | undefined;
    if (!record || record.expiresAt <= Date.now()) {
      if (record) database.db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(hashToken(token));
      response.status(400).json({ error: "invalid_or_expired_password_reset" });
      return;
    }
    database.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(createPasswordHash(password), record.userId);
    database.db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(hashToken(token));
    database.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(record.userId);
    response.json({ reset: true });
  });

  router.post("/verify-email", (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token.trim() : "";
    const record = database.db.prepare("SELECT user_id AS userId, expires_at AS expiresAt FROM email_verification_tokens WHERE token_hash = ?").get(hashToken(token)) as { userId: number; expiresAt: number } | undefined;
    if (!token || !record || record.expiresAt <= Date.now()) {
      if (record) database.db.prepare("DELETE FROM email_verification_tokens WHERE token_hash = ?").run(hashToken(token));
      response.status(400).json({ error: "invalid_or_expired_verification" });
      return;
    }
    database.db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(record.userId);
    database.db.prepare("DELETE FROM email_verification_tokens WHERE token_hash = ?").run(hashToken(token));
    const user = findUser(database, record.userId);
    if (!user) { response.status(400).json({ error: "invalid_or_expired_verification" }); return; }
    createSession(database, user.id, response);
    response.json({ authenticated: true, user: userResponse(user) });
  });

  router.post("/verify-email/resend", async (request, response) => {
    if (abuseRateLimit(request, response, "verification-resend")) return;
    const email = normalizeEmail(request.body?.email);
    if (!email) { response.status(400).json({ error: "invalid_email" }); return; }
    const row = database.db.prepare("SELECT id, email_verified AS emailVerified FROM users WHERE email = ?").get(email) as { id: number; emailVerified: number } | undefined;
    if (!row || row.emailVerified === 1) {
      response.json({ sent: true });
      return;
    }
    const recent = database.db.prepare("SELECT created_at AS createdAt FROM email_verification_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id) as { createdAt: number } | undefined;
    if (recent && recent.createdAt + RESEND_COOLDOWN_MS > Date.now()) {
      response.status(429).json({ error: "verification_resend_cooldown" });
      return;
    }
    const rawToken = randomToken(32);
    const expiresAt = Date.now() + VERIFICATION_TTL_MS;
    database.db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(row.id);
    database.db.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hashToken(rawToken), row.id, expiresAt, Date.now());
    try {
      await mailer(email, `${configuredOrigin()}/#/verify-email?token=${rawToken}`);
    } catch {
      database.db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(row.id);
      response.status(503).json({ error: "email_delivery_failed" });
      return;
    }
    response.json({ sent: true });
  });

  router.post("/nonce", (request, response) => {
    if (abuseRateLimit(request, response, "wallet-nonce")) return;
    const address = parseAddress(request.body?.address);
    if (!address) {
      response.status(400).json({ error: "invalid_address" });
      return;
    }
    const nonce = randomToken(24);
    const expiresAt = Date.now() + NONCE_TTL_MS;
    const message = [`${configuredOrigin()} wants you to sign in to EventRent.`, "", "Sign in with your Ethereum account:", address, "", "This signature proves wallet ownership. It does not authorize a blockchain transaction.", `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`, `Expiration Time: ${new Date(expiresAt).toISOString()}`].join("\n");
    database.db.prepare("DELETE FROM auth_nonces WHERE expires_at <= ?").run(Date.now());
    database.db.prepare("INSERT INTO auth_nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)").run(nonce, address, message, expiresAt);
    response.json({ nonce, message, expiresAt: new Date(expiresAt).toISOString() });
  });

  router.post("/verify", (request, response) => {
    const address = parseAddress(request.body?.address);
    const nonce = typeof request.body?.nonce === "string" ? request.body.nonce : "";
    const signature = typeof request.body?.signature === "string" ? request.body.signature : "";
    const record = database.db.prepare("SELECT nonce, address, message, expires_at AS expiresAt FROM auth_nonces WHERE nonce = ?").get(nonce) as { nonce: string; address: string; message: string; expiresAt: number } | undefined;
    database.db.prepare("DELETE FROM auth_nonces WHERE nonce = ?").run(nonce);
    if (!address || !signature || !record || record.expiresAt <= Date.now() || record.address.toLowerCase() !== address.toLowerCase()) {
      response.status(401).json({ error: "invalid_or_expired_challenge" });
      return;
    }
    try {
      if (getAddress(verifyMessage(record.message, signature)).toLowerCase() !== address.toLowerCase()) throw new Error("invalid");
    } catch {
      response.status(401).json({ error: "invalid_signature" });
      return;
    }
    let user = database.db.prepare("SELECT id FROM users WHERE wallet_address = ?").get(address) as { id: number } | undefined;
    if (!user) {
      const result = database.db.prepare("INSERT INTO users (wallet_address, email_verified, created_at) VALUES (?, 1, ?)").run(address, new Date().toISOString());
      user = { id: Number(result.lastInsertRowid) };
    }
    const walletUser = findUser(database, user.id);
    if (!walletUser) {
      response.status(500).json({ error: "authentication_failed" });
      return;
    }
    createSession(database, walletUser.id, response);
    response.json({ authenticated: true, user: userResponse(walletUser) });
  });

  router.get("/session", (request, response) => {
    const user = getSessionUser(database, request);
    if (!user) {
      response.status(401).json({ authenticated: false });
      return;
    }
    response.json({ authenticated: true, user: userResponse(user) });
  });

  router.post("/role", (request, response) => {
    const user = getSessionUser(database, request);
    const role = request.body?.role;
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    if (role !== "renter" && role !== "owner") { response.status(400).json({ error: "invalid_role" }); return; }
    database.db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role, created_at) VALUES (?, ?, ?)").run(user.id, role as UserRole, new Date().toISOString());
    const updatedUser = findUser(database, user.id);
    if (!updatedUser) { response.status(500).json({ error: "authentication_failed" }); return; }
    response.json({ user: userResponse(updatedUser) });
  });

  router.post("/logout", (request, response) => {
    const token = cookieValue(request);
    if (token) database.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    clearSessionCookie(response);
    response.json({ authenticated: false });
  });

  return router;
}

/**
 * Authentication used by the running application. The local MVP intentionally
 * exposes wallet authentication only so starting the backend never requires
 * SMTP or email-verification configuration.
 */
export function createAuthRouter(database: AuthDatabase): express.Router {
  const router = express.Router();
  const abuseAttempts = new Map<string, { count: number; resetAt: number }>();

  const abuseRateLimit = (request: express.Request, response: express.Response): boolean => {
    const key = `${request.path}:${request.ip}`;
    const now = Date.now();
    const current = abuseAttempts.get(key);
    if (current && current.resetAt > now && current.count >= 10) {
      response.status(429).json({ error: "too_many_requests" });
      return true;
    }
    if (!current || current.resetAt <= now) abuseAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    else current.count += 1;
    return false;
  };

  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "POST" && rejectCrossOrigin(request, response)) return;
    next();
  });

  router.post("/nonce", (request, response) => {
    if (abuseRateLimit(request, response)) return;
    const address = parseAddress(request.body?.address);
    if (!address) {
      response.status(400).json({ error: "invalid_address" });
      return;
    }
    const nonce = randomToken(24);
    const expiresAt = Date.now() + NONCE_TTL_MS;
    const message = [`${configuredOrigin()} wants you to sign in to EventRent.`, "", "Sign in with your Ethereum account:", address, "", "This signature proves wallet ownership. It does not authorize a blockchain transaction.", `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`, `Expiration Time: ${new Date(expiresAt).toISOString()}`].join("\n");
    database.db.prepare("DELETE FROM auth_nonces WHERE expires_at <= ?").run(Date.now());
    database.db.prepare("INSERT INTO auth_nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)").run(nonce, address, message, expiresAt);
    response.json({ nonce, message, expiresAt: new Date(expiresAt).toISOString() });
  });

  router.post("/verify", (request, response) => {
    const address = parseAddress(request.body?.address);
    const nonce = typeof request.body?.nonce === "string" ? request.body.nonce : "";
    const signature = typeof request.body?.signature === "string" ? request.body.signature : "";
    const record = database.db.prepare("SELECT nonce, address, message, expires_at AS expiresAt FROM auth_nonces WHERE nonce = ?").get(nonce) as { nonce: string; address: string; message: string; expiresAt: number } | undefined;
    database.db.prepare("DELETE FROM auth_nonces WHERE nonce = ?").run(nonce);
    if (!address || !signature || !record || record.expiresAt <= Date.now() || record.address.toLowerCase() !== address.toLowerCase()) {
      response.status(401).json({ error: "invalid_or_expired_challenge" });
      return;
    }
    try {
      if (getAddress(verifyMessage(record.message, signature)).toLowerCase() !== address.toLowerCase()) throw new Error("invalid");
    } catch {
      response.status(401).json({ error: "invalid_signature" });
      return;
    }
    let user = database.db.prepare("SELECT id FROM users WHERE wallet_address = ?").get(address) as { id: number } | undefined;
    if (!user) {
      const result = database.db.prepare("INSERT INTO users (wallet_address, email_verified, created_at) VALUES (?, 1, ?)").run(address, new Date().toISOString());
      user = { id: Number(result.lastInsertRowid) };
    }
    const walletUser = findUser(database, user.id);
    if (!walletUser) {
      response.status(500).json({ error: "authentication_failed" });
      return;
    }
    createSession(database, walletUser.id, response);
    response.json({ authenticated: true, user: userResponse(walletUser) });
  });

  router.get("/session", (request, response) => {
    const user = getSessionUser(database, request);
    if (!user) {
      response.status(401).json({ authenticated: false });
      return;
    }
    response.json({ authenticated: true, user: userResponse(user) });
  });

  router.post("/role", (request, response) => {
    const user = getSessionUser(database, request);
    const role = request.body?.role;
    if (!user) { response.status(401).json({ error: "authentication_required" }); return; }
    if (role !== "renter" && role !== "owner") { response.status(400).json({ error: "invalid_role" }); return; }
    database.db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role, created_at) VALUES (?, ?, ?)").run(user.id, role as UserRole, new Date().toISOString());
    const updatedUser = findUser(database, user.id);
    if (!updatedUser) { response.status(500).json({ error: "authentication_failed" }); return; }
    response.json({ user: userResponse(updatedUser) });
  });

  router.post("/logout", (request, response) => {
    const token = cookieValue(request);
    if (token) database.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    clearSessionCookie(response);
    response.json({ authenticated: false });
  });

  return router;
}
