import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
function run(command, args, input, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('injection_timeout')); }, 3000);
    child.stdout.on('data', data => { if (output.length < 4096) output += data; });
    child.stderr.on('data', () => {}); // Never log text or subprocess input.
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('target_refused_or_changed')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
export class DryRunAdapter {
  label = 'Dry run — no OS input';
  constructor(onText = () => {}) { this.onText = onText; }
  async inject(text) { await this.onText(text); return { status: 'injected' }; }
}
export class MacAdapter {
  label = 'Focused editable field (macOS)';
  constructor(helper = fileURLToPath(new URL('../native/teleport-input', import.meta.url))) { this.helper = helper; }
  async inject(text) { await run(this.helper, [], text); return { status: 'injected' }; }
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
