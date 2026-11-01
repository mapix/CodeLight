# Large existing-session recovery

## Evidence

The reported existing session had a live original owner: discovery took 2 ms
and a direct fresh snapshot returned active state with 3,487 rows. Multiple
desktop-selection receipts were already complete. The phone's latest-window
request returned HTTP 400, so the navigation-failure banner did not identify
the failing layer.

Its connector plaintext was 33,350,146 bytes, close to the unchanged 32 MiB
active-checkpoint limit. A fresh projection on a private copy of the actual
checkpoint failed with `connector-capacity`. About 21 MB was ciphertext from
5,302 already-acknowledged observer events. Historical rows and event bodies
accumulated across windows even though new observation was limited to the
latest 100 native rows.

## Change

The sole checkpoint writer now makes acknowledged event bodies and prefixes
outside the current observation window durable in immutable encrypted history
segments. The active checkpoint keeps all event IDs, row aliases/revisions,
current prefixes, pending event bodies, native command plans and receipts.
An archived prefix re-entering the current window is authenticated and restored
before native revision processing. Historical audit/recovery can reconstruct
the full event bodies and prefix versions from the archive index.

Files and directory entries are synchronized before body references replace
the active payload. An interrupted archive-before-checkpoint update is
idempotent. An archive-write failure leaves active bodies intact. The 32 MiB
active limit and network message limits remain; history segments use a separate
128 MiB local encrypted envelope bound. Empty bootstrap collection also avoids
an unnecessary full checkpoint write.

## Verification before installation

- 50 targeted connector, archive and network relay tests passed. A near-limit
  legacy fixture grows with new native content, migrates old acknowledged
  bodies, preserves an unknown reply plan, and restores an old prefix without
  republishing its historical input.
- Interrupted migration, archive-write failure, source/key mismatch, pending
  body retention and stable alias/command identity regressions passed.
- All bridge/mobile/production-relay typechecks and bridge lint passed. The
  composed relay fixture's TypeScript declarations were corrected as part of
  this validation.
- The same actual checkpoint and a fresh original snapshot recovered on a
  private copy in 1.7 s. Active plaintext was 3,431,798 bytes. All 5,302 original
  acknowledged ciphertexts and 2,394 archived original row bodies were verified
  byte-for-byte. No native mutation was dispatched. This copy used a local
  transport stub and is not physical-phone acceptance.

Mac 0.5.4 installation and physical latest-window/retry verification are
recorded below after the signed candidate is installed.

## Local installation and physical acceptance

Developer ID signature verification and same-source helper-bundle comparison
passed. Per the user's instruction, notarization is deferred until the product
is ready; this local 0.5.4 candidate is not notarized. All four owned 0.5.3
processes exited cleanly before the complete stopped connector directory and
previous app were retained. Existing Mac, relay, network and account secret
keys remained unchanged. The original desktop process stayed running.

The first phone reconnection selected Relay and encountered its previously
observed intermittent catalog timeout. A fresh automatic choice reached the
updated LAN endpoint: selection 516 ms, catalog HTTP 200 in 407 ms, latest
20 original rows HTTP 200 in 3.4 s and original status active.

The live installed checkpoint is connected and about 3.7 MB plaintext with two
encrypted archives. Against the stopped backup, all 5,302 acknowledged
ciphertexts and 2,394 archived original rows were verified, with no pending
events and no added native commands. The user explicitly confirmed the actual
session shows latest messages and the previous open/retry error disappeared.
Public Relay stability remains a separate open issue.
