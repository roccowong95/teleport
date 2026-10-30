// Local integrity seal only: no certificate, keychain identity or notarization.
// Keep osx-sign's Electron-specific per-helper JIT/hardened-runtime defaults.
export const macSigningOptions = {
  identity: '-',
  identityValidation: false,
  continueOnError: false,
  optionsForFile: () => ({timestamp: 'none'}),
};
