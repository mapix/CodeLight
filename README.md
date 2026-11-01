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

- Titles publish most recent first using original Codex update time, grouped by project across worktrees. Sessions older than 72 hours initially load basic title/project/time fields; opening one loads its richer data.
- Paired phones restore an account-bound encrypted title cache. Existing rows remain usable while titles synchronize; stale connection results show synchronization until a current request can confirm failure. Opening a chat never waits for the whole title catalog.
- A session tap requests desktop selection immediately and starts synchronization; no extra Open Desktop step.
- Native project conversations use a session select box. Long titles fit the closed control, and the platform menu lists the available conversations.
- Foreground project headers and visible session rows use lightweight active/waiting summaries from Codex. Unknown, stale or disconnected observations remain explicit; message history is loaded only for selected sessions.
- Opening a session waits for its existing observation and reads a fresh recent window, positioned at the newest messages. Earlier history loads in bounded pages only when you scroll upward; list/background work does not prefetch old history. A long active turn's start time is not used to date every new message.
- After pairing, the Mac App defaults to a statistics dashboard with realtime/cumulative gateway traffic and interaction counts. Use the Statistics/Pairing switch to scan again.
- Mac **Start** and **Pause** control the CodeLight service. Pause completes its owned service shutdown before Start becomes available. Pairing, settings and operation journals are retained; original Codex sessions keep running.
- Mac **Connections** has independent Local network and Cloudflare checkboxes,
  plus Relay after a compatible HTTPS Relay server/key has been configured.
  Available channels start enabled by default; later checkbox choices persist.
  They can run together, and a failed channel does not stop the others.
- One QR carries the enabled connection addresses and pinned Mac identity.
  The phone automatically chooses an available verified route. Open its
  **Connection** sheet from global Settings or the session header icon to choose another channel or return to Automatic at any
  time; the same peer/session cache and original command IDs are retained.
- Use **Configure Relay** on Mac to validate and save a compatible server/key.
  The public Relay forwards opaque HTTP/WebSocket streams and holds no session
  or account store. Local networking keeps content and device authorization
  sealed; public channels retain HTTPS/WSS certificate validation.
- New question prompts remain accessible while you read earlier history.
  Select an option, then explicitly submit; the original question identity and
  native acceptance/unknown-receipt rules still apply.
- Device authorization, rename and individual revocation are managed by the Mac App.
- Phone background refresh requests a 60-minute minimum schedule from iOS; the operating system chooses actual runs. Mac observers keep collecting selected Codex sources.
- Native model and reasoning controls update the existing desktop owner, with conflict and unknown-receipt protection.
- User-facing strings follow the phone's selected language with a documented fallback. Native UI and runtime support are verified separately from TypeScript or fixture results.

Local addresses/ports and Cloudflare Quick Tunnel addresses can change on Mac
restart. A configured Relay keeps its authenticated route across reconnections.
The phone can obtain updated addresses through a working authenticated channel;
scan the current QR if every stored route is unavailable. Allow local-network
access when iOS prompts if you want to use LAN. Live APNs push needs publisher
credentials and push-enabled phone signing; the source-built iPhone client is
not an App Store/TestFlight release.

The normal user entry point is the Mac App. `scripts/codelight-daemon.mjs` remains
an advanced self-hosted/diagnostic entry point with an explicit server/profile;
it must retain the same Codex-only source boundary. Legacy server-selection and
manual-account flows are not the current one-scan phone onboarding.

## Licensing

See `THIRD-PARTY-NOTICES.md` and `licenses/Happy-LICENSE` for the Happy-derived mobile, API and protocol sources. Bundled runtime licenses are retained separately.

See [contribution guidance](CONTRIBUTING.md) and the [public release workflow](docs/PUBLIC-RELEASE.md).
