#!/usr/bin/env node
// Deliberately ephemeral: this development CLI never writes credentials to disk.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { Receiver } from './controller.mjs';
import { DryRunAdapter, TmuxAdapter } from './adapters.mjs';
const {values} = parseArgs({options:{endpoint:{type:'string'},name:{type:'string',default:'Headless development receiver'},'dry-run':{type:'boolean'},'tmux-pane':{type:'string'},'allow-tmux':{type:'boolean'}}});
if (!values.endpoint || (!values['dry-run'] && !values['allow-tmux'])) throw Error('Supply --endpoint and either --dry-run or --allow-tmux --tmux-pane %N.');
const adapter=values['dry-run'] ? new DryRunAdapter() : new TmuxAdapter(values['tmux-pane'],{optIn:values['allow-tmux']});
const receiver=new Receiver({store:{load:async()=>null,save:async()=>{}},adapter,WebSocketImpl:WebSocket});
const terminal=createInterface({input:process.stdin,output:process.stdout});
let pending=null, shown=false;
receiver.on('notice',()=>process.stderr.write('Connection or message refused.\n'));
receiver.on('pair-request',p=>{pending=p; console.log(`Compare SAS on phone: ${p.sas}. Type approve to approve this pending phone, reject to reject.`);});
receiver.on('status',async state=>{if(state.connected&&!shown){shown=true;try{const pair=await receiver.pairing();console.log(`Private pairing URL (expires in 120s):\n${pair.url}\nCommands: approve, reject, resume, pause, pair, quit. Input starts paused.`);}catch{console.error('Pairing unavailable.');}}});
terminal.on('line',async line=>{try{switch(line.trim()){case 'approve':if(pending){await receiver.approve(pending.deviceId,true);pending=null;}break;case 'reject':if(pending){await receiver.approve(pending.deviceId,false);pending=null;}break;case 'resume':await receiver.pause(false);console.log('Input enabled.');break;case 'pause':await receiver.pause(true);console.log('Input paused.');break;case 'pair':console.log((await receiver.pairing()).url);break;case 'quit':await shutdown();break;default:console.log('Unknown command.');}}catch{console.error('Action refused.');}});
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;receiver.stop();try{await receiver.request(`/${receiver.state.roomId}`,null,'DELETE');}catch{}terminal.close();process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
await receiver.initialize();await receiver.setup(values.endpoint,values.name);
console.log(`${adapter.label}. Keys held in memory only; restart requires re-pairing. Text is never printed.`);
