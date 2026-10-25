import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import http from "node:http";
import { Wallet } from "ethers";
import { createAuthRouter } from "./auth.js";
import { openAuthDatabase } from "./db.js";

async function startServer() {
  const database = openAuthDatabase(":memory:");
  const app = express();
  app.use(express.json());
  app.use("/auth", createAuthRouter(database));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
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

test("wallet authentication creates a session, persists a role, and rejects challenge replay", async () => {
  const { database, server, baseUrl } = await startServer();
  const wallet = Wallet.createRandom();
  try {
    const nonceResponse = await request(baseUrl, "/auth/nonce", { method: "POST", body: JSON.stringify({ address: wallet.address }) });
    assert.equal(nonceResponse.status, 200);
    const challenge = await nonceResponse.json() as { nonce: string; message: string };
    const signature = await wallet.signMessage(challenge.message);
    const verified = await request(baseUrl, "/auth/verify", { method: "POST", body: JSON.stringify({ address: wallet.address, nonce: challenge.nonce, signature }) });
    assert.equal(verified.status, 200);
    const sessionCookie = cookie(verified);
    const role = await request(baseUrl, "/auth/role", { method: "POST", headers: { cookie: sessionCookie }, body: JSON.stringify({ role: "owner" }) });
    assert.equal(role.status, 200);
    assert.deepEqual((await role.json() as { user: { roles: string[] } }).user.roles, ["owner"]);
    assert.equal((await request(baseUrl, "/auth/session", { headers: { cookie: sessionCookie } })).status, 200);
    assert.equal((await request(baseUrl, "/auth/verify", { method: "POST", body: JSON.stringify({ address: wallet.address, nonce: challenge.nonce, signature }) })).status, 401);
  } finally {
    database.close();
    server.close();
  }
});
