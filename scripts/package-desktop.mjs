import {cp, mkdir, readFile, rm, access} from 'node:fs/promises';
import {dirname, join, resolve, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import { packager } from '@electron/packager';
import { macSigningOptions } from './macos-signing.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const platform=process.platform, arch=process.arch;
if (!((platform==='darwin'&&arch==='arm64')||(platform==='win32'&&arch==='x64'))) throw Error('Packaging is defined only on native macOS arm64 / Windows x64 runners.');
const appSource=join(root,'apps/desktop');
const appPackage=JSON.parse(await readFile(join(appSource,'package.json'),'utf8'));
const version=process.env.TELEPORT_VERSION?.replace(/^v/,'') || appPackage.version;
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw Error('Invalid release version');
const stage=join(root,'artifacts/package-stage');
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
await cp(join(appSource,'src'),join(stage,'src'),{recursive:true});
const helper=platform==='darwin'?'native/teleport-input':'native/windows';
await access(join(appSource,helper));await cp(join(appSource,helper),join(stage,helper),{recursive:true});
await import('node:fs/promises').then(fs=>fs.writeFile(join(stage,'package.json'),JSON.stringify({name:'teleport',productName:'Teleport',version,type:'module',main:'src/main.cjs',description:'Phone-to-desktop encrypted text input',author:'Teleport contributors',dependencies:appPackage.dependencies},null,2)));
// Copy the exact npm-ci-installed production dependency closure. No second resolution/install.
// Fail rather than silently flatten incompatible versions.
const copied=new Map();
async function locate(name,from){let dir=from;for(;;){const p=join(dir,'node_modules',name,'package.json');try{await access(p);return dirname(p);}catch{}const up=dirname(dir);if(up===dir)throw Error(`Missing runtime dependency ${name}`);dir=up;}}
async function copyDependency(name,from){const source=await locate(name,from);const p=JSON.parse(await readFile(join(source,'package.json'),'utf8'));if(copied.has(name)){if(copied.get(name)!==p.version)throw Error(`Dependency version conflict: ${name}`);return;}copied.set(name,p.version);await cp(source,join(stage,'node_modules',name),{recursive:true,dereference:true,filter:path=>!relative(source,path).split(sep).includes('node_modules')});for(const dependency of Object.keys(p.dependencies||{}))await copyDependency(dependency,source);}
for(const name of Object.keys(appPackage.dependencies))await copyDependency(name,appSource);
const electronVersion=JSON.parse(await readFile(join(root,'node_modules/electron/package.json'),'utf8')).version;
const outputs=await packager({dir:stage,out:join(root,'artifacts/desktop'),name:'Teleport',platform,arch,electronVersion,appVersion:version,appBundleId:'dev.teleport.desktop',asar:false,prune:false,overwrite:true,osxSign:platform==='darwin'?macSigningOptions:false,osxNotarize:false});
console.log(outputs.join('\n'));
