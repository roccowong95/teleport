# Teleport receiver (MVP source)

Electron tray/menu-bar receiver with a narrow sandboxed renderer bridge. Setup creates a room at your relay origin. A short-lived fragment-only QR pairs a phone; the owner must compare the displayed SAS with the phone and explicitly approve. Approved public keys are pinned locally; relay-provided keys never replace pins. Each connection gets a new session, and text is authenticated/decrypted locally, gated, then injected through an adapter. No clipboard fallback, no added Enter, no text logging.

## Cloud-verifiable commands

From repository root:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run test -w @teleport/desktop
npm run build -w @teleport/desktop
npm run headless -w @teleport/desktop -- --endpoint http://localhost:8787 --dry-run
```

`build` is JavaScript syntax validation, **not** a signed application build or a native Objective-C compilation. The dry-run adapter validates protocol plumbing without typing anywhere. Its `injected` ACK is a simulated acceptance, not OS input. The headless CLI holds keys in RAM, prints only its private short-lived pairing URL and security/status information, requires manual SAS approval and `resume`, and best-effort deletes its temporary room on clean exit. Restart requires re-pairing. It never prints received text. Do not use a shared terminal for pairing URLs.

## macOS development (not verified in this Linux cloud environment)

```sh
npm install                     # allow Electron binary download on your Mac
npm run build:mac-helper -w @teleport/desktop
npm start -w @teleport/desktop
```

Enable Accessibility access for the helper/hosting development app in macOS System Settings → Privacy & Security → Accessibility. No permissions are silently granted. Native source uses Objective-C with AppKit/ApplicationServices via the selected xcrun clang/SDK. GUI/tray launch, native compilation, permission prompts, emoji/long-text injection, focus switching, and password rejection still need real-Mac verification. No signed/notarized distributable is provided.

The Objective-C helper reads UTF-8 via stdin, checks a frontmost enabled AX text field/text area with writable selected text, rejects secure-text subroles, and rechecks the PID and focused AX element before every small Unicode CGEvent chunk. It refuses unsupported/non-AX targets. Large text is split without splitting UTF-16 surrogate pairs. Input begins paused on each launch; resume and then focus the target app before sending. No Return key event is synthesized; newline/tab characters already in the payload remain literal Unicode input and may be interpreted by the target app.

A race between final focus check and OS event delivery is unavoidable with global CGEvent posting. A posted event is not proof that an application accepted or saved text. Partial failure is acknowledged as `unknown`, never automatically retried. Apple notes that some frameworks ignore Unicode event strings: [CGEvent Unicode API](https://developer.apple.com/documentation/coregraphics/cgevent/keyboardsetunicodestring(stringlength:unicodestring:)). Test your target application with harmless text first.

Credentials (owner token, keypair, pinned device keys) are persisted together in Electron `safeStorage` encrypted data with restrictive file permissions. Encryption absence, Linux `basic_text`, or corrupt storage stops startup; there is no plaintext fallback. Linux headless testing is explicitly ephemeral rather than pretending to offer OS keychain storage.

## Linux tmux experiment (WIP, opt-in only)

```sh
tmux list-panes -a -F '#{pane_id} #{pane_current_command}'
npm run headless -w @teleport/desktop -- --endpoint https://your-relay.example --allow-tmux --tmux-pane %3
```

This targets only the exact numeric pane you specify. It rejects all C0/C1 controls, tabs, CR/LF and Unicode line separators; invokes `tmux send-keys -l` using an argument array with `shell:false`; and never appends Enter. It is not a general Linux desktop backend. Literal text appears in process arguments during the short `tmux` invocation; do not use for secrets on shared hosts. No real tmux/native test has been claimed by unit tests. A dry-run adapter is available for fully isolated cloud tests.

Windows native injection is intentionally unsupported/blocked. No PowerShell, SendKeys, clipboard, or privileged fallback is included.

## Test coverage

Tests cover explicit-approval pinning, encrypted text/ACK flow, paused-by-default behavior, deduplication, expiry/session rejection, changed-key refusal, unknown adapter failures, fail-closed credential storage with a test-only encryption mock, and tmux command/control-character safety. Storage mocks are not production cryptography. The shared protocol's tests cover cryptographic implementation and validation limits.

The desktop device list supports individual revocation. **Delete room & reset** uses a native confirmation dialog, deletes the relay room, then wipes saved identity/pins and returns to paused setup. It requires relay reachability, so deletion failure leaves local credentials intact for retry. Reconnect uses capped exponential delay (1–30 seconds); an explicit restart clears stopped state and generates a fresh session.

**Disconnect** (window or tray menu) closes the WebSocket and cancels reconnect attempts without deleting pairings. **Connect to relay** explicitly reconnects with a fresh session. This is distinct from Pause, which keeps the connection online but rejects text.

The active helper source is `native/TeleportInput.m`; the former Swift source is retained only for reference and is not built. This avoids a Swift-module toolchain failure observed even on a minimal AppKit import, without modifying system SDK files. `native/teleport-input --check-access` reports `access_available` or `access_required` and does not request/change permissions. Exit success here is not a focus/input acceptance test.
