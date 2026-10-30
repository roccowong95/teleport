//! Narrow, fail-closed Windows text insertion. No clipboard, elevation, UIAccess,
//! target-text reads, implicit Return, or automatic retry. Optional Enter is explicit. Success means events
//! were posted, never that the target application saved/accepted them.

use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

/// Only these static codes may cross the native/controller/UI boundary.
pub const INPUT_FAILURE_CODES: &[&str] = &[
    "input_size_refused", "input_control_refused", "input_cancelled",
    "windows_input_unavailable", "input_busy", "input_worker_failed", "input_worker_unavailable",
    "input_deadline_exceeded", "input_posting_unconfirmed", "input_desktop_unavailable",
    "input_modifier_held", "input_foreground_unavailable", "input_integrity_unknown", "input_target_elevated",
    "input_focus_unavailable", "input_focus_pid_mismatch", "input_enabled_unknown", "input_target_disabled",
    "input_focus_state_unknown", "input_target_not_focused", "input_focusable_unknown", "input_target_not_focusable",
    "input_password_unknown", "input_password_target", "input_control_type_unknown", "input_unsupported_control",
    "input_editability_unknown", "input_target_readonly", "input_unsupported_editability",
    "input_runtime_id_unavailable", "input_focus_changed", "input_automation_unavailable",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputFailure {
    pub code: &'static str,
    /// True as soon as SendInput is attempted, including zero/partial event counts.
    /// Once true, later cancellation/guard failure/panic must remain unknown.
    pub may_have_posted: bool,
}
fn failure(code: &'static str) -> InputFailure {
    debug_assert!(INPUT_FAILURE_CODES.contains(&code));
    InputFailure { code, may_have_posted: false }
}
#[cfg(any(windows, test))]
fn with_posting_progress(mut error: InputFailure, posting: &AtomicBool) -> InputFailure {
    error.may_have_posted |= posting.load(Ordering::Acquire);
    error
}


fn ensure_active(cancel: &AtomicBool) -> Result<(), InputFailure> {
    if cancel.load(Ordering::Acquire) { Err(failure("input_cancelled")) } else { Ok(()) }
}

fn validate_text(text: &str) -> Result<(), InputFailure> {
    if text.is_empty() || text.len() > 8192 {
        return Err(failure("input_size_refused"));
    }
    if text.chars().any(|c| (c < '\u{20}' && !matches!(c, '\t' | '\n' | '\r')) || ('\u{7f}'..='\u{9f}').contains(&c)) {
        return Err(failure("input_control_refused"));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn unicode_chunks(text: &str) -> Vec<Vec<u16>> {
    let mut chunks = Vec::new();
    let mut chunk = Vec::with_capacity(20);
    for c in text.chars() {
        let mut units = [0u16; 2];
        let encoded = c.encode_utf16(&mut units);
        if chunk.len() + encoded.len() > 20 {
            chunks.push(chunk);
            chunk = Vec::with_capacity(20);
        }
        chunk.extend_from_slice(encoded);
    }
    if !chunk.is_empty() { chunks.push(chunk); }
    chunks
}

/// Explicit per-injection choice; callers must never automatically retry in compatibility mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum InputMode {
    #[default]
    Strict,
    Compatibility,
}

#[cfg(any(windows, test))]
fn require_nonpassword_and_editability(
    mode: InputMode,
    password: Option<bool>,
    strict_editability: impl FnOnce() -> Result<(), InputFailure>,
) -> Result<(), InputFailure> {
    match password {
        Some(false) => {},
        Some(true) => return Err(failure("input_password_target")),
        None => return Err(failure("input_password_unknown")),
    }
    // Compatibility waives ONLY control classification and writable-pattern metadata.
    // All focus, identity, privilege, cancellation and desktop gates remain outside this gate.
    match mode {
        InputMode::Strict => strict_editability(),
        InputMode::Compatibility => Ok(()),
    }
}

pub fn inject(text: &str) -> Result<(), InputFailure> {
    inject_cancellable(text, Arc::new(AtomicBool::new(false)))
}

/// Cancellation stops future chunks; it cannot retract events already queued by Windows.
/// Use a fresh token per injection. Never clear/reuse a cancelled token.
pub fn inject_cancellable(text: &str, cancel: Arc<AtomicBool>) -> Result<(), InputFailure> {
    inject_cancellable_with_mode(text, cancel, InputMode::Strict, false)
}

/// Compatibility is an explicit, immutable choice for this injection, not a fallback.
pub fn inject_cancellable_with_mode(text: &str, cancel: Arc<AtomicBool>, mode: InputMode, press_enter: bool) -> Result<(), InputFailure> {
    ensure_active(&cancel)?;
    validate_text(text)?;
    #[cfg(windows)]
    { native::inject(text, cancel, mode, press_enter) }
    #[cfg(not(windows))]
    { let _ = (text, mode, press_enter); Err(failure("windows_input_unavailable")) }
}

/// Invoke only after the complete text phase succeeded. No retry or fallback here.
#[cfg(any(windows, test))]
fn finish_with_optional_enter(
    press_enter: bool,
    cancel: &AtomicBool,
    recheck: impl FnOnce() -> Result<(), InputFailure>,
    post_enter: impl FnOnce() -> Result<(), InputFailure>,
) -> Result<(), InputFailure> {
    if !press_enter { return Ok(()); }
    ensure_active(cancel)?;
    recheck()?;
    ensure_active(cancel)?;
    post_enter()
}

#[cfg(windows)]
mod native {
    use super::{finish_with_optional_enter, InputMode, require_nonpassword_and_editability, unicode_chunks, ensure_active, InputFailure, failure, with_posting_progress};
    use std::{ffi::c_void, mem::size_of, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
    use windows::{core::Interface, Win32::{
        Foundation::{CloseHandle, HANDLE, HWND},
        Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, SAFEARRAY},
            Ole::{SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayGetVartype},
            Variant::{VariantClear, VARIANT, VT_BOOL, VT_I4},
            Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
            RemoteDesktop::ProcessIdToSessionId,
            StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, HDESK, UOI_NAME},
        },
        UI::{
            Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement, IUIAutomationTextPattern, IUIAutomationValuePattern, UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_HasKeyboardFocusPropertyId, UIA_IsEnabledPropertyId, UIA_IsKeyboardFocusablePropertyId, UIA_IsPasswordPropertyId, UIA_IsReadOnlyAttributeId, UIA_TextPatternId, UIA_ValuePatternId, UIA_PROPERTY_ID},
            Input::KeyboardAndMouse::{GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY},
            WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
        },
    }};

    type Result<T> = std::result::Result<T, InputFailure>;
    static BUSY: AtomicBool = AtomicBool::new(false);
    struct BusyGuard;
    impl Drop for BusyGuard { fn drop(&mut self) { BUSY.store(false, Ordering::Release); } }
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }
    struct Desktop(HDESK);
    impl Drop for Desktop { fn drop(&mut self) { unsafe { let _ = CloseDesktop(self.0); } } }
    struct Apartment;
    impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
    struct Variant(VARIANT);
    impl Drop for Variant { fn drop(&mut self) { unsafe { let _ = VariantClear(&mut self.0); } } }
    impl Variant {
        unsafe fn exact_bool(&self) -> Option<bool> {
            let inner = &self.0.Anonymous.Anonymous;
            if inner.vt != VT_BOOL { return None; }
            match inner.Anonymous.boolVal.0 { 0 => Some(false), -1 => Some(true), _ => None }
        }
        unsafe fn exact_i32(&self) -> Option<i32> {
            let inner = &self.0.Anonymous.Anonymous;
            if inner.vt == VT_I4 { Some(inner.Anonymous.lVal) } else { None }
        }
    }
    struct Array(*mut SAFEARRAY);
    impl Drop for Array { fn drop(&mut self) { if !self.0.is_null() { unsafe { let _ = SafeArrayDestroy(self.0); } } } }
    struct Focus { hwnd: HWND, pid: u32, runtime_id: Vec<i32> }
    fn require(value: bool, code: &'static str) -> Result<()> { if value { Ok(()) } else { Err(failure(code)) } }

    unsafe fn interactive_desktop() -> Result<()> {
        let mut session = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut session).map_err(|_| failure("input_desktop_unavailable"))?;
        require(session != 0, "input_desktop_unavailable")?;
        let desktop = Desktop(OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS).map_err(|_| failure("input_desktop_unavailable"))?);
        let mut name = [0u16; 256];
        let mut needed = 0;
        GetUserObjectInformationW(HANDLE(desktop.0.0), UOI_NAME, Some(name.as_mut_ptr().cast()), size_of::<[u16; 256]>() as u32, Some(&mut needed)).map_err(|_| failure("input_desktop_unavailable"))?;
        let end = name.iter().position(|c| *c == 0).ok_or_else(|| failure("input_desktop_unavailable"))?;
        require(name[..end] == "Default".encode_utf16().collect::<Vec<_>>(), "input_desktop_unavailable")
    }

    unsafe fn integrity(process: HANDLE) -> Result<u32> {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).map_err(|_| failure("input_integrity_unknown"))?;
        let token = OwnedHandle(token);
        let mut size = 0;
        let _ = GetTokenInformation(token.0, TokenIntegrityLevel, None, 0, &mut size);
        require(size >= size_of::<TOKEN_MANDATORY_LABEL>() as u32 && size <= 65536, "input_integrity_unknown")?;
        let mut bytes = vec![0u64; (size as usize + 7) / 8];
        GetTokenInformation(token.0, TokenIntegrityLevel, Some(bytes.as_mut_ptr().cast()), size, &mut size).map_err(|_| failure("input_integrity_unknown"))?;
        let label = &*bytes.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        require(IsValidSid(label.Label.Sid).as_bool(), "input_integrity_unknown")?;
        let count = GetSidSubAuthorityCount(label.Label.Sid);
        require(!count.is_null() && *count > 0, "input_integrity_unknown")?;
        let rid = GetSidSubAuthority(label.Label.Sid, u32::from(*count - 1));
        require(!rid.is_null(), "input_integrity_unknown")?;
        Ok(*rid)
    }

    unsafe fn bool_property(element: &IUIAutomationElement, id: UIA_PROPERTY_ID, expected: bool, unknown: &'static str, refused: &'static str) -> Result<()> {
        let value = Variant(element.GetCurrentPropertyValueEx(id, true).map_err(|_| failure(unknown))?);
        match value.exact_bool() {
            Some(actual) => require(actual == expected, refused),
            None => Err(failure(unknown)),
        }
    }
    unsafe fn runtime_id(element: &IUIAutomationElement) -> Result<Vec<i32>> {
        let code = "input_runtime_id_unavailable";
        let array = Array(element.GetRuntimeId().map_err(|_| failure(code))?);
        require(!array.0.is_null() && SafeArrayGetDim(array.0) == 1, code)?;
        require(SafeArrayGetVartype(array.0).map_err(|_| failure(code))? == VT_I4, code)?;
        let lower = SafeArrayGetLBound(array.0, 1).map_err(|_| failure(code))?;
        let upper = SafeArrayGetUBound(array.0, 1).map_err(|_| failure(code))?;
        let count = i64::from(upper) - i64::from(lower) + 1;
        require((1..=64).contains(&count), code)?;
        let mut values = Vec::with_capacity(count as usize);
        for index in lower..=upper {
            let mut value = 0i32;
            SafeArrayGetElement(array.0, &index, (&mut value as *mut i32).cast::<c_void>()).map_err(|_| failure(code))?;
            values.push(value);
        }
        Ok(values)
    }

    unsafe fn focus(automation: &IUIAutomation, mode: InputMode) -> Result<Focus> {
        interactive_desktop()?;
        for key in [0x10, 0x11, 0x12, 0x5b, 0x5c] {
            require((GetAsyncKeyState(key) as u16 & 0x8000) == 0, "input_modifier_held")?;
        }
        let hwnd = GetForegroundWindow();
        require(!hwnd.0.is_null(), "input_foreground_unavailable")?;
        let mut pid = 0;
        require(GetWindowThreadProcessId(hwnd, Some(&mut pid)) != 0 && pid != 0, "input_foreground_unavailable")?;
        let process = OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|_| failure("input_integrity_unknown"))?);
        require(integrity(process.0)? <= integrity(GetCurrentProcess())?, "input_target_elevated")?;
        let element = automation.GetFocusedElement().map_err(|_| failure("input_focus_unavailable"))?;
        require(element.CurrentProcessId().map_err(|_| failure("input_focus_unavailable"))? as u32 == pid, "input_focus_pid_mismatch")?;
        bool_property(&element, UIA_IsEnabledPropertyId, true, "input_enabled_unknown", "input_target_disabled")?;
        bool_property(&element, UIA_HasKeyboardFocusPropertyId, true, "input_focus_state_unknown", "input_target_not_focused")?;
        bool_property(&element, UIA_IsKeyboardFocusablePropertyId, true, "input_focusable_unknown", "input_target_not_focusable")?;
        let password = Variant(element.GetCurrentPropertyValueEx(UIA_IsPasswordPropertyId, true).map_err(|_| failure("input_password_unknown"))?);
        require_nonpassword_and_editability(mode, password.exact_bool(), || {
            let control = Variant(element.GetCurrentPropertyValueEx(UIA_ControlTypePropertyId, true).map_err(|_| failure("input_control_type_unknown"))?);
            let control_type = control.exact_i32().ok_or_else(|| failure("input_control_type_unknown"))?;
            require(control_type == UIA_EditControlTypeId.0 || control_type == UIA_DocumentControlTypeId.0, "input_unsupported_control")?;
            // Metadata only: never retrieve target text, titles, process names, Value or selection text.
            match element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                Ok(value) => require(!value.CurrentIsReadOnly().map_err(|_| failure("input_editability_unknown"))?.as_bool(), "input_target_readonly")?,
                Err(_) => {
                    let text = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).map_err(|_| failure("input_unsupported_editability"))?;
                    let range = text.DocumentRange().map_err(|_| failure("input_editability_unknown"))?;
                    let read_only = Variant(range.GetAttributeValue(UIA_IsReadOnlyAttributeId).map_err(|_| failure("input_editability_unknown"))?);
                    match read_only.exact_bool() {
                        Some(value) => require(!value, "input_target_readonly")?,
                        None => return Err(failure("input_editability_unknown")),
                    }
                }
            }
            Ok(())
        })?;
        let runtime_id = runtime_id(&element)?;
        require(GetForegroundWindow() == hwnd, "input_focus_changed")?;
        Ok(Focus { hwnd, pid, runtime_id })
    }

    unsafe fn run(text: &str, cancel: &AtomicBool, posting: &AtomicBool, mode: InputMode, press_enter: bool) -> Result<()> {
        ensure_active(cancel)?;
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(|_| failure("input_automation_unavailable"))?;
        let _apartment = Apartment;
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).map_err(|_| failure("input_automation_unavailable"))?;
        let settings: IUIAutomation2 = automation.cast().map_err(|_| failure("input_automation_unavailable"))?;
        settings.SetAutoSetFocus(false).map_err(|_| failure("input_automation_unavailable"))?;
        settings.SetConnectionTimeout(750).map_err(|_| failure("input_automation_unavailable"))?;
        settings.SetTransactionTimeout(750).map_err(|_| failure("input_automation_unavailable"))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let initial = focus(&automation, mode)?;
        for chunk in unicode_chunks(text) {
            ensure_active(cancel)?;
            let current = focus(&automation, mode)?;
            require(current.hwnd == initial.hwnd && current.pid == initial.pid && current.runtime_id == initial.runtime_id, "input_focus_changed")?;
            if Instant::now() >= deadline { return Err(failure("input_deadline_exceeded")); }
            let mut events = Vec::with_capacity(chunk.len() * 2);
            for unit in chunk {
                for up in [false, true] {
                    events.push(INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0), wScan: unit,
                        dwFlags: KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { Default::default() },
                        ..Default::default()
                    } } });
                }
            }
            // The final focus check and OS event delivery cannot be made atomic.
            // A partial count is unknown; never retry this text automatically.
            ensure_active(cancel)?;
            posting.store(true, Ordering::Release); // Arm before the call: even zero is conservatively unknown.
            if SendInput(&events, size_of::<INPUT>() as i32) != events.len() as u32 {
                return Err(failure("input_posting_unconfirmed"));
            }
        }
        finish_with_optional_enter(press_enter, cancel, || {
            let current = focus(&automation, mode)?;
            require(current.hwnd == initial.hwnd && current.pid == initial.pid && current.runtime_id == initial.runtime_id, "input_focus_changed")?;
            require(Instant::now() < deadline, "input_deadline_exceeded")
        }, || {
            // Explicit key event, not a newline appended to the text. Never reached after
            // a text-phase error or partial count. Focus-to-delivery cannot be atomic.
            let events = [false, true].map(|up| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0x0d), wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                    ..Default::default()
                } },
            });
            ensure_active(cancel)?;
            posting.store(true, Ordering::Release);
            require(SendInput(&events, size_of::<INPUT>() as i32) == events.len() as u32, "input_posting_unconfirmed")
        })
    }

    pub(super) fn inject(text: &str, cancel: Arc<AtomicBool>, mode: InputMode, press_enter: bool) -> Result<()> {
        ensure_active(&cancel)?;
        if BUSY.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
            return Err(failure("input_busy"));
        }
        let text = text.to_owned();
        let posting = Arc::new(AtomicBool::new(false));
        let worker_posting = posting.clone();
        // Dedicated MTA avoids COM apartment conflicts with the WebView/GUI STA.
        // Caller must not run this blocking function on the GUI event loop.
        let worker = std::thread::Builder::new().name("teleport-input".into()).spawn(move || {
            let _busy = BusyGuard;
            unsafe { run(&text, &cancel, &worker_posting, mode, press_enter) }.map_err(|error| with_posting_progress(error, &worker_posting))
        });
        match worker {
            Ok(worker) => worker.join().unwrap_or_else(|_| Err(with_posting_progress(failure("input_worker_failed"), &posting))),
            Err(_) => { BUSY.store(false, Ordering::Release); Err(failure("input_worker_unavailable")) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn enter_is_off_by_default_and_only_follows_successful_recheck() {
        let cancel = AtomicBool::new(false);
        assert!(finish_with_optional_enter(false, &cancel, || panic!("disabled"), || panic!("disabled")).is_ok());
        let steps = std::cell::RefCell::new(Vec::new());
        assert!(finish_with_optional_enter(true, &cancel, || { steps.borrow_mut().push("recheck"); Ok(()) }, || { steps.borrow_mut().push("enter"); Ok(()) }).is_ok());
        assert_eq!(*steps.borrow(), vec!["recheck", "enter"]);
        assert_eq!(finish_with_optional_enter(true, &cancel, || Err(failure("input_focus_changed")), || panic!("must not post after guard failure")), Err(failure("input_focus_changed")));
    }
    #[test] fn enter_is_not_posted_after_cancellation_or_text_failure() {
        let cancel = AtomicBool::new(true);
        assert_eq!(finish_with_optional_enter(true, &cancel, || panic!("already cancelled"), || panic!("already cancelled")), Err(failure("input_cancelled")));
        cancel.store(false, Ordering::Release);
        assert_eq!(finish_with_optional_enter(true, &cancel, || { cancel.store(true, Ordering::Release); Ok(()) }, || panic!("cancelled during recheck")), Err(failure("input_cancelled")));
        fn sequence(cancel: &AtomicBool) -> Result<(), InputFailure> {
            Err::<(), _>(failure("input_posting_unconfirmed"))?;
            finish_with_optional_enter(true, cancel, || panic!("text failed"), || panic!("text failed"))
        }
        assert_eq!(sequence(&cancel), Err(failure("input_posting_unconfirmed")));
    }
    #[test] fn strict_is_default_and_retains_editability_rejections() {
        assert_eq!(InputMode::default(), InputMode::Strict);
        for code in ["input_control_type_unknown", "input_unsupported_control", "input_editability_unknown", "input_target_readonly", "input_unsupported_editability"] {
            assert_eq!(require_nonpassword_and_editability(InputMode::Strict, Some(false), || Err(failure(code))), Err(failure(code)));
            assert!(require_nonpassword_and_editability(InputMode::Compatibility, Some(false), || panic!("compatibility must not inspect editability")).is_ok());
        }
        assert!(require_nonpassword_and_editability(InputMode::Strict, Some(false), || Ok(())).is_ok());
    }
    #[test] fn neither_mode_waives_password_or_unknown_password() {
        for mode in [InputMode::Strict, InputMode::Compatibility] {
            for (password, code) in [(None, "input_password_unknown"), (Some(true), "input_password_target")] {
                assert_eq!(require_nonpassword_and_editability(mode, password, || panic!("password gate must run first")), Err(failure(code)));
            }
        }
    }
    #[test] fn compatibility_still_validates_text_and_cancellation() {
        assert_eq!(inject_cancellable_with_mode("safe", Arc::new(AtomicBool::new(true)), InputMode::Compatibility, false), Err(failure("input_cancelled")));
        assert_eq!(inject_cancellable_with_mode("\0", Arc::new(AtomicBool::new(false)), InputMode::Compatibility, false), Err(failure("input_control_refused")));
        assert_eq!(inject_cancellable_with_mode("", Arc::new(AtomicBool::new(false)), InputMode::Compatibility, false), Err(failure("input_size_refused")));
    }
    #[test] fn unicode_and_whitespace_are_preserved() {
        let text = "你好 👩🏽‍💻\n下一行\tend\r";
        assert!(validate_text(text).is_ok());
        assert_eq!(String::from_utf16(&unicode_chunks(text).concat()).unwrap(), text);
    }
    #[test] fn reject_empty_oversize_and_control_text() {
        for text in ["", "\0", "\u{1b}", "\u{7f}", "\u{85}"] { assert!(validate_text(text).is_err()); }
        assert!(validate_text(&"a".repeat(8192)).is_ok());
        assert!(validate_text(&"a".repeat(8193)).is_err());
        assert!(validate_text(&"中".repeat(2731)).is_err());
    }
    #[test] fn chunks_never_split_surrogate_pairs_or_add_return() {
        let text = format!("{}😀{}", "a".repeat(19), "😀".repeat(50));
        let chunks = unicode_chunks(&text);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 20 && String::from_utf16(chunk).is_ok()));
        assert_eq!(String::from_utf16(&chunks.concat()).unwrap(), text);
    }
    #[test] fn already_cancelled_refuses_before_platform_work() {
        let cancel = Arc::new(AtomicBool::new(true));
        assert_eq!(inject_cancellable("harmless", cancel), Err(failure("input_cancelled")));
    }
    #[test] fn cancellation_is_observed_between_chunks() {
        let cancel = AtomicBool::new(false);
        let mut chunks = unicode_chunks(&"x".repeat(60)).into_iter();
        assert!(ensure_active(&cancel).is_ok());
        assert!(chunks.next().is_some());
        cancel.store(true, Ordering::Release);
        assert_eq!(ensure_active(&cancel), Err(failure("input_cancelled")));
        assert!(chunks.next().is_some()); // Remaining data exists, but must not be posted.
    }
    #[test] fn posting_attempt_permanently_changes_errors_to_unknown() {
        let posting = AtomicBool::new(false);
        assert!(!with_posting_progress(failure("input_password_target"), &posting).may_have_posted);
        posting.store(true, Ordering::Release);
        for code in ["input_cancelled", "input_focus_changed", "input_worker_failed", "input_posting_unconfirmed"] {
            let error = with_posting_progress(failure(code), &posting);
            assert_eq!(error.code, code);
            assert!(error.may_have_posted);
        }
        let already_unknown = InputFailure { code: "input_worker_failed", may_have_posted: true };
        assert!(with_posting_progress(already_unknown, &AtomicBool::new(false)).may_have_posted);
    }
    #[test] fn diagnostic_codes_are_fixed_and_unique() {
        let unique: std::collections::HashSet<_> = INPUT_FAILURE_CODES.iter().collect();
        assert_eq!(unique.len(), INPUT_FAILURE_CODES.len());
        assert!(INPUT_FAILURE_CODES.iter().all(|code| code.chars().all(|c| c.is_ascii_lowercase() || c == '_')));
    }
    #[cfg(windows)]
    #[test] fn official_input_union_has_platform_layout() {
        use windows::Win32::UI::Input::KeyboardAndMouse::INPUT;
        assert_eq!(std::mem::size_of::<INPUT>(), if std::mem::size_of::<usize>() == 8 { 40 } else { 28 });
    }
    #[cfg(not(windows))]
    #[test] fn non_windows_refuses_input() { assert_eq!(inject("harmless"), Err(failure("windows_input_unavailable"))); }
}
