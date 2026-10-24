# EventRent Architecture Reference

## Runtime topology

```mermaid
sequenceDiagram
  participant B as Browser
  participant V as Vite
  participant A as Express API
  participant D as SQLite
  participant M as MetaMask
  participant H as Hardhat/RentalEscrow

  B->>V: GET frontend and relative /api request
  V->>A: Proxy /api or /auth
  A->>D: Session, listing, booking query
  D-->>A: Persistent application data
  A-->>V: JSON response
  V-->>B: JSON response
  B->>M: Request wallet signature or transaction
  M->>H: JSON-RPC contract call
  B->>A: Submit transaction hash for verification
  A->>H: Verify receipt, event, calldata, and state
  A->>D: Persist verified evidence
```

## State authority

| Concern | Authority |
|---|---|
| User, session, email verification | SQLite plus backend auth code |
| Listing ownership and active flag | SQLite plus backend authorization |
| Booking request and owner decision | SQLite plus backend transactions |
| `createRental` evidence | Backend verification of the chain, then SQLite metadata |
| Deposit custody and escrow lifecycle | `RentalEscrow` on the configured chain |
| UI loading and navigation | React state only |

## Booking and escrow sequence

```mermaid
sequenceDiagram
  participant R as Renter
  participant API as Express
  participant DB as SQLite
  participant O as Owner
  participant C as RentalEscrow

  R->>API: POST /api/bookings
  API->>DB: BEGIN IMMEDIATE, validate overlap, insert REQUESTED
  O->>API: PATCH /api/bookings/:id/status
  API->>DB: Approve inside write transaction
  O->>C: createRental(...)
  O->>API: PATCH /api/bookings/:id/onchain
  API->>C: Verify receipt, event, calldata, and getRental
  API->>DB: Store VERIFIED creation evidence
  R->>C: fundDeposit(...)
  O->>C: confirmPickup(...)
  R->>C: markReturned(...)
  O->>C: approveRefund(...) or raiseDispute(...)
  API->>C: Explicit reconciliation reads current rental state
```

## Contract state machine

```mermaid
stateDiagram-v2
  [*] --> CREATED: createRental
  CREATED --> FUNDED: renter funds exact deposit
  FUNDED --> ACTIVE: owner confirms pickup
  FUNDED --> REFUNDED: renter recovers at start time
  ACTIVE --> RETURNED: renter marks returned
  ACTIVE --> DISPUTED: owner or renter triggers timeout at end
  RETURNED --> REFUNDED: owner approves refund
  RETURNED --> DISPUTED: owner or renter raises dispute
  DISPUTED --> RESOLVED: arbitrator splits deposit
  REFUNDED --> [*]
  RESOLVED --> [*]
```

`withdraw` transfers an already-created claimable balance. It does not change rental status.

## API groups

- `/auth/register`, `/auth/login`, `/auth/session`, `/auth/logout`
- `/auth/verify-email`, `/auth/verify-email/resend`
- `/auth/password-reset/request`, `/auth/password-reset/confirm`
- `/auth/nonce`, `/auth/verify`
- `/api/listings`, `/api/listings/:id`, `/api/my/listings`
- `/api/bookings`, `/api/bookings/:id`
- `/api/bookings/:id/status`
- `/api/bookings/:id/onchain`
- `/api/bookings/:id/onchain/reconcile`

Protected routes use the server-side session cookie and perform object-level ownership checks. Client workspace selection is presentation state only.
