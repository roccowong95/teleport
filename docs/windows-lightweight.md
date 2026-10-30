# Lightweight Windows preview (Tauri)

This is a Windows-only migration, separate from the existing macOS v0.1 alpha release. The Windows process uses Rust and the system Microsoft Edge WebView2 Evergreen Runtime. Portable artifacts must not bundle Electron, Node.js, .NET, or a fixed/offline WebView2 runtime. An existing WebView2 installation is a prerequisite; its disk footprint is not included in the ZIP's measured sizes. Obtain missing WebView2 only from Microsoft's official distribution; this preview does not silently install it.

## CI scope

`windows-lightweight.yml` uses standard `ubuntu-latest` and `windows-latest` runners, with short artifact retention. Shared JavaScript/protocol tests, Windows Rust tests, native compilation, and actual EXE/WebView startup must pass before publishing. Startup smoke uses a fresh temporary profile and a readiness marker, then exits. It does not connect a relay, read the user's profile, request elevation, disable sandbox/UIPI, or inject text. A successful startup smoke is **not** evidence of real input/password-window/UIPI acceptance; that remains an explicit Windows test.

The portable archive contains only the compiled EXE, an optional generated WebView2 loader DLL, and a README. Its adjacent JSON manifest records exact compressed bytes, expanded bytes, each staged file's SHA256, archive SHA256, source commit, and excluded runtimes. No size claim is made until those files are produced. Unexpected output above 80 MiB expanded or 50 MiB compressed fails packaging for investigation rather than silently shipping a large runtime.

## Build/test commands

Requires Windows x64, the project's pinned Rust toolchain, Windows SDK/MSVC build tools, Node 24 for frontend build tooling, and WebView2. Node is a build dependency only, not an installed app runtime.

```powershell
npm ci
cargo test --locked --manifest-path apps/windows-tauri/src-tauri/Cargo.toml
npm exec --workspace @teleport/windows-tauri -- tauri build --no-bundle
node scripts/windows-smoke.mjs
node scripts/windows-package.mjs
```

The portable program is unsigned. Respect Windows security warnings; do not bypass SmartScreen or run as Administrator merely to make text injection work. UIPI refusal must remain a normal safe failure.

## Windows-only release gate

After ordinary CI is reviewed, the authorized one-shot request may add/change `.github/windows-release-request.json`:

```json
{"version":"v0.2.0-alpha.1","release":true}
```

Only that file changing in a main push activates the request. Every test/build runs again, and the exact passing commit becomes the immutable tag target. Later unrelated pushes do not publish again. Existing tags/releases/assets are never overwritten. Future `v0.2.*` prerelease tags belong only to this lightweight workflow; the legacy workflow is restricted to `v0.1.*` tags and ignores Windows-only source changes. Shared source/dependency changes still get legacy checks.

Only the release job has `contents: write`; no Cloudflare deployment, signing credential, paid larger runner, offline browser runtime or automatic updater is configured. Assets are the Windows-only ZIP, measured-size JSON manifest and `SHA256SUMS.txt`. macOS alpha artifacts are not replaced by this release.

## Stop behavior

Pause/disconnect/revoke/reset signal the active native operation before waiting for the controller/network. New text is blocked while that emergency stop is pending. Each native Unicode chunk and its immediate `SendInput` boundary checks the per-operation cancellation flag. Cancellation is reported as unknown, never retried. Windows input events already posted cannot be recalled; focus/cancellation checks and event posting cannot form an atomic OS transaction. This is not a hard real-time emergency-stop guarantee.

### alpha.2 connection diagnostics

Setup and later status refresh failures now report separate stages and reviewed error codes. Raw errors, URLs, local paths and credentials are not displayed. HTTP timeout/connect/TLS failures and WebSocket upgrade failures are distinct; a diagnostic category is not proof of the user's network root cause. This release does **not** make blocked or unreachable `workers.dev` domains reachable.

Current proxy boundary: HTTP reads inherited proxy environment variables; it does not currently import Windows Internet Settings/PAC. WebSocket connections are direct and do not automatically use proxy environment variables or Windows proxy settings. Browser reachability therefore does not prove backend reachability. TLS verification remains strict.

An explicitly opted-in Windows CI check creates a synthetic room, uses the production Rust HTTP and WebSocket transport, verifies authentication and deletes the room. It does not use native input or real user text. Ordinary unit tests skip this live test; no Cloudflare account credential is required.

### alpha.3 input outcome diagnostics

Desktop and phone now show native input results separately from connection errors. A refusal known to occur before any OS input attempt is `rejected`; any possible partial input, uncertain posting, late cancellation or worker failure is `unknown`. An accepted OS event stream is `submitted` on desktop (`injected` in the existing encrypted protocol for compatibility), not proof that a target application accepted or saved the text. No automatic resend is added.

Only reviewed static reason codes are exposed: no input text, window title, process name or raw exception is sent in diagnostics. Password, UIAutomation editability, focus, integrity/UIPI and cancellation safeguards remain enforced; this release does not add a compatibility bypass or claim tested WeChat support. Unknown/custom widgets can still be refused, now with a specific reason.
