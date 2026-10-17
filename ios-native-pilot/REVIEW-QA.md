# Native client follow-up review — 17 October 2026

This pass stays within the standalone Swift client. No phone installation,
production deployment, Expo update, OTA or TestFlight submission was attempted.

Fixed and polished:

- Queued messages use a full-height native multiline editor. Save failures keep
  the text and show a retryable error. The editor belongs to the conversation,
  so dispatching/removing its queue row does not discard unsaved edits; these
  remain copyable. Queue rows use stable server IDs and one shared scroll area.
- Sharing images preserves original bytes/resolution and advertises matching
  PNG/JPEG/GIF/HEIC/HEIF/WebP/TIFF/BMP representations, with a generic original
  file fallback for other ImageIO formats. Sharing loaded conversations remains
  available offline while remote mutations stay disabled.
- Full tool output has native Find, Command–F, selectable text and scaled
  monospaced type. The full-screen document presentation avoids an iPad bug
  where tapping the floating Find toolbar dismissed the surrounding sheet.
- Archive loading, retry, empty archive and empty search have distinct states.
  Archived task goals now resolve through the same active/archived task lookup.
- Speech recovery shows errors in the speech screen, avoids duplicate/cancelled
  errors, and prevents dismissal while moving a recovered transcript to a task.

Validation: all 115 unit tests pass, including byte/resolution preservation and
concrete-format negotiation through Apple's real `NSItemProvider` API. Seven
targeted UI flows pass on iPhone and iPad: five queue/sharing/output flows,
sidebar/options/archive navigation, and the four voice-composer states. The five
review flows also pass with accessibility-large text, with focused reruns after
fixes. A final signed Apple Development Debug app/widget build and deep signature
verification pass. Real microphone/transcription quality remains a phone check.

Screenshots were inspected in dark phone, light tablet and accessibility text.
The ignored local [gallery](artifacts/review-2026-10-17/index.html) holds 39 captures.
Offline/error fixtures use a fake relay and isolated notification preferences;
they neither read a pairing nor issue relay requests.

The isolated native-only review used this repository helper command, with the
adjacent task/media/attachment owners and changed views supplied via `--dataset`:

```sh
.agents/skills/autoreview/scripts/autoreview --mode local --max-priority P2 \
  --dataset ios-native-pilot/FalconDeckNative/Data/TaskFeatures.swift \
  --dataset ios-native-pilot/FalconDeckNative/Data/MediaFeatures.swift \
  --dataset ios-native-pilot/FalconDeckNative/Features/ConversationView.swift \
  --dataset ios-native-pilot/FalconDeckNative/Features/QueuedMessagesView.swift \
  --dataset ios-native-pilot/FalconDeckNative/Features/TaskOptionsView.swift \
  --dataset ios-native-pilot/FalconDeckNative/Features/TextDocumentView.swift \
  --dataset ios-native-pilot/FalconDeckNative/Data/Attachment.swift
```

Review found the missing concrete image type, which was fixed and regression
tested. Final review: no actionable P0–P2 findings. A subsequent shorter editor
title/accessibility label is a mechanical UI refinement, checked in the simulator.
