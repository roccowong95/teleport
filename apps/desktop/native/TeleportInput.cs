// Windows-only helper: no clipboard, shell, elevation, UIAccess or synthetic Return.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

internal static class TeleportInput
{
    private const uint TokenQuery = 0x0008, ProcessQueryLimitedInformation = 0x1000;
    private const uint KeyEventUnicode = 0x0004, KeyEventKeyUp = 0x0002;
    private const int TokenIntegrityLevel = 25;
    private sealed record Focus(IntPtr Window, uint ProcessId, int[] RuntimeId);

    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public INPUTUNION data; }
    // MOUSEINPUT must be present: it determines the native INPUT union size/alignment.
    [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public HARDWAREINPUT hardware;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort virtualKey, scan; public uint flags, time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct HARDWAREINPUT { public uint message; public ushort low, high; }
    [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr sid; public uint attributes; }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr info, uint length, out uint needed);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    private static bool InteractiveDesktop()
    {
        if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0) return false;
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
        if (desktop == IntPtr.Zero) return false;
        try {
            var name = new StringBuilder(256);
            return GetUserObjectInformation(desktop, 2 /* UOI_NAME */, name, 512, out _) && name.ToString() == "Default";
        } finally { CloseDesktop(desktop); }
    }
    private static uint? Integrity(IntPtr process)
    {
        if (!OpenProcessToken(process, TokenQuery, out IntPtr token)) return null;
        try {
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out uint size);
            if (size == 0 || size > 65536) return null;
            IntPtr info = Marshal.AllocHGlobal((int)size);
            try {
                if (!GetTokenInformation(token, TokenIntegrityLevel, info, size, out _)) return null;
                var label = Marshal.PtrToStructure<SID_AND_ATTRIBUTES>(info);
                if (label.sid == IntPtr.Zero) return null;
                byte count = Marshal.ReadByte(GetSidSubAuthorityCount(label.sid));
                return count == 0 ? null : unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(label.sid, (uint)(count - 1))));
            } finally { Marshal.FreeHGlobal(info); }
        } finally { CloseHandle(token); }
    }
    private static bool CanTarget(uint pid)
    {
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (process == IntPtr.Zero) return false;
        try { uint? target = Integrity(process), ours = Integrity(GetCurrentProcess()); return target.HasValue && ours.HasValue && target.Value <= ours.Value; }
        finally { CloseHandle(process); }
    }
    private static bool BoolProperty(AutomationElement element, AutomationProperty property, bool expected)
        => element.GetCurrentPropertyValue(property, true) is bool value && value == expected;

    private static Focus? SafeFocus()
    {
        if (!InteractiveDesktop()) return null;
        // Do not release or synthesize user-held modifiers; refuse while held.
        foreach (int key in new[] { 0x10, 0x11, 0x12, 0x5b, 0x5c }) if ((GetAsyncKeyState(key) & 0x8000) != 0) return null;
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out uint pid) == 0 || !CanTarget(pid)) return null;
        AutomationElement element = AutomationElement.FocusedElement;
        if (element == null || element.Current.ProcessId != pid ||
            !BoolProperty(element, AutomationElement.IsEnabledProperty, true) ||
            !BoolProperty(element, AutomationElement.HasKeyboardFocusProperty, true) ||
            !BoolProperty(element, AutomationElement.IsKeyboardFocusableProperty, true) ||
            !BoolProperty(element, AutomationElement.IsPasswordProperty, false)) return null;
        object type = element.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty, true);
        if (!Equals(type, ControlType.Edit) && !Equals(type, ControlType.Document)) return null;
        // Read metadata only, never target text. Unknown/mixed read-only state is refused.
        bool writable;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out object pattern))
            writable = pattern is ValuePattern value && !value.Current.IsReadOnly;
        else if (element.TryGetCurrentPattern(TextPattern.Pattern, out object textPattern) && textPattern is TextPattern textProvider)
            writable = textProvider.DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute) is bool readOnly && !readOnly;
        else writable = false;
        if (!writable) return null;
        int[] runtimeId = element.GetRuntimeId();
        if (runtimeId == null || runtimeId.Length == 0 || GetForegroundWindow() != window) return null;
        return new Focus(window, pid, runtimeId);
    }
    private static INPUT Key(char c, bool up) => new() { type = 1, data = new INPUTUNION { keyboard = new KEYBDINPUT { virtualKey = 0, scan = c, flags = KeyEventUnicode | (up ? KeyEventKeyUp : 0) } } };

    // UIAutomation client operates on this non-UI MTA thread. It opens no window and takes no focus.
    [MTAThread]
    private static int Main(string[] args)
    {
        try {
            if (!OperatingSystem.IsWindows()) return 1;
            if (args.Length == 1 && args[0] == "--check-access") {
                // This is only interactive-desktop availability, not a promise of access to any target.
                bool available = InteractiveDesktop();
                Console.WriteLine(available ? "interactive_desktop_available_target_checks_still_required" : "interactive_desktop_unavailable");
                return available ? 0 : 2;
            }
            if (args.Length != 0 || Marshal.SizeOf<INPUT>() != (IntPtr.Size == 8 ? 40 : 28)) return 1;
            using Stream input = Console.OpenStandardInput();
            byte[] bytes = new byte[8193]; int count = 0, read;
            while (count < bytes.Length && (read = input.Read(bytes, count, bytes.Length - count)) > 0) count += read;
            if (count == 0 || count > 8192) return 1;
            string text = new UTF8Encoding(false, true).GetString(bytes, 0, count);
            foreach (char c in text) if ((c < 32 && c != '\t' && c != '\r' && c != '\n') || (c >= 0x7f && c <= 0x9f)) return 1;
            Focus? initial = SafeFocus(); if (initial == null) return 2;
            for (int offset = 0; offset < text.Length;) {
                int length = Math.Min(20, text.Length - offset);
                if (offset + length < text.Length && char.IsHighSurrogate(text[offset + length - 1])) length--;
                Focus? current = SafeFocus();
                if (current == null || current.Window != initial.Window || current.ProcessId != initial.ProcessId || !current.RuntimeId.SequenceEqual(initial.RuntimeId)) return 2;
                var events = new INPUT[length * 2];
                for (int i = 0; i < length; i++) { events[i * 2] = Key(text[offset + i], false); events[i * 2 + 1] = Key(text[offset + i], true); }
                if (SendInput((uint)events.Length, events, Marshal.SizeOf<INPUT>()) != (uint)events.Length) return 3;
                offset += length;
            }
            return 0; // Events posted, not proof of app acceptance or persistence. Partial failure can occur.
        } catch { return 1; } // No text, tokens or target contents in logs.
    }
}
