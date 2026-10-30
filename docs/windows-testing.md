# Windows receiver — implementation and acceptance checklist

**Source implementation; no Windows desktop/input test has been performed.** Cloud cross-compilation, if reported separately, proves compilation only. Do not infer working focus detection, Unicode entry, UIAutomation support, UIPI behavior or packaging from a build.

## Build

Use Node 24, npm and the official .NET 10 SDK. In a clean checkout:

```powershell
npm ci
npm run check
node apps/desktop/scripts/build-windows-helper.mjs --rid win-x64
# Or --rid win-arm64 for a native Windows ARM64 build.
```

The helper project is `apps/desktop/native/TeleportInput.Windows.csproj`, targeting `net10.0-windows` with Windows UIAutomation references. It publishes a **self-contained directory** to `apps/desktop/native/windows/`; the entrypoint is `teleport-input.exe`. Keep the entire directory together, not just the `.exe`: it contains the .NET/WindowsDesktop runtime and dependencies. No installed .NET runtime is required for the published helper, but the SDK is required to build. Do not trim/single-file it without new validation. Run the build separately for each architecture; do not publish two RIDs concurrently into the same checkout/output directory. Intermediate caches are RID-specific. `DOTNET_BIN` may point to an isolated official SDK executable. Cross-compilation requires an explicit `--rid` and does not run the binary.

Electron itself must also match the intended platform/architecture. This helper does not provide a Windows signing identity. CI build artifacts, if produced by the repository workflow, are compile/package outputs rather than desktop input acceptance. The executable uses an `asInvoker`, `uiAccess=false` manifest: **no administrative elevation** or UIPI bypass.

## What the helper does

- Takes strict UTF-8 on stdin, maximum 8192 bytes; prints no input/target text.
- Requires an interactive `Default` desktop and refuses locked/secure/unknown desktops.
- Checks current foreground window and PID, target integrity level no higher than its own, and focused UIAutomation runtime ID.
- Requires an enabled, keyboard-focused, non-password Edit/Document control supporting writable `ValuePattern` or a `TextPattern` with a definite non-read-only attribute. Missing/unsupported properties are refused rather than guessed safe.
- Refuses while Shift/Ctrl/Alt/Windows keys are held, rather than changing the user's keyboard state.
- Before each small Unicode chunk, rechecks the desktop, foreground window/PID and same UIAutomation element. Surrogate pairs are not split across chunks.
- Calls `SendInput` with Unicode scan units and matching up events. It adds **no Return**, clipboard action or shell command. Input posting count must match; otherwise it fails without retry.

`teleport-input.exe --check-access` reports only interactive-desktop availability. It cannot guarantee access to any particular window or predict UIPI success. Exit 0 after input means events were posted, not that the target accepted/saved them. Any nonzero/timeout is handled by the desktop receiver as unknown/refused; partial insertion is possible. Never automatically resend.

## Deliberate compatibility limits

Custom/canvas editors, some Chromium/Office/rich text controls, terminals and providers lacking a definite writable Value/Text pattern may be refused. This narrow first version does **not** claim arbitrary Windows input compatibility. Newline/tab characters carried as Unicode may be interpreted differently by applications despite not synthesizing Return. A global focus race remains between the final check and event delivery. An administrator window is not a reason to elevate Teleport: use a normal-integrity harmless test window instead. Secure desktops/password fields are outside scope.

## Evening acceptance (user-controlled Windows machine only)

1. Confirm exact commit, Windows version/architecture, Electron version and helper build result.
2. Start local relay and receiver in a dedicated test directory; use a clean Electron profile. No user documents/accounts are needed.
3. Pair with SAS comparison, keep receiving paused until a new unsaved **harmless test editor** has focus.
4. Check Chinese, emoji/surrogate pairs, selection replacement, multiline/tab, long text, and no added Enter. Record each target application's result, including refusal.
5. Check pause, disconnect, key revocation, changed focus mid-message, held modifiers, higher-integrity target refusal, password refusal, and locked desktop. Do not enter any real credentials or invoke a destructive shell. Do not grant admin rights to make a failed case pass.
6. Capture ACK/unknown semantics without logging the input text; inspect the test document before any manual retry.
7. Stop only processes launched for this test and remove only that isolated test directory if desired.

## Primary references

Microsoft documents [SendInput's UIPI restrictions, event count and held-key behavior](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) and [Unicode KEYBDINPUT/VK_PACKET semantics](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput). These guarantees do not prove this implementation works in every application; real acceptance remains required.
