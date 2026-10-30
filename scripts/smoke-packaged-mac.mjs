import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
if(process.platform!=='darwin')throw Error('Packaged macOS smoke must run on macOS');
const binary=resolve(process.argv[2]||'artifacts/desktop/Teleport-darwin-arm64/Teleport.app/Contents/MacOS/Teleport');
const directory=await mkdtemp(join(tmpdir(),'teleport-ci-smoke-'));
let stdout='',stderr='',timedOut=false;
try{
 const child=spawn(binary,[],{env:{...process.env,TELEPORT_CI_SMOKE_DIR:directory},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-16000);});
 child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-16000);});
 let killTimer;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);},60000);
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>{clearTimeout(timer);clearTimeout(killTimer);});
 if(timedOut||result.code!==0)throw Error(`Packaged app failed: timeout=${timedOut}, exit=${result.code}, signal=${result.signal}\n${stdout}\n${stderr}`);
 const marker=JSON.parse(await readFile(join(directory,'smoke-result.json'),'utf8'));
 if(marker.ready!==true||marker.renderer!==true||marker.permissions!==true)throw Error('App did not confirm main + renderer startup + read-only permission IPC');
 console.log('Packaged macOS app: main, sandboxed renderer and read-only permission IPC confirmed. No network/input/permission request or grant claimed.');
}finally{await rm(directory,{recursive:true,force:true});}
