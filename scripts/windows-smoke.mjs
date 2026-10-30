import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
if(process.platform!=='win32')throw Error('Windows executable smoke requires Windows');
const binary=resolve(process.argv[2]||'apps/windows-tauri/src-tauri/target/release/teleport-windows.exe');
const directory=await mkdtemp(join(tmpdir(),'teleport-windows-smoke-'));
let stdout='',stderr='',timedOut=false;
try{
 const child=spawn(binary,[],{env:{...process.env,TELEPORT_CI_SMOKE_DIR:directory},stdio:['ignore','pipe','pipe'],windowsHide:false});
 child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-16000);});
 child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-16000);});
 const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
 if(timedOut||result.code!==0)throw Error(`Windows startup failed: timeout=${timedOut} exit=${result.code} signal=${result.signal}\n${stdout}\n${stderr}`);
 const marker=JSON.parse(await readFile(join(directory,'smoke-result.json'),'utf8'));
 if(marker.ready!==true||marker.renderer!==true)throw Error('Rust + WebView renderer readiness not confirmed');
 console.log('Actual Windows executable and WebView renderer started and exited cleanly. No relay/input/UIPI acceptance claimed.');
}finally{await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:300});}
