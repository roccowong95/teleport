//! Narrow, fail-closed Windows text insertion. No clipboard, elevation, UIAccess,
//! target-text reads, synthesized Return, or automatic retry. Success means events
//! were posted, never that the target application saved/accepted them.

fn validate_text(text: &str) -> Result<(), String> {
    if text.is_empty() || text.len() > 8192 {
        return Err("input_size_refused".into());
    }
    if text.chars().any(|c| (c < '\u{20}' && !matches!(c, '\t' | '\n' | '\r')) || ('\u{7f}'..='\u{9f}').contains(&c)) {
        return Err("input_control_refused".into());
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

pub fn inject(text: &str) -> Result<(), String> {
    validate_text(text)?;
    #[cfg(windows)]
    { native::inject(text) }
    #[cfg(not(windows))]
    { let _ = text; Err("windows_input_unavailable".into()) }
}

#[cfg(windows)]
mod native {
    use super::unicode_chunks;
    use std::{ffi::c_void, mem::size_of, sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};
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

    type Result<T> = std::result::Result<T, String>;
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
    fn err<T>(_: T) -> String { "input_target_refused".into() }
    fn require(value: bool) -> Result<()> { if value { Ok(()) } else { Err("input_target_refused".into()) } }

    unsafe fn interactive_desktop() -> Result<()> {
        let mut session = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut session).map_err(err)?;
        require(session != 0)?;
        let desktop = Desktop(OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS).map_err(err)?);
        let mut name = [0u16; 256];
        let mut needed = 0;
        GetUserObjectInformationW(HANDLE(desktop.0.0), UOI_NAME, Some(name.as_mut_ptr().cast()), size_of::<[u16; 256]>() as u32, Some(&mut needed)).map_err(err)?;
        let end = name.iter().position(|c| *c == 0).ok_or_else(|| err(()))?;
        require(name[..end] == "Default".encode_utf16().collect::<Vec<_>>())
    }

    unsafe fn integrity(process: HANDLE) -> Result<u32> {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).map_err(err)?;
        let token = OwnedHandle(token);
        let mut size = 0;
        let _ = GetTokenInformation(token.0, TokenIntegrityLevel, None, 0, &mut size);
        require(size >= size_of::<TOKEN_MANDATORY_LABEL>() as u32 && size <= 65536)?;
        // u64 backing gives TOKEN_MANDATORY_LABEL the required alignment on x86/x64/ARM64.
        let mut bytes = vec![0u64; (size as usize + 7) / 8];
        GetTokenInformation(token.0, TokenIntegrityLevel, Some(bytes.as_mut_ptr().cast()), size, &mut size).map_err(err)?;
        let label = &*bytes.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        require(IsValidSid(label.Label.Sid).as_bool())?;
        let count = GetSidSubAuthorityCount(label.Label.Sid);
        require(!count.is_null() && *count > 0)?;
        let rid = GetSidSubAuthority(label.Label.Sid, u32::from(*count - 1));
        require(!rid.is_null())?;
        Ok(*rid)
    }

    unsafe fn bool_property(element: &IUIAutomationElement, id: UIA_PROPERTY_ID, expected: bool) -> Result<()> {
        let value = Variant(element.GetCurrentPropertyValueEx(id, true).map_err(err)?);
        require(value.exact_bool() == Some(expected))
    }
    unsafe fn runtime_id(element: &IUIAutomationElement) -> Result<Vec<i32>> {
        let array = Array(element.GetRuntimeId().map_err(err)?);
        require(!array.0.is_null() && SafeArrayGetDim(array.0) == 1)?;
        require(SafeArrayGetVartype(array.0).map_err(err)? == VT_I4)?;
        let lower = SafeArrayGetLBound(array.0, 1).map_err(err)?;
        let upper = SafeArrayGetUBound(array.0, 1).map_err(err)?;
        let count = i64::from(upper) - i64::from(lower) + 1;
        require((1..=64).contains(&count))?;
        let mut values = Vec::with_capacity(count as usize);
        for index in lower..=upper {
            let mut value = 0i32;
            SafeArrayGetElement(array.0, &index, (&mut value as *mut i32).cast::<c_void>()).map_err(err)?;
            values.push(value);
        }
        Ok(values)
    }

    unsafe fn focus(automation: &IUIAutomation) -> Result<Focus> {
        interactive_desktop()?;
        // Never release or synthesize a modifier that the user is holding.
        for key in [0x10, 0x11, 0x12, 0x5b, 0x5c] {
            require((GetAsyncKeyState(key) as u16 & 0x8000) == 0)?;
        }
        let hwnd = GetForegroundWindow();
        require(!hwnd.0.is_null())?;
        let mut pid = 0;
        require(GetWindowThreadProcessId(hwnd, Some(&mut pid)) != 0 && pid != 0)?;
        let process = OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(err)?);
        require(integrity(process.0)? <= integrity(GetCurrentProcess())?)?;
        let element = automation.GetFocusedElement().map_err(err)?;
        require(element.CurrentProcessId().map_err(err)? as u32 == pid)?;
        bool_property(&element, UIA_IsEnabledPropertyId, true)?;
        bool_property(&element, UIA_HasKeyboardFocusPropertyId, true)?;
        bool_property(&element, UIA_IsKeyboardFocusablePropertyId, true)?;
        bool_property(&element, UIA_IsPasswordPropertyId, false)?;
        let control = Variant(element.GetCurrentPropertyValueEx(UIA_ControlTypePropertyId, true).map_err(err)?);
        require(matches!(control.exact_i32(), Some(value) if value == UIA_EditControlTypeId.0 || value == UIA_DocumentControlTypeId.0))?;
        // Metadata only: do not retrieve document contents, selection text or Value.
        let writable = match element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            Ok(value) => !value.CurrentIsReadOnly().map_err(err)?.as_bool(),
            Err(_) => {
                let text = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).map_err(err)?;
                let range = text.DocumentRange().map_err(err)?;
                let read_only = Variant(range.GetAttributeValue(UIA_IsReadOnlyAttributeId).map_err(err)?);
                read_only.exact_bool() == Some(false) // Mixed/unsupported/default objects are refused.
            }
        };
        require(writable)?;
        let runtime_id = runtime_id(&element)?;
        require(GetForegroundWindow() == hwnd)?;
        Ok(Focus { hwnd, pid, runtime_id })
    }

    unsafe fn run(text: &str) -> Result<()> {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(err)?;
        let _apartment = Apartment;
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let settings: IUIAutomation2 = automation.cast().map_err(err)?;
        settings.SetAutoSetFocus(false).map_err(err)?;
        settings.SetConnectionTimeout(750).map_err(err)?;
        settings.SetTransactionTimeout(750).map_err(err)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let initial = focus(&automation)?;
        for chunk in unicode_chunks(text) {
            let current = focus(&automation)?;
            require(current.hwnd == initial.hwnd && current.pid == initial.pid && current.runtime_id == initial.runtime_id)?;
            if Instant::now() >= deadline { return Err("input_deadline_exceeded".into()); }
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
            if SendInput(&events, size_of::<INPUT>() as i32) != events.len() as u32 {
                return Err("input_posting_unconfirmed".into());
            }
        }
        Ok(())
    }

    pub(super) fn inject(text: &str) -> Result<()> {
        if BUSY.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
            return Err("input_busy".into());
        }
        let text = text.to_owned();
        // Dedicated MTA avoids COM apartment conflicts with the WebView/GUI STA.
        // Caller must not run this blocking function on the GUI event loop.
        let worker = std::thread::Builder::new().name("teleport-input".into()).spawn(move || {
            let _busy = BusyGuard;
            unsafe { run(&text) }
        });
        match worker {
            Ok(worker) => worker.join().unwrap_or_else(|_| Err("input_worker_failed".into())),
            Err(_) => { BUSY.store(false, Ordering::Release); Err("input_worker_unavailable".into()) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    #[cfg(windows)]
    #[test] fn official_input_union_has_platform_layout() {
        use windows::Win32::UI::Input::KeyboardAndMouse::INPUT;
        assert_eq!(std::mem::size_of::<INPUT>(), if std::mem::size_of::<usize>() == 8 { 40 } else { 28 });
    }
    #[cfg(not(windows))]
    #[test] fn non_windows_refuses_input() { assert_eq!(inject("harmless"), Err("windows_input_unavailable".into())); }
}
