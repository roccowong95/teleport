// Presentation only. Identity, E2EE, transport, plaintext and input stay in Rust.
export async function mountReceiver({document,invoke,listen,drawQR,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}) {
  const $=id=>document.getElementById(id);
  let state={configured:false,connected:false,paused:true,devices:[]}, pending=null, qrTimer, pendingTimer, qrVersion=0, statusVersion=0, resetBusy=false;
  const busy=new Set(), unlisten=[];
  const notice=text=>{$('notice').textContent=text;};
  function clearQR(){qrVersion++;clearTimer(qrTimer);$('qr').hidden=true;$('pairUrl').value='';const canvas=$('qrCanvas');canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);}
  function clearPending(){clearTimer(pendingTimer);pending=null;$('approval').hidden=true;$('sas').textContent='';$('phoneName').textContent='';}
  async function action(key,fn){if(busy.has(key))return;busy.add(key);const button=$(key);if(button)button.disabled=true;notice('');try{await fn();}catch{notice('Action failed. Check the connection or expired pairing, then retry. No text is replayed.');}finally{busy.delete(key);if(button)button.disabled=false;renderControls();}}
  function renderControls(){
    $('newPair').disabled=!state.connected||busy.has('newPair');
    $('pause').disabled=!state.connected||busy.has('pause');
    $('connectionToggle').textContent=state.disconnected?'Connect to relay':'Disconnect';
    $('approve').disabled=!pending||busy.has('approvalAction');$('reject').disabled=!pending||busy.has('approvalAction');
  }
  function render(value){
    state=value;statusVersion++;
    $('setup').hidden=!!state.configured;$('receiver').hidden=!state.configured;
    $('computer').textContent=state.name||'';
    $('connection').textContent=`${state.connected?'Relay connected':'Relay offline'} · ${state.paused?'Input paused':'Input enabled'}`;
    $('target').textContent=state.targetLabel||'Focused editable field (Windows)';
    $('pause').textContent=state.paused?'Resume input':'Pause input';
    const devices=Array.isArray(state.devices)?state.devices:[];$('devices').replaceChildren();$('noDevices').hidden=devices.length>0;
    for(const peer of devices){const li=document.createElement('li'),label=document.createElement('span'),button=document.createElement('button');label.textContent=`${peer.name} · ${peer.online?'online':'offline'}`;button.textContent='Revoke';button.type='button';button.className='secondary';button.onclick=()=>action(`revoke-${peer.deviceId}`,async()=>{button.disabled=true;try{await invoke('revoke',{deviceId:peer.deviceId});await refresh();}finally{button.disabled=false;}});li.append(label,button);$('devices').append(li);}
    if(!state.connected||!state.configured){clearQR();clearPending();}
    if(!state.configured&&$('resetDialog').open)$('resetDialog').close();
    renderControls();
  }
  async function refresh(){const before=statusVersion;const result=await invoke('status');if(before===statusVersion)render(result);}
  $('setupForm').onsubmit=event=>{event.preventDefault();return action('setupSubmit',async()=>{await invoke('setup',{endpoint:$('endpoint').value.trim(),name:$('name').value.trim()});await refresh();});};
  $('pause').onclick=()=>action('pause',async()=>{await invoke('pause',{paused:!state.paused});await refresh();});
  $('connectionToggle').onclick=()=>action('connectionToggle',async()=>{await invoke('connection',{connected:!!state.disconnected});await refresh();});
  $('newPair').onclick=()=>action('newPair',async()=>{
    clearQR();const version=qrVersion;const pair=await invoke('pairing');
    if(version!==qrVersion||!state.connected)return;
    if(typeof pair.url!=='string'||!Number.isFinite(pair.expiresAt)||pair.expiresAt<=now())throw Error('Expired pairing');
    await drawQR($('qrCanvas'),pair.url);
    if(version!==qrVersion||!state.connected){clearQR();return;}
    $('pairUrl').value=pair.url;$('expiry').textContent='Expires shortly. Keep this pairing link private.';$('qr').hidden=false;
    qrTimer=setTimer(clearQR,Math.max(0,pair.expiresAt-now()));
  });
  for(const [id,confirmed] of [['approve',true],['reject',false]])$(id).onclick=()=>action('approvalAction',async()=>{
    if(!pending)return;const request=pending;renderControls();await invoke('approve',{deviceId:request.deviceId,confirmed});if(pending===request)clearPending();
  });
  $('reset').onclick=()=>{if(resetBusy||$('resetDialog').open)return;$('resetError').textContent='';$('resetDialog').showModal();$('cancelReset').focus();};
  $('cancelReset').onclick=()=>{if(!resetBusy)$('resetDialog').close();};
  $('resetDialog').addEventListener('cancel',event=>{if(resetBusy)event.preventDefault();});
  $('confirmReset').onclick=async()=>{
    if(resetBusy||!$('resetDialog').open)return;resetBusy=true;$('confirmReset').disabled=true;$('cancelReset').disabled=true;
    try{await invoke('reset',{confirmed:true});clearQR();clearPending();$('resetDialog').close();await refresh();}
    catch{$('resetError').textContent='Reset could not be confirmed. Check the relay connection and current status before retrying.';}
    finally{resetBusy=false;$('confirmReset').disabled=false;$('cancelReset').disabled=false;}
  };
  // No navigation or file-drop surfaces. Native navigation/IPC scope must also deny remote content.
  const blockLink=event=>{if(event.target.closest?.('a'))event.preventDefault();};
  const blockDrop=event=>event.preventDefault();
  document.addEventListener('click',blockLink,true);document.addEventListener('drop',blockDrop);document.addEventListener('dragover',blockDrop);
  unlisten.push(await listen('status',event=>render(event.payload)));
  unlisten.push(await listen('notice',event=>notice(typeof event.payload==='string'?event.payload:'Receiver notice.')));
  unlisten.push(await listen('pair-request',event=>{
    if(!state.connected)return;clearPending();clearQR();pending=event.payload;$('phoneName').textContent=pending.name;$('sas').textContent=pending.sas;$('approval').hidden=false;
    pendingTimer=setTimer(clearPending,Math.min(120000,Math.max(0,(pending.expiresAt||now()+120000)-now())));renderControls();
  }));
  await refresh();
  return {refresh,destroy(){clearQR();clearPending();for(const off of unlisten)off();document.removeEventListener('click',blockLink,true);document.removeEventListener('drop',blockDrop);document.removeEventListener('dragover',blockDrop);}};
}
