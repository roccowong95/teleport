// Source contracts supplement, never replace native compilation or real Mac acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const native = readFileSync(new URL('../src-tauri/src/input_macos.m', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/input.rs', import.meta.url), 'utf8');
test('macOS permission inspection is read-only and requesting stays separate', () => {
  const inspect = native.slice(native.indexOf('unsigned int teleport_mac_permissions'), native.indexOf('void teleport_mac_request_permission'));
  assert.match(inspect, /AXIsProcessTrusted\(\)/);
  assert.match(inspect, /CGPreflightPostEventAccess\(\)/);
  assert.doesNotMatch(inspect, /CGRequestPostEventAccess|AXIsProcessTrustedWithOptions/);
  assert.match(rust, /"accessibility" => 1, "postEvent" => 2, _ => return Err/);
});
test('macOS compatibility does not waive password, enabled, focus or modifier checks', () => {
  const focus = native.slice(native.indexOf('static const char *copy_focus'), native.indexOf('static const char *recheck'));
  const compatibilityGate = focus.indexOf('if (!error && !compatibility)');
  for (const guard of ['input_permission_required', 'input_desktop_unavailable', 'input_modifier_held', 'input_focus_pid_mismatch', 'input_target_disabled', 'input_target_not_focused', 'input_password_unknown', 'input_password_target']) {
    assert.ok(focus.indexOf(guard) >= 0 && focus.indexOf(guard) < compatibilityGate, guard);
  }
  assert.match(focus, /kAXUnknownSubrole/);
  assert.match(focus.slice(compatibilityGate), /kAXSelectedTextAttribute/);
});
test('macOS checks cancellation at posting and marks attempted events unknown before posting', () => {
  const pair = native.slice(native.indexOf('static const char *post_pair'), native.indexOf('const char *teleport_mac_inject'));
  assert.ok(pair.indexOf('cancelled(context)') < pair.indexOf('posting(context)'));
  assert.ok(pair.indexOf('posting(context)') < pair.indexOf('CGEventPost(kCGHIDEventTap, down)'));
  assert.match(pair, /CGEventPost\(kCGHIDEventTap, up\)/);
  assert.match(rust, /with_posting_progress\(failure\(code\), &context.posting\)/);
});
test('macOS Return is explicit, after complete text, guarded again; no clipboard or text reads', () => {
  assert.match(native, /if \(!error && enter\)/);
  const enter = native.slice(native.indexOf('if (!error && enter)'));
  assert.ok(enter.indexOf('recheck(') < enter.indexOf('post_pair('));
  assert.match(enter, /CGEventCreateKeyboardEvent\(NULL, 36, true\)/);
  assert.match(native, /last >= 0xd800 && last <= 0xdbff/);
  assert.doesNotMatch(native, /NSPasteboard|kAXValueAttribute|AXUIElementCopyAttributeValue\([^;]*kAXSelectedTextAttribute/);
});
