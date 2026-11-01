# Submission feedback, native row identity and mirror recovery

## Corrected acceptance

The replacement-chat answer was received by the original desktop with a complete
native receipt. The user then clarified that several phone failures appeared
before closing the form, and the reply arrived afterward. The phone retained the
same pending v3 operation. This does not establish successful phone feedback.
The transient error included one additional line that was no longer available;
the exact lost/late phone acknowledgment cause remains unconfirmed.

## Confirmed display causes and changes

One original assistant paragraph produced ten independent text events. Those
events lacked row identity, so the phone rendered each suffix as a separate
message. New suffixes carry native row ID, prefix offset and correction revision.
The reducer joins only that row, retains gaps until their prefix/full snapshot
arrives, and preserves incremental transport.

Repeated recent windows could also lose an existing display row after its real
wire ID changed to a recent-window ID. Canonical native row mappings and explicit
wire aliases now join those updates. Confirmed user rows replace provisional
native input through the original client command identity. Equal text with a
different original identity is retained. Old fragment-only checkpoints publish
one full replacement even when their original text has not changed.

Submission now queries the original receipt after a lost ACK or missing receipt
payload. Unknown outcomes retain the submitted answer and offer Check result.
Closing an unknown form sends no cancellation; reconnect recovery and explicit
checking share the original operation. Offline sockets cannot buffer mutations.
A late earlier reply cannot close a newer question form. Private diagnostics keep
bounded stage/time/status values without answer text, credentials or endpoints.

## Installation failure and recovery

During restart, an orphaned CodeLight database process and tunnel process were
found. Both stopped with SIGTERM. Subsequent PGlite startup failed because its
WAL checkpoint was invalid; the old/new server bundle and PGlite JS/WASM/data
artifacts matched. A private copy reproduced the failure. The original corrupt
directory was retained before installing a recovered copy.

The recovered heap initially contained mirror messages through 14:41. Original
acknowledged projection journals restored 533 encrypted messages with matching
canonical HMACs, original IDs, sequences and timestamps; 96 metadata/state fields
and two registered session identities were also restored. The audited journals
had no missing acknowledged bodies or missing native-input message rows. The
result contained 1,414 sessions and 19,383 messages and passed reopen verification.
No native commands were redispatched. Account keys and receipt files were kept.
These counts prove the audited journal coverage, not an exhaustive claim about
every possible lost database transaction.

The embedded server disconnected Prisma at shutdown without explicitly closing
the externally supplied PGlite instance. The new database close persists the
engine checkpoint even when Prisma disconnect fails. Mac pipe EOF/broken output
now stops the owned service; observer cleanup errors cannot skip child shutdown.
Child termination precedes service-lease release.

## Executed checks and remaining gates

- 38 connector regressions and 65 affected phone regressions passed.
- Two actual PGlite close/reopen/error regressions and three owned cleanup/process-exit
  regressions passed, including a real TERM-resistant child. Before the engine-close change, both database tests failed.
- Bridge/mobile/production-relay typechecks and bridge lint passed.
- Phone/simulator build `2026110107` succeeded and was installed. Their bundles
  contain native row identity, Check result and private diagnostic code.
- Final Mac 0.5.2 submission `f032db8e-d4bb-4c8b-b9f4-5f09d547763f` was Apple
  Accepted. Stapling, ticket validation, strict signatures and Gatekeeper checks
  passed before installation; installed signature/Gatekeeper checks also passed.
- The installed Mac native UI showed Local network/Cloudflare/Relay checked,
  with Local and Relay Ready. The real parent-termination check ended all four
  owned processes, and the database control reported a clean shutdown checkpoint.
  Reopening succeeded; the local and public Relay Mac health routes both returned
  200. A subsequent UI capture failed in the system screen-capture service, so
  the post-restart health is API evidence rather than a second UI capture.
- Final phone build `2026110107` was installed. Its attempted automatic launch
  was denied because the device was locked; physical launch/answer verification
  remains the user's next step. Account/box/relay keys and original desktop
  process identity/start time matched the installation baseline.

Physical-phone feedback before manual close, message grouping, original-ID
receipt retirement and real channel switching still require live verification.
The public download remains the earlier release until the final release gates.
