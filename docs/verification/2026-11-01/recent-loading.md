# Recent-first directory and selected-session loading

## Confirmed source causes

- `Sync.onSessionVisible` started observation but also invalidated message sync
  immediately. The bounded mirror page could therefore finish before native
  observation provided a fresh latest view.
- A later visit used forward sync from its cached sequence, and touch preload
  could satisfy an entry before that fresh observation. CodeLight now coalesces
  tap/focus entry and uses a fresh latest native window for peer entries.
- The last 50 mirror protocol records may be text suffixes or tool results whose
  seed records lie outside the page. They are not necessarily 50 complete visible
  messages. Selected peer reads return full native rows and tool call/result seeds.
- Native projection assigned a turn's start timestamp to every item. Long active
  turns therefore gave newer public content an hours-old time. Original item
  `startedAtMs`/`completedAtMs` and per-item owner maps now take precedence; turn
  start remains the fallback. Observation time is not used as message time.
- The SQLite worker ordered seconds-based `updated_at` even when its returned
  descriptor used millisecond native recency. Its ordering now uses the same
  native recency expression and omits old first-message previews from the query.

## Implementation and owners

`CodeLightRecentService` reads the Mac's already-owned index/bindings without
activating directory sources. It orders native update time and publishes an
initial 200 entries, then pages up to 1000 (hard limit 2000). Entries older than
72 hours contain basic title/identity/project/time metadata, no preview, heavy
agent state or session keys. A selected recent response includes its existing
key and real transport checkpoint field versions inside the authenticated peer
box response.

The service's selected read coalesces source preparation and
`NativeHappyConnector.readRecent`. A recent read uses the original adapter's
`freshSnapshot`; cached owner state cannot claim freshness. Connector operation
tracking protects that read from idle observer retirement. The phone sends
`POST /api/peer/sessions/:id/recent`; older pages use the session-bound `/history`
cursor only when `loadOlderMessages` is called by the reader's upward scroll.

Complete native text rows replace their known mirror fragment IDs. Tool rows
seed the original call and current result through guarded native upserts. An
older running seed cannot reopen an actually completed approved tool; the new
regression reproduced that failure before the fix. Seed versions are owned by the
CodeLight projection and advance with changed native content stamps, including
silent content changes at the same native revision. Stream correction counters
remain separate, so a large seed version cannot suppress a later stream fix.
Equal native times retain original row order without changing displayed time.
Per-turn item order stays stable when complete history prepends older turns.
The real Codex factory mirrors only its latest 100 public rows, while command
reconciliation, current requests and explicit history reads retain the full view.
CodeLight layout/content-size events cannot fetch older pages before a real
reading gesture, and a settled page cannot walk more pages without continued
scrolling. Explicit incomplete history uses the original owner's complete-history
read and reports completion only after the original flag confirms it.

Phone entry captures the credential owner and selected session. A superseded
selection or replaced credentials cannot publish a late recent window. Hover
preload and background history prefetch do not load older CodeLight pages.
Unopened basic entries do not fetch per-session keys merely to decrypt transient
heavy state; their directory fields refresh on the next peer catalog read.

## Executed verification

- 34 Node tests passed in the recent-data/native-backend test run, including real
  read-only SQLite ordering, the 72-hour cutoff, session-bound history cursors,
  simultaneous recent-read coalescing, and original item/map timestamps.
- 43 tests passed in the connector/projection-performance/index-cache run; the
  opt-in synthetic benchmark was skipped. Existing projection row-work bounds,
  revision/owner behavior, unknown receipt persistence, and observer retirement
  regressions passed.
- A subsequent directed connector recent-read regression passed: changed complete
  text at an unchanged native revision advances the seed version, keeps its
  fragment identities, and sends no native command. The accompanying two index
  cache tests passed again.
- 30 mobile tests passed in the initial `codeLightRecent.test.ts` and `sync.preload.test.ts` run.
  They exercise complete text/tool seeds without earlier protocol dependencies,
  later stream corrections, tap/focus coalescing, observation-before-fetch,
  no hover/history prefetch, explicit older cursor advance, superseded responses,
  and 200/1000 catalog paging without key/history initialization.
- The later seven-file mobile run passed 101 tests, covering chat pagination,
  native family recency with pin ties, question/channel dock reachability,
  connection selection, translations, and loading/proof orchestration. After
  the final seed refinement, a four-file run passed all 37 tests, including newer
  owner/draft preservation and the completed-tool regression.
- Five final Node regressions passed for item timestamps, same-revision seeds,
  bounded observation with explicit complete history, incomplete cursors and
  the real read-only index worker.
- Integrated `pnpm typecheck:all`, root Lint and `git diff --check` passed.

The tests use controlled fixtures at transport/store boundaries. Request-count
claims are fixture evidence, not physical-phone RTT or rendering measurements.

## Integrated interfaces and native acceptance remaining

`CodeLightRecentService` integrates with the authenticated peer HTTP route. Its options
are `sources()`, `resolveSource(happySessionId)`, `available()` and optional `now()`.
`resolveSource` must prepare and await the existing observer under the daemon's
source-use boundary; it must not navigate or start another native runtime.
`apiSocket.peerRequest` returns a normal JSON `Response` only after authenticating
and decrypting the pinned peer's sealed response.

Verify an active real session's
latest text/time, complete current tools, first recent directory paint, and
explicit older-page behavior on the native phone. Measure the actual request
count/bytes/time to first recent display across LAN/public channels. No rebuild,
phone installation, deployment, public push or model message was performed by
this loading subtask.

The cursor covers the loaded original-owner view until explicit reading requests
complete history when the original flag is false. Confirmed complete responses
report `historyCoverage=complete-native-view`; unknown completeness stays
`loaded-native-view`, without a claim that the full original history is exhausted.

## Phone connection control

`PeerChannelControl` independently subscribes to the single connection service.
It is inline below the directory header and in the chat input dock above the
question banner, remaining reachable when older history is on screen. The
existing native picker sheet shows Automatic plus each paired route's host,
current state and measured latency. It accepts no address/key and reports
failures with localized text without exposing raw errors. Ten languages and the
dedicated English mirror include its strings.

`codelight://dev/peer-channel` is a native layout fixture for the sheet, automatic
selection, manual Cloudflare selection and Relay failure. Its documentation IP
and example hostnames are not probed. Production channel selection uses the
authenticated connection owner. Sync's machines/account/settings/profile requests
use the peer-aware transport on v2 connections, covered by a no-raw-LAN-bearer
machine-loading regression. Native sheet/real route switching still requires
the root task's device acceptance.
