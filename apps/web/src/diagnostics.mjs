// Messages are a closed whitelist: never render native exceptions, target text,
// window titles, or arbitrary peer-provided codes as diagnostic output.
const inputReasons = Object.freeze({
  "paused": "电脑已暂停接收，请在电脑端恢复。",
  "unauthorized": "该手机的授权已失效，请重新配对。",
  "expired": "这次发送已过期。",
  "session_mismatch": "电脑连接已更新，这次发送所属的会话已失效。",
  "duplicate": "电脑识别到重复消息。",
  "invalid_message": "消息校验未通过。",
  "invalid_text": "内容不符合输入要求，请检查大小与控制字符。",
  "rate_limited": "输入请求过于频繁，请稍后再手动发送。",
  "input_size_refused": "内容大小不符合电脑端限制，请缩短内容。",
  "input_control_refused": "内容含不允许的控制字符，请检查内容。",
  "input_cancelled": "电脑端已取消本次输入。",
  "windows_input_unavailable": "当前环境无法使用 Windows 输入功能。",
  "input_busy": "电脑正在处理另一次输入，请等待其完成。",
  "input_worker_failed": "电脑输入组件执行异常，请检查桌面端状态。",
  "input_worker_unavailable": "电脑输入组件不可用，请检查桌面端状态。",
  "input_deadline_exceeded": "电脑输入处理超时。",
  "input_posting_unconfirmed": "Windows 输入事件的提交未能完全确认，可能已输入部分文字。",
  "input_desktop_unavailable": "当前 Windows 桌面不可用，请返回正常的已解锁桌面。",
  "input_modifier_held": "电脑上有修饰键按住，请松开 Ctrl、Alt、Shift 或 Windows 键。",
  "input_foreground_unavailable": "未找到可用的前台窗口，请先点击目标输入框。",
  "input_integrity_unknown": "无法验证目标应用的权限级别，安全检查已停止输入。",
  "input_target_elevated": "目标应用的权限高于 Teleport。请以普通权限打开目标应用，不要为此提升 Teleport 权限。",
  "input_focus_unavailable": "无法读取输入焦点，请先点击目标输入框。",
  "input_focus_pid_mismatch": "焦点与前台应用不匹配，请重新点击目标输入框。",
  "input_enabled_unknown": "无法确认目标控件是否启用，安全检查已停止输入。",
  "input_target_disabled": "目标输入控件未启用，请选择可编辑的输入框。",
  "input_focus_state_unknown": "无法确认目标控件是否获得焦点，请重新点击输入框。",
  "input_target_not_focused": "目标输入框没有获得键盘焦点，请先点击输入框。",
  "input_focusable_unknown": "无法确认目标控件能否接收键盘输入。",
  "input_target_not_focusable": "目标控件不能接收键盘输入，请选择聊天输入框。",
  "input_password_unknown": "无法确认目标是否为密码框，安全检查已停止输入。",
  "input_password_target": "目标是密码输入框，Teleport 不向其中输入。",
  "input_control_type_unknown": "无法识别目标控件类型，安全检查已停止输入。",
  "input_unsupported_control": "目标控件类型不受支持；自定义输入框可能未提供所需的辅助功能信息。",
  "input_editability_unknown": "无法确认目标输入框是否可编辑，安全检查已停止输入。",
  "input_target_readonly": "目标控件为只读，请选择可编辑的输入框。",
  "input_unsupported_editability": "目标输入框未提供受支持的可编辑信息；请先用记事本验证连接。",
  "input_runtime_id_unavailable": "无法验证目标输入框身份，安全检查已停止输入。",
  "input_focus_changed": "输入期间目标焦点发生变化，请检查原窗口和当前窗口。",
  "input_automation_unavailable": "Windows 辅助功能接口不可用，请检查桌面端状态。",
  "injection_unconfirmed": "电脑未能确认输入处理结果。"
});
export const INPUT_DIAGNOSTIC_CODES = Object.freeze(Object.keys(inputReasons));
export function ackMessage(status, code) {
 if (status === 'injected') return '电脑已提交输入事件，但无法确认目标应用是否接收。若目标应用没有文字，请先点击目标输入框并检查应用权限；草稿已保留，不会自动重发。';
 const reason = typeof code === 'string' && Object.hasOwn(inputReasons, code) ? `${inputReasons[code]}[${code}] ` : '';
 if (status === 'rejected') return `电脑拒绝了这次发送。${reason || '请检查电脑端接收状态和目标输入框。'}草稿已保留，不会自动重发。`;
 return `结果未知：可能已输入全部或部分文字。${reason}请先检查电脑，再决定是否手动发送；草稿已保留，不会自动重发。`;
}
export function sendBlockReason({hasDevice, enabled, online, connected, approved, ready, paused, pending, bytes}) {
 if (pending) return '等待电脑确认中（最多 15 秒），请勿重复发送。';
 if (!hasDevice) return '尚未配对：请扫描电脑端二维码并批准连接。';
 if (!enabled) return '连接已停止：请点击「重新连接」；授权失效时请重新扫码。';
 if (!online) return '手机网络离线：恢复网络后才可发送，草稿不会排队发送。';
 if (!connected) return '连接尚未建立：请检查网络和电脑端连接状态。';
 if (!approved) return '等待配对批准：核对两端安全码后，在电脑端批准。';
 if (!ready) return '电脑尚未就绪：请确认桌面端在线，并等待加密通道恢复。';
 if (paused) return '电脑已暂停接收：请在电脑端恢复后再发送。';
 if (bytes > 8192) return '文字超过 8192 字节：请缩短内容后再发送。';
 if (bytes === 0) return '还没有文字：先输入或粘贴内容，再点击发送。';
 return '';
}
export function unknownMessage(reason) {
 const detail = reason === 'timeout' ? '等待电脑确认已超过 15 秒。' : reason === 'disconnected' ? '等待确认时连接或电脑会话中断。' : '';
 return `${detail}${ackMessage('unknown')}`;
}
