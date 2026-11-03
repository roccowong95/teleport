// In-process macOS backend. Never reads target text or invokes a shell/clipboard.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdbool.h>
#include <stdint.h>
#include <time.h>

typedef bool (*Cancelled)(const void *);
typedef void (*Posting)(const void *);

unsigned int teleport_mac_permissions(void) {
    return (AXIsProcessTrusted() ? 1U : 0U) | (CGPreflightPostEventAccess() ? 2U : 0U);
}
void teleport_mac_request_permission(unsigned int permission) {
    @autoreleasepool {
        if (permission == 1) {
            NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
            (void)AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
        } else if (permission == 2) {
            (void)CGRequestPostEventAccess();
        }
    }
}
static double monotonic_seconds(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t) != 0) return 0;
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
static const char *bool_attribute(AXUIElementRef element, CFStringRef attribute, const char *unknown, const char *refused) {
    CFTypeRef value = NULL;
    AXError result = AXUIElementCopyAttributeValue(element, attribute, &value);
    const char *error = unknown;
    if (result == kAXErrorSuccess && value && CFGetTypeID(value) == CFBooleanGetTypeID()) {
        error = CFBooleanGetValue((CFBooleanRef)value) ? NULL : refused;
    }
    if (value) CFRelease(value);
    return error;
}
// Returns retained focus with known non-secure subrole. Unknown password metadata
// is refused in BOTH modes; compatibility waives only role/writability metadata.
static const char *copy_focus(bool compatibility, AXUIElementRef *out, pid_t *pid) {
    if (teleport_mac_permissions() != 3) return "input_permission_required";
    CFDictionaryRef session = CGSessionCopyCurrentDictionary();
    bool interactive = session && CFEqual(CFDictionaryGetValue(session, kCGSessionOnConsoleKey) ?: kCFBooleanFalse, kCFBooleanTrue)
        && CFEqual(CFDictionaryGetValue(session, kCGSessionLoginDoneKey) ?: kCFBooleanFalse, kCFBooleanTrue)
        && !CFEqual(CFDictionaryGetValue(session, CFSTR("CGSSessionScreenIsLocked")) ?: kCFBooleanFalse, kCFBooleanTrue);
    if (session) CFRelease(session);
    if (!interactive) return "input_desktop_unavailable";
    CGEventFlags modifiers = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
    if (modifiers & (kCGEventFlagMaskShift | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand | kCGEventFlagMaskSecondaryFn)) return "input_modifier_held";
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app || app.processIdentifier <= 0) return "input_foreground_unavailable";
    *pid = app.processIdentifier;
    AXUIElementRef root = AXUIElementCreateApplication(*pid);
    if (!root) return "input_automation_unavailable";
    AXUIElementSetMessagingTimeout(root, 0.25);
    CFTypeRef value = NULL;
    AXError result = AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute, &value);
    CFRelease(root);
    if (result != kAXErrorSuccess || !value) { if (value) CFRelease(value); return "input_focus_unavailable"; }
    if (CFGetTypeID(value) != AXUIElementGetTypeID()) { CFRelease(value); return "input_focus_unavailable"; }
    AXUIElementRef element = (AXUIElementRef)value;
    AXUIElementSetMessagingTimeout(element, 0.25);
    const char *error = NULL;
    pid_t elementPID = 0;
    if (AXUIElementGetPid(element, &elementPID) != kAXErrorSuccess || elementPID != *pid) error = "input_focus_pid_mismatch";
    if (!error) error = bool_attribute(element, kAXEnabledAttribute, "input_enabled_unknown", "input_target_disabled");
    if (!error) error = bool_attribute(element, kAXFocusedAttribute, "input_focus_state_unknown", "input_target_not_focused");
    CFTypeRef subrole = NULL;
    if (!error) {
        if (AXUIElementCopyAttributeValue(element, kAXSubroleAttribute, &subrole) != kAXErrorSuccess || !subrole || CFGetTypeID(subrole) != CFStringGetTypeID()) error = "input_password_unknown";
        else if (CFEqual(subrole, kAXSecureTextFieldSubrole)) error = "input_password_target";
        else if (CFEqual(subrole, kAXUnknownSubrole) || CFStringGetLength((CFStringRef)subrole) == 0) error = "input_password_unknown";
    }
    if (subrole) CFRelease(subrole);
    if (!error && !compatibility) {
        CFTypeRef role = NULL;
        if (AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role) != kAXErrorSuccess || !role || CFGetTypeID(role) != CFStringGetTypeID()) error = "input_control_type_unknown";
        else if (!CFEqual(role, kAXTextFieldRole) && !CFEqual(role, kAXTextAreaRole)) error = "input_unsupported_control";
        if (role) CFRelease(role);
        Boolean writable = false;
        if (!error && AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute, &writable) != kAXErrorSuccess) error = "input_editability_unknown";
        if (!error && !writable) error = "input_target_readonly";
    }
    if (!error && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != *pid) error = "input_focus_changed";
    if (error) CFRelease(element); else *out = element;
    return error;
}
static const char *recheck(AXUIElementRef initial, pid_t pid, bool compatibility, double deadline, Cancelled cancelled, const void *context) {
    if (cancelled(context)) return "input_cancelled";
    AXUIElementRef current = NULL;
    pid_t currentPID = 0;
    const char *error = copy_focus(compatibility, &current, &currentPID);
    if (!error && (currentPID != pid || !CFEqual(current, initial))) error = "input_focus_changed";
    if (current) CFRelease(current);
    if (!error && monotonic_seconds() >= deadline) error = "input_deadline_exceeded";
    if (!error && cancelled(context)) error = "input_cancelled";
    return error;
}
static const char *post_pair(CGEventRef down, CGEventRef up, Cancelled cancelled, Posting posting, const void *context) {
    if (cancelled(context)) return "input_cancelled";
    // Cancellation and global focus cannot be atomic with event delivery. Once down
    // is attempted always send its matching up, even if cancellation arrives meanwhile.
    posting(context);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    // CGEventPost is void: successful submission is not acceptance by the target app.
    return NULL;
}
const char *teleport_mac_inject(const uint8_t *bytes, size_t count, bool compatibility, bool enter, Cancelled cancelled, Posting posting, const void *context) {
    @autoreleasepool {
        if (cancelled(context)) return "input_cancelled";
        if (!bytes || !count || count > 8192) return "input_size_refused";
        NSString *text = [[NSString alloc] initWithBytes:bytes length:count encoding:NSUTF8StringEncoding];
        if (!text || !text.length) return "input_size_refused";
        for (NSUInteger i = 0; i < text.length; i++) {
            unichar c = [text characterAtIndex:i];
            if ((c < 32 && c != 9 && c != 10 && c != 13) || (c >= 0x7f && c <= 0x9f)) return "input_control_refused";
        }
        AXUIElementRef initial = NULL;
        pid_t pid = 0;
        double deadline = monotonic_seconds() + 3.0;
        const char *error = copy_focus(compatibility, &initial, &pid);
        if (error) return error;
        for (NSUInteger offset = 0; offset < text.length;) {
            NSUInteger length = MIN((NSUInteger)20, text.length - offset);
            unichar last = [text characterAtIndex:offset + length - 1];
            if (offset + length < text.length && last >= 0xd800 && last <= 0xdbff) length--;
            UniChar chunk[20];
            [text getCharacters:chunk range:NSMakeRange(offset, length)];
            CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
            CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
            if (!down || !up) error = "input_worker_failed";
            if (!error) {
                CGEventSetFlags(down, 0); CGEventSetFlags(up, 0);
                CGEventKeyboardSetUnicodeString(down, length, chunk);
                CGEventKeyboardSetUnicodeString(up, length, chunk);
                error = recheck(initial, pid, compatibility, deadline, cancelled, context);
                if (!error) error = post_pair(down, up, cancelled, posting, context);
            }
            if (down) CFRelease(down); if (up) CFRelease(up);
            if (error) break;
            offset += length;
        }
        if (!error && enter) {
            // Explicit Return key only after the complete text phase and fresh guards.
            CGEventRef down = CGEventCreateKeyboardEvent(NULL, 36, true);
            CGEventRef up = CGEventCreateKeyboardEvent(NULL, 36, false);
            if (!down || !up) error = "input_worker_failed";
            if (!error) {
                CGEventSetFlags(down, 0); CGEventSetFlags(up, 0);
                error = recheck(initial, pid, compatibility, deadline, cancelled, context);
                if (!error) error = post_pair(down, up, cancelled, posting, context);
            }
            if (down) CFRelease(down); if (up) CFRelease(up);
        }
        if (!error && cancelled(context)) error = "input_cancelled";
        CFRelease(initial);
        return error;
    }
}
