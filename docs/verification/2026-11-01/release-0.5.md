# CodeLight 0.5 release preparation

## Scope

Version 0.5 adds simultaneous Local network/Cloudflare/configured Relay entries,
one pinned-key QR with an authenticated channel list, automatic and manual phone
connection choice, stable same-peer operation identity, recent-first directory
pages and fresh selected-session windows. Entries older than 72 hours start with
basic information; earlier history remains bounded and gesture-driven. Original
Codex ownership and gateway-mode-only support are unchanged.

Public scope remains Apple Silicon/macOS 14+ and a source-built iPhone client.
No device-bound IPA, signing profile, private notary logs, account files or
personal QA captures belong in source or website artifacts.

## Source and privacy correction

The private v2 `connection-channels.json` contains a saved Relay key. Its filename
was missing from the prior source selection/ignore list. A sentinel regression
first reproduced its inclusion, then passed after Git ignore, source selection
and independent archive verification were updated. Six packaging regressions
passed, including tracked deletions, private state and symlink boundaries.
Website local-resource/anchor/artifact checks also passed.

The source snapshot is reviewed separately from the original private Git history.
It is applied only to the existing public checkout; original private history is
never pushed. Gitleaks is combined with a bounded path/identifier/privacy review,
not treated as proof that arbitrary conversation data is safe to publish.

## Executed logical/native checks

- Mac connection manager, per-channel gateway composition, sealed device proofs
  and recent-data behavior have scoped regressions. The preparation run recorded
  22 related passing tests; the final service-only run recorded 5 passing tests.
- Native Mac channel/data values, checkbox availability and retained dashboard
  choice have Swift-backed checks; complete Swift source typechecking passed.
- Phone recent/channel/order code recorded 101 affected tests passing before
  the final narrow tool-seed fix. The final four-file run recorded 37 passing
  tests, including an older running tool seed not reopening a completed tool.
- The dependency release gate retains raw advisory counts and permits only the
  two specific patched image-container advisories after their bounded regressions.
  Unreviewed high/critical findings block publication. Actual preparation counts
  and residual reachability limits are recorded in `SECURITY.md` and private
  numeric audit output.
- Final preparation `pnpm typecheck:all` and `pnpm lint` passed. The exported
  source installed from its frozen lockfile in a new temporary directory and
  passed bridge/mobile/production-relay typechecks there. Its then-current
  selection contained 2,062 files and passed staged Gitleaks scanning.
- The dependency gate's raw result was 0 critical, 2 high, 4 moderate and 1 low.
  The two high findings are the documented patched image-container advisories;
  their regressions passed and no unreviewed high/critical finding remained.
- A fresh same-flags esbuild of the current Mac service exactly matched the
  signed 0.5 candidate's service bundle. The copied index worker and portable
  wire module also matched current source hashes; the 100-row mirror changes
  were already included. This verifies source freshness, not Apple acceptance.

## Publication gates

### Takeover installation checkpoint

The final submitted Mac archive was accepted by Apple under submission
`f1c1b3d5-eb75-4560-a41e-aa500b7821df`. Ticket stapling and validation, strict
recursive signature verification and Gatekeeper assessment passed. A rebuild
with the production esbuild flags matched the candidate service bundle exactly;
the copied index worker also matched current source. The verified 0.5.0 app was
installed in `/Applications`, retaining the previous app as a private local
backup. The installed app passed signature and Gatekeeper checks again.

Phone and simulator Release build `2026110104` succeeded, were installed and
launched. The Mac native UI showed Local network, Cloudflare and configured Relay
checked by default. Local network and Relay reached Ready; Cloudflare remained
Unverified. A new multi-channel QR was displayed. The phone reconnected, but a
legacy connection alone does not establish v2 route-switch acceptance.

The native simulator's connection preview opened all three routes, switched from
Automatic to manual Cloudflare, and retained that selected route when the fixture
Relay failed with a visible error. This scene does not probe real routes. Original
desktop process identity/start time and Mac box/relay key files were unchanged.
The local account file was refreshed by the existing startup authentication;
byte equality of that file is not claimed.

On Node 24.15.0, bridge/mobile/production-relay typechecks and bridge lint passed.
The takeover run passed 26 scoped Node tests and 50 scoped mobile tests covering
fresh native reads/active-question steering, channel proofs/configuration,
operation isolation, recent entry and preload ordering. Physical-phone question
delivery and real automatic/manual route switching remain pending. The next
acceptance question is in the replacement chat.

The takeover checkpoint above confirms Apple acceptance, stapling and local
installation. Public 0.5 downloads, all physical-phone routes and question
submission have not passed acceptance yet. The final release owner records those
outcomes after native QA. Fresh-source installation/typechecks, final
source/history scans and immutable artifact/website checks must use the final
reviewed snapshot. A previous 0.4 pass does not certify a new 0.5 candidate.

The website update retains the earlier versioned 0.4 archive/checksum while
changing the current manifest only after the final 0.5 gates. No phone temperature,
frame-rate or battery guarantee is inferred from fixture timings.
