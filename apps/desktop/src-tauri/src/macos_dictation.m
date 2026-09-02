#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <Carbon/Carbon.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#import <Speech/Speech.h>
#import <objc/runtime.h>
#import <os/log.h>
#import "dictation_events.h"
#include <math.h>
#include <string.h>
#include <unistd.h>

extern void fd_dictation_emit(int32_t kind, const char *payload);

typedef struct {
  bool chord;
  CGKeyCode keyCode;
  CGEventFlags requiredFlags;
  CGEventFlags deviceMask;
} FDHotkey;

typedef NS_ENUM(NSInteger, FDActivationMode) {
  FDActivationModeHold = 0,
  FDActivationModeToggle = 1,
};

typedef NS_ENUM(NSInteger, FDProvider) {
  FDProviderSystem = 0,
  FDProviderOpenRouter = 1,
};

static const CGKeyCode FDRightCommandKeyCode = 54;
static const CGKeyCode FDFunctionKeyCode = 63;
static const CGKeyCode FDRightOptionKeyCode = 61;
static const CGKeyCode FDEscapeKeyCode = 53;
static const CGKeyCode FDLeftCommandKeyCode = 55;
static const CGKeyCode FDLeftOptionKeyCode = 58;
static const CGKeyCode FDRightControlKeyCode = 62;
static const CGKeyCode FDLeftControlKeyCode = 59;
static const CGKeyCode FDCapsLockKeyCode = 57;
static const CGKeyCode FDUnknownKeyCode = (CGKeyCode)UINT16_MAX;

static CGEventFlags FDSignificantFlags(CGEventFlags flags) {
  return flags & (kCGEventFlagMaskShift | kCGEventFlagMaskControl |
                  kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand);
}

static BOOL FDHotkeysEqual(FDHotkey a, FDHotkey b) {
  return a.chord == b.chord && a.keyCode == b.keyCode &&
         a.requiredFlags == b.requiredFlags && a.deviceMask == b.deviceMask;
}

static FDHotkey FDModifierHotkey(CGKeyCode keyCode, CGEventFlags deviceMask) {
  return (FDHotkey){false, keyCode, 0, deviceMask};
}

static FDHotkey FDDefaultHotkey(void) {
  return FDModifierHotkey(FDRightCommandKeyCode, NX_DEVICERCMDKEYMASK);
}

static CGKeyCode FDKeyCodeForName(NSString *name) {
  static NSDictionary<NSString *, NSNumber *> *map;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    map = @{
      @"A" : @0,     @"S" : @1,     @"D" : @2,    @"F" : @3,    @"H" : @4,
      @"G" : @5,     @"Z" : @6,     @"X" : @7,    @"C" : @8,    @"V" : @9,
      @"B" : @11,    @"Q" : @12,    @"W" : @13,   @"E" : @14,   @"R" : @15,
      @"Y" : @16,    @"T" : @17,    @"1" : @18,   @"2" : @19,   @"3" : @20,
      @"4" : @21,    @"6" : @22,    @"5" : @23,   @"=" : @24,   @"Plus" : @24,
      @"9" : @25,    @"7" : @26,    @"-" : @27,   @"8" : @28,   @"0" : @29,
      @"]" : @30,    @"O" : @31,    @"U" : @32,   @"[" : @33,   @"I" : @34,
      @"P" : @35,    @"Enter" : @36, @"Return" : @36, @"L" : @37, @"J" : @38,
      @"'" : @39,    @"K" : @40,    @";" : @41,   @"\\" : @42,  @"," : @43,
      @"/" : @44,    @"N" : @45,    @"M" : @46,   @"." : @47,   @"Tab" : @48,
      @"Space" : @49, @"`" : @50,   @"Backspace" : @51,
      @"F17" : @64,  @"F18" : @79,  @"F19" : @80, @"F20" : @90, @"F5" : @96,
      @"F6" : @97,   @"F7" : @98,   @"F3" : @99,  @"F8" : @100, @"F9" : @101,
      @"F11" : @103, @"F13" : @105, @"F16" : @106, @"F14" : @107, @"F10" : @109,
      @"F12" : @111, @"F15" : @113, @"Home" : @115, @"PageUp" : @116,
      @"Delete" : @117, @"F4" : @118, @"End" : @119, @"F2" : @120,
      @"PageDown" : @121, @"F1" : @122, @"Left" : @123, @"Right" : @124,
      @"Down" : @125, @"Up" : @126,
    };
  });
  NSNumber *code = map[name];
  if (!code && name.length == 1) {
    code = map[name.uppercaseString];
  }
  return code ? (CGKeyCode)code.unsignedShortValue : FDUnknownKeyCode;
}

static FDHotkey FDParseHotkey(NSString *value) {
  if (value.length == 0) return FDDefaultHotkey();
  if ([value isEqualToString:@"right_command"]) {
    return FDModifierHotkey(FDRightCommandKeyCode, NX_DEVICERCMDKEYMASK);
  }
  if ([value isEqualToString:@"left_command"]) {
    return FDModifierHotkey(FDLeftCommandKeyCode, NX_DEVICELCMDKEYMASK);
  }
  if ([value isEqualToString:@"left_function"]) {
    return FDModifierHotkey(FDFunctionKeyCode, kCGEventFlagMaskSecondaryFn);
  }
  if ([value isEqualToString:@"right_option"]) {
    return FDModifierHotkey(FDRightOptionKeyCode, NX_DEVICERALTKEYMASK);
  }
  if ([value isEqualToString:@"left_option"]) {
    return FDModifierHotkey(FDLeftOptionKeyCode, NX_DEVICELALTKEYMASK);
  }
  if ([value isEqualToString:@"right_control"]) {
    return FDModifierHotkey(FDRightControlKeyCode, NX_DEVICERCTLKEYMASK);
  }
  if ([value isEqualToString:@"left_control"]) {
    return FDModifierHotkey(FDLeftControlKeyCode, NX_DEVICELCTLKEYMASK);
  }
  if ([value isEqualToString:@"caps_lock"]) {
    return FDModifierHotkey(FDCapsLockKeyCode, kCGEventFlagMaskAlphaShift);
  }

  NSArray<NSString *> *parts = [value componentsSeparatedByString:@"+"];
  NSString *keyName = parts.lastObject;
  CGKeyCode keyCode = FDKeyCodeForName(keyName);
  if (keyCode == FDUnknownKeyCode) return FDDefaultHotkey();
  CGEventFlags flags = 0;
  for (NSUInteger index = 0; index + 1 < parts.count; index++) {
    NSString *part = parts[index];
    if ([part isEqualToString:@"Mod"] || [part isEqualToString:@"Cmd"] ||
        [part isEqualToString:@"Command"] || [part isEqualToString:@"Meta"]) {
      flags |= kCGEventFlagMaskCommand;
    } else if ([part isEqualToString:@"Ctrl"] ||
               [part isEqualToString:@"Control"]) {
      flags |= kCGEventFlagMaskControl;
    } else if ([part isEqualToString:@"Alt"] ||
               [part isEqualToString:@"Option"]) {
      flags |= kCGEventFlagMaskAlternate;
    } else if ([part isEqualToString:@"Shift"]) {
      flags |= kCGEventFlagMaskShift;
    }
  }
  return (FDHotkey){true, keyCode, flags, 0};
}

static BOOL FDChordMatches(FDHotkey hotkey, CGKeyCode keyCode,
                           CGEventFlags flags) {
  return hotkey.chord && keyCode == hotkey.keyCode &&
         FDSignificantFlags(flags) == hotkey.requiredFlags;
}
static const CGKeyCode FDQwertyVKeyCode = 9;
static const CGKeyCode FDQwertyCKeyCode = 8;
static const useconds_t FDCopyPollIntervalMicros = 25 * 1000;
static const int FDCopyPollAttempts = 16;
static const useconds_t FDPasteboardPrepareDelayMicros = 80 * 1000;
static const useconds_t FDPasteShortcutEventDelayMicros = 10 * 1000;
static const int64_t FDPasteEventUserData = 0x46445053; // "FDPS"
static const int64_t FDPasteboardRestoreDelayNanoseconds =
    1500 * NSEC_PER_MSEC;
// Shorter files are encoder-startup artifacts rather than usable speech. The
// 20 ms failure that motivated this guard contained only a PCM click in its
// M4A container and every transcription provider rejected it.
static const NSTimeInterval FDMinimumUsableRecordingDurationSeconds = 0.25;
static NSString *const FDRetainedRecordingPathKey =
    @"falcondeck.dictation.retained-recording-path";
static NSString *const FDRetainedRecordingProviderKey =
    @"falcondeck.dictation.retained-recording-provider";
static NSString *const FDRetainedRecordingDurationKey =
    @"falcondeck.dictation.retained-recording-duration";
static NSPasteboardType FDTransientPasteboardType =
    @"org.nspasteboard.TransientType";
static NSPasteboardType FDAutoGeneratedPasteboardType =
    @"org.nspasteboard.AutoGeneratedType";
static NSPasteboardType FDPasteboardSourceType = @"org.nspasteboard.source";

// Tauri's focusable(false) keeps a window from becoming key, but AppKit still
// activates the owning application when that NSWindow is clicked. Terminal
// dictation states expose buttons, so the overlay must be an actual
// non-activating NSPanel to let those buttons work without raising FalconDeck.
@interface FDDictationOverlayPanel : NSPanel
@end

@implementation FDDictationOverlayPanel

- (BOOL)canBecomeKeyWindow {
  return NO;
}

- (BOOL)canBecomeMainWindow {
  return NO;
}

@end

static NSWindowStyleMask FDOverlayStyleMask(NSWindowStyleMask current) {
  return current | NSWindowStyleMaskNonactivatingPanel;
}

static void FDEmit(FDEventKind kind, NSString *payload) {
  fd_dictation_emit((int32_t)kind, (payload ?: @"").UTF8String);
}

static BOOL FDRecordingDurationIsUsable(NSTimeInterval duration) {
  return isfinite(duration) &&
      duration >= FDMinimumUsableRecordingDurationSeconds;
}

static os_log_t FDPasteLog(void) {
  static os_log_t log;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    log = os_log_create("com.falcondeck.desktop", "dictation-paste");
  });
  return log;
}

// The AX element and its owning PID must come from the same query. Reading the
// frontmost application separately is not sufficient for floating panels and
// applications whose focused editor is exposed by a helper process.
static AXUIElementRef FDCopyFocusedUIElement(pid_t *processIdentifier) {
  if (processIdentifier) *processIdentifier = 0;
  AXUIElementRef systemWideElement = AXUIElementCreateSystemWide();
  if (!systemWideElement) return NULL;

  CFTypeRef focusedElement = NULL;
  AXError result = AXUIElementCopyAttributeValue(
      systemWideElement, kAXFocusedUIElementAttribute, &focusedElement);
  CFRelease(systemWideElement);
  if (result != kAXErrorSuccess || !focusedElement) {
    if (focusedElement) CFRelease(focusedElement);
    return NULL;
  }
  if (CFGetTypeID(focusedElement) != AXUIElementGetTypeID()) {
    CFRelease(focusedElement);
    return NULL;
  }

  pid_t focusedProcessIdentifier = 0;
  AXUIElementGetPid((AXUIElementRef)focusedElement,
                    &focusedProcessIdentifier);
  if (processIdentifier) *processIdentifier = focusedProcessIdentifier;
  return (AXUIElementRef)focusedElement;
}

// Returns selected text when the focused element exposes it. An empty string
// means the attribute exists and nothing is selected. nil means the app did
// not report a selection (Electron editors, many web fields).
static NSString *FDSelectedTextFromElement(AXUIElementRef element) {
  if (!element) return nil;
  CFTypeRef value = NULL;
  AXError result =
      AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute, &value);
  if (result == kAXErrorSuccess && value) {
    if (CFGetTypeID(value) == CFStringGetTypeID()) {
      return (__bridge_transfer NSString *)value;
    }
    CFRelease(value);
  }

  CFTypeRef selectedRangeRef = NULL;
  AXError rangeResult = AXUIElementCopyAttributeValue(
      element, kAXSelectedTextRangeAttribute, &selectedRangeRef);
  if (rangeResult != kAXErrorSuccess || !selectedRangeRef) {
    if (selectedRangeRef) CFRelease(selectedRangeRef);
    return nil;
  }
  if (CFGetTypeID(selectedRangeRef) != AXValueGetTypeID()) {
    CFRelease(selectedRangeRef);
    return nil;
  }
  CFRange range = {0, 0};
  Boolean gotRange =
      AXValueGetValue((AXValueRef)selectedRangeRef, kAXValueCFRangeType, &range);
  CFRelease(selectedRangeRef);
  if (!gotRange || range.location == kCFNotFound) return nil;
  if (range.length <= 0) return @"";

  CFTypeRef fullValueRef = NULL;
  AXError valueResult =
      AXUIElementCopyAttributeValue(element, kAXValueAttribute, &fullValueRef);
  if (valueResult != kAXErrorSuccess || !fullValueRef) {
    if (fullValueRef) CFRelease(fullValueRef);
    return nil;
  }
  if (CFGetTypeID(fullValueRef) != CFStringGetTypeID()) {
    CFRelease(fullValueRef);
    return nil;
  }
  NSString *fullText = (__bridge_transfer NSString *)fullValueRef;
  if (range.location < 0 || range.length < 0) return nil;
  NSUInteger location = (NSUInteger)range.location;
  NSUInteger length = (NSUInteger)range.length;
  if (location + length > fullText.length) return nil;
  return [fullText substringWithRange:NSMakeRange(location, length)];
}

static NSArray<NSPasteboardItem *> *FDSnapshotPasteboard(
    NSPasteboard *pasteboard) {
  NSMutableArray<NSPasteboardItem *> *snapshots = [NSMutableArray array];
  for (NSPasteboardItem *item in pasteboard.pasteboardItems) {
    NSPasteboardItem *snapshot = [[NSPasteboardItem alloc] init];
    for (NSPasteboardType type in item.types) {
      NSData *data = [item dataForType:type];
      if (data) [snapshot setData:[data copy] forType:type];
    }
    if (snapshot.types.count > 0) [snapshots addObject:snapshot];
  }
  return [snapshots copy];
}

static void FDRestorePasteboard(NSPasteboard *pasteboard,
                                NSArray<NSPasteboardItem *> *items) {
  [pasteboard clearContents];
  if (items.count > 0) [pasteboard writeObjects:items];
}

static BOOL FDWriteTransientTranscript(NSPasteboard *pasteboard,
                                       NSString *text) {
  NSPasteboardItem *item = [[NSPasteboardItem alloc] init];
  if (![item setString:text forType:NSPasteboardTypeString]) return NO;
  [item setData:NSData.data forType:FDTransientPasteboardType];
  [item setData:NSData.data forType:FDAutoGeneratedPasteboardType];
  [item setString:@"com.falcondeck.desktop"
          forType:FDPasteboardSourceType];
  [pasteboard clearContents];
  return [pasteboard writeObjects:@[ item ]] &&
         [text isEqualToString:
                   [pasteboard stringForType:NSPasteboardTypeString]];
}

static CGKeyCode FDVirtualKeyCodeForCharacter(UniChar target,
                                               UInt32 modifiers,
                                               CGKeyCode fallback) {
  TISInputSourceRef inputSource =
      TISCopyCurrentKeyboardLayoutInputSource();
  if (!inputSource) return fallback;
  CFDataRef layoutData = (CFDataRef)TISGetInputSourceProperty(
      inputSource, kTISPropertyUnicodeKeyLayoutData);
  if (!layoutData) {
    CFRelease(inputSource);
    return fallback;
  }

  const UCKeyboardLayout *layout =
      (const UCKeyboardLayout *)CFDataGetBytePtr(layoutData);
  CGKeyCode result = fallback;
  for (UInt16 keyCode = 0; keyCode < 128; keyCode += 1) {
    UInt32 deadKeyState = 0;
    UniChar characters[4] = {0};
    UniCharCount length = 0;
    OSStatus status = UCKeyTranslate(
        layout, keyCode, kUCKeyActionDisplay, modifiers,
        (UInt32)LMGetKbdType(), kUCKeyTranslateNoDeadKeysMask,
        &deadKeyState, 4, &length, characters);
    if (status == noErr && length == 1 && characters[0] == target) {
      result = (CGKeyCode)keyCode;
      break;
    }
  }
  CFRelease(inputSource);
  return result;
}

static CGKeyCode FDCharacterVirtualKeyCode(UniChar target, CGKeyCode fallback) {
  UInt32 commandModifiers = (UInt32)((cmdKey & 0xff00) >> 8);
  CGKeyCode commandMapped =
      FDVirtualKeyCodeForCharacter(target, commandModifiers, UINT16_MAX);
  if (commandMapped != UINT16_MAX) return commandMapped;
  return FDVirtualKeyCodeForCharacter(target, 0, fallback);
}

static CGKeyCode FDPasteVirtualKeyCode(void) {
  // Command-switching layouts (for example Dvorak-QWERTY ⌘) can map a
  // different physical key while Command is held. Resolve the shortcut using
  // the same modifier state as the event, then fall back to the unmodified
  // layout and finally the physical QWERTY V key.
  return FDCharacterVirtualKeyCode((UniChar)'v', FDQwertyVKeyCode);
}

static CGKeyCode FDCopyVirtualKeyCode(void) {
  return FDCharacterVirtualKeyCode((UniChar)'c', FDQwertyCKeyCode);
}

@interface FDDictationController : NSObject <AVCaptureFileOutputRecordingDelegate> {
  AXUIElementRef _pasteTargetElement;
}
@property(nonatomic) BOOL enabled;
@property(nonatomic) BOOL rewriteEnabled;
@property(nonatomic) BOOL modifierDown;
@property(nonatomic) BOOL rewriteModifierDown;
@property(nonatomic) BOOL modifierUsedInChord;
@property(nonatomic) BOOL rewriteModifierUsedInChord;
@property(nonatomic) BOOL cancelling;
@property(nonatomic) BOOL recording;
@property(nonatomic) BOOL stopping;
@property(nonatomic) NSUInteger modifierGeneration;
@property(nonatomic) NSUInteger rewriteModifierGeneration;
@property(nonatomic) NSUInteger speechGeneration;
@property(nonatomic) pid_t pasteTargetProcessIdentifier;
@property(nonatomic) pid_t pasteTargetApplicationProcessIdentifier;
@property(nonatomic) NSUInteger pasteboardGeneration;
@property(nonatomic) NSInteger activePasteboardChangeCount;
@property(nonatomic, copy) NSArray<NSPasteboardItem *> *pasteboardRestoreItems;
// A cancelled take's audio outlives the cancel while the overlay still offers
// Undo, so Esc stays recoverable. Held in memory only, and dropped from Rust
// when the undo window closes.
@property(nonatomic) BOOL cancelledRecordingPending;
// While dictation history is on, a pasted transcript no longer means the audio
// can go: Rust keeps it for the retention window and deletes it from there.
@property(nonatomic) BOOL retainRecordings;
// Provider used for the retained recording; -1 when unknown (no recording,
// or a recording that predates this field).
@property(nonatomic) NSInteger retainedProvider;
@property(nonatomic) FDHotkey shortcut;
@property(nonatomic) FDHotkey rewriteShortcut;
@property(nonatomic) FDHotkey recordingShortcut;
@property(nonatomic) BOOL rewriteSession;
@property(nonatomic, copy) NSString *rewriteSelection;
@property(nonatomic, copy) NSString *pendingRewriteSelection;
@property(nonatomic) BOOL pendingRewriteAxResolved;
@property(nonatomic) FDActivationMode activationMode;
@property(nonatomic) FDProvider provider;
@property(nonatomic) FDProvider recordingProvider;
@property(nonatomic, copy) NSString *inputDeviceID;
@property(nonatomic, strong) AVCaptureSession *captureSession;
@property(nonatomic, strong) AVCaptureAudioFileOutput *audioFileOutput;
// Serializes the blocking AVCaptureSession start/stop calls off the main
// thread so the overlay can appear before the microphone is warm.
@property(nonatomic, strong) dispatch_queue_t sessionQueue;
// YES once startRecordingToOutputFileURL has been issued for this session.
@property(nonatomic) BOOL fileOutputActive;
@property(nonatomic, strong) dispatch_source_t audioLevelTimer;
@property(nonatomic, strong) NSURL *recordingURL;
@property(nonatomic) NSTimeInterval recordingDurationSeconds;
@property(nonatomic, strong) SFSpeechRecognizer *speechRecognizer
    API_AVAILABLE(macos(10.15));
@property(nonatomic, strong) SFSpeechRecognitionTask *speechTask
    API_AVAILABLE(macos(10.15));
@property(nonatomic) CFMachPortRef eventTap;
@property(nonatomic) CFRunLoopSourceRef eventTapSource;
- (void)handleFlagsChanged:(CGKeyCode)keyCode flags:(CGEventFlags)flags;
- (void)handleKeyDown:(CGKeyCode)keyCode
                flags:(CGEventFlags)flags
               repeat:(BOOL)repeat;
- (void)handleKeyUp:(CGKeyCode)keyCode flags:(CGEventFlags)flags;
- (void)handleChordDown:(BOOL)rewrite;
- (void)handleChordUp:(BOOL)rewrite;
- (void)startRecordingAsRewrite:(BOOL)rewrite;
- (NSString *)captureSelectedText;
- (BOOL)postCopyShortcut;
- (void)clearRewriteSession;
- (void)primeRewriteSelectionCapture;
- (void)transcribeSystemRecording:(NSURL *)url API_AVAILABLE(macos(10.15));
- (void)startAudioLevelMeter;
- (void)stopAudioLevelMeter;
- (void)setRetainedRecordingURL:(NSURL *)url provider:(FDProvider)provider;
- (void)setRecordingDurationSeconds:(NSTimeInterval)duration;
- (void)sessionDidFinishStarting:(AVCaptureSession *)session
                          output:(AVCaptureAudioFileOutput *)output
                             url:(NSURL *)url;
- (BOOL)claimSpeechCompletion:(NSUInteger)generation API_AVAILABLE(macos(10.15));
- (void)surfaceRetainedRecordingIfNeeded;
- (void)capturePasteTarget;
- (BOOL)refreshPasteTargetIfFocused;
- (BOOL)postPasteShortcut;
- (void)finishActivePasteboardSessionIfOwned;
- (void)dropCancelledRecording;
- (void)returnFocusToPasteTarget;
@end

static CGEventRef FDEventTapCallback(CGEventTapProxy proxy, CGEventType type,
                                     CGEventRef event, void *context) {
  (void)proxy;
  FDDictationController *controller = (__bridge FDDictationController *)context;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (controller.eventTap) CGEventTapEnable(controller.eventTap, true);
    return event;
  }

  // FalconDeck's own Cmd-C / Cmd-V injections carry this tag. If they re-enter
  // the tap they look like a real chord on the still-held rewrite key and
  // cancel the recording they were meant to serve.
  if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) ==
      FDPasteEventUserData) {
    return event;
  }

  CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(
      event, kCGKeyboardEventKeycode);
  CGEventFlags flags = CGEventGetFlags(event);
  BOOL repeat = type == kCGEventKeyDown &&
                CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) !=
                    0;
  BOOL consume = NO;
  if (type == kCGEventKeyDown || type == kCGEventKeyUp) {
    if (controller.enabled &&
        FDChordMatches(controller.shortcut, keyCode, flags)) {
      consume = YES;
    }
    if (controller.rewriteEnabled &&
        FDChordMatches(controller.rewriteShortcut, keyCode, flags)) {
      consume = YES;
    }
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    if (type == kCGEventFlagsChanged) {
      [controller handleFlagsChanged:keyCode flags:flags];
    } else if (type == kCGEventKeyDown) {
      [controller handleKeyDown:keyCode flags:flags repeat:repeat];
    } else if (type == kCGEventKeyUp) {
      [controller handleKeyUp:keyCode flags:flags];
    }
  });
  return consume ? NULL : event;
}

@implementation FDDictationController

+ (instancetype)sharedController {
  static FDDictationController *controller;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    controller = [[FDDictationController alloc] init];
  });
  return controller;
}

- (instancetype)init {
  self = [super init];
  if (!self) return nil;
  self.sessionQueue = dispatch_queue_create(
      "com.falcondeck.dictation.session", DISPATCH_QUEUE_SERIAL);
  self.shortcut = FDDefaultHotkey();
  self.rewriteShortcut = FDModifierHotkey(
      FDRightOptionKeyCode, NX_DEVICERALTKEYMASK);
  NSString *retainedPath =
      [NSUserDefaults.standardUserDefaults stringForKey:FDRetainedRecordingPathKey];
  if (retainedPath.length > 0 &&
      [NSFileManager.defaultManager fileExistsAtPath:retainedPath]) {
    self.recordingURL = [NSURL fileURLWithPath:retainedPath];
    NSNumber *storedProvider =
        [NSUserDefaults.standardUserDefaults objectForKey:FDRetainedRecordingProviderKey];
    self.retainedProvider = storedProvider ? storedProvider.integerValue : -1;
    NSNumber *storedDuration =
        [NSUserDefaults.standardUserDefaults objectForKey:FDRetainedRecordingDurationKey];
    self.recordingDurationSeconds =
        storedDuration && FDRecordingDurationIsUsable(storedDuration.doubleValue)
            ? storedDuration.doubleValue
            : 0;
  } else {
    [NSUserDefaults.standardUserDefaults removeObjectForKey:FDRetainedRecordingPathKey];
    [NSUserDefaults.standardUserDefaults removeObjectForKey:FDRetainedRecordingDurationKey];
  }
  [NSNotificationCenter.defaultCenter
      addObserver:self
         selector:@selector(applicationDidBecomeActive:)
             name:NSApplicationDidBecomeActiveNotification
           object:nil];
  return self;
}

- (void)dealloc {
  if (_pasteTargetElement) CFRelease(_pasteTargetElement);
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  (void)notification;
  if (self.enabled || self.rewriteEnabled) [self installEventTapIfNeeded];
}

- (void)setRetainedRecordingURL:(NSURL *)url provider:(FDProvider)provider {
  self.recordingURL = url;
  self.recordingDurationSeconds = 0;
  [NSUserDefaults.standardUserDefaults removeObjectForKey:FDRetainedRecordingDurationKey];
  if (url) {
    [NSUserDefaults.standardUserDefaults setObject:url.path
                                            forKey:FDRetainedRecordingPathKey];
    [NSUserDefaults.standardUserDefaults setObject:@(provider)
                                            forKey:FDRetainedRecordingProviderKey];
    self.retainedProvider = provider;
  } else {
    [NSUserDefaults.standardUserDefaults removeObjectForKey:FDRetainedRecordingPathKey];
    [NSUserDefaults.standardUserDefaults removeObjectForKey:FDRetainedRecordingProviderKey];
    self.retainedProvider = -1;
  }
}

- (void)setRecordingDurationSeconds:(NSTimeInterval)duration {
  _recordingDurationSeconds =
      FDRecordingDurationIsUsable(duration) ? duration : 0;
  if (self.recordingURL && _recordingDurationSeconds > 0) {
    [NSUserDefaults.standardUserDefaults
        setDouble:_recordingDurationSeconds
           forKey:FDRetainedRecordingDurationKey];
  } else {
    [NSUserDefaults.standardUserDefaults
        removeObjectForKey:FDRetainedRecordingDurationKey];
  }
}

- (void)configureEnabled:(BOOL)enabled
                 shortcut:(FDHotkey)shortcut
           activationMode:(FDActivationMode)activationMode
                  provider:(FDProvider)provider
           inputDeviceID:(NSString *)inputDeviceID
        retainRecordings:(BOOL)retainRecordings
          rewriteEnabled:(BOOL)rewriteEnabled
         rewriteShortcut:(FDHotkey)rewriteShortcut {
  self.retainRecordings = retainRecordings;
  BOOL shouldResetModifier =
      self.enabled != enabled || !FDHotkeysEqual(self.shortcut, shortcut);
  BOOL shouldResetRewrite =
      self.rewriteEnabled != rewriteEnabled ||
      !FDHotkeysEqual(self.rewriteShortcut, rewriteShortcut);
  self.enabled = enabled;
  self.shortcut = shortcut;
  self.activationMode = activationMode;
  self.provider = provider;
  self.inputDeviceID = inputDeviceID.length > 0 ? inputDeviceID : nil;
  self.rewriteEnabled = rewriteEnabled;
  self.rewriteShortcut = rewriteShortcut;
  if (shouldResetModifier && !self.recording && !self.stopping) {
    self.modifierDown = NO;
    self.modifierUsedInChord = NO;
    self.modifierGeneration += 1;
  }
  if (shouldResetRewrite && !self.recording && !self.stopping) {
    self.rewriteModifierDown = NO;
    self.rewriteModifierUsedInChord = NO;
    self.rewriteModifierGeneration += 1;
  }
  if (enabled || rewriteEnabled) {
    [self installEventTapIfNeeded];
    [self surfaceRetainedRecordingIfNeeded];
  } else {
    // Stop routing every system-wide keystroke through the callback while
    // dictation and rewrite are both off; re-enabling re-arms the existing tap.
    if (self.eventTap) CGEventTapEnable(self.eventTap, false);
    if (self.recording) [self cancelRecording];
    if (!self.recording) [self clearRewriteSession];
  }
}

- (void)installEventTapIfNeeded {
  if (self.eventTap) {
    CGEventTapEnable(self.eventTap, true);
    return;
  }
  CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) |
                     CGEventMaskBit(kCGEventKeyDown) |
                     CGEventMaskBit(kCGEventKeyUp);
  // Filter so chord shortcuts do not also type into the focused app. Modifier-
  // only triggers still pass through (the callback returns those events).
  self.eventTap = CGEventTapCreate(
      kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
      mask, FDEventTapCallback, (__bridge void *)self);
  if (!self.eventTap) {
    self.eventTap = CGEventTapCreate(
        kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
        mask, FDEventTapCallback, (__bridge void *)self);
  }
  if (!self.eventTap) {
    return;
  }
  self.eventTapSource = CFMachPortCreateRunLoopSource(
      kCFAllocatorDefault, self.eventTap, 0);
  CFRunLoopAddSource(CFRunLoopGetMain(), self.eventTapSource,
                     kCFRunLoopCommonModes);
  CGEventTapEnable(self.eventTap, true);
}

- (BOOL)isKey:(CGKeyCode)keyCode forShortcut:(FDHotkey)shortcut {
  return keyCode == shortcut.keyCode;
}

- (BOOL)isShortcutDown:(FDHotkey)shortcut
               keyCode:(CGKeyCode)keyCode
                 flags:(CGEventFlags)flags {
  if (shortcut.chord) {
    return FDSignificantFlags(flags) == shortcut.requiredFlags;
  }
  if (shortcut.deviceMask != 0 && (flags & shortcut.deviceMask) != 0) {
    return YES;
  }
  CGEventFlags generic = 0;
  if (shortcut.deviceMask == NX_DEVICERCMDKEYMASK ||
      shortcut.deviceMask == NX_DEVICELCMDKEYMASK) {
    generic = kCGEventFlagMaskCommand;
  } else if (shortcut.deviceMask == NX_DEVICERALTKEYMASK ||
             shortcut.deviceMask == NX_DEVICELALTKEYMASK) {
    generic = kCGEventFlagMaskAlternate;
  } else if (shortcut.deviceMask == NX_DEVICERCTLKEYMASK ||
             shortcut.deviceMask == NX_DEVICELCTLKEYMASK) {
    generic = kCGEventFlagMaskControl;
  } else {
    generic = shortcut.deviceMask;
  }
  return keyCode == shortcut.keyCode && generic != 0 && (flags & generic) != 0;
}

- (BOOL)isDictationKey:(CGKeyCode)keyCode {
  return self.enabled && !self.shortcut.chord &&
         [self isKey:keyCode forShortcut:self.shortcut];
}

- (BOOL)isRewriteKey:(CGKeyCode)keyCode {
  if (!self.rewriteEnabled || self.rewriteShortcut.chord) return NO;
  // Dictation keeps the key if both features are bound to it.
  if (self.enabled && FDHotkeysEqual(self.shortcut, self.rewriteShortcut)) {
    return NO;
  }
  return [self isKey:keyCode forShortcut:self.rewriteShortcut];
}

- (void)startAudioLevelMeter {
  [self stopAudioLevelMeter];
  dispatch_source_t timer = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  if (!timer) return;
  self.audioLevelTimer = timer;
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0),
                            50 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
  __weak FDDictationController *weakSelf = self;
  dispatch_source_set_event_handler(timer, ^{
    FDDictationController *strongSelf = weakSelf;
    if (!strongSelf || !strongSelf.recording) return;
    float averagePower = -160.0f;
    for (AVCaptureConnection *connection in strongSelf.audioFileOutput.connections) {
      for (AVCaptureAudioChannel *channel in connection.audioChannels) {
        averagePower = MAX(averagePower, channel.averagePowerLevel);
      }
    }
    // Map the useful voice range onto 0...1. The square root makes quieter
    // speech visible without letting room noise dominate the meter.
    float linear = MAX(0.0f, MIN(1.0f, (averagePower + 55.0f) / 55.0f));
    float level = sqrtf(linear);
    FDEmit(FDEventAudioLevel,
           [NSString stringWithFormat:@"%.4f", level]);
  });
  dispatch_resume(timer);
}

- (void)stopAudioLevelMeter {
  if (!self.audioLevelTimer) return;
  dispatch_source_cancel(self.audioLevelTimer);
  self.audioLevelTimer = nil;
}

- (void)primeRewriteSelectionCapture {
  [self capturePasteTarget];
  NSString *axText = FDSelectedTextFromElement(_pasteTargetElement);
  if (!axText) {
    self.pendingRewriteAxResolved = NO;
    self.pendingRewriteSelection = nil;
    return;
  }
  NSString *trimmed = [axText
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  self.pendingRewriteAxResolved = YES;
  self.pendingRewriteSelection = trimmed.length > 0 ? axText : nil;
}

- (void)armHoldRecording:(BOOL)rewrite {
  if (self.activationMode != FDActivationModeHold) return;
  if (rewrite) [self primeRewriteSelectionCapture];
  NSUInteger generation =
      rewrite ? self.rewriteModifierGeneration : self.modifierGeneration;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 80 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
    BOOL stillDown =
        rewrite ? self.rewriteModifierDown : self.modifierDown;
    BOOL unused =
        rewrite ? !self.rewriteModifierUsedInChord : !self.modifierUsedInChord;
    BOOL sameGeneration =
        rewrite ? self.rewriteModifierGeneration == generation
                : self.modifierGeneration == generation;
    BOOL featureOn = rewrite ? self.rewriteEnabled : self.enabled;
    if (featureOn && stillDown && unused && sameGeneration && !self.recording) {
      [self startRecordingAsRewrite:rewrite];
    }
  });
}

- (void)handleTriggerRelease:(BOOL)rewrite {
  if (rewrite) {
    self.rewriteModifierGeneration += 1;
    if (self.rewriteModifierUsedInChord) {
      self.pendingRewriteAxResolved = NO;
      self.pendingRewriteSelection = nil;
      return;
    }
  } else {
    self.modifierGeneration += 1;
    if (self.modifierUsedInChord) return;
  }
  if (self.activationMode == FDActivationModeHold) {
    if (self.recording && self.rewriteSession == rewrite) [self stopRecording];
    else if (rewrite && !self.recording) {
      self.pendingRewriteAxResolved = NO;
      self.pendingRewriteSelection = nil;
    }
    return;
  }
  if (self.recording) {
    if (self.rewriteSession == rewrite) [self stopRecording];
  } else {
    [self startRecordingAsRewrite:rewrite];
  }
}

- (void)handleFlagsChanged:(CGKeyCode)keyCode flags:(CGEventFlags)flags {
  if (!self.enabled && !self.rewriteEnabled) return;
  if (self.recording && self.recordingShortcut.chord) {
    if (FDSignificantFlags(flags) != self.recordingShortcut.requiredFlags) {
      if (self.rewriteSession) {
        self.rewriteModifierDown = NO;
      } else {
        self.modifierDown = NO;
      }
      [self handleTriggerRelease:self.rewriteSession];
    }
    return;
  }
  if (self.recording) {
    if (self.rewriteSession) {
      if (![self isKey:keyCode forShortcut:self.recordingShortcut]) return;
      BOOL isDown = [self isShortcutDown:self.recordingShortcut
                                keyCode:keyCode
                                  flags:flags];
      if (isDown == self.rewriteModifierDown) return;
      self.rewriteModifierDown = isDown;
      if (isDown) {
        self.rewriteModifierUsedInChord = NO;
        self.rewriteModifierGeneration += 1;
        return;
      }
      [self handleTriggerRelease:YES];
    } else {
      if (![self isKey:keyCode forShortcut:self.recordingShortcut]) return;
      BOOL isDown = [self isShortcutDown:self.recordingShortcut
                                keyCode:keyCode
                                  flags:flags];
      if (isDown == self.modifierDown) return;
      self.modifierDown = isDown;
      if (isDown) {
        self.modifierUsedInChord = NO;
        self.modifierGeneration += 1;
        return;
      }
      [self handleTriggerRelease:NO];
    }
    return;
  }

  if ([self isDictationKey:keyCode]) {
    BOOL isDown = [self isShortcutDown:self.shortcut keyCode:keyCode flags:flags];
    if (isDown == self.modifierDown) return;
    self.modifierDown = isDown;
    if (isDown) {
      self.modifierUsedInChord = NO;
      self.modifierGeneration += 1;
      [self armHoldRecording:NO];
      return;
    }
    [self handleTriggerRelease:NO];
    return;
  }

  if ([self isRewriteKey:keyCode]) {
    BOOL isDown =
        [self isShortcutDown:self.rewriteShortcut keyCode:keyCode flags:flags];
    if (isDown == self.rewriteModifierDown) return;
    self.rewriteModifierDown = isDown;
    if (isDown) {
      self.rewriteModifierUsedInChord = NO;
      self.rewriteModifierGeneration += 1;
      [self armHoldRecording:YES];
      return;
    }
    [self handleTriggerRelease:YES];
  }
}

- (void)handleChordDown:(BOOL)rewrite {
  if (rewrite) {
    if (self.rewriteModifierDown) return;
    self.rewriteModifierDown = YES;
    self.rewriteModifierUsedInChord = NO;
    self.rewriteModifierGeneration += 1;
  } else {
    if (self.modifierDown) return;
    self.modifierDown = YES;
    self.modifierUsedInChord = NO;
    self.modifierGeneration += 1;
  }
  if (self.activationMode == FDActivationModeHold) {
    [self armHoldRecording:rewrite];
    return;
  }
  [self handleTriggerRelease:rewrite];
}

- (void)handleChordUp:(BOOL)rewrite {
  if (rewrite) {
    if (!self.rewriteModifierDown) return;
    self.rewriteModifierDown = NO;
  } else {
    if (!self.modifierDown) return;
    self.modifierDown = NO;
  }
  if (self.activationMode == FDActivationModeHold) {
    [self handleTriggerRelease:rewrite];
  }
}

- (void)handleKeyDown:(CGKeyCode)keyCode
                flags:(CGEventFlags)flags
               repeat:(BOOL)repeat {
  if (!self.enabled && !self.rewriteEnabled) return;
  if (self.recording && keyCode == FDEscapeKeyCode) {
    [self cancelRecording];
    return;
  }
  if (!repeat && self.enabled &&
      FDChordMatches(self.shortcut, keyCode, flags)) {
    [self handleChordDown:NO];
    return;
  }
  if (!repeat && self.rewriteEnabled &&
      FDChordMatches(self.rewriteShortcut, keyCode, flags)) {
    [self handleChordDown:YES];
    return;
  }
  if (repeat) return;
  if (self.modifierDown) {
    self.modifierUsedInChord = YES;
    self.modifierGeneration += 1;
    if (self.recording && !self.rewriteSession &&
        self.activationMode == FDActivationModeHold) {
      [self cancelRecording];
    }
  }
  if (self.rewriteModifierDown) {
    self.rewriteModifierUsedInChord = YES;
    self.rewriteModifierGeneration += 1;
    self.pendingRewriteAxResolved = NO;
    self.pendingRewriteSelection = nil;
    if (self.recording && self.rewriteSession &&
        self.activationMode == FDActivationModeHold) {
      [self cancelRecording];
    }
  }
}

- (void)handleKeyUp:(CGKeyCode)keyCode flags:(CGEventFlags)flags {
  (void)flags;
  if (self.enabled && self.shortcut.chord &&
      keyCode == self.shortcut.keyCode) {
    [self handleChordUp:NO];
  }
  if (self.rewriteEnabled && self.rewriteShortcut.chord &&
      keyCode == self.rewriteShortcut.keyCode) {
    [self handleChordUp:YES];
  }
}

- (void)capturePasteTarget {
  if (_pasteTargetElement) {
    CFRelease(_pasteTargetElement);
    _pasteTargetElement = NULL;
  }
  pid_t focusedProcessIdentifier = 0;
  _pasteTargetElement = FDCopyFocusedUIElement(&focusedProcessIdentifier);
  pid_t applicationProcessIdentifier =
      NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  self.pasteTargetProcessIdentifier = focusedProcessIdentifier > 0
      ? focusedProcessIdentifier
      : applicationProcessIdentifier;
  self.pasteTargetApplicationProcessIdentifier =
      applicationProcessIdentifier > 0
          ? applicationProcessIdentifier
          : self.pasteTargetProcessIdentifier;
  os_log_info(FDPasteLog(),
              "captured target elementPid=%{public}d appPid=%{public}d",
              self.pasteTargetProcessIdentifier,
              self.pasteTargetApplicationProcessIdentifier);
}

- (void)startRecording {
  [self startRecordingAsRewrite:NO];
}

- (void)clearRewriteSession {
  self.rewriteSession = NO;
  self.rewriteSelection = nil;
  self.pendingRewriteAxResolved = NO;
  self.pendingRewriteSelection = nil;
}

- (void)startRecordingAsRewrite:(BOOL)rewrite {
  BOOL featureOn = rewrite ? self.rewriteEnabled : self.enabled;
  if (!featureOn || self.recording || self.stopping) return;
  [self dropCancelledRecording];
  if (self.recordingURL &&
      [NSFileManager.defaultManager fileExistsAtPath:self.recordingURL.path]) {
    FDEmit(FDEventFailedRetained,
           @"A previous recording is waiting to be transcribed. Retry or discard it first.");
    return;
  }
  if (@available(macOS 10.14, *)) {
    if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] !=
        AVAuthorizationStatusAuthorized) {
      FDEmit(FDEventFailed,
             @"Microphone access is required. Enable it in System Settings → Privacy & Security → Microphone.");
      return;
    }
  } else {
    FDEmit(FDEventFailed, @"Desktop dictation requires macOS 10.14 or later.");
    return;
  }
  if (self.provider == FDProviderSystem) {
    if (@available(macOS 10.15, *)) {
      if ([SFSpeechRecognizer authorizationStatus] !=
          SFSpeechRecognizerAuthorizationStatusAuthorized) {
        FDEmit(FDEventFailed,
               @"Speech Recognition access is required for Apple Speech transcription.");
        return;
      }
    } else {
      FDEmit(FDEventFailed,
             @"Apple Speech dictation requires macOS 10.15 or later.");
      return;
    }
  }
  if (!AXIsProcessTrusted()) {
    FDEmit(FDEventFailed,
           @"Accessibility access is required to paste dictation into other apps.");
    return;
  }

  // Keep the insertion target stable while transcription runs. In particular,
  // the dictation overlay must not cause a later paste to be routed back
  // through FalconDeck's global event stream or into a newly focused app.
  [self capturePasteTarget];
  if (rewrite) {
    NSString *selection = nil;
    if (self.pendingRewriteAxResolved) {
      selection = self.pendingRewriteSelection;
    } else {
      selection = [self captureSelectedText];
    }
    self.pendingRewriteAxResolved = NO;
    self.pendingRewriteSelection = nil;
    NSString *trimmed = [selection
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length == 0) {
      [self clearRewriteSession];
      FDEmit(FDEventRewriteSelection, @"");
      FDEmit(FDEventFailed,
             @"Select text first, then hold the rewrite shortcut and say how to edit it.");
      return;
    }
    self.rewriteSession = YES;
    self.rewriteSelection = selection;
  } else {
    [self clearRewriteSession];
  }

  NSString *name = [NSString stringWithFormat:@"falcondeck-dictation-%@.m4a",
                                             NSUUID.UUID.UUIDString];
  NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:name]];
  AVCaptureDevice *device = self.inputDeviceID.length > 0
      ? [AVCaptureDevice deviceWithUniqueID:self.inputDeviceID]
      : nil;
  if (!device) device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
  if (!device) {
    if (rewrite) [self clearRewriteSession];
    FDEmit(FDEventFailed, @"No microphone is currently available.");
    return;
  }

  NSError *error;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device
                                                                      error:&error];
  if (!input || error) {
    if (rewrite) [self clearRewriteSession];
    FDEmit(FDEventFailed,
           error.localizedDescription ?: @"FalconDeck could not open the selected microphone.");
    return;
  }
  AVCaptureSession *session = [[AVCaptureSession alloc] init];
  AVCaptureAudioFileOutput *output = [[AVCaptureAudioFileOutput alloc] init];
  if (![session canAddInput:input] || ![session canAddOutput:output]) {
    if (rewrite) [self clearRewriteSession];
    FDEmit(FDEventFailed, @"FalconDeck could not configure the selected microphone.");
    return;
  }
  [session beginConfiguration];
  [session addInput:input];
  [session addOutput:output];
  [session commitConfiguration];
  // Speech models resample to 16 kHz mono internally, so recording above
  // that only inflates the file. 32 kbps AAC yields identical transcripts
  // while cutting the OpenRouter upload several-fold versus the previous
  // 44.1 kHz high-quality encode — and the 8 MiB cap now covers far longer
  // takes.
  output.audioSettings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @16000,
    AVNumberOfChannelsKey : @1,
    AVEncoderBitRateKey : @32000,
  };
  if (![[AVCaptureAudioFileOutput availableOutputFileTypes]
          containsObject:AVFileTypeAppleM4A]) {
    if (rewrite) [self clearRewriteSession];
    FDEmit(FDEventFailed, @"This Mac cannot create an M4A dictation recording.");
    return;
  }
  self.captureSession = session;
  self.audioFileOutput = output;
  [self setRetainedRecordingURL:url provider:self.provider];
  self.cancelling = NO;
  self.recordingShortcut = rewrite ? self.rewriteShortcut : self.shortcut;
  self.recordingProvider = self.provider;
  self.recording = YES;
  self.fileOutputActive = NO;
  // Surface the overlay before the microphone is warm: -startRunning blocks
  // for hundreds of milliseconds and previously gated all recording feedback.
  if (rewrite && self.rewriteSelection.length > 0) {
    FDEmit(FDEventRewriteSelection, self.rewriteSelection);
  }
  FDEmit(FDEventRecording, rewrite ? @"rewrite" : @"");
  __weak FDDictationController *weakSelf = self;
  dispatch_async(self.sessionQueue, ^{
    [session startRunning];
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf sessionDidFinishStarting:session output:output url:url];
    });
  });
}

// Runs on the main thread once -startRunning returns. The writer may have
// released the shortcut, cancelled, or been superseded while the microphone
// was warming up.
- (void)sessionDidFinishStarting:(AVCaptureSession *)session
                          output:(AVCaptureAudioFileOutput *)output
                             url:(NSURL *)url {
  if (session != self.captureSession) {
    dispatch_async(self.sessionQueue, ^{ [session stopRunning]; });
    return;
  }
  if (!self.recording || !session.running) {
    BOOL wasCancelled = self.cancelling;
    BOOL wasStopped = self.stopping && !wasCancelled;
    dispatch_async(self.sessionQueue, ^{ [session stopRunning]; });
    self.captureSession = nil;
    self.audioFileOutput = nil;
    self.recording = NO;
    self.stopping = NO;
    self.cancelling = NO;
    [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
    [self setRetainedRecordingURL:nil provider:0];
    if (wasCancelled) {
      FDEmit(FDEventCancelled, @"");
    } else if (wasStopped) {
      FDEmit(FDEventFailed,
             @"The recording stopped before the microphone was ready. Hold the shortcut a little longer.");
    } else {
      FDEmit(FDEventFailed, @"FalconDeck could not start the microphone.");
    }
    return;
  }
  [output startRecordingToOutputFileURL:url
                         outputFileType:AVFileTypeAppleM4A
                      recordingDelegate:self];
  self.fileOutputActive = YES;
  [self startAudioLevelMeter];
}

- (void)stopRecording {
  if (!self.recording) return;
  self.recording = NO;
  self.stopping = YES;
  [self stopAudioLevelMeter];
  FDEmit(FDEventProcessing, @"");
  [self.audioFileOutput stopRecording];
}

- (void)cancelRecording {
  if (!self.recording) return;
  self.cancelling = YES;
  self.recording = NO;
  self.stopping = YES;
  [self stopAudioLevelMeter];
  [self.audioFileOutput stopRecording];
}

- (void)captureOutput:(AVCaptureFileOutput *)output
    didFinishRecordingToOutputFileAtURL:(NSURL *)outputFileURL
                        fromConnections:(NSArray<AVCaptureConnection *> *)connections
                                  error:(NSError *)error {
  (void)output;
  (void)connections;
  dispatch_async(dispatch_get_main_queue(), ^{
    AVCaptureSession *finishedSession = self.captureSession;
    if (finishedSession) {
      dispatch_async(self.sessionQueue, ^{ [finishedSession stopRunning]; });
    }
    [self stopAudioLevelMeter];
    self.captureSession = nil;
    self.audioFileOutput = nil;
    self.fileOutputActive = NO;
    self.stopping = NO;
    NSURL *url = self.recordingURL ?: outputFileURL;
    NSTimeInterval duration = CMTimeGetSeconds(output.recordedDuration);
    if (self.cancelling) {
      self.cancelling = NO;
      NSNumber *cancelledSize = url
          ? [[[NSFileManager defaultManager] attributesOfItemAtPath:url.path error:nil]
                objectForKey:NSFileSize]
          : nil;
      if (url && cancelledSize.unsignedLongLongValue > 0 &&
          FDRecordingDurationIsUsable(duration)) {
        // Hold what was said up to the Esc so the overlay can undo it, but keep
        // the path out of NSUserDefaults: a persisted cancelled take would come
        // back after a relaunch as a recording "waiting to be transcribed".
        [self setRetainedRecordingURL:nil provider:0];
        self.recordingURL = url;
        [self setRecordingDurationSeconds:duration];
        self.retainedProvider = self.recordingProvider;
        self.cancelledRecordingPending = YES;
        FDEmit(FDEventCancelledRetained, @"");
        return;
      }
      if (url) [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
      [self setRetainedRecordingURL:nil provider:0];
      FDEmit(FDEventCancelled, @"");
      return;
    }
    NSNumber *fileSize = url
        ? [[[NSFileManager defaultManager] attributesOfItemAtPath:url.path error:nil]
              objectForKey:NSFileSize]
        : nil;
    if (error || !url || fileSize.unsignedLongLongValue == 0) {
      FDEmit(FDEventFailedRetained,
             error.localizedDescription ?: @"The audio recording could not be completed.");
      return;
    }
    if (!FDRecordingDurationIsUsable(duration)) {
      [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
      [self setRetainedRecordingURL:nil provider:0];
      FDEmit(FDEventFailed,
             @"The recording ended before the microphone captured enough audio. "
              @"Hold the shortcut a little longer and try again.");
      return;
    }
    [self setRecordingDurationSeconds:duration];
    if (self.recordingProvider == FDProviderSystem) {
      if (@available(macOS 10.15, *)) {
        // The OpenRouter path carries the path in FDEventAudioReady; Apple
        // Speech never leaves this process, so announce it separately.
        FDEmit(FDEventAudioRecorded, url.path);
        [self transcribeSystemRecording:url];
      } else {
        FDEmit(FDEventFailedRetained,
               @"Apple Speech requires macOS 10.15 or later. Your recording has been retained.");
      }
    } else {
      FDEmit(FDEventAudioReady, url.path);
    }
  });
}

// Clears the in-flight speech task when the completing callback still owns
// the current generation. Returns NO when a discard or newer request already
// superseded this transcription.
- (BOOL)claimSpeechCompletion:(NSUInteger)generation {
  if (generation != self.speechGeneration) return NO;
  self.speechTask = nil;
  self.speechRecognizer = nil;
  return YES;
}

- (void)transcribeSystemRecording:(NSURL *)url {
  if (self.speechTask) {
    FDEmit(FDEventFailedRetained,
           @"This recording is already being transcribed.");
    return;
  }
  NSUInteger generation = ++self.speechGeneration;
  SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] init];
  if (!recognizer || !recognizer.available) {
    FDEmit(FDEventFailedRetained,
           @"Apple Speech is temporarily unavailable. Your recording has been retained.");
    return;
  }
  SFSpeechURLRecognitionRequest *request =
      [[SFSpeechURLRecognitionRequest alloc] initWithURL:url];
  request.shouldReportPartialResults = NO;
  request.taskHint = SFSpeechRecognitionTaskHintDictation;
  if (@available(macOS 13.0, *)) request.addsPunctuation = YES;
  // On-device recognition skips the server round-trip whenever the language
  // model is installed locally (and is the only mode that works offline).
  // Locales without local support keep using the server path.
  if (recognizer.supportsOnDeviceRecognition) {
    request.requiresOnDeviceRecognition = YES;
  }
  self.speechRecognizer = recognizer;
  self.speechTask = [recognizer recognitionTaskWithRequest:request
                                             resultHandler:^(SFSpeechRecognitionResult *result,
                                                             NSError *error) {
    if (!result.final) {
      if (error) {
        dispatch_async(dispatch_get_main_queue(), ^{
          if (![self claimSpeechCompletion:generation]) return;
          FDEmit(FDEventFailedRetained,
                 error.localizedDescription
                     ?: @"Apple Speech could not transcribe the recording.");
        });
      }
      return;
    }
    NSString *text = [result.bestTranscription.formattedString
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (![self claimSpeechCompletion:generation]) return;
      if (text.length < 3) {
        FDEmit(FDEventFailedRetained,
               error.localizedDescription ?: @"No speech was detected. Your recording has been retained.");
        return;
      }
      if (self.rewriteSession) {
        FDEmit(FDEventRewriteInstruction, text);
        return;
      }
      if (![self pasteText:text]) {
        // Carries the transcript so the overlay can offer a clipboard copy.
        FDEmit(FDEventPasteFailed, text);
        return;
      }
      if (!self.retainRecordings) {
        [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
      }
      [self setRetainedRecordingURL:nil provider:0];
      FDEmit(FDEventCompleted, text);
    });
  }];
}

- (BOOL)refreshPasteTargetIfFocused {
  pid_t ownProcessIdentifier = NSProcessInfo.processInfo.processIdentifier;
  for (NSUInteger attempt = 0; attempt < 2; attempt += 1) {
    pid_t focusedProcessIdentifier = 0;
    AXUIElementRef focusedElement =
        FDCopyFocusedUIElement(&focusedProcessIdentifier);
    pid_t frontmostProcessIdentifier =
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    // Session events go to the frontmost application. AX focus can lag during
    // an app switch, so it is useful for refreshing the editor but must not be
    // allowed to overrule the application that will actually receive Cmd+V.
    BOOL targetOwnsFocus =
        frontmostProcessIdentifier > 0 &&
        frontmostProcessIdentifier ==
            self.pasteTargetApplicationProcessIdentifier;
    if (targetOwnsFocus) {
      if (focusedElement &&
          (focusedProcessIdentifier == self.pasteTargetProcessIdentifier ||
           focusedProcessIdentifier ==
               self.pasteTargetApplicationProcessIdentifier)) {
        if (_pasteTargetElement) CFRelease(_pasteTargetElement);
        _pasteTargetElement = focusedElement;
        self.pasteTargetProcessIdentifier = focusedProcessIdentifier;
      } else if (focusedElement) {
        CFRelease(focusedElement);
      }
      return YES;
    }
    if (focusedElement) CFRelease(focusedElement);

    // The dictation overlay normally cannot take focus. Its buttons can briefly
    // activate FalconDeck, though, so restore the captured external target in
    // that one known case. Never pull focus away from another external app the
    // writer intentionally switched to while transcription was running.
    if (attempt == 0 && frontmostProcessIdentifier == ownProcessIdentifier &&
        self.pasteTargetApplicationProcessIdentifier > 0 &&
        self.pasteTargetApplicationProcessIdentifier != ownProcessIdentifier) {
      NSRunningApplication *targetApplication =
          [NSRunningApplication runningApplicationWithProcessIdentifier:
                                    self.pasteTargetApplicationProcessIdentifier];
      [targetApplication activateWithOptions:0];
      if (_pasteTargetElement) {
        AXUIElementSetAttributeValue(_pasteTargetElement,
                                     kAXFocusedAttribute,
                                     kCFBooleanTrue);
      }
      usleep(FDPasteboardPrepareDelayMicros);
      continue;
    }

    os_log_error(FDPasteLog(),
                 "target lost focus targetPid=%{public}d appPid=%{public}d "
                 "focusedPid=%{public}d frontmostPid=%{public}d",
                 self.pasteTargetProcessIdentifier,
                 self.pasteTargetApplicationProcessIdentifier,
                 focusedProcessIdentifier, frontmostProcessIdentifier);
    return NO;
  }
  return NO;
}

- (BOOL)postPasteShortcut {
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
  if (!source) return NO;
  CGKeyCode pasteKeyCode = FDPasteVirtualKeyCode();
  CGEventRef commandDown =
      CGEventCreateKeyboardEvent(source, FDLeftCommandKeyCode, true);
  CGEventRef pasteDown =
      CGEventCreateKeyboardEvent(source, pasteKeyCode, true);
  CGEventRef pasteUp =
      CGEventCreateKeyboardEvent(source, pasteKeyCode, false);
  CGEventRef commandUp =
      CGEventCreateKeyboardEvent(source, FDLeftCommandKeyCode, false);
  if (!commandDown || !pasteDown || !pasteUp || !commandUp) {
    if (commandDown) CFRelease(commandDown);
    if (pasteDown) CFRelease(pasteDown);
    if (pasteUp) CFRelease(pasteUp);
    if (commandUp) CFRelease(commandUp);
    CFRelease(source);
    return NO;
  }

  CGEventSetFlags(commandDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(pasteDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(pasteUp, kCGEventFlagMaskCommand);
  CGEventSetFlags(commandUp, 0);
  CGEventRef events[] = {commandDown, pasteDown, pasteUp, commandUp};
  for (NSUInteger index = 0; index < 4; index += 1) {
    CGEventSetIntegerValueField(events[index], kCGEventSourceUserData,
                                FDPasteEventUserData);
    // Post at the HID entry point so the shortcut follows the same routing
    // path as physical keyboard input. FalconDeck already requires the
    // Accessibility grant needed for this system-wide injection.
    CGEventPost(kCGHIDEventTap, events[index]);
    if (index < 3) usleep(FDPasteShortcutEventDelayMicros);
  }
  CFRelease(commandDown);
  CFRelease(pasteDown);
  CFRelease(pasteUp);
  CFRelease(commandUp);
  CFRelease(source);
  os_log_info(FDPasteLog(),
              "posted paste shortcut appPid=%{public}d keyCode=%{public}u",
              self.pasteTargetApplicationProcessIdentifier, pasteKeyCode);
  return YES;
}

- (BOOL)postCopyShortcut {
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
  if (!source) return NO;
  CGKeyCode copyKeyCode = FDCopyVirtualKeyCode();
  CGEventRef commandDown =
      CGEventCreateKeyboardEvent(source, FDLeftCommandKeyCode, true);
  CGEventRef copyDown =
      CGEventCreateKeyboardEvent(source, copyKeyCode, true);
  CGEventRef copyUp =
      CGEventCreateKeyboardEvent(source, copyKeyCode, false);
  CGEventRef commandUp =
      CGEventCreateKeyboardEvent(source, FDLeftCommandKeyCode, false);
  if (!commandDown || !copyDown || !copyUp || !commandUp) {
    if (commandDown) CFRelease(commandDown);
    if (copyDown) CFRelease(copyDown);
    if (copyUp) CFRelease(copyUp);
    if (commandUp) CFRelease(commandUp);
    CFRelease(source);
    return NO;
  }

  CGEventSetFlags(commandDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(copyDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(copyUp, kCGEventFlagMaskCommand);
  CGEventSetFlags(commandUp, 0);
  CGEventRef events[] = {commandDown, copyDown, copyUp, commandUp};
  for (NSUInteger index = 0; index < 4; index += 1) {
    CGEventSetIntegerValueField(events[index], kCGEventSourceUserData,
                                FDPasteEventUserData);
    CGEventPost(kCGHIDEventTap, events[index]);
    if (index < 3) usleep(FDPasteShortcutEventDelayMicros);
  }
  CFRelease(commandDown);
  CFRelease(copyDown);
  CFRelease(copyUp);
  CFRelease(commandUp);
  CFRelease(source);
  return YES;
}

- (NSString *)captureSelectedText {
  NSString *axText = FDSelectedTextFromElement(_pasteTargetElement);
  if (axText) {
    NSString *trimmed = [axText
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return trimmed.length > 0 ? axText : nil;
  }

  NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
  NSArray<NSPasteboardItem *> *previousItems = nil;
  @try {
    previousItems = FDSnapshotPasteboard(pasteboard);
  } @catch (__unused NSException *exception) {
    previousItems = @[];
  }
  NSInteger before = pasteboard.changeCount;
  if (![self postCopyShortcut]) {
    @try {
      FDRestorePasteboard(pasteboard, previousItems);
    } @catch (__unused NSException *exception) {
    }
    return nil;
  }
  for (int attempt = 0; attempt < FDCopyPollAttempts; attempt += 1) {
    usleep(FDCopyPollIntervalMicros);
    if (pasteboard.changeCount == before) continue;
    NSString *text = nil;
    @try {
      text = [pasteboard stringForType:NSPasteboardTypeString];
    } @catch (__unused NSException *exception) {
      text = nil;
    }
    @try {
      FDRestorePasteboard(pasteboard, previousItems);
    } @catch (__unused NSException *exception) {
    }
    NSString *trimmed = [text
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return trimmed.length > 0 ? text : nil;
  }
  @try {
    FDRestorePasteboard(pasteboard, previousItems);
  } @catch (__unused NSException *exception) {
  }
  return nil;
}

- (void)finishActivePasteboardSessionIfOwned {
  NSInteger temporaryChangeCount = self.activePasteboardChangeCount;
  if (temporaryChangeCount == 0) return;
  self.pasteboardGeneration += 1;
  NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
  @try {
    if (pasteboard.changeCount == temporaryChangeCount) {
      FDRestorePasteboard(pasteboard, self.pasteboardRestoreItems ?: @[]);
    }
  } @catch (__unused NSException *exception) {
    os_log_error(FDPasteLog(), "clipboard restore raised an exception");
  }
  self.activePasteboardChangeCount = 0;
  self.pasteboardRestoreItems = nil;
}

- (BOOL)pasteText:(NSString *)text {
  if (!AXIsProcessTrusted() || text.length == 0) return NO;
  pid_t targetApplicationProcessIdentifier =
      self.pasteTargetApplicationProcessIdentifier > 0
          ? self.pasteTargetApplicationProcessIdentifier
          : self.pasteTargetProcessIdentifier;
  if (targetApplicationProcessIdentifier <= 0) return NO;

  // FalconDeck owns its composer and can update it directly. Cross-process AX
  // selected-text writes are deliberately not used: controlled web fields can
  // report kAXErrorSuccess without accepting the edit or firing their input
  // handlers. A normal paste is the one insertion contract those applications,
  // terminals and native controls all share.
  if (targetApplicationProcessIdentifier ==
      NSProcessInfo.processInfo.processIdentifier) {
    FDEmit(FDEventSelfInsert, text);
    return YES;
  }
  if (![self refreshPasteTargetIfFocused]) return NO;

  NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
  NSArray<NSPasteboardItem *> *previousItems = nil;
  @try {
    BOOL reusesActiveTransaction =
        self.activePasteboardChangeCount != 0 &&
        pasteboard.changeCount == self.activePasteboardChangeCount;
    previousItems = reusesActiveTransaction
        ? (self.pasteboardRestoreItems ?: @[])
        : FDSnapshotPasteboard(pasteboard);
  } @catch (__unused NSException *exception) {
    previousItems = @[];
  }

  NSUInteger generation = self.pasteboardGeneration + 1;
  self.pasteboardGeneration = generation;
  self.pasteboardRestoreItems = previousItems;
  @try {
    if (!FDWriteTransientTranscript(pasteboard, text)) {
      FDRestorePasteboard(pasteboard, previousItems);
      self.activePasteboardChangeCount = 0;
      self.pasteboardRestoreItems = nil;
      return NO;
    }
  } @catch (__unused NSException *exception) {
    @try {
      FDRestorePasteboard(pasteboard, previousItems);
    } @catch (__unused NSException *restoreException) {
    }
    self.activePasteboardChangeCount = 0;
    self.pasteboardRestoreItems = nil;
    return NO;
  }
  NSInteger transcriptChangeCount = pasteboard.changeCount;
  self.activePasteboardChangeCount = transcriptChangeCount;

  // Give the pasteboard server and clipboard integrations one short settling
  // turn before delivering the shortcut. Re-check focus afterwards so the
  // normal session event can never be routed to an app that became active in
  // that interval.
  usleep(FDPasteboardPrepareDelayMicros);
  if (![self refreshPasteTargetIfFocused] || ![self postPasteShortcut]) {
    [self finishActivePasteboardSessionIfOwned];
    return NO;
  }

  __weak FDDictationController *weakSelf = self;
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW,
                    FDPasteboardRestoreDelayNanoseconds),
      dispatch_get_main_queue(), ^{
        FDDictationController *strongSelf = weakSelf;
        if (!strongSelf || strongSelf.pasteboardGeneration != generation) {
          return;
        }
        @try {
          BOOL stillOwnsPasteboard =
              pasteboard.changeCount == transcriptChangeCount;
          if (stillOwnsPasteboard) {
            FDRestorePasteboard(
                pasteboard, strongSelf.pasteboardRestoreItems ?: @[]);
            os_log_info(FDPasteLog(), "restored clipboard after paste");
          } else {
            os_log_info(FDPasteLog(),
                        "skipped clipboard restore because ownership changed");
          }
        } @catch (__unused NSException *exception) {
          os_log_error(FDPasteLog(),
                       "delayed clipboard restore raised an exception");
        }
        strongSelf.activePasteboardChangeCount = 0;
        strongSelf.pasteboardRestoreItems = nil;
      });
  return YES;
}

- (void)retryLastRecording {
  if (self.pasteTargetProcessIdentifier <= 0) {
    [self capturePasteTarget];
  }
  NSURL *url = self.recordingURL;
  if (!url || ![[NSFileManager defaultManager] fileExistsAtPath:url.path]) {
    FDEmit(FDEventFailed, @"There is no retained recording to retry.");
    return;
  }
  // Retry with the provider that recorded the audio; only legacy recordings
  // without a stored provider fall back to the current setting.
  self.cancelledRecordingPending = NO;
  [self returnFocusToPasteTarget];
  FDProvider provider =
      self.retainedProvider >= 0 ? (FDProvider)self.retainedProvider : self.provider;
  if (@available(macOS 10.15, *)) {
    if (provider == FDProviderSystem && self.speechTask) {
      FDEmit(FDEventFailedRetained,
             @"This recording is already being transcribed.");
      return;
    }
  }
  FDEmit(FDEventProcessing, @"");
  if (self.rewriteSession && self.rewriteSelection.length > 0) {
    FDEmit(FDEventRewriteSelection, self.rewriteSelection);
  }
  if (provider == FDProviderSystem) {
    if (@available(macOS 10.15, *)) {
      FDEmit(FDEventAudioRecorded, url.path);
      [self transcribeSystemRecording:url];
    } else {
      FDEmit(FDEventFailedRetained,
             @"Apple Speech requires macOS 10.15 or later. Your recording has been retained.");
    }
  } else {
    FDEmit(FDEventAudioReady, url.path);
  }
}

// Deletes the audio held for the undo window. Rust calls this when the window
// closes; -startRecording and -shutdown call it so the take cannot linger.
- (void)dropCancelledRecording {
  if (!self.cancelledRecordingPending) return;
  self.cancelledRecordingPending = NO;
  if (self.recordingURL) {
    [[NSFileManager defaultManager] removeItemAtURL:self.recordingURL error:nil];
  }
  [self setRetainedRecordingURL:nil provider:0];
}

// Clicking the overlay pulls FalconDeck to the front. Hand focus back to the
// app the transcript is bound for, so the writer keeps their place.
- (void)returnFocusToPasteTarget {
  pid_t target = self.pasteTargetApplicationProcessIdentifier > 0
      ? self.pasteTargetApplicationProcessIdentifier
      : self.pasteTargetProcessIdentifier;
  pid_t own = NSProcessInfo.processInfo.processIdentifier;
  if (target <= 0 || target == own) return;
  if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != own) return;
  [[NSRunningApplication runningApplicationWithProcessIdentifier:target]
      activateWithOptions:0];
}

- (void)discardLastRecording {
  if (self.recording) {
    [self cancelRecording];
    return;
  }
  self.cancelledRecordingPending = NO;
  if (@available(macOS 10.15, *)) {
    self.speechGeneration += 1;
    [self.speechTask cancel];
    self.speechTask = nil;
    self.speechRecognizer = nil;
  }
  if (self.recordingURL) {
    [[NSFileManager defaultManager] removeItemAtURL:self.recordingURL error:nil];
    [self setRetainedRecordingURL:nil provider:0];
  }
  [self clearRewriteSession];
  FDEmit(FDEventCancelled, @"");
}

- (void)markLastRecordingCompleted {
  [self setRetainedRecordingURL:nil provider:0];
  [self clearRewriteSession];
}

// A recording restored from a previous session (or left over from a failed
// transcription) otherwise blocks every new recording invisibly. Surface it
// whenever dictation is (re-)enabled and the controller is idle.
- (void)surfaceRetainedRecordingIfNeeded {
  if ((!self.enabled && !self.rewriteEnabled) || self.recording ||
      self.stopping) {
    return;
  }
  if (self.cancelledRecordingPending) return;
  if (@available(macOS 10.15, *)) {
    if (self.speechTask) return;
  }
  NSURL *url = self.recordingURL;
  if (!url || ![[NSFileManager defaultManager] fileExistsAtPath:url.path]) return;
  FDEmit(FDEventFailedRetained,
         @"A recording is waiting to be transcribed. Retry or discard it from "
         @"the dictation overlay.");
}

- (void)shutdown {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [self finishActivePasteboardSessionIfOwned];
  [self dropCancelledRecording];
  [self stopAudioLevelMeter];
  if (@available(macOS 10.15, *)) {
    self.speechGeneration += 1;
    [self.speechTask cancel];
    self.speechTask = nil;
    self.speechRecognizer = nil;
  }
  if (self.recording) [self cancelRecording];
  if (self.eventTapSource) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), self.eventTapSource,
                          kCFRunLoopCommonModes);
    CFRelease(self.eventTapSource);
    self.eventTapSource = NULL;
  }
  if (self.eventTap) {
    CFMachPortInvalidate(self.eventTap);
    CFRelease(self.eventTap);
    self.eventTap = NULL;
  }
}

@end

bool fd_dictation_make_overlay_nonactivating(void *window_pointer) {
  if (!window_pointer) return false;

  __block bool configured = false;
  void (^configure)(void) = ^{
    NSWindow *window = (__bridge NSWindow *)window_pointer;
    Class originalClass = object_getClass(window);
    Class panelClass = FDDictationOverlayPanel.class;
    if (!originalClass ||
        class_getInstanceSize(panelClass) > class_getInstanceSize(originalClass)) {
      return;
    }

    Class replacedClass = object_setClass(window, panelClass);
    if (replacedClass != originalClass) return;

    FDDictationOverlayPanel *panel = (FDDictationOverlayPanel *)window;
    panel.styleMask = FDOverlayStyleMask(panel.styleMask);
    panel.becomesKeyOnlyIfNeeded = YES;
    // The overlay belongs to the external app receiving dictation, so it must
    // remain visible while FalconDeck itself is inactive.
    panel.hidesOnDeactivate = NO;
    configured = [panel isKindOfClass:NSPanel.class] &&
        (panel.styleMask & NSWindowStyleMaskNonactivatingPanel) != 0 &&
        !panel.canBecomeKeyWindow && !panel.canBecomeMainWindow;
  };

  if (NSThread.isMainThread) configure();
  else dispatch_sync(dispatch_get_main_queue(), configure);
  return configured;
}

bool fd_dictation_test_overlay_panel_contract(void) {
  Class candidate = FDDictationOverlayPanel.class;
  BOOL isPanelClass = NO;
  for (Class superclass = candidate; superclass;
       superclass = class_getSuperclass(superclass)) {
    if (superclass == NSPanel.class) {
      isPanelClass = YES;
      break;
    }
  }
  Method candidateCanKey =
      class_getInstanceMethod(candidate, @selector(canBecomeKeyWindow));
  Method panelCanKey =
      class_getInstanceMethod(NSPanel.class, @selector(canBecomeKeyWindow));
  Method candidateCanMain =
      class_getInstanceMethod(candidate, @selector(canBecomeMainWindow));
  Method panelCanMain =
      class_getInstanceMethod(NSPanel.class, @selector(canBecomeMainWindow));
  return isPanelClass &&
      (FDOverlayStyleMask(NSWindowStyleMaskBorderless) &
       NSWindowStyleMaskNonactivatingPanel) != 0 &&
      candidateCanKey && panelCanKey &&
      method_getImplementation(candidateCanKey) !=
          method_getImplementation(panelCanKey) &&
      candidateCanMain && panelCanMain &&
      method_getImplementation(candidateCanMain) !=
          method_getImplementation(panelCanMain);
}

void fd_dictation_configure(bool enabled, const char *shortcut,
                            int32_t activation_mode, int32_t provider,
                            const char *input_device_id,
                            bool retain_recordings, bool rewrite_enabled,
                            const char *rewrite_shortcut) {
  NSString *inputDeviceID = input_device_id
      ? [NSString stringWithUTF8String:input_device_id]
      : nil;
  NSString *shortcutName = shortcut
      ? [NSString stringWithUTF8String:shortcut]
      : @"right_command";
  NSString *rewriteName = rewrite_shortcut
      ? [NSString stringWithUTF8String:rewrite_shortcut]
      : @"right_option";
  FDHotkey parsedShortcut = FDParseHotkey(shortcutName);
  FDHotkey parsedRewrite = FDParseHotkey(rewriteName);
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController]
        configureEnabled:enabled
               shortcut:parsedShortcut
         activationMode:(FDActivationMode)activation_mode
                provider:(FDProvider)provider
           inputDeviceID:inputDeviceID
        retainRecordings:retain_recordings
          rewriteEnabled:rewrite_enabled
         rewriteShortcut:parsedRewrite];
  });
}

// The recording the overlay would retry, so a retry that already happened
// elsewhere can clear it without disturbing a different pending one.
char *fd_dictation_retained_recording_path(void) {
  @autoreleasepool {
    __block NSString *path = nil;
    void (^read)(void) = ^{
      path = [FDDictationController sharedController].recordingURL.path;
    };
    if (NSThread.isMainThread) {
      read();
    } else {
      dispatch_sync(dispatch_get_main_queue(), read);
    }
    return path.length > 0 ? strdup(path.UTF8String) : NULL;
  }
}

double fd_dictation_retained_recording_duration_seconds(void) {
  __block NSTimeInterval duration = 0;
  void (^read)(void) = ^{
    duration = [FDDictationController sharedController].recordingDurationSeconds;
  };
  if (NSThread.isMainThread) {
    read();
  } else {
    dispatch_sync(dispatch_get_main_queue(), read);
  }
  return isfinite(duration) && duration > 0 ? duration : 0;
}

bool fd_dictation_test_recording_duration_is_usable(double duration_seconds) {
  return FDRecordingDurationIsUsable(duration_seconds);
}

char *fd_dictation_audio_devices_json(void) {
  @autoreleasepool {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSArray<AVCaptureDevice *> *devices =
        [AVCaptureDevice devicesWithMediaType:AVMediaTypeAudio];
#pragma clang diagnostic pop
    AVCaptureDevice *defaultDevice =
        [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
    NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
    for (AVCaptureDevice *device in devices) {
      [items addObject:@{
        @"id" : device.uniqueID ?: @"",
        @"name" : device.localizedName ?: @"Microphone",
        @"isDefault" : @([device.uniqueID isEqualToString:defaultDevice.uniqueID]),
      }];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:items options:0 error:nil];
    NSString *json = data
        ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
        : @"[]";
    return strdup(json.UTF8String ?: "[]");
  }
}

char *fd_dictation_temp_directory(void) {
  NSString *directory = NSTemporaryDirectory() ?: @"/tmp";
  return strdup(directory.UTF8String ?: "/tmp");
}

void fd_dictation_free_string(char *value) {
  free(value);
}

static void FDOpenPrivacySettings(NSString *pane) {
  NSString *value = [NSString stringWithFormat:
      @"x-apple.systempreferences:com.apple.preference.security?%@", pane];
  [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:value]];
}

void fd_dictation_request_microphone_permission(void) {
  if (@available(macOS 10.14, *)) {
    AVAuthorizationStatus status =
        [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status == AVAuthorizationStatusNotDetermined) {
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                               completionHandler:^(__unused BOOL granted) {}];
    } else if (status != AVAuthorizationStatusAuthorized) {
      FDOpenPrivacySettings(@"Privacy_Microphone");
    }
  }
}

void fd_dictation_request_speech_permission(void) {
  if (@available(macOS 10.15, *)) {
    SFSpeechRecognizerAuthorizationStatus status =
        [SFSpeechRecognizer authorizationStatus];
    if (status == SFSpeechRecognizerAuthorizationStatusNotDetermined) {
      [SFSpeechRecognizer requestAuthorization:^(__unused SFSpeechRecognizerAuthorizationStatus status) {}];
    } else if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
      FDOpenPrivacySettings(@"Privacy_SpeechRecognition");
    }
  }
}

void fd_dictation_request_accessibility_permission(void) {
  NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
  AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

int32_t fd_dictation_microphone_permission(void) {
  if (@available(macOS 10.14, *)) {
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
      case AVAuthorizationStatusAuthorized: return 2;
      case AVAuthorizationStatusNotDetermined: return 0;
      default: return 1;
    }
  }
  return 3;
}

int32_t fd_dictation_speech_permission(void) {
  if (@available(macOS 10.15, *)) {
    switch ([SFSpeechRecognizer authorizationStatus]) {
      case SFSpeechRecognizerAuthorizationStatusAuthorized: return 2;
      case SFSpeechRecognizerAuthorizationStatusNotDetermined: return 0;
      default: return 1;
    }
  }
  return 3;
}

bool fd_dictation_accessibility_permission(void) {
  return AXIsProcessTrusted();
}

void fd_dictation_start(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController] startRecording];
  });
}

void fd_dictation_stop(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController] stopRecording];
  });
}

void fd_dictation_cancel(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController] cancelRecording];
  });
}

void fd_dictation_drop_cancelled(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController] dropCancelledRecording];
  });
}

void fd_dictation_retry(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController] retryLastRecording];
  });
}

void fd_dictation_discard(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController] discardLastRecording];
  });
}

bool fd_dictation_paste_text(const char *utf8_text) {
  if (!utf8_text) return false;
  NSString *text = [NSString stringWithUTF8String:utf8_text];
  return [[FDDictationController sharedController] pasteText:text];
}

bool fd_dictation_test_transient_pasteboard_round_trip(void) {
  @autoreleasepool {
    NSPasteboard *pasteboard = [NSPasteboard pasteboardWithUniqueName];
    NSPasteboardType customType = @"com.falcondeck.dictation.test-custom";
    NSPasteboardType secondCustomType =
        @"com.falcondeck.dictation.test-second-custom";
    NSData *customData = [@"original-custom-payload"
        dataUsingEncoding:NSUTF8StringEncoding];
    NSData *secondCustomData = [@"second-original-payload"
        dataUsingEncoding:NSUTF8StringEncoding];
    NSPasteboardItem *originalItem = [[NSPasteboardItem alloc] init];
    [originalItem setString:@"original text"
                    forType:NSPasteboardTypeString];
    [originalItem setData:customData forType:customType];
    NSPasteboardItem *secondOriginalItem =
        [[NSPasteboardItem alloc] init];
    [secondOriginalItem setData:secondCustomData forType:secondCustomType];
    [pasteboard clearContents];
    [pasteboard writeObjects:@[ originalItem, secondOriginalItem ]];

    NSArray<NSPasteboardItem *> *snapshot = FDSnapshotPasteboard(pasteboard);
    BOOL wroteTranscript =
        FDWriteTransientTranscript(pasteboard, @"temporary transcript");
    NSInteger temporaryChangeCount = pasteboard.changeCount;
    BOOL ownsTransientPayload =
        wroteTranscript &&
        [@"temporary transcript" isEqualToString:
            [pasteboard stringForType:NSPasteboardTypeString]] &&
        [pasteboard dataForType:FDTransientPasteboardType] != nil &&
        [pasteboard dataForType:FDAutoGeneratedPasteboardType] != nil &&
        [@"com.falcondeck.desktop" isEqualToString:
            [pasteboard stringForType:FDPasteboardSourceType]];

    // Rewriting even an identical payload transfers ownership and must stop an
    // older transaction from restoring over it.
    [pasteboard clearContents];
    [pasteboard setString:@"temporary transcript"
                  forType:NSPasteboardTypeString];
    BOOL ownershipChangeDetected =
        pasteboard.changeCount != temporaryChangeCount;

    FDRestorePasteboard(pasteboard, snapshot);
    NSArray<NSPasteboardItem *> *restoredItems = pasteboard.pasteboardItems;
    BOOL restoredOriginal =
        restoredItems.count == 2 &&
        [@"original text" isEqualToString:
            [pasteboard stringForType:NSPasteboardTypeString]] &&
        [customData isEqualToData:[restoredItems[0] dataForType:customType]] &&
        [secondCustomData isEqualToData:
            [restoredItems[1] dataForType:secondCustomType]];
    [pasteboard releaseGlobally];
    return ownsTransientPayload && ownershipChangeDetected && restoredOriginal;
  }
}

bool fd_dictation_copy_text(const char *utf8_text) {
  if (!utf8_text) return false;
  NSString *text = [NSString stringWithUTF8String:utf8_text];
  if (text.length == 0) return false;
  __block bool copied = false;
  void (^copy)(void) = ^{
    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    [pasteboard clearContents];
    copied = [pasteboard setString:text forType:NSPasteboardTypeString];
  };
  if (NSThread.isMainThread) copy();
  else dispatch_sync(dispatch_get_main_queue(), copy);
  return copied;
}

void fd_dictation_mark_completed(void) {
  [[FDDictationController sharedController] markLastRecordingCompleted];
}

void fd_dictation_open_accessibility_settings(void) {
  FDOpenPrivacySettings(@"Privacy_Accessibility");
}

void fd_dictation_shutdown(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController] shutdown];
  });
}
