# Teleport (working title)

Send text from your phone's browser/keyboard to the focused input on your computer. No account. Pair by QR, compare a security code, approve on the computer, and keep trusted devices for later.

**Early MVP source, not a production-ready or signed app.** Cloud protocol and local Cloudflare runtime tests pass; real macOS input and browser acceptance are still pending. Windows input is not implemented. Linux tmux is an explicit-target, single-line WIP, not global focus injection.

## Monorepo

- `apps/web`: mobile-first web UI / installable manifest (no offline message queue or service-worker caching of keys).
- `apps/relay`: Cloudflare Worker + hibernating SQLite Durable Object. Routes opaque encrypted messages only while both ends are online.
- `apps/desktop`: Electron tray receiver, macOS Swift input helper, dry-run and experimental tmux adapters.
- `packages/protocol`: shared NaCl encryption, authenticated routing context, pairing codec, replay/expiry gate.

## Local cloud-runtime development — no Cloudflare login

Requires Node 24 and npm. From the repository root:

```sh
npm ci
npm test
npm run check
npm run build -w @teleport/web
npm run dev
```

`wrangler dev --local` simulates Worker/DO locally. It creates local development state, not a deployed Cloudflare service. Desktop developer instructions: [apps/desktop/README.md](apps/desktop/README.md). Phone Web/PWA details: [apps/web/README.md](apps/web/README.md).

For a headless build/test machine that does not run Electron, use `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`. `npm run build` builds the web assets, checks desktop JavaScript syntax, then runs a Worker deployment **dry-run**. It does not compile the Swift helper, package/sign Electron or deploy remotely.

Browser acceptance needs Playwright Chromium (`npx playwright install chromium`) and a sandbox capable of running it. `npm run test:browser` runs UI mocks. To test the full UI against the local Worker, run `npm run dev` first, then `npm run test:e2e`. Set `CHROMIUM_PATH` to an existing Chrome/Chromium executable for either browser suite when you do not want a separate Playwright browser download. The latter uses an explicitly simulated input adapter and must not be described as a real OS typing test.

## Self-hosting on your Cloudflare account

MVP is deliberately Cloudflare-only; no VPS adapter. Build web assets, authenticate Wrangler yourself, review limits/billing and deploy `apps/relay` to your own account. Its Wrangler configuration binds the assets and SQLite DO migration. See [relay instructions](apps/relay/README.md). Use a dedicated HTTPS origin; pair clients to that exact origin. Browser camera/scanning happens through the phone camera opening the QR URL, not an in-app camera permission.

A publicly reachable deployment needs abuse controls for room creation and account spending protections before inviting others. Do not assume a free plan prevents all abuse or charges. No deployed endpoint, account credentials, real pairing data or signing identity is included.

## Delivery behavior

- Only Send transmits text; newline in the editor does not send.
- Starts paused on the computer; resume deliberately.
- No extra Return key, clipboard fallback, offline queue, or automatic resend.
- ACK means adapter reported insertion, **not** target app saved text. Lost/partial ACK = unknown; inspect target before retrying.
- Desktop supports pause, disconnect/reconnect, device revoke and reset. Phone supports disconnect, forget and reset local identity/pairings.
- No user account exists: “delete user data” means revoke pairings/room and remove local keys, not account deletion.

Read [security boundaries](docs/security.md), [wire contract](docs/wire-contract.md), and [test status](docs/testing.md) before use. Never try early builds in a password field, production shell or destructive workflow.
