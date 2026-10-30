import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('Native helper requires macOS and Apple SDK; no cross-platform success is claimed.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {encoding:'utf8'}).trim();
const clang = execFileSync('xcrun', ['--sdk', 'macosx', '--find', 'clang'], {encoding:'utf8'}).trim();
execFileSync(clang, ['-fobjc-arc', '-mmacosx-version-min=10.15', '-Wall', '-Wextra', '-isysroot', sdk, resolve(root,'native/TeleportInput.m'), '-o', resolve(root,'native/teleport-input'), '-framework','AppKit','-framework','ApplicationServices'], {stdio:'inherit'});
