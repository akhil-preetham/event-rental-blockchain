# EventRent authentication

EventRent now supports email-first authentication and optional MetaMask authentication. One account can hold renter and owner capabilities, while the selected workspace is persisted server-side after authentication.

## Local setup

Install dependencies from the project root:

```powershell
npm install
```

Start the authentication server:

```powershell
npm run backend
```

Start the frontend in another terminal:

```powershell
npm run dev --prefix frontend
```

The Vite development server proxies `/auth` to `http://localhost:8787`.
It also proxies `/api` to the same backend.

For the local escrow flow, use separate terminals:

```powershell
npx hardhat node
$env:RENTAL_ESCROW_DEPLOY="1"
npx hardhat run scripts/deploy.ts --network localhost
npm run backend
npm run dev --prefix frontend
```

The deploy script is opt-in and does not edit either environment file. It exits
without deploying when the configured address already contains the expected
bytecode, and refuses to overwrite a configured address. Copy the printed
address into both backend and `frontend/.env.local`, then verify it:

```powershell
npm run inspect:chain -- --json
```

Ensure `frontend/.env.local` contains the deployed local address and:

```text
VITE_HARDHAT_CHAIN_ID=31337
```

The deployment address is local-chain state. If the Hardhat node is restarted, deploy again and update the address before using wallet transactions. Use only Hardhat test accounts and test ETH.

Optional backend configuration:

```text
PORT=8787
APP_ORIGIN=http://localhost:5173
AUTH_DB_PATH=C:\path\to\eventrent-auth.sqlite
NODE_ENV=development
EMAIL_DELIVERY_MODE=smtp
SMTP_HOST=smtp.example.test
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM=EventRent <noreply@example.test>
BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545
BLOCKCHAIN_CHAIN_ID=31337
RENTAL_ESCROW_ADDRESS=0x_deployed_local_address
RENTAL_ESCROW_DEPLOY=
BLOCKCHAIN_CONFIRMATIONS=2
BLOCKCHAIN_RPC_TIMEOUT_MS=10000
```

The root `.env.example` documents these backend variables, but this project does not
automatically load `.env` files. Set them in the backend process environment before
running `npm run backend` (for example, with PowerShell `$env:NAME="value"`).
The frontend reads `frontend/.env.local` through Vite; never put backend secrets in
that file because `VITE_*` values are exposed to the browser.

If `AUTH_DB_PATH` is omitted, the database is created at `backend/eventrent-auth.sqlite`. This local database is not a source-code artifact and should not be committed.

## Email authentication

Registration and login use:

- Normalized, unique email addresses.
- Passwords hashed with Node.js `crypto.scryptSync` and a random per-password salt.
- SQLite-persisted accounts.
- SQLite-persisted sessions.
- HttpOnly cookies with `SameSite=Lax`.
- `Secure` cookies when `NODE_ENV=production`.

The browser never receives a password hash or session token. Passwords are never logged.

The same account can later rent equipment and list equipment. The frontend selection is not trusted as proof of identity: it is submitted through the authenticated `POST /auth/role` endpoint and stored in SQLite. Protected marketplace operations enforce the corresponding persisted capability.

`GET /auth/session` returns the account's persisted capabilities, and `POST /auth/role`
requires an existing authenticated session before adding either `renter` or `owner`.
Existing accounts are backfilled with both capabilities during database initialization
so the migration does not strand current marketplace users.

## Optional MetaMask authentication

MetaMask remains available from the authentication dialog. It uses the existing server challenge flow:

1. The server issues a short-lived, single-use, origin-bound nonce.
2. MetaMask signs the challenge.
3. The server verifies the signature.
4. The server creates the same SQLite-backed session.

Connecting a wallet without signing the challenge is not authentication. A wallet is still required to authorize RentalEscrow blockchain transactions.

## Email verification

Registration creates an unverified account and sends a single-use, 24-hour verification link. Only the token hash is stored. Login and protected marketplace mutations remain unavailable until the link is successfully consumed. Resend requests are rate-limited by a short cooldown.

SMTP is required for normal operation. If the SMTP variables are missing, registration returns `email_delivery_unavailable` and does not create a usable account. For local-only development, set `EMAIL_DELIVERY_MODE=console` with `NODE_ENV=development`; the backend prints a development verification link and must never use this mode in production.

## Password recovery and abuse controls

Verified email accounts can request a password-reset link through `POST /auth/password-reset/request`. The endpoint intentionally returns the same success-shaped response for unknown, unverified, and known addresses. Reset tokens are random, expire after one hour, are stored only as SHA-256 hashes, are single-use, and revoke existing sessions after a successful reset. The configured mailer must deliver the link in normal operation.

Password login failures are rate-limited per client address and normalized email for a short window. This is a single-process safeguard for local development; production deployments should add shared rate limiting at the edge or use a shared datastore.

## Production safeguards and limitations

For production:

- Serve the frontend and backend over HTTPS.
- Set `NODE_ENV=production` so cookies include `Secure`.
- Set `APP_ORIGIN` to the exact HTTPS frontend origin.
- Use a protected database location and backups.
- Add rate limiting and monitoring for registration/login.
- Keep the origin validation and same-site cookie controls aligned with the deployment topology, and add a dedicated CSRF token strategy if the frontend and backend are deployed on different sites.
- Add password reset and production email-provider monitoring.
- Keep secrets and operational configuration outside source control.

SQLite makes sessions survive backend restarts on one application instance. A multi-instance deployment needs a shared session/database strategy and coordination.

## Local marketplace MVP

The backend also exposes a small SQLite-backed marketplace:

- `GET /api/listings` and `GET /api/listings/:id` are public discovery endpoints.
- `POST /api/listings`, `PUT /api/listings/:id`, and `GET /api/my/listings` require an authenticated session with the `owner` capability.
- `POST /api/bookings` requires the `renter` capability and creates a requested off-chain booking after validating dates and rejecting overlapping requested/approved bookings.
- `GET /api/bookings` returns the signed-in user's renter bookings and owner booking requests.
- `PATCH /api/bookings/:id/status` requires the `owner` capability and lets only the listing owner move a `REQUESTED` booking to `APPROVED` or `REJECTED`. Approval checks for conflicts inside a SQLite write transaction.
- `PATCH /api/bookings/:id/onchain` requires the `owner` capability and records a confirmed local-chain `createRental` transaction and rental ID for an approved booking. It accepts only chain ID `31337` and does not mark the deposit as funded.
- The backend now verifies that transaction through the configured RPC provider before recording it: the receipt must succeed, target the configured `RENTAL_ESCROW_ADDRESS`, call `createRental`, emit the actual `RentalCreated` event, and match the approved booking's owner, renter, fee, deposit, and dates. Verified transaction hashes are idempotent and stored with block/event metadata.
- Verification requires the configured confirmation depth (default `2`) and compares the receipt block hash with the canonical RPC block. If reconciliation later detects that a recorded transaction is missing, reorged, or has mismatched state, the booking is marked `UNVERIFIED` rather than silently remaining final. This is detection/quarantine, not a full reorganization-safe indexer.
- `POST /api/bookings/:id/onchain/reconcile` rechecks a previously recorded rental after a restart or suspected database/index mismatch. It does not treat an unconfirmed event as final.
- Reconciliation also reads the current on-chain rental status (`CREATED`, `FUNDED`, `ACTIVE`, `RETURNED`, `REFUNDED`, `DISPUTED`, or `RESOLVED`) and stores a timestamped snapshot in SQLite. The contract remains authoritative; this is not a background indexer.

Start the backend before the Vite frontend so its `/api` proxy can resolve:

```powershell
npm run backend
npm run dev --prefix frontend
```

The first local database initialization seeds two clearly marked demonstration listings. They are not verified inventory and are not blockchain rentals. The booking lifecycle is `REQUESTED → APPROVED/REJECTED`; an approved booking can then become linked to an on-chain `CREATED` rental after the owner confirms `createRental`. The renter must still call `fundDeposit` separately. A booking is not represented as funded until that deposit transaction is confirmed; the Solidity contract remains the final authority for funded reservation overlap.

For local escrow integration, the owner must be signed in with MetaMask, connected to Hardhat Local (`31337`), and have a listing booking whose renter has a wallet-authenticated account. Email-only accounts do not provide a verified renter wallet address for `createRental`.

## Verification

```powershell
npm run typecheck:auth
npm run test:auth
npm run test:marketplace
npm run build --prefix frontend
npm test
```

The current automated coverage verifies authentication, marketplace booking ownership and transitions, concurrent overlap rejection, mocked authoritative transaction verification/idempotency/retry behavior, frontend compilation, and the existing 73 Solidity tests. It does not replace a manual MetaMask flow against a running local node.
