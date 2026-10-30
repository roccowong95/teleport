# Teleport 手机输入台

Vanilla TypeScript / Vite. Chinese mobile-first UI. Production files are built to `dist/` and served by the relay Worker on the **same origin**. Do not place the phone app on a different origin from the API.

```sh
npm run build -w @teleport/web
npm run test -w @teleport/web         # focused security/state unit tests
npm run test:browser -w @teleport/web # local Vite + Playwright wire mocks
```

Browser tests need Chromium and permission to create local sockets. Set `CHROMIUM_PATH` to a system Chromium, or install Playwright's Chromium. They cover encrypted send/ACK and draft retention, no Enter auto-send, manual disconnect, missing-ready lockout, delivery uncertainty/no replay, cancelled destructive actions, QR fragment removal, explicit pairing and pending approval lockout. These mocks are not a substitute for the full relay/desktop integration test.

## Security and behavior

- Pairing secrets are accepted only from the fragment, then immediately removed from browser history. Decoding rejects expired links; endpoint validation additionally pins the exact current origin, permits HTTPS only (explicit localhost development exception), and rejects endpoint paths, credentials, query and hash.
- A new NaCl identity and random sender token are created for each pairing. Owner public key is pinned from the QR payload; SAS is shown until desktop approval. All application crypto comes from `@teleport/protocol`.
- Saved device identities, private keys and client tokens live in `localStorage`. This is **not hardware-backed storage**: scripts executing on this origin or someone with browser-profile access can read them. The UI discloses this risk. Use a dedicated trusted origin with no third-party scripts. Text drafts remain in page memory only and are not persisted or logged.
- Send requires an authenticated approved socket and an owner-encrypted `ready` session, and is disabled while paused/pending or outside the 1–8192 UTF-8-byte range. Enter inserts a newline only. Every send is a new explicit click. ACK timeout, disconnect, or changed owner session produces an unknown result; no offline queue or auto-replay exists. Draft is never automatically cleared.
- Reconnect uses capped exponential backoff with jitter and online/foreground signals. Manual disconnect is persisted and disables reconnection until explicit reconnect.
- Forget attempts server revocation before deleting local keys; failure is disclosed with an instruction to remove the phone on desktop. Reset clears only this browser and explicitly warns that desktop revocation is still needed.
- Manifest and icons support installation. No service worker is registered; no secret API responses or outbound messages are cached for offline replay.

### Input diagnostics

Phone status separates connection readiness from the last send result. Disabled-send hints explain missing pairing, manual disconnect, offline/unready/paused states and empty/oversized drafts. While awaiting ACK, the button displays a 15-second countdown. Timeout or interrupted delivery remains unknown, never a retry trigger.

An `injected` ACK only means OS input events were submitted, **not** that the target application received or displayed text. Rejected/unknown outcomes show translated, whitelisted native codes (and their static `[code]` identifiers). Arbitrary exception strings/codes are discarded. ACK status, not an individual error code, determines whether input may have occurred; focus/guard checks can fail after earlier chunks were submitted.
