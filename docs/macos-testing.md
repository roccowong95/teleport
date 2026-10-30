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

After required authorization, dependencies can be installed normally with `npm ci`. The lockfile pins Electron 41.10.7. Electron's official install script selects platform/architecture, handles Apple-silicon Rosetta detection and verifies bundled artifact checksums. An incomplete download means Electron launch is not ready; it does not establish a source bug. Retry the official `node node_modules/electron/install.js` after the download permission/network issue is resolved. Avoid third-party mirrors, disabling checksums, quarantine removal or sandbox-disable flags.

## Test order

1. `npm run check`, `npm run build -w @teleport/web`, `npm test`.
2. `npm run dev`: local loopback Worker/DO only, no Cloudflare login/deployment. Loopback/network permission may be needed in a managed shell.
3. `npx playwright install chromium`, `npm run test:browser`, then `npm run test:e2e`. Browser runners require a functioning browser sandbox; do not disable it. E2E uses a dry-run adapter and generated fixture keys, and deletes its room on cleanup.
4. `npm run build:mac-helper -w @teleport/desktop`: compiles the native source, does not grant Accessibility permission.
5. `npm start -w @teleport/desktop`: user explicitly grants required Accessibility access if prompted. Start paused, pair with SAS comparison, then resume only after opening a harmless dedicated editable field. Test Chinese, emoji, multiline, selection replacement, pause, disconnect, secure-field refusal and deliberate focus change. Record exact OS, architecture and target application. Never use a production command line for this.

For protocol-only isolated testing: `npm run headless -w @teleport/desktop -- --endpoint http://localhost:8787 --dry-run`. This receiver holds keys in RAM only; clean exit best-effort deletes its temporary room. Its printed pairing URL is sensitive until expiry; do not publish test logs containing it.

Desktop GUI uses normal Electron userData by default. For a clean test, supply a dedicated Electron `--user-data-dir` in the isolated test directory and verify the chosen path before pairing. Do not reset the user's existing profile. Browser test contexts are fresh temporary contexts. Stop only processes started by this test run; clean only its own test directories after recording results.

## Current platform boundary

macOS native code is the only implemented desktop insertion adapter and remains unverified until these checks pass. Windows currently refuses insertion; no Windows support claim. Linux tmux is an explicitly selected pane, single-line literal WIP. No signed/notarized distribution or automatic CI/deploy workflow is configured.
