# Lightweight macOS preview (Tauri)

The macOS arm64 receiver uses Rust and macOS's system WKWebView instead of bundling Electron/Node.js. It shares the Windows lightweight protocol/controller/UI while keeping separate native input and Keychain-backed credential storage. Windows DPAPI and input behavior remain Windows-specific. No browser engine, Node.js, .NET or Electron runtime ships in this app. Actual archive/expanded sizes are recorded by CI, not estimated; the OS's own frameworks are excluded from those sizes.

## Profile and safety boundaries

This is a separate application identifier/profile from the Electron preview. It does not migrate, overwrite or delete the existing profile or its saved relay URL. To use the new receiver, enter the **same relay URL** already in use and explicitly pair again with SAS comparison. Do not reset the old receiver just to install the new one. No relay deployment, custom domain change, credential change or automatic update is part of this release.

Input starts paused, strict input is the default, and permission status checks do not request or grant access. Only explicit permission buttons may request macOS authorization. Resume is fail-closed until required checks pass. Compatibility input is a warned, session-only opt-in, not a password/focus/cancellation bypass. Optional phone Enter-after-text starts off, requires an authenticated capability announcement, and may send a message or execute a command. Never test on a production shell, password field or destructive workflow. Partial/uncertain input is never automatically resent.

## Build and CI

Use native macOS arm64, the pinned Rust toolchain, Node 24 and Apple command-line tools. Node is build-time only. No host security changes or toolchain-selection changes are performed.

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
cd apps/windows-tauri/src-tauri && cargo test --locked && cd ../../..
APPLE_SIGNING_IDENTITY=- npm exec --workspace @teleport/windows-tauri -- tauri build --config src-tauri/tauri.macos.conf.json --bundles app
node scripts/macos-smoke.mjs
node scripts/macos-package.mjs
```

`macos-lightweight.yml` uses standard `ubuntu-latest` and `macos-14` runners. Core checks and phone browser/loopback Worker tests precede publication. The native job tests Rust, builds the actual app, launches its executable from the bundle with an isolated smoke profile, requires Rust + WKWebView renderer readiness and clean exit, verifies its ad-hoc signature, and measures/hashes the staged files and ZIP. Smoke performs no relay connection, native input, Keychain identity access or permission request. A missing readiness marker or launch failure blocks packaging/publication. Build and smoke are not real focused-input acceptance.

The app is **ad-hoc signed, not Developer ID signed or notarized**. Respect Gatekeeper and quarantine; no removal, bypass or security-policy change is included. Archives above 50 MiB compressed or 80 MiB expanded fail for investigation. Runtime bundling is not used to fix failures. CI artifacts expire after three days; immutable releases retain their assets.

## Separate release gate

Only `v0.3.*` prerelease tags belong to this workflow. Alternatively, after ordinary CI has passed and been reviewed, an authorized main commit can add/change `.github/macos-release-request.json` with:

```json
{"version":"v0.3.0-alpha.1","release":true}
```

The request must change in that push; unrelated pushes and pull requests cannot publish. The release uses the exact SHA which passed all jobs. Existing tags/releases/assets are never overwritten. Only the release job receives `contents: write`. Assets are the macOS arm64 ZIP, per-file/size/SHA256 manifest and `SHA256SUMS.txt`. Neither older Electron macOS assets nor Windows assets are replaced.

## Real Mac acceptance handoff

Download the candidate artifact and verify its checksums. Use an isolated test profile and a dedicated harmless editor, never existing user documents. Record OS, architecture and target application. Confirm: startup and tray reopen; permission status and canceled permission prompts remain fail-closed; explicit authorization and Resume; pair/SAS approval; Chinese, emoji, multiline and selection replacement; pause/disconnect/revoke while sending; strict rejection of unsupported/password/unknown targets; focus changes and held modifiers; explicit compatibility enable/cancel/reconnect reset; optional Enter off/on, only after successful text; and clear rejected versus unknown diagnostics on desktop/phone. Existing relay URL/profile must remain untouched. Already posted OS events cannot be recalled, and submission does not prove application acceptance or saving.
