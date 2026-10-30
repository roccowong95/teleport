import {test} from 'node:test';
import assert from 'node:assert/strict';
import guard from '../src/ipc-guard.cjs';
test('privileged IPC accepts only exact local main frame, rejects subframes/other renderers/navigation',()=>{
 const url='file:///test/index.html',frame={url},wc={mainFrame:frame},window={isDestroyed:()=>false,webContents:wc},event={sender:wc,senderFrame:frame};
 assert.equal(guard.isTrustedSender(event,window,url),true);
 assert.equal(guard.isTrustedSender({...event,sender:{}},window,url),false);
 assert.equal(guard.isTrustedSender({...event,senderFrame:{url}},window,url),false);
 assert.equal(guard.isTrustedSender(event,window,'file:///other.html'),false);
 assert.equal(guard.isTrustedSender(event,{...window,isDestroyed:()=>true},url),false);
 assert.equal(guard.isTrustedSender({...event,senderFrame:null},window,url),false);
});
