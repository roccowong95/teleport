import {copyFile,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Package on Windows x64 after native build and smoke');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version=process.env.TELEPORT_VERSION||'v0.2.0-alpha.1';
if(!/^v0\.2\.\d+-[0-9A-Za-z.-]+$/.test(version))throw Error('Invalid lightweight prerelease version');
const output=join(root,'artifacts/windows-lightweight'),stage=join(output,'portable');
await mkdir(output,{recursive:true});await rm(stage,{recursive:true,force:true});await mkdir(stage);
const release=join(root,'apps/windows-tauri/src-tauri/target/release');
await copyFile(join(release,'teleport-windows.exe'),join(stage,'Teleport.exe'));
// Tauri may use a static loader; copy a sibling loader only when produced.
try{await copyFile(join(release,'WebView2Loader.dll'),join(stage,'WebView2Loader.dll'));}catch(error){if(error.code!=='ENOENT')throw error;}
await writeFile(join(stage,'README.txt'),`Teleport ${version} — lightweight Windows x64 preview\r\n\r\nRun Teleport.exe as a normal user, not administrator. Microsoft Edge WebView2 Evergreen Runtime must already be installed. Download it only from Microsoft's official site if absent. This ZIP does not contain Node.js, Electron, .NET or a fixed/offline WebView2 runtime.\r\n\r\nUnsigned preview; Windows security warnings are not bypassed. Real focus/password/UIPI acceptance requires manual testing in a harmless editor. CI startup only verifies Rust + WebView initialization. Mac remains the separate v0.1 release. Compatibility input is opt-in for this connection and resets on reconnect/restart. The phone can separately request Enter after text; it may send a message or execute a command. Both options default off.\r\n`);
const files=[];let expandedBytes=0;
for(const name of await readdir(stage)){const bytes=await readFile(join(stage,name));files.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});expandedBytes+=bytes.length;}
if(expandedBytes>80*1024*1024)throw Error('Unexpected portable payload >80 MiB; investigate accidental runtime bundling');
const zip=join(output,`Teleport-windows-x64-lightweight-${version}.zip`);
await rm(zip,{force:true});
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop"; Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $env:TELEPORT_PACKAGE_STAGE -File | ForEach-Object FullName) -DestinationPath $env:TELEPORT_PACKAGE_ZIP -CompressionLevel Optimal'],{env:{...process.env,TELEPORT_PACKAGE_STAGE:stage,TELEPORT_PACKAGE_ZIP:zip},stdio:'inherit'});
const compressedBytes=(await stat(zip)).size;
if(compressedBytes>50*1024*1024)throw Error('Unexpected ZIP >50 MiB; investigate accidental runtime bundling');
const archive=await readFile(zip);
const manifest={version,sourceCommit:process.env.GITHUB_SHA||null,platform:'windows',arch:'x64',variant:'tauri-system-webview2',signed:false,compressedBytes,expandedBytes,archive:{name:zip.split(/[\\/]/).at(-1),sha256:createHash('sha256').update(archive).digest('hex')},files,excludedRuntimes:['Electron','Node.js','.NET','fixed/offline WebView2'],externalPrerequisites:['Microsoft Edge WebView2 Evergreen Runtime (not included in size totals)'],acceptance:'CI startup smoke only; real input and UIPI require manual Windows acceptance'};
await writeFile(join(output,`Teleport-windows-x64-lightweight-${version}.manifest.json`),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({compressedBytes,expandedBytes,sha256:manifest.archive.sha256}));
