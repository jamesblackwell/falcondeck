#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef void (*FDNativeSpeechEventHandler)(int32_t kind, const char *payload);
typedef bool (*FDNativeSpeechInsertHandler)(const char *text);
void fd_native_speech_set_event_handler(FDNativeSpeechEventHandler handler);
void fd_native_speech_set_insert_handler(FDNativeSpeechInsertHandler handler);
void fd_dictation_configure(bool enabled, const char *shortcut, int32_t activation_mode,
  int32_t provider, const char *input_device_id, bool retain_recordings,
  bool rewrite_enabled, const char *rewrite_shortcut, bool auto_cleanup_enabled);
char *fd_dictation_retained_recording_path(void);
double fd_dictation_retained_recording_duration_seconds(void);
int32_t fd_native_speech_retained_provider(void);
char *fd_dictation_audio_devices_json(void);
char *fd_dictation_temp_directory(void);
void fd_dictation_free_string(char *value);
void fd_dictation_request_microphone_permission(void);
void fd_dictation_request_speech_permission(void);
void fd_dictation_request_accessibility_permission(void);
int32_t fd_dictation_microphone_permission(void);
int32_t fd_dictation_speech_permission(void);
bool fd_dictation_accessibility_permission(void);
void fd_dictation_start(void);
void fd_dictation_stop(void);
void fd_dictation_cancel(void);
void fd_native_speech_cancel_processing(void);
void fd_native_speech_suspend_shortcuts(bool suspend);
void fd_dictation_drop_cancelled(void);
void fd_dictation_retry(bool copy_only);
void fd_native_speech_retry_file(const char *path, int32_t provider);
void fd_dictation_retry_paste(const char *utf8_text);
void fd_dictation_discard(void);
bool fd_dictation_replace_transcript(const char *original, const char *replacement);
bool fd_dictation_paste_text(const char *utf8_text);
bool fd_dictation_copy_text(const char *utf8_text);
void fd_dictation_mark_completed(void);
void fd_dictation_open_accessibility_settings(void);
void fd_dictation_shutdown(void);
bool fd_dictation_test_overlay_panel_contract(void);
bool fd_dictation_test_recovery_audio_contract(void);
bool fd_dictation_test_recording_duration_is_usable(double duration_seconds);
bool fd_dictation_test_rewrite_selection_contract(void);
bool fd_dictation_test_transient_pasteboard_round_trip(void);
bool fd_dictation_test_transcript_replacement_ranges(void);
bool fd_native_speech_test_paste_target_identity(void);
