# 2026-10-31 CodeLight takeover and performance verification

## Scope

The previous chat was already interrupted in the backend and was archived. Active work continues in this standalone Git workspace. The original Codex desktop remains the sole model/session owner. Worktree controls remain text-based.

## Confirmed causes and changes

- Entering a session previously fetched the latest 100 records plus up to five speculative 100-record older pages. CodeLight now starts with 50 and uses scroll-driven exclusive-cursor paging.
- Consecutive socket messages previously also invalidated message HTTP/Git synchronization. The native fast path now relies on its sequence admission; gaps still reconcile. Catalog activity is coalesced, preserves concurrent metadata, and skips old-account publications.
- Native navigation now retains one session route. A 10,000-row single turn previously defeated the initial message window; CodeLight now processes at most 120 rows initially, then grows as the reader asks.
- Lifecycle-only message updates retain the sorted array. Actual changes sort only changed rows and merge into the existing order. Unrelated message writes reuse the catalog selector result.
- Long Markdown first renders at most 8,000 characters and expands in chunks. Full original copy content remains available. Header artwork uses a 96-pixel generated brand derivative.
- Decryption is divided into small scheduling chunks. Selecting a session writes only the small recent-session index, rather than serializing the whole encrypted catalog.
- Warm catalogs use the existing delta endpoint. The server returns the first scan start watermark, preventing a later page timestamp from skipping concurrent changes to earlier pages. The watermark commits only after complete success and older relays keep the previous one.
- Background idle sockets disconnect; pending sends retain their watchdog and disconnect after draining. Background refresh is bounded to one recent session/page and requests a 60-minute OS schedule. iOS remains the schedule owner.
- Observer output batches up to 50 records / 256 KiB, preserving FIFO, durable ciphertext and stable local IDs through lost ACKs. The fixed 120-record test uses three requests, versus 120 before.

## Measurements

The live catalog contained 1,347 sessions across seven pages, totaling 3,213,075 response bytes. The read-only delta query in this sample returned one row / 2,859 bytes. This is a sample, not a constant network guarantee.

Synthetic host benchmarks and input sizes are in the adjacent JSON files. They measure algorithm work and request budgets; they do not measure iPhone frames or temperature.

## Final verification status

- Bridge, phone and production relay typechecks pass; root Lint passes. The final affected suite has 140 passing bridge tests and 74 passing phone tests, with the native projection benchmark executed separately. Earlier performance regressions also passed 102 phone and 37 transport/native-connector tests.
- Mac final dashboard build succeeds; Developer ID signing verifies six native binaries. `/Applications/CodeLight.app` is updated and its native paired UI defaults to Statistics. The previous installed bundle is preserved locally.
- Source ZIP extraction, frozen dependency installation and standalone bridge/phone typecheck passed. The final source check also verifies the explicit Expo Babel preset and production relay typing.
- Final iPhone build 2026103110 is installed and launched. CoreDevice app inventory confirms CodeLight 1.8.0 / 2026103110. The user scanned the new Mac QR and confirmed that individual session statuses are visible. Earlier lock-screen launch denial was resolved by unlocking the device.
- Early native CUA capture failed after unlock with ScreenCaptureKit -3811; the updated Mac window later became readable and its Ready-to-scan state was verified. Instruments could not attach to the paired iPhone and timed out waiting for the device to boot. Device process enumeration succeeded. Native frame rate, sustained scrolling feel and thermal acceptance remain unmeasured; no cold-phone claim is made.

No new model test prompts were sent. Private credentials, device registries, native conversations and private environment-bound QA harnesses are excluded from the Git source/export.

## Packaging repairs

The independent build exposed missing entitlements paths, the unlisted Expo Babel preset, missing Node WebAssembly declarations and an obsolete tar/npm source verifier. These are corrected with repository-relative native files, explicit package dependencies, a pinned pnpm ZIP verifier and actual build exit-code propagation. No old monorepo hoisting is required.

A final cached-history regression exposed a repeated turn-boundary allowance on live updates. The phone now pins the exact chosen row; a 10,000-row fixture stays at 120 rows and grows to 121 for one live insertion. All 37 chat-list cases and 22 sync cases pass after the fix.

The subsequent current-turn question prompt fix and its live verification are
recorded in [question-scope.md](question-scope.md).

The Codex-only project activity, session select, locale and compatibility pass is
recorded in [codex-activity.md](codex-activity.md).
