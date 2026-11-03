import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('macOS bundle smoke requires native macOS arm64');
const binary=resolve(process.argv[2]||'apps/windows-tauri/src-tauri/target/release/bundle/macos/Teleport.app/Contents/MacOS/teleport-windows');
const directory=await mkdtemp(join(tmpdir(),'teleport-macos-smoke-'));
let stdout='',stderr='',timedOut=false;
try{
 const child=spawn(binary,[],{env:{...process.env,TELEPORT_CI_SMOKE_DIR:directory},stdio:['ignore','pipe','pipe'],windowsHide:false});
 child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-16000);});
 child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-16000);});
 const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
 if(timedOut||result.code!==0)throw Error(`macOS startup failed: timeout=${timedOut} exit=${result.code} signal=${result.signal}\n${stdout}\n${stderr}`);
 const marker=JSON.parse(await readFile(join(directory,'smoke-result.json'),'utf8'));
 if(marker.ready!==true||marker.renderer!==true)throw Error('Rust + WebView renderer readiness not confirmed');
 console.log('Actual macOS app bundle and WKWebView renderer started and exited cleanly. No relay/input/Accessibility acceptance claimed.');
}finally{await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:300});}
