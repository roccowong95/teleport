# Test status — 2026-10-30

## Verified in Linux cloud

- Shared protocol: 8 tests (Unicode, encryption/authentication, tampering, SAS, pairing expiry, session/TTL/replay gate, low-order key rejection).
- Relay: 10 tests using actual workerd/Miniflare SQLite Durable Objects and WebSockets (approval, auth, revocation, connection caps, 10-second authentication expiry, reconstructed state, maximum escaped text size, offline no-queue).
- Desktop controller/adapters: 17 unit tests for pinned keys, explicit approval, pause, injection result/unknown, dedupe, encrypted safeStorage, reset, reconnect and tmux argument safety.
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

## Subsequent Mac test report

The isolated Mac test runner reported all core tests/checks/web build and the four browser UI mock scenarios passing after explicit permission. Full browser→relay E2E awaits a rerun using the existing Chrome executable via `CHROMIUM_PATH`. Native Swift remains blocked: even a minimal AppKit import fails with duplicate SwiftBridging modules in that toolchain, so no native insertion success is claimed.

Electron was raised from 41.10.7 to the exact published patched version 42.11.16 following `npm audit`. The highest advisory, [GHSA-jr5w-w6x2-84p9](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9), affects certificate revocation in Chromium and Node networking; the official advisory requires an Electron update. Desktop runtime acceptance must be repeated on the new version.

## Native/runtime follow-up

The test Mac subsequently compiled the full Objective-C helper successfully. Its read-only access check returned `access_required` (exit 2); no Accessibility grant or actual input success is claimed. Full existing-Chrome browser→local Worker/DO E2E with the simulated desktop adapter passed. Windows preview source and adapter tests are being added; native Windows/runtime results remain separately required.
