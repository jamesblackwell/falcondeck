#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>

// Exercise the bridge's actual control flow without querying other apps,
// requesting permissions, opening a microphone, or touching the clipboard.
static AXUIElementRef testFocusedElement;
static CFRange testSelection;
static NSString *testValue;
static BOOL testSelectionAvailable = YES;
static NSString *testMarker;
static pid_t testPID = 12345;

@interface FDTestApplication : NSObject
@property(readonly) pid_t processIdentifier;
@end
@implementation FDTestApplication
- (pid_t)processIdentifier { return testPID; }
@end

@interface FDTestWorkspace : NSObject
+ (instancetype)sharedWorkspace;
@property(readonly) NSRunningApplication *frontmostApplication;
- (BOOL)openURL:(NSURL *)url;
@end
@implementation FDTestWorkspace
+ (instancetype)sharedWorkspace {
  static id workspace;
  if (!workspace) workspace = [self new];
  return workspace;
}
- (NSRunningApplication *)frontmostApplication {
  return (id)[FDTestApplication new];
}
- (BOOL)openURL:(NSURL *)url { (void)url; abort(); }
@end

@interface FDTestPasteboard : NSObject
@property(class, readonly) FDTestPasteboard *generalPasteboard;
@property(readonly) NSArray<NSPasteboardItem *> *pasteboardItems;
@property(readonly) NSInteger changeCount;
+ (instancetype)pasteboardWithUniqueName;
- (NSInteger)clearContents;
- (BOOL)writeObjects:(NSArray *)objects;
- (BOOL)setString:(NSString *)string forType:(NSPasteboardType)type;
- (NSString *)stringForType:(NSPasteboardType)type;
- (NSData *)dataForType:(NSPasteboardType)type;
- (void)releaseGlobally;
@end
@implementation FDTestPasteboard
+ (instancetype)generalPasteboard { abort(); }
+ (instancetype)pasteboardWithUniqueName { abort(); }
- (NSArray<NSPasteboardItem *> *)pasteboardItems { abort(); }
- (NSInteger)changeCount { abort(); }
- (NSInteger)clearContents { abort(); }
- (BOOL)writeObjects:(NSArray *)objects { (void)objects; abort(); }
- (BOOL)setString:(NSString *)string forType:(NSPasteboardType)type { (void)string; (void)type; abort(); }
- (NSString *)stringForType:(NSPasteboardType)type { (void)type; abort(); }
- (NSData *)dataForType:(NSPasteboardType)type { (void)type; abort(); }
- (void)releaseGlobally { abort(); }
@end

static NSMutableArray *testExports;
@interface FDTestExportSession : NSObject
@property(nonatomic, strong) NSURL *outputURL;
@property(nonatomic, copy) NSString *outputFileType;
@property(nonatomic) AVAssetExportSessionStatus status;
@property(nonatomic, copy) void (^completion)(void);
- (instancetype)initWithAsset:(AVAsset *)asset presetName:(NSString *)preset;
- (void)exportAsynchronouslyWithCompletionHandler:(void (^)(void))completion;
- (void)cancelExport;
@end
@implementation FDTestExportSession
- (instancetype)initWithAsset:(AVAsset *)asset presetName:(NSString *)preset {
  self = [super init];
  if (self) { (void)asset; (void)preset; [testExports addObject:self]; }
  return self;
}
- (void)exportAsynchronouslyWithCompletionHandler:(void (^)(void))completion { self.completion = completion; }
- (void)cancelExport { self.status = AVAssetExportSessionStatusCancelled; }
@end

static AXError FDTestCopyAttribute(AXUIElementRef element,
                                  CFStringRef attribute, CFTypeRef *value) {
  (void)element;
  if (CFEqual(attribute, kAXFocusedUIElementAttribute)) {
    *value = CFRetain(testFocusedElement);
    return kAXErrorSuccess;
  }
  if (testSelectionAvailable && CFEqual(attribute, kAXSelectedTextRangeAttribute)) {
    *value = AXValueCreate(kAXValueCFRangeType, &testSelection);
    return kAXErrorSuccess;
  }
  if (CFEqual(attribute, kAXValueAttribute)) {
    *value = CFBridgingRetain(testValue);
    return kAXErrorSuccess;
  }
  if (testMarker && CFEqual(attribute, CFSTR("AXSelectedTextMarkerRange"))) {
    *value = CFBridgingRetain(testMarker);
    return kAXErrorSuccess;
  }
  if (CFEqual(attribute, kAXSelectedTextAttribute) && testSelection.location >= 0 &&
      testSelection.length >= 0 && testSelection.location <= (CFIndex)testValue.length &&
      testSelection.length <= (CFIndex)testValue.length - testSelection.location) {
    *value = CFBridgingRetain([testValue substringWithRange:
        NSMakeRange((NSUInteger)testSelection.location, (NSUInteger)testSelection.length)]);
    return kAXErrorSuccess;
  }
  *value = NULL;
  return kAXErrorAttributeUnsupported;
}

static AXError FDTestSetAttribute(AXUIElementRef element,
                                 CFStringRef attribute, CFTypeRef value) {
  (void)element;
  if (CFEqual(attribute, kAXSelectedTextRangeAttribute)) {
    return AXValueGetValue((AXValueRef)value, kAXValueCFRangeType, &testSelection)
        ? kAXErrorSuccess : kAXErrorFailure;
  }
  return kAXErrorAttributeUnsupported;
}

#define NSWorkspace FDTestWorkspace
#define NSPasteboard FDTestPasteboard
#define AVAssetExportSession FDTestExportSession
#define AXUIElementCopyAttributeValue FDTestCopyAttribute
#define AXUIElementSetAttributeValue FDTestSetAttribute
#import "../../Sources/NativeSpeechBridge/NativeSpeechBridge.m"

static NSUInteger failures;
static void Check(BOOL condition, const char *message) {
  if (!condition) { fprintf(stderr, "FAIL: %s\n", message); failures += 1; }
}

static void DrainMainQueue(void) {
  __block BOOL drained = NO;
  dispatch_async(dispatch_get_main_queue(), ^{ drained = YES; });
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2];
  while (!drained && deadline.timeIntervalSinceNow > 0) {
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
  }
  Check(drained, "main queue drained before test deadline");
}

@interface FDTestController : FDDictationController
@property(nonatomic) NSUInteger starts;
@property(nonatomic) NSUInteger stops;
@property(nonatomic) NSUInteger recoverySurfaces;
@property(nonatomic) NSUInteger historyRetries;
@property(nonatomic) BOOL historySawRewrite;
@property(nonatomic) NSUInteger preparations;
@end

@interface FDTestExportController : FDDictationController
@end
@implementation FDTestExportController
- (void)setRetainedRecordingURL:(NSURL *)url provider:(FDProvider)provider {
  self.recordingURL = url;
  self.retainedProvider = provider;
}
- (void)setRecordingDurationSeconds:(NSTimeInterval)duration { (void)duration; }
@end
@implementation FDTestController
- (void)startRecordingAsRewrite:(BOOL)rewrite {
  self.starts += 1;
  self.recording = YES;
  self.rewriteSession = rewrite;
  self.recordingShortcut = rewrite ? self.rewriteShortcut : self.shortcut;
}
- (void)stopRecording { self.stops += 1; self.recording = NO; }
- (void)installEventTapIfNeeded {}
- (void)surfaceRetainedRecordingIfNeeded { self.recoverySurfaces += 1; }
- (void)setRetainedRecordingURL:(NSURL *)url provider:(FDProvider)provider {
  self.recordingURL = url;
  self.retainedProvider = url ? provider : -1;
}
- (void)setRecordingDurationSeconds:(NSTimeInterval)duration { (void)duration; }
- (void)prepareRecordingForTranscription:(NSURL *)url provider:(FDProvider)provider {
  (void)url; (void)provider;
  self.preparations += 1;
}
- (void)retryLastRecordingCopyOnly:(BOOL)copyOnly {
  (void)copyOnly;
  self.historyRetries += 1;
  self.historySawRewrite = self.rewriteSession || self.rewriteSelection != nil;
}
- (BOOL)pasteText:(NSString *)text attemptTargetedFirst:(BOOL)targeted {
  (void)text; (void)targeted;
  return YES;
}
@end

@interface FDTestCaptureOutput : NSObject
@end
@implementation FDTestCaptureOutput
- (CMTime)recordedDuration { return CMTimeMakeWithSeconds(1, 600); }
@end

@interface FDTestTargetController : FDDictationController
@property(nonatomic) BOOL acceptedTarget;
- (void)seedLastPaste:(CFRange)range;
@end
@implementation FDTestTargetController
- (BOOL)pasteText:(NSString *)text attemptTargetedFirst:(BOOL)targeted {
  (void)text; (void)targeted;
  self.acceptedTarget = [self refreshPasteTargetIfFocused];
  return self.acceptedTarget;
}
- (BOOL)pasteText:(NSString *)text { return [self pasteText:text attemptTargetedFirst:NO]; }
- (void)markLastRecordingCompleted {}
- (void)seedLastPaste:(CFRange)range {
  _lastPastedElement = (AXUIElementRef)CFRetain(testFocusedElement);
  self.lastPastedRange = range;
  self.lastPastedRangeKnown = YES;
  self.lastPastedApplicationPid = testPID;
}
@end

static FDDictationController *testSharedController;
static id TestSharedController(id cls, SEL selector) {
  (void)cls; (void)selector;
  return testSharedController;
}

static void TestCapturedDestination(void) {
  FDDictationController *controller = [FDDictationController alloc];
  testSelectionAvailable = YES;
  testSelection = CFRangeMake(2, 0);
  testValue = @"first second";
  [controller capturePasteTarget];
  Check([controller refreshPasteTargetIfFocused], "unchanged captured caret accepted");
  testSelection = CFRangeMake(8, 0);
  Check(![controller refreshPasteTargetIfFocused], "moved caret rejected in same editor");
  testSelection = CFRangeMake(2, 0);
  testValue = @"FIRST second";
  Check(![controller refreshPasteTargetIfFocused], "changed text rejected at same caret");
  testValue = @"first second";
  testSelection = CFRangeMake(0, 5);
  [controller capturePasteTarget];
  testSelection = CFRangeMake(6, 6);
  Check(![controller refreshPasteTargetIfFocused], "changed selection rejected in same editor");
  testSelectionAvailable = NO;
  [controller capturePasteTarget];
  Check(![controller refreshPasteTargetIfFocused], "automatic delivery rejects unknown selection identity");
  testMarker = @"document:first:caret:2";
  [controller capturePasteTarget];
  Check([controller refreshPasteTargetIfFocused], "unchanged text marker fallback accepted");
  testMarker = @"document:first:caret:8";
  Check(![controller refreshPasteTargetIfFocused], "changed text marker fallback rejected");
  testMarker = nil;
  FDTestTargetController *retry = [FDTestTargetController alloc];
  [retry retryPasteTranscript:@"recovered transcript"];
  DrainMainQueue();
  Check(retry.acceptedTarget, "explicit retry accepts current destination without selection APIs");
  testSelectionAvailable = YES;
}

static void TestReplacementOwnsItsDeliberateSelection(void) {
  FDTestTargetController *controller = [FDTestTargetController alloc];
  testValue = @"first ";
  testSelection = CFRangeMake(6, 0);
  [controller capturePasteTarget];
  testValue = @"first transcript";
  testSelection = CFRangeMake(16, 0);
  [controller seedLastPaste:CFRangeMake(6, 10)];
  Check([controller replaceTranscript:@"transcript" withText:@"corrected"],
        "validated replacement updates its own selection snapshot");
}

static void TestToggleChord(void) {
  for (NSUInteger rewrite = 0; rewrite < 2; rewrite += 1) {
    FDTestController *controller = [FDTestController alloc];
    controller.enabled = YES;
    controller.rewriteEnabled = YES;
    controller.shortcut = FDParseHotkey(@"Mod+Shift+D");
    controller.rewriteShortcut = FDParseHotkey(@"Mod+Shift+R");
    controller.activationMode = FDActivationModeToggle;
    FDHotkey shortcut = rewrite ? controller.rewriteShortcut : controller.shortcut;
    [controller handleChordDown:(BOOL)rewrite];
    [controller handleKeyUp:shortcut.keyCode flags:shortcut.requiredFlags];
    [controller handleFlagsChanged:FDLeftCommandKeyCode flags:kCGEventFlagMaskShift];
    Check(controller.recording && controller.starts == 1 && controller.stops == 0,
          "toggle chord keeps recording after modifiers release");
    [controller handleKeyDown:shortcut.keyCode flags:shortcut.requiredFlags repeat:NO];
    Check(!controller.recording && controller.stops == 1, "next toggle chord stops recording");
    controller.activationMode = FDActivationModeHold;
    [controller startRecordingAsRewrite:(BOOL)rewrite];
    [controller handleFlagsChanged:FDLeftCommandKeyCode flags:kCGEventFlagMaskShift];
    Check(!controller.recording && controller.stops == 2, "hold chord stops when modifiers release");
  }
}

static void TestConfigurationRecovery(void) {
  FDTestController *controller = [FDTestController alloc];
  for (NSUInteger iteration = 0; iteration < 2; iteration += 1) {
    [controller configureEnabled:YES shortcut:FDDefaultHotkey()
                 activationMode:FDActivationModeHold provider:FDProviderOpenRouter
                  inputDeviceID:nil retainRecordings:YES rewriteEnabled:NO
                 rewriteShortcut:FDDefaultHotkey() autoCleanupEnabled:YES];
  }
  Check(controller.recoverySurfaces == 1,
        "config edits do not replace active transcription with retained recovery");
}

static void TestHistoryRetryClearsRewrite(void) {
  FDTestController *controller = [FDTestController alloc];
  testSharedController = controller;
  controller.rewriteSession = YES;
  controller.rewriteSelection = @"stale selected passage";
  fd_native_speech_retry_file("/tmp/falcondeck-native-dictation-test.m4a", 0);
  DrainMainQueue();
  Check(controller.historyRetries == 1 && !controller.historySawRewrite,
        "history transcription cannot inherit a previous rewrite session");
}

static void TestRetryPasteReleasesUnretainedAudio(void) {
  FDTestController *controller = [FDTestController alloc];
  NSURL *audio = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:[@"falcondeck-native-dictation-" stringByAppendingString:NSUUID.UUID.UUIDString]]];
  [@"fixture" writeToURL:audio atomically:YES encoding:NSUTF8StringEncoding error:nil];
  controller.recordingURL = audio;
  controller.retainRecordings = NO;
  [controller retryPasteTranscript:@"recovered transcript"];
  DrainMainQueue();
  Check(![NSFileManager.defaultManager fileExistsAtPath:audio.path],
        "successful retry paste deletes audio when history is disabled");
  [NSFileManager.defaultManager removeItemAtURL:audio error:nil];
}

static void TestCancelWhileCaptureIsFinalizing(void) {
  for (NSUInteger cancel = 0; cancel < 2; cancel += 1) {
    FDTestController *controller = [FDTestController alloc];
    testSharedController = controller;
    NSURL *audio = [NSURL fileURLWithPath:[NSTemporaryDirectory()
        stringByAppendingPathComponent:[@"falcondeck-native-dictation-" stringByAppendingString:NSUUID.UUID.UUIDString]]];
    [@"fixture" writeToURL:audio atomically:YES encoding:NSUTF8StringEncoding error:nil];
    controller.recordingURL = audio;
    controller.stopping = YES;
    if (cancel) fd_native_speech_cancel_processing();
    [controller captureOutput:(id)[FDTestCaptureOutput alloc]
        didFinishRecordingToOutputFileAtURL:audio fromConnections:@[] error:nil];
    DrainMainQueue();
    Check(controller.preparations == (cancel ? 0 : 1) && [controller.recordingURL isEqual:audio] && !controller.stopping,
          "file finalization retains audio and respects transcription cancellation");
    [NSFileManager.defaultManager removeItemAtURL:audio error:nil];
  }
}

static void TestCancelledExportCannotDeleteRetryOutput(void) {
  testExports = [NSMutableArray array];
  NSURL *audio = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:[NSString stringWithFormat:
          @"falcondeck-native-dictation-%@.caf", NSUUID.UUID.UUIDString]]];
  AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:16000 channels:1];
  AVAudioFile *writer = [[AVAudioFile alloc] initForWriting:audio settings:format.settings error:nil];
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:16000];
  buffer.frameLength = 16000;
  memset(buffer.floatChannelData[0], 0, 16000 * sizeof(float));
  BOOL wrote = [writer writeFromBuffer:buffer error:nil];
  writer = nil;
  Check(wrote, "export fixture saved without microphone access");
  FDTestExportController *controller = [FDTestExportController alloc];
  controller.recordingURL = audio;
  [controller prepareRecordingForTranscription:audio provider:FDProviderSystem];
  [controller cancelProcessing];
  [controller prepareRecordingForTranscription:audio provider:FDProviderSystem];
  Check(testExports.count == 2, "cancelled export can be retried");
  if (testExports.count == 2) {
    FDTestExportSession *first = testExports[0], *retry = testExports[1];
    [@"retry-owned output" writeToURL:retry.outputURL atomically:YES encoding:NSUTF8StringEncoding error:nil];
    first.completion();
    first.completion = nil;
    DrainMainQueue();
    Check(![first.outputURL isEqual:retry.outputURL] &&
        [NSFileManager.defaultManager fileExistsAtPath:retry.outputURL.path],
        "stale cancelled export cannot delete retry-owned output");
    retry.status = AVAssetExportSessionStatusFailed;
    retry.completion();
    retry.completion = nil;
    DrainMainQueue();
    Check(![NSFileManager.defaultManager fileExistsAtPath:retry.outputURL.path],
          "failed export deletes only its own partial output");
    [NSFileManager.defaultManager removeItemAtURL:first.outputURL error:nil];
    [NSFileManager.defaultManager removeItemAtURL:retry.outputURL error:nil];
  }
  [NSFileManager.defaultManager removeItemAtURL:audio error:nil];
  testExports = nil;
}

static void TestSpeechCompletionCanOnlyBeClaimedOnce(void) {
  FDDictationController *controller = [FDDictationController alloc];
  controller.speechGeneration = 7;
  Check([controller claimSpeechCompletion:7], "first speech completion claims generation");
  Check(![controller claimSpeechCompletion:7], "late error or final callback cannot claim same completion");
}

int main(void) {
  @autoreleasepool {
    testFocusedElement = AXUIElementCreateApplication(testPID);
    Method shared = class_getClassMethod(FDDictationController.class, @selector(sharedController));
    IMP originalShared = method_setImplementation(shared, (IMP)TestSharedController);
    TestCapturedDestination();
    TestReplacementOwnsItsDeliberateSelection();
    TestToggleChord();
    TestConfigurationRecovery();
    TestHistoryRetryClearsRewrite();
    TestRetryPasteReleasesUnretainedAudio();
    TestCancelWhileCaptureIsFinalizing();
    TestCancelledExportCannotDeleteRetryOutput();
    TestSpeechCompletionCanOnlyBeClaimedOnce();
    method_setImplementation(shared, originalShared);
    testSharedController = nil;
    CFRelease(testFocusedElement);
    fprintf(stderr, "%lu native speech bridge failure(s)\n", (unsigned long)failures);
    return failures ? 1 : 0;
  }
}
