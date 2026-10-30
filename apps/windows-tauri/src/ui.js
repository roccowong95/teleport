// Presentation only. Identity, E2EE, transport, plaintext and input stay in Rust.
// Only exact, reviewed backend codes cross into diagnostics. Never print raw errors,
// response bodies, URLs, paths, tokens, stack traces or caller-supplied messages.
const ERROR_DETAILS = new Map([
  ['invalid_endpoint','Enter a valid relay origin.'],
  ['https_origin_required','Use an HTTPS origin without a path, credentials, query or fragment.'],
  ['invalid_name','Use a nonempty computer name within the supported length limit.'],
  ['already_configured','This computer is already configured. Reopen Teleport to refresh its status; do not create another room.'],
  ['relay_unreachable','The relay request could not be completed. This code alone does not identify the network cause.'],
  ['relay_timeout','The relay request timed out.'],
  ['relay_request_invalid','The desktop HTTP client could not prepare the relay request.'],
  ['relay_response_invalid','The desktop HTTP client could not read the relay response.'],
  ['relay_tls_failed','The relay connection reported a TLS failure.'],
  ['relay_dns_failed','The relay connection reported a name-resolution failure.'],
  ['relay_proxy_failed','The relay connection reported a proxy failure.'],
  ['relay_connect_failed','The desktop client could not establish the relay connection.'],
  ['relay_websocket_failed','The relay WebSocket connection failed.'],
  ['auth_failed','The receiver could not send its relay authentication.'],
  ['auth_timeout','Relay authentication timed out.'],
  ['invalid_auth','The relay authentication response was not accepted.'],
  ['socket_closed','The relay WebSocket connection closed.'],
  ['socket_error','The relay WebSocket reported a connection error.'],
  ['invalid_message','An invalid relay message was refused.'],
  ['oversized_frame','An oversized relay message was refused.'],
  ['send_timeout','Sending to the relay timed out.'],
  ['send_failed','Sending to the relay failed.'],
  ['relay_offline','Connect to the relay before retrying this operation.'],
  ['relay_busy_or_offline','The relay connection is unavailable or busy.'],
  ['invalid_relay_response','The relay response was not valid JSON in the expected format.'],
  ['relay_response_too_large','The relay response exceeded the allowed size.'],
  ['invalid_room','The relay did not return a valid room identifier.'],
  ['invalid_roomId','The relay response was missing its room identifier.'],
  ['secure_storage_unavailable','Windows secure credential encryption was unavailable. No plaintext fallback is used.'],
  ['windows_secure_storage_required','This receiver requires Windows secure credential storage.'],
  ['secure_store_directory_failed','The secure credential directory could not be created.'],
  ['secure_store_write_failed','Encrypted credentials could not be written.'],
  ['secure_store_replace_failed','The encrypted credential file could not be replaced.'],
  ['secure_store_read_failed','Saved encrypted credentials could not be read.'],
  ['secure_store_remove_failed','Saved encrypted credentials could not be removed.'],
  ['invalid_store_path','The secure credential destination is invalid.'],
  ['invalid_store_value','Credentials could not be prepared for secure storage.'],
  ['invalid_store_size','Secure credential data exceeded the allowed size.'],
  ['invalid_secure_store','The encrypted credential file is invalid.'],
  ['controller_stopped','The desktop receiver service is stopped. Reopen Teleport.'],
  ['untrusted_window','The desktop command was blocked by its window security check.'],
  ['untrusted_origin','The desktop command was blocked by its origin security check.'],
  ['window_unavailable','The desktop window could not be verified.'],
  ['http_initialization_failed','The desktop HTTP client could not be initialized.'],
  ['pairing_expired','Generate a new pairing code and compare the security codes again.'],
  ['invalid_pair_expiry','The relay returned an invalid pairing expiry.'],
  ['changed_peer_key','The phone key changed. Reject the request and verify the device.'],
  ['confirmation_required','Confirm this action explicitly before retrying.'],
  ['invalid_input_mode','The requested input mode was not recognized.'],
  ['compatibility_confirmation_required','Compatibility input requires explicit acceptance of its risks.'],
  ['input_busy','An input operation is still finishing.'],
  ['newer_stop_requested','A newer pause or disconnect took priority. Input remains paused.'],
]);
for(let status=100;status<=599;status++){ERROR_DETAILS.set(`relay_http_${status}`,`The relay returned HTTP ${status}.`);ERROR_DETAILS.set(`relay_websocket_http_${status}`,`The WebSocket handshake returned HTTP ${status}.`);}
const INPUT_DETAILS = new Map([
  ['input_worker_failed','The input worker could not confirm completion.'],
  ['input_worker_unavailable','The input worker could not be started.'],
  ['input_cancelled','Input was cancelled by a newer stop or safety action.'],
  ['input_size_refused','The text size was refused by the native input guard.'],
  ['input_control_refused','Control characters were refused by the native input guard.'],
  ['windows_input_unavailable','Native Windows input is unavailable in this environment.'],
  ['input_desktop_unavailable','A supported interactive Windows desktop could not be verified.'],
  ['input_integrity_unknown','The target security level could not be verified.'],
  ['input_target_elevated','The target runs at a higher security level. Use a normal, non-elevated target; do not bypass this guard.'],
  ['input_modifier_held','Release Shift, Ctrl, Alt and Windows keys before trying again.'],
  ['input_foreground_unavailable','The foreground target could not be verified.'],
  ['input_focus_unavailable','Windows accessibility could not identify the focused target.'],
  ['input_focus_pid_mismatch','The focused element did not match the foreground application.'],
  ['input_enabled_unknown','The target enabled state could not be verified.'],
  ['input_target_disabled','The target control is disabled.'],
  ['input_focus_state_unknown','The keyboard focus state could not be verified.'],
  ['input_target_not_focused','The target does not have keyboard focus.'],
  ['input_focusable_unknown','The target focusability could not be verified.'],
  ['input_target_not_focusable','The target cannot receive keyboard focus.'],
  ['input_password_unknown','Windows did not establish that the target is a non-password field. The safety guard remains active.'],
  ['input_password_target','Password fields are blocked. Choose a non-password editable field.'],
  ['input_control_type_unknown','The target control type could not be verified.'],
  ['input_unsupported_control','The target is not a supported editable control.'],
  ['input_target_readonly','The target is read-only.'],
  ['input_editability_unknown','Windows accessibility could not verify that the target is editable.'],
  ['input_unsupported_editability','The target does not expose the supported editable-field metadata.'],
  ['input_runtime_id_unavailable','A stable target identity could not be verified.'],
  ['input_focus_changed','The focused target changed during the operation.'],
  ['input_automation_unavailable','Windows accessibility automation is unavailable.'],
  ['input_deadline_exceeded','The native input operation exceeded its time limit.'],
  ['input_posting_unconfirmed','Windows did not confirm all requested input events.'],
  ['input_busy','Another input operation is still finishing.'],
  ['injection_unconfirmed','Input completion could not be confirmed.'],
  ['unauthorized','The sending phone is not authorized.'],
  ['paused','Input is paused. Resume explicitly before a new send.'],
  ['invalid_message','The received message was refused.'],
  ['invalid_text','The received text failed the safety checks.'],
  ['session_mismatch','The message belongs to an earlier receiver session.'],
  ['expired','The message expired before it could be accepted.'],
  ['duplicate','This message was already handled. Inspect the target before a new send.'],
  ['rate_limited','The receiver temporarily refused additional messages.'],
]);
function inputDiagnostic(result){
  const status=['submitted','rejected','unknown'].includes(result?.status)?result.status:'unknown';
  if(status==='submitted')return 'Input diagnostic — submitted. Windows accepted the input events; this does not verify that the target app accepted or saved the text. Inspect the target field.';
  const code=typeof result?.code==='string'&&INPUT_DETAILS.has(result.code)?result.code:'unknown_input_result';
  const detail=INPUT_DETAILS.get(code)||'Unrecognized technical details were withheld to protect private data.';
  const outcome=status==='rejected'?'This attempt was rejected. Inspect the target and resolve the issue before sending again.':'Some or all text may already have been entered. If this request included Enter, it may also have been posted. Inspect the target field and app before any manual retry; Teleport does not automatically resend.';
  return `Input diagnostic — ${status} [${code}]. ${detail} ${outcome}`;
}
const STAGES={setup:'Setup command',setup_status:'Status refresh after successful setup',status:'Status refresh',pause:'Change input state',connection:'Change relay connection',pairing:'Create pairing code',approve:'Pairing approval',revoke:'Revoke phone',reset:'Reset room',set_input_mode:'Change input mode',input_mode_status:'Status refresh after input mode change'};
class UiFailure extends Error{constructor(stage,code){super('Safe UI diagnostic');this.stage=stage;this.code=code;}}
function safeCode(error){const value=typeof error==='string'?error:error instanceof Error?error.message:typeof error?.code==='string'?error.code:'';return ERROR_DETAILS.has(value)?value:'unknown_error';}
function diagnostic(error){
  const failure=error instanceof UiFailure?error:new UiFailure('action',safeCode(error));
  const label=STAGES[failure.stage]||'Desktop action';
  const detail=ERROR_DETAILS.get(failure.code)||'The error was not recognized; technical details were withheld to protect private data.';
  const next=failure.stage==='setup_status'?' Setup completed. Close and reopen Teleport to refresh status; do not repeat setup.':'';
  return `${label} failed [${failure.code}]. ${detail}${next}`;
}

export async function mountReceiver({document,invoke,listen,drawQR,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}) {
  const $=id=>document.getElementById(id);
  let state={configured:false,connected:false,paused:true,devices:[]}, pending=null, qrTimer, pendingTimer, qrVersion=0, statusVersion=0, resetBusy=false, modeBusy=false;
  const busy=new Set(), unlisten=[];
  const notice=text=>{$('notice').textContent=text;};
  async function call(command,args,stage=command){try{return await invoke(command,args);}catch(error){throw new UiFailure(stage,safeCode(error));}}
  function clearQR(){qrVersion++;clearTimer(qrTimer);$('qr').hidden=true;$('pairUrl').value='';const canvas=$('qrCanvas');canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);}
  function clearPending(){clearTimer(pendingTimer);pending=null;$('approval').hidden=true;$('sas').textContent='';$('phoneName').textContent='';}
  async function action(key,fn){if(busy.has(key))return;busy.add(key);const button=$(key);if(button)button.disabled=true;notice('');try{await fn();}catch(error){notice(diagnostic(error));}finally{busy.delete(key);if(button)button.disabled=false;renderControls();}}
  function renderControls(){
    $('newPair').disabled=!state.connected||busy.has('newPair');
    $('pause').disabled=!state.connected||busy.has('pause')||modeBusy;
    $('inputModeToggle').disabled=!state.connected||modeBusy;
    $('confirmInputMode').disabled=!state.connected||modeBusy;
    $('cancelInputMode').disabled=modeBusy;
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
    const compatibility=state.inputMode==='compatibility';
    $('inputModeStatus').textContent=compatibility?'Compatibility input mode — reduced target checks':'Strict input mode';
    $('inputModeStatus').className=compatibility?'compatibility-active':'';
    $('inputModeHint').textContent=compatibility?'Risk: text may go to the wrong place. App receipt is not verified. Focus and password/security guards still apply.':'Strict mode verifies the control type and writable-field metadata.';
    $('inputModeToggle').textContent=compatibility?'Return to strict input':'Enable compatibility input…';
    if((!state.connected||!state.configured||compatibility)&&$('inputModeDialog').open)$('inputModeDialog').close();
    const devices=Array.isArray(state.devices)?state.devices:[];$('devices').replaceChildren();$('noDevices').hidden=devices.length>0;
    for(const peer of devices){const li=document.createElement('li'),label=document.createElement('span'),button=document.createElement('button');label.textContent=`${peer.name} · ${peer.online?'online':'offline'}`;button.textContent='Revoke';button.type='button';button.className='secondary';button.onclick=()=>action(`revoke-${peer.deviceId}`,async()=>{button.disabled=true;try{await call('revoke',{deviceId:peer.deviceId});await refresh();}finally{button.disabled=false;}});li.append(label,button);$('devices').append(li);}
    if(!state.connected||!state.configured){clearQR();clearPending();}
    if(!state.configured&&$('resetDialog').open)$('resetDialog').close();
    renderControls();
  }
  async function refresh(stage='status'){const before=statusVersion;const result=await call('status',undefined,stage);if(before===statusVersion)render(result);}
  $('setupForm').onsubmit=event=>{event.preventDefault();return action('setupSubmit',async()=>{await call('setup',{endpoint:$('endpoint').value.trim(),name:$('name').value.trim()});await refresh('setup_status');});};
  $('pause').onclick=()=>action('pause',async()=>{await call('pause',{paused:!state.paused});await refresh();});
  $('connectionToggle').onclick=()=>action('connectionToggle',async()=>{await call('connection',{connected:!!state.disconnected});await refresh();});
  $('newPair').onclick=()=>action('newPair',async()=>{
    clearQR();const version=qrVersion;const pair=await call('pairing');
    if(version!==qrVersion||!state.connected)return;
    if(typeof pair.url!=='string'||!Number.isFinite(pair.expiresAt)||pair.expiresAt<=now())throw new UiFailure('pairing','pairing_expired');
    await drawQR($('qrCanvas'),pair.url);
    if(version!==qrVersion||!state.connected){clearQR();return;}
    $('pairUrl').value=pair.url;$('expiry').textContent='Expires shortly. Keep this pairing link private.';$('qr').hidden=false;
    qrTimer=setTimer(clearQR,Math.max(0,pair.expiresAt-now()));
  });
  for(const [id,confirmed] of [['approve',true],['reject',false]])$(id).onclick=()=>action('approvalAction',async()=>{
    if(!pending)return;const request=pending;renderControls();await call('approve',{deviceId:request.deviceId,confirmed});if(pending===request)clearPending();
  });
  async function changeInputMode(mode,confirmed){
    if(modeBusy)return;modeBusy=true;renderControls();notice('');$('inputModeError').textContent='';
    try{
      await call('set_input_mode',{mode,confirmed});
      if($('inputModeDialog').open)$('inputModeDialog').close();
      await refresh('input_mode_status');
      notice('Input mode updated. Input is paused; resume separately when the intended target is focused.');
    }catch(error){
      const message=diagnostic(error)+' Input mode is not confirmed by this interface; check its displayed state before resuming.';
      if($('inputModeDialog').open)$('inputModeError').textContent=message;else notice(message);
    }finally{modeBusy=false;renderControls();}
  }
  $('inputModeToggle').onclick=()=>{
    if(modeBusy||!state.connected)return;
    if(state.inputMode==='compatibility')return changeInputMode('strict',false);
    if($('inputModeDialog').open)return;
    $('inputModeError').textContent='';$('inputModeDialog').showModal();$('cancelInputMode').focus();
  };
  $('cancelInputMode').onclick=()=>{if(!modeBusy)$('inputModeDialog').close();};
  $('inputModeDialog').addEventListener('cancel',event=>{if(modeBusy)event.preventDefault();});
  $('confirmInputMode').onclick=()=>{
    if(modeBusy||!state.connected||!$('inputModeDialog').open||state.inputMode==='compatibility')return;
    return changeInputMode('compatibility',true);
  };
  $('reset').onclick=()=>{if(resetBusy||$('resetDialog').open)return;$('resetError').textContent='';$('resetDialog').showModal();$('cancelReset').focus();};
  $('cancelReset').onclick=()=>{if(!resetBusy)$('resetDialog').close();};
  $('resetDialog').addEventListener('cancel',event=>{if(resetBusy)event.preventDefault();});
  $('confirmReset').onclick=async()=>{
    if(resetBusy||!$('resetDialog').open)return;resetBusy=true;$('confirmReset').disabled=true;$('cancelReset').disabled=true;
    try{await call('reset',{confirmed:true});clearQR();clearPending();$('resetDialog').close();await refresh();}
    catch(error){$('resetError').textContent=diagnostic(error)+' Reset could not be confirmed; check current status before retrying.';}
    finally{resetBusy=false;$('confirmReset').disabled=false;$('cancelReset').disabled=false;}
  };
  // No navigation or file-drop surfaces. Native navigation/IPC scope must also deny remote content.
  const blockLink=event=>{if(event.target.closest?.('a'))event.preventDefault();};
  const blockDrop=event=>event.preventDefault();
  document.addEventListener('click',blockLink,true);document.addEventListener('drop',blockDrop);document.addEventListener('dragover',blockDrop);
  unlisten.push(await listen('status',event=>render(event.payload)));
  const knownNotices=new Set(['Message refused or connection error.','Relay refused an operation. Check authorization and connection.']);
  unlisten.push(await listen('notice',event=>notice(knownNotices.has(event.payload)?event.payload:typeof event.payload==='string'&&INPUT_DETAILS.has(event.payload)&&(event.payload.startsWith('input_')||event.payload==='windows_input_unavailable'||event.payload==='injection_unconfirmed')?inputDiagnostic({status:'unknown',code:event.payload}):safeCode(event.payload)!=='unknown_error'?diagnostic(new UiFailure('connection',safeCode(event.payload))):'Receiver notice. Unrecognized details were withheld to protect private data.')));
  unlisten.push(await listen('input-result',event=>notice(inputDiagnostic(event.payload))));
  unlisten.push(await listen('pair-request',event=>{
    if(!state.connected)return;clearPending();clearQR();pending=event.payload;$('phoneName').textContent=pending.name;$('sas').textContent=pending.sas;$('approval').hidden=false;
    pendingTimer=setTimer(clearPending,Math.min(120000,Math.max(0,(pending.expiresAt||now()+120000)-now())));renderControls();
  }));
  await refresh();
  return {refresh,destroy(){clearQR();clearPending();for(const off of unlisten)off();document.removeEventListener('click',blockLink,true);document.removeEventListener('drop',blockDrop);document.removeEventListener('dragover',blockDrop);}};
}
