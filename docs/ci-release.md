# CI and preview prereleases

The workflow uses only standard GitHub-hosted `ubuntu-latest`, `macos-14` (arm64) and `windows-latest` (x64) runners. No larger runner, Cloudflare deployment, signing secret, spending-limit change or automatic updater is configured. Artifacts are retained for three days.

Normal pushes/PRs run checks and all non-browser core tests on Linux, followed by native compilation and packaging on macOS/Windows. Sandboxed browser mocks and real local Worker/DO browser integration (simulated input adapter) run on the standard macOS runner before packaging. This avoids an Ubuntu runner AppArmor/user-namespace limitation without disabling browser sandboxing or modifying host security policy. Successful builds do not prove real focus/Accessibility/UIPI behavior; manual OS acceptance remains necessary.

Packaging stages only desktop source, the appropriate native helper, and the exact installed production dependency closure from `npm ci`. Electron is pinned in the lockfile; Windows packages are unsigned ZIPs; macOS app bundles are ad-hoc sealed for local integrity, **not Developer ID signed or notarized**. The Windows ZIP includes the self-contained .NET runtime folder; do not extract only its helper EXE. The macOS ZIP preserves the app bundle. OS security prompts are not disabled or bypassed.

## Release gate

A prerelease `v*` tag runs all tests/builds again and releases only after every job passes. Existing releases/assets are never overwritten.

For the explicitly approved initial release, a separate commit may add `.github/release-request.json` with exactly:

```json
{"version":"v0.1.0-alpha.1","release":true}
```

Only a push to `main` that **changes that file** activates this one-shot route. The exact `github.sha` that passes all checks/builds is used as the tag target and release commit. Later unrelated pushes do not create releases. An already existing tag/release is not retargeted or overwritten. This same-run route is necessary because tags created using a workflow's `GITHUB_TOKEN` do not trigger another workflow run. Do not add this file until ordinary CI has been reviewed; it is intentionally absent from the initial workflow commit.

Only the release job receives `contents: write`; all other jobs are read-only, checkout does not persist credentials. Releases include both ZIPs and `SHA256SUMS.txt`, marked prerelease with unsigned Windows / ad-hoc-only macOS warnings. No signing or external deployment credential is requested.

Manual package commands after the appropriate native helper is built:

```sh
npm run package:desktop
```

Only native macOS arm64 / Windows x64 packaging is defined. The script deliberately refuses other platforms rather than claiming cross-platform native validation.

## macOS ad-hoc integrity seal

The standard `@electron/osx-sign` path signs nested code from the inside out with identity `-`, not a Developer ID certificate. It keeps the library’s Electron-specific per-helper hardened-runtime/JIT entitlement defaults, disables timestamp service (`none`), fails packaging if signing fails, and does not use a blanket `codesign --deep` command. No signing credential or notarization service is involved. This seal does not establish developer trust and does not bypass Gatekeeper, quarantine or Accessibility authorization.

## Packaged GUI startup gate

After packaging, macOS CI launches the actual app executable with a dedicated temporary profile. It requires main-process readiness, sandboxed renderer readiness and clean exit within 60 seconds. It makes no relay connection or real input request and does not alter Keychain, Accessibility, quarantine or host security settings. This gate catches pre-JavaScript loader/signature failures that source-level tests cannot.

For ad-hoc macOS previews only, the main and Electron helper app-bundle signatures add `com.apple.security.cs.disable-library-validation` to their role-specific standard Electron entitlement plists. Ad-hoc binaries have no Team ID, so default hardened-runtime library validation otherwise rejects the embedded Electron Framework. Hardened runtime and JIT settings remain; the narrow exception is not applied to the native input helper. This reduces that app's library-validation protection and is an explicit development-distribution limitation, not an OS policy bypass or notarization substitute. A future Developer ID release should reassess/remove the exception with proper same-team signing.
