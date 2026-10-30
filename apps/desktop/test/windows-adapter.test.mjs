import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {WindowsAdapter} from '../src/adapters.mjs';
function spawnFixture(code=0){let observed;return {spawn(command,args,options){const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=text=>{observed={command,args,options,text};queueMicrotask(()=>child.emit('exit',code));};return child;},get observed(){return observed;}};}
test('Windows adapter passes exact Unicode only through stdin, hidden process, no shell or Enter',async()=>{const f=spawnFixture(),adapter=new WindowsAdapter('C:\\Test Dir\\teleport-input.exe',{spawnImpl:f.spawn});const text='中文 👩🏽‍💻\nline & echo not-a-command';await adapter.inject(text);assert.equal(f.observed.text,text);assert.deepEqual(f.observed.args,[]);assert.equal(f.observed.options.shell,false);assert.equal(f.observed.options.windowsHide,true);});
test('Windows helper refusal propagates rather than claiming injection',async()=>{const f=spawnFixture(2),adapter=new WindowsAdapter('teleport-input.exe',{spawnImpl:f.spawn});await assert.rejects(adapter.inject('hello'),/target_refused/);});
