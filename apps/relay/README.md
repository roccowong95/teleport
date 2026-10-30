# Teleport relay (Cloudflare only)

One Worker serves the built PWA and routes each random room UUID to a SQLite-backed Durable Object. No VPS, Node server, external database, or message queue is used. The wire contract is [`../../docs/wire-contract.md`](../../docs/wire-contract.md).

## Local checks

From repository root, Node 24:

```sh
npm install
npm run build -w @teleport/web
npm run check -w @teleport/relay
npm test -w @teleport/relay
npm run dev -w @teleport/relay
# localhost:8787 (the PWA and API share this origin)
npm run deploy:dry-run -w @teleport/relay
```

`build` and `deploy:dry-run` both only execute `wrangler deploy --dry-run`, writing the bundle to `dist`. They do not log in or deploy. The `../web/dist` assets path in `wrangler.jsonc` is relative to this directory (equivalent to repository `apps/web/dist`). Build the web workspace first. Real publication, account selection, custom domains and Cloudflare billing/limits require separate owner authorization; none have been performed.

## Security and state

- Native Durable Object WebSocket Hibernation: `acceptWebSocket`, event methods, and serialized identity/rate attachments. No keep-alive timer prevents hibernation. Alarms only enforce outstanding authentication and pairing deadlines.
- SHA-256 hashes of random 256-bit bearer tokens are persisted, never raw tokens. Persistent room data contains public keys, device names/IDs, token hashes, and short-lived pairing metadata. WebSocket attachments contain identity, counters, and deadlines, not tokens or message content.
- Pair tokens and pending requests expire after 120 seconds. A successfully consumed pairing token cannot be replayed. Owner must be online to accept a pairing request and explicitly approve its device; the owner app performs the SAS comparison.
- Owner-only room management; owner or matching sender can revoke a device. Revocation closes its connection and removes its authorization. Every relay checks current device authorization. Room deletion removes all metadata and closes connections.
- The server validates and forwards only opaque `{v, nonce, ciphertext}` envelopes; it never decrypts or persists them. No plaintext/application-payload logging and no offline queue. `peer_offline` is an explicit failure, never an instruction to retry automatically.
- WebSocket authentication is the first frame, not a URL token. API query parameters are rejected. Present Origin headers must match request origin. HTTPS is required except explicit loopback development.
- Per room: 8 approved devices, one pending request, 20 total sockets and 4 unauthenticated sockets. Unauthenticated sockets expire in 10 seconds. Per socket: 30 messages per second, 28 KB frame cap, 26,688-character ciphertext cap (matching the protocol’s 20,000-byte plaintext bound plus NaCl overhead). HTTP JSON bodies are stream-limited to 2 KB; device names are at most 120 UTF-8 bytes.

These are application bounds, not a public service abuse/billing defense. Before a public production deployment, configure Cloudflare account-level request/rate and spending controls, and review room-creation abuse protection. Room creation is intentionally unauthenticated for this local MVP; unexpired approved room metadata remains until the owner deletes it. Worker observability is disabled to reduce accidental metadata logging. Provider/network metadata still exists; end-to-end encryption does not hide endpoints, message timing, sizes, public keys or device names.

## Tests

Node tests use the real local Cloudflare workerd runtime through Miniflare (version pinned to the one required by Wrangler 4.156.0). They cover full live pairing/approval/relay, sender isolation, owner replacement, reject/replay, revocation, deletion, offline behavior, malformed auth, origins, secret query rejection and unauthenticated socket caps/deadlines. Focused state tests exercise expiry cleanup, hash-only storage and reconstruction from persisted socket identity. Local tests are not evidence of production deployment, remote isolate eviction behavior, or production capacity.
