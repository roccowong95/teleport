import test from 'node:test'; import assert from 'node:assert/strict';
import {generateIdentity,randomToken,seal,open,sas,encodePairing,decodePairing,ReceiverGate,validEndpoint} from '../index.js';
const a=generateIdentity(),b=generateIdentity(), c={roomId:'test-room-12345678',sender:'owner',recipient:'phone'};
test('Unicode authenticated encryption roundtrip and fresh nonce',()=>{let p={kind:'text',text:'你好 👨‍👩‍👧‍👦\n第二行'};let e=seal(p,c,b.publicKey,a.secretKey);assert.deepEqual(open(e,c,a.publicKey,b.secretKey),p);assert.notEqual(seal(p,c,b.publicKey,a.secretKey).nonce,e.nonce);assert.ok(!JSON.stringify(e).includes('你好'));});
test('ciphertext, key and context tampering fail closed',()=>{let e=seal({kind:'text',text:'secret'},c,b.publicKey,a.secretKey);assert.throws(()=>open({...e,ciphertext:(e.ciphertext[0]==='A'?'B':'A')+e.ciphertext.slice(1)},c,a.publicKey,b.secretKey));assert.throws(()=>open(e,{...c,roomId:'other'},a.publicKey,b.secretKey));assert.throws(()=>open(e,c,generateIdentity().publicKey,b.secretKey));assert.throws(()=>open({...e,v:0},c,a.publicKey,b.secretKey));});
test('SAS matches endpoints and binds room',async()=>{assert.equal(await sas(a.secretKey,b.publicKey,c.roomId),await sas(b.secretKey,a.publicKey,c.roomId));assert.notEqual(await sas(a.secretKey,b.publicKey,c.roomId),await sas(a.secretKey,b.publicKey,'other'));});
test('pairing validation and expiry',()=>{let p={v:1,endpoint:'https://example.com',roomId:c.roomId,pairToken:randomToken(),ownerPublicKey:a.publicKey,name:'测试电脑',expiresAt:Date.now()+10000};let e=encodePairing(p);assert.deepEqual(decodePairing(e),p);assert.throws(()=>decodePairing(e,Date.now()+11000));assert.throws(()=>encodePairing({...p,endpoint:'http://example.com'}));assert.throws(()=>decodePairing('invalid'));});
test('endpoint transport validation',()=>{assert.equal(validEndpoint('http://localhost:8787'),'http://localhost:8787');for(const u of ['http://public.example','https://x:a@example.com','https://example.com/path','file:///tmp'])assert.throws(()=>validEndpoint(u));});
const msg=(now=Date.now())=>({kind:'text',id:crypto.randomUUID(),sessionId:'s',text:'中文🙂',sentAt:now,expiresAt:now+15000});
test('gate rejects duplication before injection',()=>{let g=new ReceiverGate('s'),m=msg();assert.equal(g.accept(m).ok,true);assert.equal(g.accept(m).code,'duplicate');});
test('gate guards stale, future, session, size and controls',()=>{let now=Date.now(), g=new ReceiverGate('s');for(let patch of [{expiresAt:now-1},{sentAt:now+9000},{sessionId:'other'},{text:'x'.repeat(8193)},{text:'\x1b[31m'},{text:''},{expiresAt:now+30000}])assert.equal(g.accept({...msg(now),...patch},{now}).ok,false);assert.equal(g.accept(msg(now),{paused:true}).code,'paused');assert.equal(g.accept(msg(now),{authorized:false}).code,'unauthorized');});
test('reject low-order peer keys',()=>{assert.throws(()=>seal({kind:'text'},c,'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',a.secretKey),/invalid_peer_key/);});

test('optional pressEnter is legacy-compatible but strictly boolean when present',()=>{
 const gate = new ReceiverGate('s');
 assert.equal(gate.accept(msg()).ok,true);
 for(const pressEnter of [false,true]) assert.equal(gate.accept({...msg(),pressEnter}).ok,true);
 for(const pressEnter of [null,undefined,0,1,'true','false',[],{}]) assert.equal(gate.accept({...msg(),pressEnter}).code,'invalid_press_enter');
 const invalid={...msg(),pressEnter:'true'};
 assert.equal(gate.accept(invalid).code,'invalid_press_enter');
 assert.equal(gate.accept({...invalid,pressEnter:false}).ok,true,'invalid options must not consume message IDs');
});
test('pressEnter option is authenticated and frozen inside ciphertext with unchanged text',()=>{
 const payload={...msg(),text:'line 1\nline 2',pressEnter:true};
 const envelope=seal(payload,c,b.publicKey,a.secretKey);
 payload.pressEnter=false;
 const received=open(envelope,c,a.publicKey,b.secretKey);
 assert.equal(received.pressEnter,true);assert.equal(received.text,'line 1\nline 2');
 assert.equal(JSON.stringify(envelope).includes('pressEnter'),false);
});
test('text schema rejects unknown action fields without consuming the message ID',()=>{
 const gate=new ReceiverGate('s');
 for(const extra of [{execute:true},{action:'enter'},{press_enter:true},{mode:'unicode'},{capabilities:{pressEnter:true}}]) {
  const message=msg();assert.equal(gate.accept({...message,...extra}).code,'invalid_message');assert.equal(gate.accept(message).ok,true);
 }
});
