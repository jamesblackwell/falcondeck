---
name: mobile-testflight
description: Build and submit the native SwiftUI FalconDeck iOS app to the existing TestFlight listing. Use when asked to push, ship, or release a TestFlight build.
---

# Mobile TestFlight push

The SwiftUI app in `ios-native-pilot` replaces the existing iOS app:
`com.falcondeck.mobile`, App Store Connect `6760899257`. Use its Release
configuration. Debug retains the separate pilot identifier. Read
`ios-native-pilot/README.md` for the archive/export path.

Query App Store Connect for the latest uploaded build and marketing version
before choosing the next version/build. Run the relevant simulator checks and
repo-required review, regenerate with XcodeGen, then archive and export the
native app with Xcode App Store Connect signing. Use existing authorized
credentials; keep private keys in a private temporary directory and remove them
when finished. Do not print credentials.

Submit the exported native IPA from `apps/mobile`:

```bash
eas submit --platform ios --profile preview-testflight \
  --path ../../ios-native-pilot/artifacts/<export>/FalconDeckNative.ipa \
  --non-interactive --wait
```

Notes:
- `--platform ios` is required in non-interactive mode.
- The version/build is set by the native Xcode project; submission does not increment it.
- Verify Apple processing and access for the existing TestFlight tester group.
- Return the version/build and TestFlight/submission link.
- If submission hangs, check https://status.expo.dev/ for EAS Submit outages.
- Expo build and OTA commands target the legacy React Native app. Use those only
  when the user explicitly requests a legacy Expo build; they do not ship native changes.
