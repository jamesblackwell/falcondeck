---
name: mobile-testflight
description: Push a new FalconDeck mobile TestFlight build via EAS. Use when asked to push, ship, or release a TestFlight build.
---

# Mobile TestFlight push

From `apps/mobile`, run:

```bash
eas build --profile preview-testflight --platform ios --auto-submit --no-wait --non-interactive
```

Notes:
- `--platform ios` is required in non-interactive mode.
- `buildNumber` auto-increments; credentials come from EAS servers, no local setup needed.
- Auto-submit pushes to App Store Connect (ascAppId 6760899257) once the build finishes.
- Return the build and submission URLs from the command output.
- If submission hangs, check https://status.expo.dev/ for EAS Submit outages.
- JS-only changes: use `make mobile-deploy` (OTA) instead. Ad-hoc install: `make mobile-build`.
