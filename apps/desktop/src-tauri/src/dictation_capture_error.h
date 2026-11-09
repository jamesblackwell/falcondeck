#pragma once

#import <AVFoundation/AVFoundation.h>
#include <errno.h>

// Use error codes rather than localized descriptions, which can contain paths.
// AVFoundation may wrap a filesystem error in an otherwise generic failure.
static NSString *FDCaptureFailureReason(NSError *error) {
  for (NSUInteger depth = 0; error && depth < 8; depth++) {
    if (([error.domain isEqualToString:AVFoundationErrorDomain] &&
         error.code == AVErrorDiskFull) ||
        ([error.domain isEqualToString:NSCocoaErrorDomain] &&
         error.code == NSFileWriteOutOfSpaceError) ||
        ([error.domain isEqualToString:NSPOSIXErrorDomain] &&
         (error.code == ENOSPC || error.code == EDQUOT))) {
      return @"Not enough disk space to save microphone audio. Free up space on your Mac, then try recording again.";
    }
    if ([error.domain isEqualToString:AVFoundationErrorDomain]) {
      switch (error.code) {
        case AVErrorApplicationIsNotAuthorizedToUseDevice:
          return @"Microphone access is off for FalconDeck. Enable it in System Settings → Privacy & Security → Microphone.";
        case AVErrorDeviceWasDisconnected:
        case AVErrorDeviceNotConnected:
          return @"The selected microphone disconnected. Reconnect it or choose another input in Voice settings.";
        case AVErrorDeviceInUseByAnotherApplication:
          return @"The microphone is in use by another app. Close that app or choose another input in Voice settings.";
        default: break;
      }
    }
    error = error.userInfo[NSUnderlyingErrorKey];
  }
  return nil;
}

static NSString *FDEmptyCaptureMessage(NSError *error) {
  return FDCaptureFailureReason(error) ?:
      @"The microphone did not save any audio. Try recording again.";
}
