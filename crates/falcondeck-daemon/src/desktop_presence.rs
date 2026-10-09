//! Local user presence for notification delivery, independent of window focus.

/// Give someone using another app two minutes before routing attention to a phone.
const DESKTOP_AWAY_AFTER_SECONDS: f64 = 120.0;

#[cfg(any(target_os = "macos", test))]
fn presence_from_idle_seconds(seconds: f64) -> Option<bool> {
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds < DESKTOP_AWAY_AFTER_SECONDS)
}

/// Returns native desktop presence, or `None` when the client activity lease
/// should be used instead. Query at delivery time so a hidden or suspended
/// webview cannot leave a stale presence flag behind.
pub fn native_desktop_is_present() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        macos::is_present()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
        fn CFBooleanGetValue(value: *const c_void) -> u8;
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            text: *const std::ffi::c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }

    pub(super) fn is_present() -> Option<bool> {
        // SAFETY: Core Graphics returns an owned session dictionary containing
        // the documented CFBoolean console property; release it after reading.
        let on_console = unsafe {
            let session = CGSessionCopyCurrentDictionary();
            if session.is_null() {
                return None;
            }
            // kCGSessionOnConsoleKey is a CFSTR macro, not an exported symbol.
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                c"kCGSSessionOnConsoleKey".as_ptr(),
                0x0800_0100, // kCFStringEncodingUTF8
            );
            if key.is_null() {
                CFRelease(session);
                return None;
            }
            let value = CFDictionaryGetValue(session, key);
            let on_console = (!value.is_null()).then(|| CFBooleanGetValue(value) != 0);
            CFRelease(key);
            CFRelease(session);
            on_console
        }?;
        if !on_console {
            return Some(false);
        }

        // HIDSystemState (1) uses the hardware input table across all apps.
        // kCGAnyInputEventType is UINT32_MAX. This reads elapsed time only; it
        // does not install an event tap or capture keys or mouse positions.
        let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) };
        super::presence_from_idle_seconds(seconds)
    }
}

#[cfg(test)]
mod tests {
    use super::presence_from_idle_seconds;

    #[test]
    fn switching_apps_keeps_the_two_minute_input_grace() {
        assert_eq!(presence_from_idle_seconds(0.0), Some(true));
        assert_eq!(presence_from_idle_seconds(90.0), Some(true));
        assert_eq!(presence_from_idle_seconds(119.999), Some(true));
        assert_eq!(presence_from_idle_seconds(120.0), Some(false));
        assert_eq!(presence_from_idle_seconds(3600.0), Some(false));
    }

    #[test]
    fn unavailable_idle_time_falls_back_to_client_activity() {
        assert_eq!(presence_from_idle_seconds(-1.0), None);
        assert_eq!(presence_from_idle_seconds(f64::NAN), None);
        assert_eq!(presence_from_idle_seconds(f64::INFINITY), None);
    }
}
