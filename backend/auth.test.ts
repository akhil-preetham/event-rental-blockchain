import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { test } from "node:test";
import express from "express";
import http from "node:http";
import { Wallet } from "ethers";
import { createAuthRouter } from "./auth.js";
import { openAuthDatabase } from "./db.js";

async function startTestServer() {
  const database = openAuthDatabase(":memory:");
  const verificationTokens: string[] = [];
  const app = express();
  app.use(express.json());
  app.use("/auth", createAuthRouter(database, async (_email, url) => {
    verificationTokens.push(url.match(/[?&]token=([^&]+)/)?.[1] || "");
  }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, database, verificationTokens, baseUrl: `http://127.0.0.1:${address.port}` };
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

test("registers an email account and restores its session", async () => {
  const { server, database, verificationTokens, baseUrl } = await startTestServer();
  try {
    const response = await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "Person@Example.com", password: "correct horse battery staple" }) });
    assert.equal(response.status, 201);
    const body = await response.json() as { user: { email: string }; verificationRequired: boolean };
    assert.equal(body.user.email, "person@example.com");
    assert.equal(body.verificationRequired, true);
    assert.equal((await request(baseUrl, "/auth/session")).status, 401);
    const verified = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[0] }) });
    const session = await request(baseUrl, "/auth/session", { headers: { cookie: cookie(verified) } });
    assert.equal(session.status, 200);
    assert.equal((await session.json() as { authenticated: boolean }).authenticated, true);
  } finally {
    database.close();
    server.close();
  }
});

test("stores a selected workspace role without trusting the frontend for authentication", async () => {
  const { server, database, verificationTokens, baseUrl } = await startTestServer();
  try {
    await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "role@example.com", password: "correct horse battery staple" }) });
    const verified = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[0] }) });
    const sessionCookie = cookie(verified);
    const invalid = await request(baseUrl, "/auth/role", { method: "POST", headers: { cookie: sessionCookie }, body: JSON.stringify({ role: "admin" }) });
    assert.equal(invalid.status, 400);
    const selected = await request(baseUrl, "/auth/role", { method: "POST", headers: { cookie: sessionCookie }, body: JSON.stringify({ role: "owner" }) });
    assert.equal(selected.status, 200);
    assert.deepEqual((await selected.json() as { user: { roles: string[] } }).user.roles, ["owner"]);
  } finally {
    database.close();
    server.close();
  }
});

test("rejects duplicate emails without exposing password data", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const payload = JSON.stringify({ email: "same@example.com", password: "correct horse battery staple" });
    assert.equal((await request(baseUrl, "/auth/register", { method: "POST", body: payload })).status, 201);
    const duplicate = await request(baseUrl, "/auth/register", { method: "POST", body: payload });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "email_already_registered" });
  } finally {
    database.close();
    server.close();
  }
});

test("verifies passwords and rejects invalid email logins", async () => {
  const { server, database, verificationTokens, baseUrl } = await startTestServer();
  try {
    await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "login@example.com", password: "correct horse battery staple" }) });
    await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[0] }) });
    const valid = await request(baseUrl, "/auth/login", { method: "POST", body: JSON.stringify({ email: "LOGIN@example.com", password: "correct horse battery staple" }) });
    assert.equal(valid.status, 200);
    const invalid = await request(baseUrl, "/auth/login", { method: "POST", body: JSON.stringify({ email: "login@example.com", password: "wrong password here" }) });
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: "invalid_credentials" });
  } finally {
    database.close();
    server.close();
  }
});

test("supports single-use password resets and revokes existing sessions", async () => {
  const { server, database, verificationTokens, baseUrl } = await startTestServer();
  try {
    await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "reset@example.com", password: "correct horse battery staple" }) });
    const verified = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[0] }) });
    const sessionCookie = cookie(verified);
    await request(baseUrl, "/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email: "reset@example.com" }) });
    const resetToken = verificationTokens[1];
    assert.ok(resetToken);
    const reset = await request(baseUrl, "/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token: resetToken, password: "new correct horse staple" }) });
    assert.equal(reset.status, 200);
    assert.equal((await request(baseUrl, "/auth/session", { headers: { cookie: sessionCookie } })).status, 401);
    const login = await request(baseUrl, "/auth/login", { method: "POST", body: JSON.stringify({ email: "reset@example.com", password: "new correct horse staple" }) });
    assert.equal(login.status, 200);
    const replay = await request(baseUrl, "/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token: resetToken, password: "another password" }) });
    assert.equal(replay.status, 400);
  } finally {
    database.close();
    server.close();
  }
});

test("rate-limits repeated invalid password attempts", async () => {
  const { server, database, verificationTokens, baseUrl } = await startTestServer();
  try {
    await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "limited@example.com", password: "correct horse battery staple" }) });
    await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[0] }) });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await request(baseUrl, "/auth/login", { method: "POST", body: JSON.stringify({ email: "limited@example.com", password: "wrong password here" }) })).status, 401);
    }
    assert.equal((await request(baseUrl, "/auth/login", { method: "POST", body: JSON.stringify({ email: "limited@example.com", password: "wrong password here" }) })).status, 429);
  } finally {
    database.close();
    server.close();
  }
});

test("logs out and invalidates a persistent session", async () => {
  const { server, database, verificationTokens, baseUrl } = await startTestServer();
  try {
    await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "logout@example.com", password: "correct horse battery staple" }) });
    const login = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[0] }) });
    const sessionCookie = cookie(login);
    const logout = await request(baseUrl, "/auth/logout", { method: "POST", headers: { cookie: sessionCookie } });
    assert.equal(logout.status, 200);
    assert.equal((await request(baseUrl, "/auth/session", { headers: { cookie: sessionCookie } })).status, 401);
  } finally {
    database.close();
    server.close();
  }
});

test("treats malformed session cookies as unauthenticated requests", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const malformedCookie = "eventrent_session=%E0%A4%A";
    const session = await request(baseUrl, "/auth/session", { headers: { cookie: malformedCookie } });
    assert.equal(session.status, 401);
    const logout = await request(baseUrl, "/auth/logout", { method: "POST", headers: { cookie: malformedCookie } });
    assert.equal(logout.status, 200);
  } finally {
    database.close();
    server.close();
  }
});

test("restores an email session after reopening the SQLite database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eventrent-auth-"));
  const databasePath = path.join(directory, "auth.sqlite");
  const first = openAuthDatabase(databasePath);
  const firstApp = express();
  firstApp.use(express.json());
  const firstTokens: string[] = [];
  firstApp.use("/auth", createAuthRouter(first, async (_email, url) => { firstTokens.push(url.match(/[?&]token=([^&]+)/)?.[1] || ""); }));
  const firstServer = http.createServer(firstApp);
  await new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
  const firstAddress = firstServer.address();
  assert(firstAddress && typeof firstAddress !== "string");
  const firstBaseUrl = `http://127.0.0.1:${firstAddress.port}`;
  const registration = await request(firstBaseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "persist@example.com", password: "correct horse battery staple" }) });
  const verifiedRegistration = await request(firstBaseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: firstTokens[0] }) });
  const sessionCookie = cookie(verifiedRegistration);
  first.close();
  firstServer.close();

  const second = openAuthDatabase(databasePath);
  const secondApp = express();
  secondApp.use(express.json());
  secondApp.use("/auth", createAuthRouter(second, async () => undefined));
  const secondServer = http.createServer(secondApp);
  await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
  const secondAddress = secondServer.address();
  assert(secondAddress && typeof secondAddress !== "string");
  try {
    const restored = await request(`http://127.0.0.1:${secondAddress.port}`, "/auth/session", { headers: { cookie: sessionCookie } });
    assert.equal(restored.status, 200);
  } finally {
    second.close();
    secondServer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps optional wallet authentication and rejects replay", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const wallet = Wallet.createRandom();
    const nonce = await request(baseUrl, "/auth/nonce", { method: "POST", body: JSON.stringify({ address: wallet.address }) });
    const challenge = await nonce.json() as { nonce: string; message: string };
    const signature = await wallet.signMessage(challenge.message);
    const verified = await request(baseUrl, "/auth/verify", { method: "POST", body: JSON.stringify({ address: wallet.address, nonce: challenge.nonce, signature }) });
    assert.equal(verified.status, 200);
    const replay = await request(baseUrl, "/auth/verify", { method: "POST", body: JSON.stringify({ address: wallet.address, nonce: challenge.nonce, signature }) });
    assert.equal(replay.status, 401);
  } finally {
    database.close();
    server.close();
  }
});

test("rejects unverified login, expired verification, and token reuse", async () => {
  const { server, database, verificationTokens, baseUrl } = await startTestServer();
  try {
    const registration = await request(baseUrl, "/auth/register", { method: "POST", body: JSON.stringify({ email: "verify@example.com", password: "correct horse battery staple" }) });
    assert.equal(registration.status, 201);
    assert.equal((await request(baseUrl, "/auth/login", { method: "POST", body: JSON.stringify({ email: "verify@example.com", password: "correct horse battery staple" }) })).status, 403);
    database.db.prepare("UPDATE email_verification_tokens SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1, hashTokenForTest(verificationTokens[0]));
    const expired = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[0] }) });
    assert.equal(expired.status, 400);
    const resend = await request(baseUrl, "/auth/verify-email/resend", { method: "POST", body: JSON.stringify({ email: "verify@example.com" }) });
    assert.equal(resend.status, 200);
    const verified = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[1] }) });
    assert.equal(verified.status, 200);
    const reused = await request(baseUrl, "/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationTokens[1] }) });
    assert.equal(reused.status, 400);
  } finally {
    database.close();
    server.close();
  }
});

function hashTokenForTest(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
