import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { Receiver } from '../apps/desktop/src/controller.mjs';
import { DryRunAdapter } from '../apps/desktop/src/adapters.mjs';
import { generateIdentity,randomToken,decodePairing,seal,open,sas } from '@teleport/protocol';
async function until(check) {const end=Date.now()+7000;while(!check()){if(Date.now()>end)throw Error('Timeout');await new Promise(r=>setTimeout(r,10));}}
test('actual DO + desktop controller + phone protocol: encrypted Unicode, SAS, dedupe, reconnect, revoke',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'relay',modules:true,script:await readFile(new URL('../apps/relay/src/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-10-01',durableObjects:{ROOMS:{className:'Room',useSQLite:true}}}]}));
 class Socket extends EventEmitter {readyState=0;constructor(url){super();const u=new URL(url);u.protocol='https:';mf.dispatchFetch(u,{headers:{Upgrade:'websocket'}}).then(r=>{this.ws=r.webSocket;this.ws.accept();this.readyState=1;this.ws.addEventListener('message',e=>this.emit('message',Buffer.from(e.data)));this.ws.addEventListener('close',()=>{this.readyState=3;this.emit('close');});this.emit('open');}).catch(e=>this.emit('error',e));}send(x){this.ws.send(x);}close(){this.ws?.close();this.readyState=3;}}
 const fetchImpl=(url,init)=>mf.dispatchFetch(url,init);const texts=[];let saved,pending;
 const receiver=new Receiver({store:{load:async()=>saved,save:async s=>{saved=s;}},adapter:new DryRunAdapter(t=>texts.push(t)),WebSocketImpl:Socket,fetchImpl});receiver.on('pair-request',p=>pending=p);
 let phone;
 try {
 await receiver.initialize();await receiver.setup('https://localhost','Test desktop');await until(()=>receiver.connected);
 const qr=await receiver.pairing(),pair=decodePairing(new URL(qr.url).hash.slice(6)),identity=generateIdentity(),deviceId=randomUUID(),clientToken=randomToken();
 const res=await fetchImpl(`https://localhost/api/rooms/${pair.roomId}/pair`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairToken:pair.pairToken,deviceId,clientToken,publicKey:identity.publicKey,name:'Test phone'})});assert.equal(res.status,200);await until(()=>pending);assert.equal(pending.sas,await sas(identity.secretKey,pair.ownerPublicKey,pair.roomId));
 let ready,acks=[];phone=new Socket(`wss://localhost/api/rooms/${pair.roomId}/ws`);phone.on('open',()=>phone.send(JSON.stringify({type:'auth',role:'sender',deviceId,token:clientToken})));phone.on('message',d=>{const m=JSON.parse(d);if(m.type==='data'){const p=open(m.envelope,{roomId:pair.roomId,sender:'owner',recipient:deviceId},pair.ownerPublicKey,identity.secretKey);if(p.kind==='ready')ready=p;else acks.push(p);}});
 await until(()=>phone.readyState===1);await receiver.approve(deviceId,true);await until(()=>ready);assert.equal(ready.paused,true);await receiver.pause(false);await until(()=>!ready.paused);
 const sentAt=Date.now();const payload={kind:'text',id:randomUUID(),sessionId:ready.sessionId,text:'中文 👩🏽‍💻\nsecond line',sentAt,expiresAt:sentAt+15000};
 const send=p=>phone.send(JSON.stringify({type:'relay',to:'owner',envelope:seal(p,{roomId:pair.roomId,sender:deviceId,recipient:'owner'},pair.ownerPublicKey,identity.secretKey)}));
 send(payload);await until(()=>acks.length===1);assert.equal(acks[0].status,'injected',JSON.stringify(acks[0]));assert.deepEqual(texts,[payload.text]);send(payload);await until(()=>acks.length===2);assert.equal(acks[1].status,'rejected');assert.equal(texts.length,1);
 const old=ready.sessionId;receiver.connect();await until(()=>ready.sessionId!==old);assert.equal(ready.paused,true);send({...payload,id:randomUUID()});await until(()=>acks.length===3);assert.equal(acks[2].status,'rejected');assert.equal(texts.length,1);
 await receiver.revoke(deviceId);assert.equal(Object.keys(receiver.state.peers).length,0);
 }finally{receiver.stop();phone?.close();await mf.dispose();}
});
