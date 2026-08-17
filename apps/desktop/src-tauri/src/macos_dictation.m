#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#import <Speech/Speech.h>
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

typedef NS_ENUM(int32_t, FDEventKind) {
  FDEventRecording = 0,
  FDEventProcessing = 1,
  FDEventCompleted = 2,
  FDEventFailed = 3,
  FDEventCancelled = 4,
  FDEventAudioReady = 5,
  FDEventFailedRetained = 6,
  FDEventAudioLevel = 7,
};

static const CGKeyCode FDRightCommandKeyCode = 54;
static const CGKeyCode FDFunctionKeyCode = 63;
static const CGKeyCode FDEscapeKeyCode = 53;
static NSString *const FDRetainedRecordingPathKey =
    @"falcondeck.dictation.retained-recording-path";

static void FDEmit(FDEventKind kind, NSString *payload) {
  fd_dictation_emit((int32_t)kind, (payload ?: @"").UTF8String);
}

@interface FDDictationController : NSObject <AVCaptureFileOutputRecordingDelegate>
@property(nonatomic) BOOL enabled;
@property(nonatomic) BOOL modifierDown;
@property(nonatomic) BOOL modifierUsedInChord;
@property(nonatomic) BOOL cancelling;
@property(nonatomic) BOOL recording;
@property(nonatomic) BOOL stopping;
@property(nonatomic) NSUInteger modifierGeneration;
@property(nonatomic) NSUInteger speechGeneration;
@property(nonatomic) FDShortcut shortcut;
@property(nonatomic) FDShortcut recordingShortcut;
@property(nonatomic) FDActivationMode activationMode;
@property(nonatomic) FDProvider provider;
@property(nonatomic) FDProvider recordingProvider;
@property(nonatomic, copy) NSString *inputDeviceID;
@property(nonatomic, strong) AVCaptureSession *captureSession;
@property(nonatomic, strong) AVCaptureAudioFileOutput *audioFileOutput;
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
  NSString *retainedPath =
      [NSUserDefaults.standardUserDefaults stringForKey:FDRetainedRecordingPathKey];
  if (retainedPath.length > 0 &&
      [NSFileManager.defaultManager fileExistsAtPath:retainedPath]) {
    self.recordingURL = [NSURL fileURLWithPath:retainedPath];
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

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  (void)notification;
  if (self.enabled) [self installEventTapIfNeeded];
}

- (void)setRetainedRecordingURL:(NSURL *)url {
  self.recordingURL = url;
  if (url) {
    [NSUserDefaults.standardUserDefaults setObject:url.path
                                            forKey:FDRetainedRecordingPathKey];
  } else {
    [NSUserDefaults.standardUserDefaults removeObjectForKey:FDRetainedRecordingPathKey];
  }
}

- (void)configureEnabled:(BOOL)enabled
                 shortcut:(FDShortcut)shortcut
           activationMode:(FDActivationMode)activationMode
                  provider:(FDProvider)provider
             inputDeviceID:(NSString *)inputDeviceID {
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
  } else if (self.recording) {
    [self cancelRecording];
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
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 180 * NSEC_PER_MSEC),
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

- (void)startRecording {
  if (!self.enabled || self.recording || self.stopping) return;
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
  output.audioSettings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @44100,
    AVNumberOfChannelsKey : @1,
    AVEncoderAudioQualityKey : @(AVAudioQualityHigh),
  };
  if (![[AVCaptureAudioFileOutput availableOutputFileTypes]
          containsObject:AVFileTypeAppleM4A]) {
    FDEmit(FDEventFailed, @"This Mac cannot create an M4A dictation recording.");
    return;
  }
  self.captureSession = session;
  self.audioFileOutput = output;
  [self setRetainedRecordingURL:url];
  self.cancelling = NO;
  self.recordingShortcut = self.shortcut;
  self.recordingProvider = self.provider;
  self.recording = YES;
  [session startRunning];
  [output startRecordingToOutputFileURL:url
                         outputFileType:AVFileTypeAppleM4A
                      recordingDelegate:self];
  [self startAudioLevelMeter];
  FDEmit(FDEventRecording, @"");
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
    [self.captureSession stopRunning];
    [self stopAudioLevelMeter];
    self.captureSession = nil;
    self.audioFileOutput = nil;
    self.stopping = NO;
    NSURL *url = self.recordingURL ?: outputFileURL;
    if (self.cancelling) {
      if (url) [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
      [self setRetainedRecordingURL:nil];
      self.cancelling = NO;
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
  self.speechRecognizer = recognizer;
  self.speechTask = [recognizer recognitionTaskWithRequest:request
                                             resultHandler:^(SFSpeechRecognitionResult *result,
                                                             NSError *error) {
    if (!result.final) {
      if (error) {
        dispatch_async(dispatch_get_main_queue(), ^{
          if (generation != self.speechGeneration) return;
          self.speechTask = nil;
          self.speechRecognizer = nil;
          FDEmit(FDEventFailedRetained, error.localizedDescription ?: @"Apple Speech could not transcribe the recording.");
        });
      }
      return;
    }
    NSString *text = [result.bestTranscription.formattedString
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.speechGeneration) return;
      self.speechTask = nil;
      self.speechRecognizer = nil;
      if (text.length < 3) {
        FDEmit(FDEventFailedRetained,
               error.localizedDescription ?: @"No speech was detected. Your recording has been retained.");
        return;
      }
      if (![self pasteText:text]) {
        FDEmit(FDEventFailedRetained,
               @"The transcript is ready, but FalconDeck could not paste it. Your recording has been retained.");
        return;
      }
      [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
      [self setRetainedRecordingURL:nil];
      FDEmit(FDEventCompleted, text);
    });
  }];
}

- (BOOL)pasteText:(NSString *)text {
  if (!AXIsProcessTrusted() || text.length == 0) return NO;
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
  CGEventRef commandDown = CGEventCreateKeyboardEvent(source, (CGKeyCode)55, true);
  CGEventRef pasteDown = CGEventCreateKeyboardEvent(source, (CGKeyCode)9, true);
  CGEventRef pasteUp = CGEventCreateKeyboardEvent(source, (CGKeyCode)9, false);
  CGEventRef commandUp = CGEventCreateKeyboardEvent(source, (CGKeyCode)55, false);
  if (!commandDown || !pasteDown || !pasteUp || !commandUp) {
    if (commandDown) CFRelease(commandDown);
    if (pasteDown) CFRelease(pasteDown);
    if (pasteUp) CFRelease(pasteUp);
    if (commandUp) CFRelease(commandUp);
    CFRelease(source);
    restorePreviousClipboard();
    return NO;
  }
  CGEventSetFlags(pasteDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(pasteUp, kCGEventFlagMaskCommand);
  CGEventPost(kCGHIDEventTap, commandDown);
  CGEventPost(kCGHIDEventTap, pasteDown);
  CGEventPost(kCGHIDEventTap, pasteUp);
  CGEventPost(kCGHIDEventTap, commandUp);
  CFRelease(commandDown);
  CFRelease(pasteDown);
  CFRelease(pasteUp);
  CFRelease(commandUp);
  CFRelease(source);

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 700 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
    if (pasteboard.changeCount != transcriptChangeCount) return;
    restorePreviousClipboard();
  });
  return YES;
}

- (void)retryLastRecording {
  NSURL *url = self.recordingURL;
  if (!url || ![[NSFileManager defaultManager] fileExistsAtPath:url.path]) {
    FDEmit(FDEventFailed, @"There is no retained recording to retry.");
    return;
  }
  if (@available(macOS 10.15, *)) {
    if (self.provider == FDProviderSystem && self.speechTask) {
      FDEmit(FDEventFailedRetained,
             @"This recording is already being transcribed.");
      return;
    }
  }
  FDEmit(FDEventProcessing, @"");
  if (self.provider == FDProviderSystem) {
    if (@available(macOS 10.15, *)) {
      [self transcribeSystemRecording:url];
    } else {
      FDEmit(FDEventFailedRetained,
             @"Apple Speech requires macOS 10.15 or later. Your recording has been retained.");
    }
  } else {
    FDEmit(FDEventAudioReady, url.path);
  }
}

- (void)discardLastRecording {
  if (self.recording) {
    [self cancelRecording];
    return;
  }
  if (@available(macOS 10.15, *)) {
    self.speechGeneration += 1;
    [self.speechTask cancel];
    self.speechTask = nil;
    self.speechRecognizer = nil;
  }
  if (self.recordingURL) {
    [[NSFileManager defaultManager] removeItemAtURL:self.recordingURL error:nil];
    [self setRetainedRecordingURL:nil];
  }
  FDEmit(FDEventCancelled, @"");
}

- (void)markLastRecordingCompleted {
  [self setRetainedRecordingURL:nil];
}

- (void)shutdown {
  [NSNotificationCenter.defaultCenter removeObserver:self];
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
                            const char *input_device_id) {
  NSString *inputDeviceID = input_device_id
      ? [NSString stringWithUTF8String:input_device_id]
      : nil;
  dispatch_async(dispatch_get_main_queue(), ^{
    [[FDDictationController sharedController]
        configureEnabled:enabled
               shortcut:(FDShortcut)shortcut
         activationMode:(FDActivationMode)activation_mode
                provider:(FDProvider)provider
           inputDeviceID:inputDeviceID];
  });
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
