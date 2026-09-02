#import <AppKit/AppKit.h>
#include <stdbool.h>

// NSSound does not keep itself alive for the length of playback when created
// from a file, so the delegate retains in-flight sounds until they finish.

@interface FDSoundKeepalive : NSObject <NSSoundDelegate>
- (void)retainSound:(NSSound *)sound;
@end

@implementation FDSoundKeepalive {
  NSMutableArray<NSSound *> *_playing;
}

+ (instancetype)shared {
  static FDSoundKeepalive *shared;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [FDSoundKeepalive new];
  });
  return shared;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _playing = [NSMutableArray array];
  }
  return self;
}

- (void)retainSound:(NSSound *)sound {
  sound.delegate = self;
  [_playing addObject:sound];
}

- (void)sound:(NSSound *)sound didFinishPlaying:(BOOL)finished {
  (void)finished;
  [_playing removeObject:sound];
}

@end

static bool FDSoundNameIsSafe(const char *name) {
  if (!name || name[0] == '\0') return false;
  for (size_t index = 0; name[index] != '\0'; index++) {
    char character = name[index];
    if (!((character >= 'A' && character <= 'Z') ||
          (character >= 'a' && character <= 'z'))) {
      return false;
    }
  }
  return true;
}

static BOOL FDPlayOnMainQueue(NSSound *sound) {
  __block BOOL played = NO;
  void (^play)(void) = ^{
    FDSoundKeepalive *keepalive = [FDSoundKeepalive shared];
    [keepalive retainSound:sound];
    if ([sound play]) {
      played = YES;
    } else {
      [keepalive sound:sound didFinishPlaying:NO];
    }
  };
  if ([NSThread isMainThread]) {
    play();
  } else {
    dispatch_sync(dispatch_get_main_queue(), play);
  }
  return played;
}

bool fd_play_system_sound(const char *name) {
  if (!FDSoundNameIsSafe(name)) return false;

  @autoreleasepool {
    NSString *soundName = [NSString stringWithUTF8String:name];
    if (soundName.length == 0) return false;

    NSString *path = [NSString
        stringWithFormat:@"/System/Library/Sounds/%@.aiff", soundName];
    NSSound *sound =
        [[NSSound alloc] initWithContentsOfFile:path byReference:YES];
    if (!sound) return false;
    return FDPlayOnMainQueue(sound);
  }
}
