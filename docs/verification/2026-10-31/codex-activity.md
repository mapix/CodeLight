# Codex activity, dashboard and performance verification

## Delivered behavior

Native project conversations use one select box. Visible project headers and
session rows receive independent active/waiting/unconfirmed summaries through
one serialized ten-second foreground loop. Offscreen headers do not prevent
visible rows from receiving status. Partial counts appear immediately;
unconfirmed native state never becomes idle. Background/blur releases interest.
Mac observers share thirty-second leases and use native deltas after their
initial local snapshot. Replies contain requested identities and booleans,
without conversation text, tool outputs or files.

Discovery, CLI, restored bindings and phone catalog are Codex-only. Removed index
entries are hidden without erasing history; a failed index cannot remove the
catalog. Ten languages cover current CodeLight flows, including row statuses,
with a home language entry, Chinese region/script resolution and English fallback.

The paired Mac App defaults to Statistics. Statistics/Pairing switches the
content, and invitation renewal preserves the selected panel. The dashboard
shows realtime rates, current and persisted cumulative bytes, HTTP/RPC counts,
online devices and uptime. It explicitly reminds users that only desktop Codex
connected through gateway mode is supported. QR artwork is cached and generated
only while the pairing view is visible; numeric updates are observed separately
from the device list.

## Performance evidence

- Long native histories use atomic path-copy patches, unchanged-branch snapshot
  reconciliation, turn/item projection caches and complete-row SHA-256 caches.
  A synthetic 26.5 MB / 20,000-row / 40-update benchmark, including complete
  consumer copies, reduced host CPU by 61% for stdout patches, 70% for status
  patches and 46% for full stdout snapshots including JSON decoding. See
  `test/performance/codex-native-projection-20261031.json`.
- Index caching uses DB/WAL/global-state signatures, shared read flights and
  generation fencing, with a sixty-second presentation refresh for Git-only
  changes. Failures cannot publish an empty catalog.
- Eleven warm activity polls used one initial follow and zero additional
  snapshot reads. Simultaneous gaps obey the four-read concurrency budget.
- Large catalog grouping caches recency. A 150,000-entry collapsed catalog and
  a 12,000-deep chain do not overflow. The fixed 800-session recency sample used
  800 reads, compared with 1,520 before.
- Conversation observers recycle beyond sixteen selections. Foreground
  viewers, navigation and unsettled work retain their observer. Retirement
  preserves binding keys, ciphertext and unknown-outcome journals.
- Metrics sample once per second and coalesce asynchronous durable writes;
  no payload listeners or per-chunk disk writes are added.

## Final verification and installation

- Final affected suite: 140 bridge/IPC/activity/catalog/device/observer/metrics
  tests passed; one benchmark was skipped in the normal suite and executed
  separately. All 74 selected phone/menu/catalog/locale/status tests passed.
  Bridge, mobile and production-relay typechecks and root Lint passed.
- The 1,996-file source ZIP passed extraction, private-path exclusion, frozen
  pnpm installation, standalone daemon help, explicit Expo preset resolution
  and bridge/mobile/production-relay typechecks in a fresh temporary workspace.
- Current-source iPhone and Simulator Release builds 2026103110 passed. The
  physical phone installation and launch succeeded; inventory confirms
  CodeLight 1.8.0 / 2026103110.
- Native Simulator 2026103110 visibly shows individual Active, Awaiting action,
  Idle and Unconfirmed badges. The earlier native menu acceptance selected item
  150 (`fixture-session-149`) and kept the long closed title within one row;
  the picker implementation is unchanged in 2026103110. Fixtures use synthetic
  conversations without attaching to an Agent.
- The user scanned the updated Mac QR and confirmed that individual session
  statuses are visible on the physical phone. The earlier project-count and
  obsolete-question fixes were also confirmed by the user.
- The latest installed service returned a 305-byte scoped session-row reply
  with exactly `id`, `known`, `active`, `waiting`. The selected probe row remained
  unconfirmed and was not reported as idle. A previous real native observer
  independently reported known, active, nonwaiting status.
- Mac Developer ID signing verified six native binaries. The staged and
  installed destinations passed deep strict verification before launch.
  Native Mac UI verified the paired default Statistics view, switching and
  renewal without stealing the selected page. Live dashboard evidence showed
  one connected device, 41 HTTP requests, 30 RPC calls, 111.1 KiB received and
  3.3 MiB sent at the observation point. These are samples, not fixed totals.
- Eight real health requests through the owned gateway increased persisted
  received/sent counters. Phone synchronization was active during this sample,
  so its byte deltas are not attributed solely to the health requests.
- Original Codex application process identity remained unchanged across the
  CodeLight update. No replacement model runner or model test prompt was used.

## Limits and deployment findings

A reused simulator shell failed before launch and is excluded from acceptance.
The current-source simulator build supplied the successful result.

The earlier Mac copy rewrote relative symlinks and failed its resource seal.
The failed copy and previous signed app were preserved. The final dashboard
update used `ditto`; signatures were verified before and after replacement.

Owner discovery failure does not prove idle. Cold, unowned and resource-limited
sources remain visibly unconfirmed. Complete project coverage is not claimed
while unconfirmed is nonzero.

Metrics count owned gateway interface bytes, excluding external TLS/IP/ISP
overhead and model tokens. Full native JSON decoding and independent consumer
copies still cost CPU and allocations. No automated physical-phone screenshot,
measured iPhone frame rate, sustained thermal result, notarization or APNs
acceptance is claimed. Private conversations, credentials, device/signing
evidence and extracted source remain outside Git and source exports.
