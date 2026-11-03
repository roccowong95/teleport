import {mkdir,readFile,readdir,rm,stat,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Package only on native macOS arm64 after app build and smoke');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version=process.env.TELEPORT_VERSION||'v0.3.0-alpha.1';
if(!/^v0\.3\.\d+-[0-9A-Za-z.-]+$/.test(version))throw Error('Invalid macOS lightweight prerelease version');
const output=join(root,'artifacts/macos-lightweight'),stage=join(output,'portable');
await mkdir(output,{recursive:true});await rm(stage,{recursive:true,force:true});await mkdir(stage);
const source=join(root,'apps/windows-tauri/src-tauri/target/release/bundle/macos/Teleport.app');
execFileSync('codesign',['--verify','--strict','--verbose=2',source],{stdio:'inherit'});
execFileSync('ditto',[source,join(stage,'Teleport.app')],{stdio:'inherit'});
await writeFile(join(stage,'README.txt'),`Teleport ${version} — lightweight macOS arm64 preview\n\nUses Apple's system WKWebView; no Electron, Node.js, .NET or bundled browser engine. Ad-hoc signed, NOT Developer ID signed or notarized. Respect macOS security warnings; do not remove quarantine or disable Gatekeeper.\n\nThis is a separate app/profile from the Electron preview; the existing relay URL and pairings are not changed. Re-enter the SAME saved relay URL and explicitly pair this receiver. Do not reset the old profile. Secrets use macOS Keychain-backed protection with no plaintext fallback.\n\nInput starts paused. Accessibility/event-posting authorization is an explicit user action, never granted automatically. Strict input is default. Compatibility mode and phone Enter-after-text both default off. Enter can send a message or execute a command. Use harmless dedicated test fields only. A submitted event is not proof a target accepted or saved text. CI validates native build and actual WKWebView startup, not real focused-input acceptance.\n`);
const files=[];let expandedBytes=0;
async function walk(directory,prefix=''){
 for(const name of (await readdir(directory)).sort()){
  const path=join(directory,name),relative=prefix+name,info=await lstat(path);
  if(info.isSymbolicLink())throw Error('Unexpected symlink in lightweight bundle; review packaging');
  if(info.isDirectory()){if(/Electron|node_modules|WebView2|\.NET/i.test(name))throw Error('Unexpected bundled runtime');await walk(path,relative+'/');}
  else if(info.isFile()){const bytes=await readFile(path);files.push({name:relative,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});expandedBytes+=bytes.length;}
  else throw Error('Unexpected non-regular bundle entry');
 }
}
await walk(stage);
if(expandedBytes>80*1024*1024)throw Error('Unexpected app payload >80 MiB; investigate runtime bundling');
const name=`Teleport-macos-arm64-lightweight-${version}`,zip=join(output,name+'.zip');
await rm(zip,{force:true});execFileSync('ditto',['-c','-k','--sequesterRsrc',stage,zip],{stdio:'inherit'});
const compressedBytes=(await stat(zip)).size;
if(compressedBytes>50*1024*1024)throw Error('Unexpected ZIP >50 MiB; investigate runtime bundling');
const archive=await readFile(zip);
const manifest={version,sourceCommit:process.env.GITHUB_SHA||null,platform:'macos',arch:'arm64',variant:'tauri-system-wkwebview',signature:'ad-hoc (not Developer ID, not notarized)',compressedBytes,expandedBytes,archive:{name:name+'.zip',sha256:createHash('sha256').update(archive).digest('hex')},files,excludedRuntimes:['Electron','Node.js','.NET','bundled browser engine'],externalPrerequisites:['macOS system WKWebView (not included in size totals)'],acceptance:'CI app/WKWebView startup only; real focus, password refusal, permissions, text and Enter require manual Mac acceptance'};
await writeFile(join(output,name+'.manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({compressedBytes,expandedBytes,sha256:manifest.archive.sha256}));
