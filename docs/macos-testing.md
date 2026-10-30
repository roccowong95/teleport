# macOS acceptance handoff

Do not treat JavaScript syntax checks or simulated injection as a native macOS pass. Use an isolated checkout/test directory and harmless dedicated test windows. No existing user documents or shells should be targeted. Do not change system permissions or toolchain selection automatically.

## Prerequisites and diagnostics

Node 24, npm, matching Apple command-line tools/macOS SDK, Electron binary, and an interactive desktop session. Before diagnosing a native import failure, collect:

```sh
uname -m
node -p 'process.arch'
command -v swiftc
swiftc --version
xcode-select -p
xcrun --sdk macosx --find swiftc
xcrun --sdk macosx --show-sdk-path
xcrun --sdk macosx swiftc -print-target-info
```

Inspect **only** relevant variables `SDKROOT`, `DEVELOPER_DIR`, `TOOLCHAINS`, `CPATH`, `CPLUS_INCLUDE_PATH`, `SWIFT_EXEC`, `SWIFTFLAGS`; do not dump account secrets from the whole environment. A duplicate `SwiftBridging` module or AppKit import failure can reflect mismatched SDK/toolchain/include paths, and is not by itself evidence of an app source defect. First test an isolated file containing only `import AppKit` with the selected compiler and matching `-sdk` path and a fresh test-directory `-module-cache-path`. Do not clear shared caches, change global `xcode-select`, install Xcode or retry a denied operation without authorization.

After required authorization, dependencies can be installed normally with `npm ci`. The lockfile pins Electron 42.11.16. Electron's official install script selects platform/architecture, handles Apple-silicon Rosetta detection and verifies bundled artifact checksums. An incomplete download means Electron launch is not ready; it does not establish a source bug. Retry the official `node node_modules/electron/install.js` after the download permission/network issue is resolved. Avoid third-party mirrors, disabling checksums, quarantine removal or sandbox-disable flags.

## Test order

1. `npm run check`, `npm run build -w @teleport/web`, `npm test`.
2. `npm run dev`: local loopback Worker/DO only, no Cloudflare login/deployment. Loopback/network permission may be needed in a managed shell.
3. `npx playwright install chromium`, `npm run test:browser`, then `CHROMIUM_PATH="/path/to/existing/Chrome/executable" npm run test:e2e` (or omit the variable for installed Playwright Chromium). Browser runners require a functioning browser sandbox; do not disable it. E2E uses a dry-run adapter and generated fixture keys, and deletes its room on cleanup.
4. `npm run build:mac-helper -w @teleport/desktop`: compiles the active Objective-C source via xcrun clang and matching SDK, does not grant Accessibility permission.
5. `npm start -w @teleport/desktop`: user explicitly grants required Accessibility access if prompted. Start paused, pair with SAS comparison, then resume only after opening a harmless dedicated editable field. Test Chinese, emoji, multiline, selection replacement, pause, disconnect, secure-field refusal and deliberate focus change. Record exact OS, architecture and target application. Never use a production command line for this.

For protocol-only isolated testing: `npm run headless -w @teleport/desktop -- --endpoint http://localhost:8787 --dry-run`. This receiver holds keys in RAM only; clean exit best-effort deletes its temporary room. Its printed pairing URL is sensitive until expiry; do not publish test logs containing it.

Desktop GUI uses normal Electron userData by default. For a clean test, supply a dedicated Electron `--user-data-dir` in the isolated test directory and verify the chosen path before pairing. Do not reset the user's existing profile. Browser test contexts are fresh temporary contexts. Stop only processes started by this test run; clean only its own test directories after recording results.

## Current platform boundary

macOS and Windows native adapters are implemented and compiled in CI; actual focused-input acceptance remains platform-specific and must be tested. Linux tmux is an explicitly selected pane, single-line literal WIP. GitHub CI publishes ad-hoc macOS/unsigned Windows previews, not Developer ID/notarized distribution; Cloudflare deployment is separate.

## Objective-C helper route

The active native helper now uses Objective-C. A minimal Objective-C AppKit import compiled on the test Mac where minimal Swift AppKit import failed. The implementation preserves per-chunk AX/PID/focus checks, rejects secure or unknown-subrole fields, enforces UTF-8 byte/control bounds and checks input-post permission without requesting it. A successful ObjC smoke compile does not prove the full helper or real input works; compile the published implementation and check `apps/desktop/native/teleport-input --check-access` before any harmless-field test. Do not edit system module maps.

### Packaged startup regression (alpha.2)

The alpha.1 artifact passed compilation and archive-integrity checks but failed before JavaScript startup: macOS dyld library validation rejected its ad-hoc Electron Framework. Alpha.2 adds a packaged-app launch gate, not merely a signature verification. It starts the actual app executable with an isolated temporary profile, loads the sandboxed renderer and preload, verifies the restricted status IPC, and exits. This smoke check does not call Accessibility, read real identities, connect a relay, or prove focused native input.

The development build remains ad-hoc signed, not Developer ID signed/notarized. Its Electron app/helper bundle entitlements allow loading the bundled ad-hoc libraries; OS security settings and quarantine are not changed. Production distribution needs a separately authorized signing/notarization design.

### Explicit permission controls (alpha.3)

The receiver exposes separate Accessibility and event-posting status checks before configuring any relay. Refresh is read-only. Each request button is an explicit user action invoking the corresponding macOS API; no startup, reconnect, or Resume action requests permission automatically. Status may be granted, denied, or unknown/error; dismissing a prompt is not success. After a settings change, refresh and follow any system-requested restart. Resume requires both checks to report granted.

The system prompt/settings identify the actual responsible application or helper. Do not assume running a helper directly from Terminal checks exactly the same responsible identity as the packaged app. Do not auto-grant privileges, edit TCC, or remove quarantine. The packaged smoke calls only the read-only status IPC; it never presses request controls or injects text.

Official APIs: [AXIsProcessTrustedWithOptions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions), [CGPreflightPostEventAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightposteventaccess()), [CGRequestPostEventAccess](https://developer.apple.com/documentation/coregraphics/cgrequestposteventaccess()). AX prompting is asynchronous and does not affect that call's trust return value. UI `denied` means currently not authorized, not proof that the user explicitly denied a prompt.
