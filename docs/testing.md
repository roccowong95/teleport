# Test status — 2026-10-30

## Verified in Linux cloud

- Shared protocol: 8 tests (Unicode, encryption/authentication, tampering, SAS, pairing expiry, session/TTL/replay gate, low-order key rejection).
- Relay: 10 tests using actual workerd/Miniflare SQLite Durable Objects and WebSockets (approval, auth, revocation, connection caps, 10-second authentication expiry, reconstructed state, maximum escaped text size, offline no-queue).
- Desktop controller/adapters: 14 unit tests for pinned keys, explicit approval, pause, injection result/unknown, dedupe, encrypted safeStorage, reset, reconnect and tmux argument safety.
- Phone helpers: 3 tests (origin, send guards, reconnect backoff).
- Cross-component integration: actual DO + actual desktop controller + phone protocol test passed: matching SAS, approval, paused state, encrypted Chinese/emoji/multiline text delivered once to simulated adapter, duplicate rejection, session rotation, revocation.
- TypeScript/syntax checks and production web build; asset-aware Wrangler deployment dry-run. **No deployed service**.

## Blocked / not claimed

- Phone browser tests (4 mocked-wire scenarios) and real-browser end-to-end test are provided, **not passed in this environment**. Chromium hit sandbox `socket() EPERM`; an attempted approval/escalation could not start its wrapper (`bwrap` read-only setup error). This was not bypassed or retried with sandbox disabled. A separate browser download returned an invalid/truncated archive.
- Wrangler network dev server hit `uv_interface_addresses` in this sandbox. In-process workerd tests succeeded independently; this is not proof of internet/reconnection behavior on real phones.
- macOS Swift compilation, Electron launch, tray appearance, OS Accessibility permission, secure input/focus races and actual Unicode insertion are **unverified**. Need a real Mac testing environment and user permission where prompted.
- Windows input, packaging/signing/notarization and auto-update are not implemented. Linux tmux integration is WIP; tests inspect explicit argument/control handling, not arbitrary terminal behavior.
- No screenshot/visual QA, physical phone or Chinese-network reliability claim.

Run `npm test`, `npm run check`, `npm run build`. Browser commands are in the root README. Run a harmless local text editor test before any sensitive application. Distinguish dry-run adapter acceptance from OS insertion and target application persistence.
