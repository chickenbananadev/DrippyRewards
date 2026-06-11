# Security Model — drippyrewards.com

Plain summary of how we handle wallet connections. **No one can drain your wallet by signing in.** Why:

## What we call on Solana wallets

| Wallet API | We call it? | Notes |
|---|---|---|
| `signMessage` | YES — for sign-in & multi-wallet linking | Just proves ownership. No funds move. |
| `signTransaction` / `signAndSendTransaction` | ONLY for explicit skin purchases | User clicks "Buy", sees the tx preview, then approves. Never automatic. |
| Token approvals | NEVER | Solana doesn't really do ERC-20 style approve; we never request anything similar. |

## Sign-in flow

```
1. User clicks CONNECT WALLET → picks wallet (Phantom/Solflare/etc)
2. Wallet pops up showing exact text:
   "Sign in to drippyrewards.com
    Wallet: ABC12345…6789
    :: <unix-ms-timestamp>"
3. User approves → wallet returns ed25519 signature
4. Server verifies sig with `nacl.sign.detached.verify`
5. Server checks: message includes wallet[:8] (anti-substitution),
   timestamp within 10min window (anti-replay)
6. On success: HTTP-only Secure SameSite=Lax cookie set
   (HMAC-signed `<wallet>.<ts>.<hmac>`; 7-day expiry)
```

## Cookie security

- `HttpOnly` — JS cannot read it (XSS protection)
- `Secure` — HTTPS only
- `SameSite=Lax` — CSRF mitigated
- HMAC-SHA256 signed with `DRIPPY_SESSION_SECRET` env var
- `crypto.timingSafeEqual` for HMAC comparison

## Server-side rate limits

- Sign-in: 5/min per IP, 10 per 5min per wallet
- Score submit: 1 per 20s per wallet/IP
- Wallet linking: requires existing session + wallet's own signature

## HTTP security headers (vercel.json)

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Frame-Options: DENY` (no clickjacking)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()`
- `Content-Security-Policy: default-src 'self'; …`

## Data we store

- Wallet addresses (public)
- Optional usernames
- Linked-wallet sets (after signature proof each)
- Selected skin per account
- Game scores

**We never store:** seed phrases, private keys, anything that could move funds. We physically can't — Solana wallets don't expose that.

## SOL skin purchases (when shipped)

- Destination is a **Squads multi-sig vault** (`DRIPPY_TREASURY_SOL_WALLET` env var)
- Single signer cannot unilaterally withdraw
- Tx amount + destination shown to user BEFORE wallet popup
- After signing, on-chain verification via Helius RPC (correct destination, correct amount, recent, not previously redeemed)
- `SADD drippy:skin:purchased:<wallet> <skin>` on success
- Purchases are permanent; never revoked by threshold changes

## Reporting

Found a security issue? Email `security@supremebuildinggroup.com` or DM `@JacobsAI` on Discord. We respond within 24 hours.

User-facing version of this doc lives at https://drippyrewards.com/security
