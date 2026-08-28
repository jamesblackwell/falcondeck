#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#import <Speech/Speech.h>
#import "dictation_events.h"
#include <math.h>
#include <string.h>

extern void fd_dictation_emit(int32_t kind, const char *payload);

typedef NS_ENUM(NSInteger, FDShortcut) {
  FDShortcutRightCommand = 0,
  FDShortcutLeftFunction = 1,
};

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
static const CGKeyCode FDEscapeKeyCode = 53;
static NSString *const FDRetainedRecordingPathKey =
    @"falcondeck.dictation.retained-recording-path";
static NSString *const FDRetainedRecordingProviderKey =
    @"falcondeck.dictation.retained-recording-provider";

static void FDEmit(FDEventKind kind, NSString *payload) {
  fd_dictation_emit((int32_t)kind, (payload ?: @"").UTF8String);
}

@interface FDDictationController : NSObject <AVCaptureFileOutputRecordingDelegate> {
  AXUIElementRef _pasteTargetElement;
}
@property(nonatomic) BOOL enabled;
@property(nonatomic) BOOL modifierDown;
@property(nonatomic) BOOL modifierUsedInChord;
@property(nonatomic) BOOL cancelling;
@property(nonatomic) BOOL recording;
@property(nonatomic) BOOL stopping;
@property(nonatomic) NSUInteger modifierGeneration;
@property(nonatomic) NSUInteger speechGeneration;
@property(nonatomic) pid_t pasteTargetProcessIdentifier;
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
@property(nonatomic) FDShortcut shortcut;
@property(nonatomic) FDShortcut recordingShortcut;
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
@property(nonatomic, strong) SFSpeechRecognizer *speechRecognizer
    API_AVAILABLE(macos(10.15));
@property(nonatomic, strong) SFSpeechRecognitionTask *speechTask
    API_AVAILABLE(macos(10.15));
@property(nonatomic) CFMachPortRef eventTap;
@property(nonatomic) CFRunLoopSourceRef eventTapSource;
- (void)handleFlagsChanged:(CGKeyCode)keyCode flags:(CGEventFlags)flags;
- (void)handleKeyDown:(CGKeyCode)keyCode;
- (void)transcribeSystemRecording:(NSURL *)url API_AVAILABLE(macos(10.15));
- (void)startAudioLevelMeter;
- (void)stopAudioLevelMeter;
- (void)setRetainedRecordingURL:(NSURL *)url provider:(FDProvider)provider;
- (void)sessionDidFinishStarting:(AVCaptureSession *)session
                          output:(AVCaptureAudioFileOutput *)output
                             url:(NSURL *)url;
- (BOOL)claimSpeechCompletion:(NSUInteger)generation API_AVAILABLE(macos(10.15));
- (void)surfaceRetainedRecordingIfNeeded;
- (void)capturePasteTarget;
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

  CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(
      event, kCGKeyboardEventKeycode);
  CGEventFlags flags = CGEventGetFlags(event);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (type == kCGEventFlagsChanged) {
      [controller handleFlagsChanged:keyCode flags:flags];
    } else if (type == kCGEventKeyDown) {
      [controller handleKeyDown:keyCode];
    }
  });
  return event;
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
  NSString *retainedPath =
      [NSUserDefaults.standardUserDefaults stringForKey:FDRetainedRecordingPathKey];
  if (retainedPath.length > 0 &&
      [NSFileManager.defaultManager fileExistsAtPath:retainedPath]) {
    self.recordingURL = [NSURL fileURLWithPath:retainedPath];
    NSNumber *storedProvider =
        [NSUserDefaults.standardUserDefaults objectForKey:FDRetainedRecordingProviderKey];
    self.retainedProvider = storedProvider ? storedProvider.integerValue : -1;
  } else {
    [NSUserDefaults.standardUserDefaults removeObjectForKey:FDRetainedRecordingPathKey];
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
  if (self.enabled) [self installEventTapIfNeeded];
}

- (void)setRetainedRecordingURL:(NSURL *)url provider:(FDProvider)provider {
  self.recordingURL = url;
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

- (void)configureEnabled:(BOOL)enabled
                 shortcut:(FDShortcut)shortcut
           activationMode:(FDActivationMode)activationMode
                  provider:(FDProvider)provider
             inputDeviceID:(NSString *)inputDeviceID
         retainRecordings:(BOOL)retainRecordings {
  self.retainRecordings = retainRecordings;
  BOOL shouldResetModifier = self.enabled != enabled || self.shortcut != shortcut;
  self.enabled = enabled;
  self.shortcut = shortcut;
  self.activationMode = activationMode;
  self.provider = provider;
  self.inputDeviceID = inputDeviceID.length > 0 ? inputDeviceID : nil;
  if (shouldResetModifier && !self.recording && !self.stopping) {
    self.modifierDown = NO;
    self.modifierUsedInChord = NO;
    self.modifierGeneration += 1;
  }
  if (enabled) {
    [self installEventTapIfNeeded];
    [self surfaceRetainedRecordingIfNeeded];
  } else {
    // Stop routing every system-wide keystroke through the callback while
    // dictation is off; re-enabling re-arms the existing tap.
    if (self.eventTap) CGEventTapEnable(self.eventTap, false);
    if (self.recording) [self cancelRecording];
  }
}

- (void)installEventTapIfNeeded {
  if (self.eventTap) {
    CGEventTapEnable(self.eventTap, true);
    return;
  }
  CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) |
                     CGEventMaskBit(kCGEventKeyDown);
  self.eventTap = CGEventTapCreate(
      kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
      mask, FDEventTapCallback, (__bridge void *)self);
  if (!self.eventTap) {
    return;
  }
  self.eventTapSource = CFMachPortCreateRunLoopSource(
      kCFAllocatorDefault, self.eventTap, 0);
  CFRunLoopAddSource(CFRunLoopGetMain(), self.eventTapSource,
                     kCFRunLoopCommonModes);
  CGEventTapEnable(self.eventTap, true);
}

- (BOOL)isConfiguredModifier:(CGKeyCode)keyCode {
  FDShortcut shortcut = self.recording ? self.recordingShortcut : self.shortcut;
  return (shortcut == FDShortcutRightCommand &&
          keyCode == FDRightCommandKeyCode) ||
         (shortcut == FDShortcutLeftFunction &&
          keyCode == FDFunctionKeyCode);
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

- (BOOL)configuredModifierIsDown:(CGEventFlags)flags {
  FDShortcut shortcut = self.recording ? self.recordingShortcut : self.shortcut;
  if (shortcut == FDShortcutRightCommand) {
    return (flags & NX_DEVICERCMDKEYMASK) != 0;
  }
  return (flags & kCGEventFlagMaskSecondaryFn) != 0;
}

- (void)handleFlagsChanged:(CGKeyCode)keyCode flags:(CGEventFlags)flags {
  if (!self.enabled || ![self isConfiguredModifier:keyCode]) return;
  BOOL isDown = [self configuredModifierIsDown:flags];
  if (isDown == self.modifierDown) return;
  self.modifierDown = isDown;

  if (isDown) {
    self.modifierUsedInChord = NO;
    self.modifierGeneration += 1;
    if (self.activationMode == FDActivationModeHold) {
      NSUInteger generation = self.modifierGeneration;
      // Short chord grace: long enough that most Right-Command shortcuts are
      // recognized as chords first, short enough that dictation feels instant.
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 80 * NSEC_PER_MSEC),
                     dispatch_get_main_queue(), ^{
        if (self.enabled && self.modifierDown &&
            !self.modifierUsedInChord &&
            self.modifierGeneration == generation && !self.recording) {
          [self startRecording];
        }
      });
    }
    return;
  }

  self.modifierGeneration += 1;
  if (self.modifierUsedInChord) return;
  if (self.activationMode == FDActivationModeHold) {
    if (self.recording) [self stopRecording];
  } else if (self.recording) {
    [self stopRecording];
  } else {
    [self startRecording];
  }
}

- (void)handleKeyDown:(CGKeyCode)keyCode {
  if (!self.enabled) return;
  if (self.recording && keyCode == FDEscapeKeyCode) {
    [self cancelRecording];
    return;
  }
  if (self.modifierDown) {
    self.modifierUsedInChord = YES;
    self.modifierGeneration += 1;
    if (self.recording && self.activationMode == FDActivationModeHold) {
      [self cancelRecording];
    }
  }
}

- (void)capturePasteTarget {
  if (_pasteTargetElement) {
    CFRelease(_pasteTargetElement);
    _pasteTargetElement = NULL;
  }
  AXUIElementRef systemWideElement = AXUIElementCreateSystemWide();
  if (systemWideElement) {
    CFTypeRef focusedElement = NULL;
    if (AXUIElementCopyAttributeValue(systemWideElement,
                                      kAXFocusedUIElementAttribute,
                                      &focusedElement) == kAXErrorSuccess &&
        focusedElement) {
      _pasteTargetElement = (AXUIElementRef)focusedElement;
    } else if (focusedElement) {
      CFRelease(focusedElement);
    }
    CFRelease(systemWideElement);
  }
  self.pasteTargetProcessIdentifier =
      NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
}

- (void)startRecording {
  if (!self.enabled || self.recording || self.stopping) return;
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

  NSString *name = [NSString stringWithFormat:@"falcondeck-dictation-%@.m4a",
                                             NSUUID.UUID.UUIDString];
  NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:name]];
  AVCaptureDevice *device = self.inputDeviceID.length > 0
      ? [AVCaptureDevice deviceWithUniqueID:self.inputDeviceID]
      : nil;
  if (!device) device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
  if (!device) {
    FDEmit(FDEventFailed, @"No microphone is currently available.");
    return;
  }

  NSError *error;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device
                                                                      error:&error];
  if (!input || error) {
    FDEmit(FDEventFailed,
           error.localizedDescription ?: @"FalconDeck could not open the selected microphone.");
    return;
  }
  AVCaptureSession *session = [[AVCaptureSession alloc] init];
  AVCaptureAudioFileOutput *output = [[AVCaptureAudioFileOutput alloc] init];
  if (![session canAddInput:input] || ![session canAddOutput:output]) {
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
    FDEmit(FDEventFailed, @"This Mac cannot create an M4A dictation recording.");
    return;
  }
  self.captureSession = session;
  self.audioFileOutput = output;
  [self setRetainedRecordingURL:url provider:self.provider];
  self.cancelling = NO;
  self.recordingShortcut = self.shortcut;
  self.recordingProvider = self.provider;
  self.recording = YES;
  self.fileOutputActive = NO;
  // Surface the overlay before the microphone is warm: -startRunning blocks
  // for hundreds of milliseconds and previously gated all recording feedback.
  FDEmit(FDEventRecording, @"");
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
    if (self.cancelling) {
      self.cancelling = NO;
      NSNumber *cancelledSize = url
          ? [[[NSFileManager defaultManager] attributesOfItemAtPath:url.path error:nil]
                objectForKey:NSFileSize]
          : nil;
      if (url && cancelledSize.unsignedLongLongValue > 0) {
        // Hold what was said up to the Esc so the overlay can undo it, but keep
        // the path out of NSUserDefaults: a persisted cancelled take would come
        // back after a relaunch as a recording "waiting to be transcribed".
        [self setRetainedRecordingURL:nil provider:0];
        self.recordingURL = url;
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

- (BOOL)pasteText:(NSString *)text {
  if (!AXIsProcessTrusted() || text.length == 0) return NO;
  pid_t targetProcessIdentifier = self.pasteTargetProcessIdentifier;
  if (targetProcessIdentifier <= 0) return NO;

  // Pasting into FalconDeck itself via Accessibility or a synthetic Cmd+V is
  // unreliable: WebKit's AX proxy reports success against the React-controlled
  // composer without the state actually updating. Hand the transcript to the
  // webview instead, which inserts it deterministically.
  if (targetProcessIdentifier == NSProcessInfo.processInfo.processIdentifier) {
    FDEmit(FDEventSelfInsert, text);
    return YES;
  }

  // Most editable controls, including WebKit textareas, support replacing the
  // selected text through Accessibility. This is the safest insertion path:
  // no clipboard mutation and no synthetic global keyboard events.
  if (_pasteTargetElement) {
    Boolean selectedTextIsSettable = false;
    AXError settableError = AXUIElementIsAttributeSettable(
        _pasteTargetElement, kAXSelectedTextAttribute,
        &selectedTextIsSettable);
    if (settableError == kAXErrorSuccess && selectedTextIsSettable &&
        AXUIElementSetAttributeValue(_pasteTargetElement,
                                     kAXSelectedTextAttribute,
                                     (__bridge CFTypeRef)text) ==
            kAXErrorSuccess) {
      return YES;
    }
  }

  NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
  NSMutableArray<NSPasteboardItem *> *previousItems = [NSMutableArray array];
  // Pasteboard items are lazy views into the current pasteboard. Keeping those
  // objects and then clearing the pasteboard leaves dangling providers that can
  // raise an Objective-C exception during the delayed restore. Snapshot each
  // payload before clearing so restoration owns independent data.
  @try {
    for (NSPasteboardItem *item in pasteboard.pasteboardItems) {
      NSPasteboardItem *snapshot = [[NSPasteboardItem alloc] init];
      for (NSPasteboardType type in item.types) {
        NSData *data = [item dataForType:type];
        if (data) [snapshot setData:[data copy] forType:type];
      }
      if (snapshot.types.count > 0) [previousItems addObject:snapshot];
    }
  } @catch (__unused NSException *exception) {
    [previousItems removeAllObjects];
  }
  void (^restorePreviousClipboard)(void) = ^{
    @try {
      [pasteboard clearContents];
      if (previousItems.count > 0) [pasteboard writeObjects:previousItems];
    } @catch (__unused NSException *exception) {
      // Clipboard restoration is best-effort and must never terminate the app.
    }
  };
  @try {
    [pasteboard clearContents];
    if (![pasteboard setString:text forType:NSPasteboardTypeString]) {
      restorePreviousClipboard();
      return NO;
    }
  } @catch (__unused NSException *exception) {
    restorePreviousClipboard();
    return NO;
  }
  NSInteger transcriptChangeCount = pasteboard.changeCount;

  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
  if (!source) {
    restorePreviousClipboard();
    return NO;
  }
  CGEventRef pasteDown = CGEventCreateKeyboardEvent(source, (CGKeyCode)9, true);
  CGEventRef pasteUp = CGEventCreateKeyboardEvent(source, (CGKeyCode)9, false);
  if (!pasteDown || !pasteUp) {
    if (pasteDown) CFRelease(pasteDown);
    if (pasteUp) CFRelease(pasteUp);
    CFRelease(source);
    restorePreviousClipboard();
    return NO;
  }
  CGEventSetFlags(pasteDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(pasteUp, kCGEventFlagMaskCommand);
  CGEventPostToPid(targetProcessIdentifier, pasteDown);
  CGEventPostToPid(targetProcessIdentifier, pasteUp);
  CFRelease(pasteDown);
  CFRelease(pasteUp);
  CFRelease(source);

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 700 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
    if (pasteboard.changeCount != transcriptChangeCount) return;
    restorePreviousClipboard();
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
  pid_t target = self.pasteTargetProcessIdentifier;
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
  FDEmit(FDEventCancelled, @"");
}

- (void)markLastRecordingCompleted {
  [self setRetainedRecordingURL:nil provider:0];
}

// A recording restored from a previous session (or left over from a failed
// transcription) otherwise blocks every new recording invisibly. Surface it
// whenever dictation is (re-)enabled and the controller is idle.
- (void)surfaceRetainedRecordingIfNeeded {
  if (!self.enabled || self.recording || self.stopping) return;
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

void fd_dictation_configure(bool enabled, int32_t shortcut,
                            int32_t activation_mode, int32_t provider,
                            const char *input_device_id,
                            bool retain_recordings) {
  NSString *inputDeviceID = input_device_id
      ? [NSString stringWithUTF8String:input_device_id]
      : nil;
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController]
        configureEnabled:enabled
               shortcut:(FDShortcut)shortcut
         activationMode:(FDActivationMode)activation_mode
                provider:(FDProvider)provider
           inputDeviceID:inputDeviceID
        retainRecordings:retain_recordings];
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
