# CI and unsigned prereleases

The workflow uses only standard GitHub-hosted `ubuntu-latest`, `macos-14` (arm64) and `windows-latest` (x64) runners. No larger runner, Cloudflare deployment, signing secret, spending-limit change or automatic updater is configured. Artifacts are retained for three days.

Normal pushes/PRs run checks, all cloud core tests, browser mocks, real local Worker/DO browser integration (simulated input adapter), then native compilation and packaging on macOS/Windows. Successful builds do not prove real focus/Accessibility/UIPI behavior; manual OS acceptance remains necessary.

Packaging stages only desktop source, the appropriate native helper, and the exact installed production dependency closure from `npm ci`. Electron is pinned in the lockfile; packages are unsigned/unnotarized ZIPs. The Windows ZIP includes the self-contained .NET runtime folder; do not extract only its helper EXE. The macOS ZIP preserves the app bundle. OS security prompts are not disabled or bypassed.

## Release gate

A prerelease `v*` tag runs all tests/builds again and releases only after every job passes. Existing releases/assets are never overwritten.

For the explicitly approved initial release, a separate commit may add `.github/release-request.json` with exactly:

```json
{"version":"v0.1.0-alpha.1","release":true}
```

Only a push to `main` that **changes that file** activates this one-shot route. The exact `github.sha` that passes all checks/builds is used as the tag target and release commit. Later unrelated pushes do not create releases. An already existing tag/release is not retargeted or overwritten. This same-run route is necessary because tags created using a workflow's `GITHUB_TOKEN` do not trigger another workflow run. Do not add this file until ordinary CI has been reviewed; it is intentionally absent from the initial workflow commit.

Only the release job receives `contents: write`; all other jobs are read-only, checkout does not persist credentials. Releases include both ZIPs and `SHA256SUMS.txt`, marked prerelease with unsigned/non-notarized warnings. No signing or external deployment credential is requested.

Manual package commands after the appropriate native helper is built:

```sh
npm run package:desktop
```

Only native macOS arm64 / Windows x64 packaging is defined. The script deliberately refuses other platforms rather than claiming cross-platform native validation.
