# EventRent Threat Model

This is an engineering threat model, not a formal security audit or production-readiness claim.

| Attack | Exploit path | Impact | Detection and mitigation | Test |
|---|---|---|---|---|
| Wallet challenge abuse | Repeated nonce requests against `/auth/nonce` | Resource exhaustion or wallet-session abuse | Short-lived single-use nonces and per-process throttle | Wallet auth test |
| Session theft | Attacker obtains the session cookie | Authenticated API access | HttpOnly, SameSite, Secure in production, and logout revocation | Session/logout tests |
| Wallet replay | Reuse a signed wallet challenge | Unauthorized wallet session | Nonce is short-lived and deleted before signature verification | Wallet replay test |
| IDOR | User requests another booking or listing | Data disclosure or unauthorized change | Backend ownership predicates and authorized booking detail route | Marketplace ownership tests |
| Forged transaction hash | Client submits unrelated successful transaction | False escrow association | Chain ID, target, sender, calldata, event, state, and confirmation checks | Marketplace verifier tests |
| Wrong chain/contract | Transaction is valid elsewhere | False application state | Configured chain and checksummed target validation | Verifier negative tests |
| Duplicate submission | Same transaction submitted repeatedly | Duplicate association or inconsistent records | Hash primary key, booking unique index, conditional update, transaction | Idempotency tests |
| Reorganization | Originally observed block becomes non-canonical | SQLite evidence becomes stale | Confirmation depth, block-hash checks, explicit reconciliation quarantine | Reconciliation tests and operational monitoring |
| RPC outage | Verification request hangs or fails | Incorrect pending/error experience | Bounded RPC timeout and explicit error code | Timeout regression test |
| Contract reentrancy | Malicious recipient attacks withdrawal | Loss of escrow funds | Checks-effects-interactions and OpenZeppelin `ReentrancyGuard` | Solidity reentrancy tests |
| Arbitrator abuse | Arbitrator assigns an unfair split | Financial dispute outcome is unfair | Arbitrator is an explicit trusted role; outcome is recorded on-chain | Contract authorization tests |
| Database tampering | Local database is modified outside the API | Incorrect application view | SQLite integrity/foreign-key checks and chain reconciliation | Operational integrity check |
| Privacy leakage | Public chain exposes wallet and rental metadata | Information disclosure | Keep unnecessary personal information off-chain; use wallet addresses only where required | Manual data review |
| Secret exposure | Private keys or backend secrets enter frontend/source | Credential compromise | Safe templates, ignore rules, no private keys in source, `VITE_*` warning | Secret scan |

## Trust assumptions

- Hardhat accounts are disposable development identities.
- The configured RPC endpoint is available and returns honest chain data.
- The arbitrator is trusted to resolve disputes according to the project’s policy.
- Physical handover, condition, damage, and return evidence are verified outside the contract.
- A wallet signature proves control of an address, not a legal or real-world identity.

## Residual risks

- Abuse throttling is process-local and must be moved to shared infrastructure for multiple instances.
- There is no continuously running event indexer; reconciliation is explicit.
- A single RPC endpoint is an availability and trust dependency.
- The Solidity contract is unchanged by this hardening pass and has not received a formal audit.
- Local SQLite is appropriate for the MVP but not a horizontally scaled production deployment.
