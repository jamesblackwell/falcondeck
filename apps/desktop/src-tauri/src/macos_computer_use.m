#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>

bool fd_computer_use_screen_recording_permission(void) {
  if (@available(macOS 10.15, *)) {
    return CGPreflightScreenCaptureAccess();
  }
  return false;
}

void fd_computer_use_request_screen_recording_permission(void) {
  if (@available(macOS 10.15, *)) {
    CGRequestScreenCaptureAccess();
  }
}

void fd_computer_use_open_screen_recording_settings(void) {
  NSURL *url = [NSURL URLWithString:
      @"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"];
  [NSWorkspace.sharedWorkspace openURL:url];
}

int32_t fd_computer_use_macos_major(void) {
  NSOperatingSystemVersion version = NSProcessInfo.processInfo.operatingSystemVersion;
  return (int32_t)version.majorVersion;
}
