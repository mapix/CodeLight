# Build and verify CodeLight

The standalone source is at this repository root. The current distribution is
Codex-only and attaches to the original Codex owner; other harness/window sources
are deferred research. Use Node 24.15.0 and pnpm 10.11.0. Dependencies and generated
native caches stay outside Git. Current scope is defined in
[the product contract](../spec/codelight-product.md).

## Gates

- `pnpm typecheck:all`: bridge, phone and production relay TypeScript.
- `pnpm lint`: bridge, scripts and root tests.
- Targeted native protocol/model/device tests: `node --test test/codex-ipc.test.mjs test/codex-backend.test.mjs test/codex-native-controls.test.mjs test/happy-native-connector.test.mjs test/discovery-daemon.test.mjs test/project-identity.test.mjs test/device-registry.test.mjs test/pairing-gateway.test.mjs`.
- Mobile paging/progress/navigation/model tests: run the corresponding Vitest files under `apps/mobile/sources`.
- Project activity checks must cover original-owner status, waiting operations,
  stale/disconnected state, foreground/background transitions and bounded status
  payloads without fetching every conversation's history. The contract is in
  [codelight-project-activity.md](../spec/codelight-project-activity.md).
- Verify Codex-only source discovery and restored observers. Historical window
  tests do not establish enabled harness support in the current distribution.
- UI checks cover the session select box, long titles, large projects and the
  supported language strings. Record fixture, simulator and physical-phone
  observations separately.

Native UI acceptance uses the dedicated CodeLight simulator and the installed iPhone. Do not send additional model test prompts to validate transport or settings. Model updates can be verified without a new turn.

Measure request/byte budgets and bounded render work for performance changes.
Do not describe synthetic timings as measured phone frame rate, battery use or
temperature. Unsupported protocol versions and unavailable OS capabilities must
remain visible rather than silently enabling a fallback runner or window mode.

## Mac

Build helper binaries with `pnpm build:native`, then `pnpm build:mac`. The app contains the relay, bridge, Node and cloudflared. Developer ID signing is explicit through `scripts/sign-mac-app.mjs`. Apple notarization is a separate distribution gate.

Copy signed bundles with `ditto` or Node `cp(..., { recursive: true,
verbatimSymlinks: true })`. Changing relative symlink text breaks the resource
seal. Verify the installed destination before launching it and preserve the
previous bundle during replacement.

## iPhone

Run `pod install` from `apps/mobile/ios`, then use `pnpm build:mobile --device YOUR_DEVICE_ID --team YOUR_TEAM_ID` or `pnpm build:mobile --simulator YOUR_SIMULATOR_ID`. The build entry point resolves signed entitlement files from this repository and propagates the actual Xcode exit status. Use the CodeLight bundle ID. `HAPPY_NONINVASIVE_LOCAL=1 EXPO_NO_DOTENV=1` enables the CodeLight distribution. Keep the system Keychain entitlement for simulator builds. Development profile installs are not App Store releases.

Background processing uses `com.expo.modules.backgroundtask.processing`; the v2
refresh task requests a 60-minute minimum interval. iOS may delay or omit runs.
Real APNs requires a push-enabled profile and publisher configuration; the app
does not use the upstream Happy Expo publisher.

## Source export

`pnpm package:source` produces a repository source ZIP using Git-known files and an additional private-state exclusion filter. Generated products and state are excluded.

Run `node scripts/verify-codelight-source.mjs --install` after export to extract the ZIP, check private-path exclusions, install the frozen workspace and typecheck it independently.

Add `--generic` to a device build when the phone is offline; Xcode builds the signed iOS artifact without waiting for hardware. Install verification still requires the paired device.
