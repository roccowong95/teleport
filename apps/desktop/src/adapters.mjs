import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
function run(command, args, input, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('injection_timeout')); }, 3000);
    child.stdout.on('data', data => { if (output.length < 4096) output += data; });
    child.stderr.on('data', () => {}); // Never log text or subprocess input.
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('target_refused_or_changed')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const unknownPermissions = error => ({ accessibility: 'unknown', postEvent: 'unknown', error });
function permissionStatus(command, args, spawnImpl, timeoutMs) {
  return new Promise(resolve => {
    let child, timer, output = '', settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    try { child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }); }
    catch { finish(unknownPermissions('permission_helper_unavailable')); return; }
    // Requests have a generous deadline for OS dialogs; timeout is UNKNOWN, never denial.
    timer = setTimeout(() => { finish(unknownPermissions('permission_check_timeout')); child.kill(); }, timeoutMs);
    child.stdout.on('data', data => {
      if (settled) return;
      output += data.toString();
      if (output.length > 4096) { finish(unknownPermissions('invalid_permission_response')); child.kill(); }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(unknownPermissions('permission_helper_unavailable')));
    child.on('close', code => {
      if (code !== 0) { finish(unknownPermissions('permission_helper_failed')); return; }
      try {
        const result = JSON.parse(output);
        const valid = value => ['granted', 'denied', 'unknown'].includes(value);
        if (!result || !valid(result.accessibility) || !valid(result.postEvent)) throw Error('invalid');
        finish({accessibility:result.accessibility, postEvent:result.postEvent});
      } catch { finish(unknownPermissions('invalid_permission_response')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end('');
  });
}
export class DryRunAdapter {
  label = 'Dry run — no OS input';
  constructor(onText = () => {}) { this.onText = onText; }
  async inject(text) { await this.onText(text); return { status: 'injected' }; }
}
export class MacAdapter {
  label = 'Focused editable field (macOS)';
  constructor(helper = fileURLToPath(new URL('../native/teleport-input', import.meta.url)), {spawnImpl = spawn, permissionCheckTimeoutMs = 5000, permissionRequestTimeoutMs = 120000} = {}) { Object.assign(this, {helper, spawnImpl, permissionCheckTimeoutMs, permissionRequestTimeoutMs}); }
  async inject(text) { await run(this.helper, [], text, this.spawnImpl); return { status: 'injected' }; }
  async checkPermissions() { return permissionStatus(this.helper, ['--permissions'], this.spawnImpl, this.permissionCheckTimeoutMs); }
  async requestPermission(kind) {
    const flag = kind === 'accessibility' ? '--request-accessibility' : kind === 'postEvent' ? '--request-post-event' : null;
    if (!flag) return unknownPermissions('invalid_permission_kind');
    return permissionStatus(this.helper, [flag], this.spawnImpl, this.permissionRequestTimeoutMs);
  }
}
export class WindowsAdapter {
  label = 'Focused editable field (Windows preview)';
  constructor(helper = fileURLToPath(new URL('../native/windows/teleport-input.exe', import.meta.url)), {spawnImpl = spawn} = {}) { this.helper = helper; this.spawnImpl = spawnImpl; }
  async inject(text) { await run(this.helper, [], text, this.spawnImpl); return {status:'injected'}; }
}
export class TmuxAdapter {
  constructor(pane, { optIn = false, spawnImpl = spawn } = {}) {
    if (!optIn || !/^%\d+$/.test(pane)) throw new Error('tmux requires explicit opt-in and numeric pane ID');
    this.pane = pane; this.spawnImpl = spawnImpl; this.label = `WIP tmux pane ${pane} — literal single line`;
  }
  async inject(text) {
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)) throw new Error('tmux_single_line_only');
    // Literal send-keys does not interpret key names; no Enter is appended.
    await run('tmux', ['send-keys', '-l', '-t', this.pane, '--', text], '', this.spawnImpl);
    return { status: 'injected' };
  }
}
export class UnsupportedAdapter { label = 'Unsupported platform — paused'; async inject() { throw new Error('unsupported_platform'); } }
