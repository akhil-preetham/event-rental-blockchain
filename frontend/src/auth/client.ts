import type { JsonRpcSigner } from "ethers";

export type AuthRole = "renter" | "owner";
export type AuthUser = { id: number; email: string | null; walletAddress: string | null; emailVerified?: boolean; roles?: AuthRole[] };
export type Session = { authenticated: boolean; user?: AuthUser };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "auth_request_failed";
    throw new Error(code);
  }
  return body as Record<string, unknown>;
}

export async function signInWithWallet(signer: JsonRpcSigner): Promise<AuthUser> {
  const address = await signer.getAddress();
  const challengeResponse = await fetch("/auth/nonce", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const challenge = await readJson(challengeResponse);
  const message = typeof challenge.message === "string" ? challenge.message : "";
  const nonce = typeof challenge.nonce === "string" ? challenge.nonce : "";
  if (!message || !nonce) throw new Error("invalid_challenge");
  const signature = await signer.signMessage(message);
  const verifyResponse = await fetch("/auth/verify", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, nonce, signature }),
  });
  const session = await readJson(verifyResponse);
  if (session.authenticated !== true || typeof session.user !== "object" || !session.user) throw new Error("authentication_failed");
  return session.user as AuthUser;
}

export async function getSession(): Promise<Session | null> {
  const response = await fetch("/auth/session", { credentials: "include" });
  if (response.status === 401) return null;
  const session = await readJson(response);
  return { authenticated: session.authenticated === true, user: session.user as AuthUser | undefined };
}

export async function logout(): Promise<void> {
  const response = await fetch("/auth/logout", { method: "POST", credentials: "include", headers: { "content-type": "application/json" } });
  await readJson(response);
}

export async function selectRole(role: AuthRole): Promise<AuthUser> {
  const response = await fetch("/auth/role", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  const body = await readJson(response);
  if (typeof body.user !== "object" || !body.user) throw new Error("role_selection_failed");
  return body.user as AuthUser;
}

async function emailRequest(path: string, email: string, password: string): Promise<AuthUser> {
  const response = await fetch(`/auth/${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await readJson(response);
  if (body.authenticated !== true || typeof body.user !== "object" || !body.user) throw new Error("authentication_failed");
  return body.user as AuthUser;
}

export async function registerWithEmail(email: string, password: string): Promise<{ verificationRequired: boolean; user: AuthUser }> {
  const response = await fetch("/auth/register", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const body = await readJson(response);
  return { verificationRequired: body.verificationRequired === true, user: body.user as AuthUser };
}

export function loginWithEmail(email: string, password: string): Promise<AuthUser> {
  return emailRequest("login", email, password);
}

export async function verifyEmailToken(token: string): Promise<AuthUser> {
  const response = await fetch("/auth/verify-email", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const body = await readJson(response);
  return body.user as AuthUser;
}

export async function resendVerification(email: string): Promise<void> {
  const response = await fetch("/auth/verify-email/resend", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  await readJson(response);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const response = await fetch("/auth/password-reset/request", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  await readJson(response);
}

export async function confirmPasswordReset(token: string, password: string): Promise<void> {
  const response = await fetch("/auth/password-reset/confirm", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) });
  await readJson(response);
}
