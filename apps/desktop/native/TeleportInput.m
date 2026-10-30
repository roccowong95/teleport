// macOS-only. No clipboard, shell commands, synthetic Return or permission changes.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <string.h>

// Returns a retained element. Caller releases it. Fail closed on unsupported AX targets.
static AXUIElementRef CopySafeFocus(pid_t *pid) {
    if (!AXIsProcessTrusted() || !CGPreflightPostEventAccess()) return NULL;
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app) return NULL;
    AXUIElementRef root = AXUIElementCreateApplication(app.processIdentifier);
    CFTypeRef value = NULL;
    AXError result = AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute, &value);
    CFRelease(root);
    if (result != kAXErrorSuccess || !value) return NULL;
    if (CFGetTypeID(value) != AXUIElementGetTypeID()) { CFRelease(value); return NULL; }
    AXUIElementRef element = (AXUIElementRef)value;
    CFTypeRef role = NULL, subrole = NULL, enabled = NULL;
    Boolean writable = false;
    BOOL ok = AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role) == kAXErrorSuccess && role &&
        (CFEqual(role, kAXTextFieldRole) || CFEqual(role, kAXTextAreaRole));
    // Require subrole query success: unknown/unsupported sensitivity must not be guessed safe.
    ok = ok && AXUIElementCopyAttributeValue(element, kAXSubroleAttribute, &subrole) == kAXErrorSuccess && subrole &&
        !CFEqual(subrole, kAXSecureTextFieldSubrole);
    ok = ok && AXUIElementCopyAttributeValue(element, kAXEnabledAttribute, &enabled) == kAXErrorSuccess &&
        enabled && CFEqual(enabled, kCFBooleanTrue);
    ok = ok && AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute, &writable) == kAXErrorSuccess && writable;
    if (role) CFRelease(role);
    if (subrole) CFRelease(subrole);
    if (enabled) CFRelease(enabled);
    if (!ok) { CFRelease(element); return NULL; }
    *pid = app.processIdentifier;
    return element;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--check-access") == 0) {
            BOOL ready = AXIsProcessTrusted() && CGPreflightPostEventAccess();
            puts(ready ? "access_available" : "access_required");
            return ready ? 0 : 2; // Checks only; never prompts or changes system permission.
        }
        if (argc != 1) return 1;
        unsigned char bytes[8193];
        size_t count = fread(bytes, 1, sizeof(bytes), stdin);
        if (ferror(stdin) || count == 0 || count > 8192) return 1;
        NSString *text = [[NSString alloc] initWithBytes:bytes length:count encoding:NSUTF8StringEncoding];
        if (!text || text.length == 0) return 1;
        // Match protocol control policy even when the helper is invoked directly.
        for (NSUInteger i = 0; i < text.length; i++) {
            unichar c = [text characterAtIndex:i];
            if ((c < 32 && c != 9 && c != 10 && c != 13) || (c >= 0x7f && c <= 0x9f)) return 1;
        }
        pid_t initialPID = 0;
        AXUIElementRef initial = CopySafeFocus(&initialPID);
        if (!initial) return 2;
        int exitCode = 0;
        for (NSUInteger offset = 0; offset < text.length;) {
            NSUInteger length = MIN((NSUInteger)20, text.length - offset);
            unichar last = [text characterAtIndex:offset + length - 1];
            if (offset + length < text.length && last >= 0xd800 && last <= 0xdbff) length--;
            UniChar chunk[20];
            [text getCharacters:chunk range:NSMakeRange(offset, length)];
            pid_t currentPID = 0;
            AXUIElementRef current = CopySafeFocus(&currentPID);
            BOOL same = current && currentPID == initialPID && CFEqual(current, initial);
            if (current) CFRelease(current);
            if (!same) { exitCode = 2; break; }
            CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
            CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
            if (!down || !up) { if (down) CFRelease(down); if (up) CFRelease(up); exitCode = 1; break; }
            CGEventSetFlags(down, 0); CGEventSetFlags(up, 0);
            CGEventKeyboardSetUnicodeString(down, length, chunk);
            CGEventKeyboardSetUnicodeString(up, length, chunk);
            // Global event delivery is not atomic with the focus check. Partial failure is possible.
            CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
            CFRelease(down); CFRelease(up);
            offset += length;
        }
        CFRelease(initial);
        return exitCode; // Posting != target application accepted/saved the text.
    }
}
