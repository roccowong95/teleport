import QRCode from 'qrcode';
import './style.css';
import { mountReceiver } from './ui.js';
const api = window.__TAURI__;
if (!api?.core?.invoke || !api?.event?.listen) {
  document.getElementById('notice').textContent = 'Open Teleport in its Windows desktop app. The browser preview cannot connect or access credentials.';
  document.getElementById('setupSubmit').disabled = true;
} else {
  mountReceiver({document,invoke:api.core.invoke,listen:api.event.listen,drawQR:(canvas,url)=>QRCode.toCanvas(canvas,url,{width:220,margin:2,errorCorrectionLevel:'M'})})
    .then(() => api.core.invoke('smoke_ready'))
    .catch(()=>{document.getElementById('notice').textContent='The desktop service is unavailable. Close and reopen Teleport.';});
}
