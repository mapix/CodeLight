# CodeLight

[Website](https://codelight.novarock.io/) · [Public source](https://github.com/mapix/CodeLight) · [MIT license](LICENSE) · [中文](README.zh-CN.md)

Only desktop Codex connected through gateway mode is supported.
只支持使用网关模式接入的桌面 Codex。

CodeLight is a native phone companion for existing Codex desktop sessions. Open the Mac App and scan its QR code: no phone account registration or VPN.

The public Mac preview targets Apple Silicon with macOS 14+. Public downloads
are Developer ID signed, Apple notarized and stapled. The iPhone client currently
requires building from source with your own Apple development signing; there is
no public App Store/TestFlight release or device-bound IPA download yet.

Read [security and trust boundaries](SECURITY.md) before pairing a phone. A paired
device can control the exposed sessions of your Mac's CodeLight account.

## Supported scope

- The current distribution supports Codex only, using the original desktop session owner and its native session protocol.
- Session IDs, history increments, input admission, stop actions, questions, permissions and model/effort settings keep the original Codex identity and confirmed capability boundaries.
- Other harnesses, window sharing and accessibility control are deferred. Historical source files and research specs remain in the repository; they are not advertised as enabled product support.

See the [current product contract](spec/codelight-product.md),
[project activity contract](spec/codelight-project-activity.md) and
[standalone project contract](spec/codelight-standard-project.md).

## Workspace

| Directory | Purpose |
| --- | --- |
| `apps/mobile` | Expo / React Native phone App |
| `apps/mac` | SwiftUI Mac App |
| `packages/relay` | Embedded encrypted sync API |
| `packages/wire` | Licensed shared wire protocol |
| `src` | Native session bridge, discovery, pairing and device authorization |
| `native` | Mac helper sources and native build entitlements |
| `spec` | Current product/protocol rules and marked historical research |
| `assets/branding` | Generated CodeLight brand assets |

## Development

Use Node 24.15.0 and pnpm 10.11.0:

```sh
pnpm install
pnpm typecheck:all
pnpm lint
pnpm dev:mobile
```

Build the Mac helpers and App:

```sh
pnpm build:native
CODELIGHT_CLOUDFLARED_BINARY=/absolute/path/to/cloudflared pnpm build:mac
node scripts/sign-mac-app.mjs /absolute/path/to/CodeLight.app 'Developer ID Application: Your Name (TEAMID)'
```

The packaging script uses the running Node executable. Supply `CODELIGHT_NODE_BINARY` to choose another Node 24 binary. Node's license is included under `licenses/`. Supply a compatible cloudflared executable via `CODELIGHT_CLOUDFLARED_BINARY`, or place it under `.runtime/cloudflared`.

For a signed iPhone trial, use `pnpm build:mobile --device YOUR_DEVICE_ID --team YOUR_TEAM_ID` (add `--generic` to compile while the phone is offline). The wrapper uses the local-trial entitlement file. The Xcode workspace remains `apps/mobile/ios/Happydev.xcworkspace`; use your own Apple Development identity/team. The current bundle identifier is `com.learnings.codelight`; the generated target name is an implementation detail retained for existing installs.

## Behavior

- Titles load progressively across all pages, grouped by original project across worktrees.
- A session tap requests desktop selection immediately and starts synchronization; no extra Open Desktop step.
- Native project conversations use a session select box. Long titles fit the closed control, and the platform menu lists the available conversations.
- Foreground project headers and visible session rows use lightweight active/waiting summaries from Codex. Unknown, stale or disconnected observations remain explicit; message history is loaded only for selected sessions.
- After pairing, the Mac App defaults to a statistics dashboard with realtime/cumulative gateway traffic and interaction counts. Use the Statistics/Pairing switch to scan again.
- Mac public access can use Cloudflare or a compatible self-hosted network Relay.
  Expand Public access, enter the HTTPS Relay address/access key and validate it.
  The phone continues scanning the QR; it has no provider setting. The public
  Relay forwards opaque HTTP/WebSocket streams and holds no session or account store.
- Device authorization, rename and individual revocation are managed by the Mac App.
- Phone background refresh requests a 60-minute minimum schedule from iOS; the operating system chooses actual runs. Mac observers keep collecting selected Codex sources.
- Native model and reasoning controls update the existing desktop owner, with conflict and unknown-receipt protection.
- User-facing strings follow the phone's selected language with a documented fallback. Native UI and runtime support are verified separately from TypeScript or fixture results.

Cloudflare Quick Tunnel addresses can change on Mac restart, requiring another scan. Live APNs push needs publisher credentials and push-enabled signing; the current local test setup is not a notarized/store release.

The normal user entry point is the Mac App. `scripts/codelight-daemon.mjs` remains
an advanced self-hosted/diagnostic entry point with an explicit server/profile;
it must retain the same Codex-only source boundary. Legacy server-selection and
manual-account flows are not the current one-scan phone onboarding.

## Licensing

See `THIRD-PARTY-NOTICES.md` and `licenses/Happy-LICENSE` for the Happy-derived mobile, API and protocol sources. Bundled runtime licenses are retained separately.

See [contribution guidance](CONTRIBUTING.md) and the [public release workflow](docs/PUBLIC-RELEASE.md).
