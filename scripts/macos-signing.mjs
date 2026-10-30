import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
// Ad-hoc builds have no Team ID, so hardened-runtime library validation cannot
// accept the embedded non-platform Electron Framework. Keep hardened runtime/JIT
// and amend only app-bundle entitlements, never system settings or native helper.
export function createMacSigningOptions(outputDirectory) {
  mkdirSync(outputDirectory,{recursive:true});
  const defaults=join(dirname(dirname(fileURLToPath(import.meta.resolve('@electron/osx-sign')))),'entitlements');
  const files={};
  for(const role of ['main','plugin','gpu','renderer']) {
    const filename=role==='main'?'default.darwin.plist':`default.darwin.${role}.plist`;
    const original=readFileSync(join(defaults,filename),'utf8');
    if((original.match(/<\/dict>/g)||[]).length!==1)throw Error('Unexpected Electron entitlement format');
    const amended=original.includes('<key>com.apple.security.cs.disable-library-validation</key>') ? original : original.replace('</dict>','  <key>com.apple.security.cs.disable-library-validation</key>\n    <true/>\n  </dict>');
    files[role]=join(outputDirectory,filename);writeFileSync(files[role],amended);
  }
  return {
    identity:'-', identityValidation:false, continueOnError:false,
    optionsForFile(filePath) {
      if(!filePath.endsWith('.app')) return {timestamp:'none'};
      const role=filePath.includes('(Plugin).app')?'plugin':filePath.includes('(GPU).app')?'gpu':filePath.includes('(Renderer).app')?'renderer':'main';
      return {timestamp:'none',entitlements:files[role]};
    },
  };
}
