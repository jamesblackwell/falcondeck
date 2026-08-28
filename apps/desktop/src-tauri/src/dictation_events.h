#ifndef FALCONDECK_DICTATION_EVENTS_H
#define FALCONDECK_DICTATION_EVENTS_H

// Event codes shared between macos_dictation.m and dictation.rs. The Rust side
// mirrors these in its `event_kind` module and a unit test asserts the two
// definitions cannot drift apart.
#import <Foundation/Foundation.h>

typedef NS_ENUM(int32_t, FDEventKind) {
  FDEventRecording = 0,
  FDEventProcessing = 1,
  FDEventCompleted = 2,
  FDEventFailed = 3,
  FDEventCancelled = 4,
  FDEventAudioReady = 5,
  FDEventFailedRetained = 6,
  FDEventAudioLevel = 7,
  FDEventSelfInsert = 8,
  FDEventPasteFailed = 9,
  FDEventCancelledRetained = 11,
  FDEventAudioRecorded = 10,
};

#endif
