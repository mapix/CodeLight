# Peer session loading and channel transitions

The phone remained at Syncing this session and channel choices did not complete.
The first native diagnostic on build 109 recorded a failed automatic selection
after about 20 seconds. That result did not establish usable channel switching.

## Confirmed implementation causes

- React Native's installed abort-controller provides instance abort events but
  no AbortSignal.any/timeout static helpers. The channel probe called those static
  methods. A regression without those methods failed before the replacement.
- The CodeLight server getter caches its runtime endpoint. Channel selection
  updated only MMKV, leaving some current requests on the previous route. The
  authenticated peer owner now commits both the stored and runtime endpoint;
  ordinary account/server edits retain their reload boundary.
- Selected-session entry waited for desktop navigation before starting the peer
  recent API, although that API already prepares the original observer. A pending
  navigation regression blocked the first window before the fix. Navigation and
  the authoritative recent read now proceed independently for authenticated peers.
- The WebSocket proof signed /v1/updates, while Engine.IO adds its default trailing
  slash. The receiver strictly checks the signed path. The new client signs and
  sends the same actual path; receiver validation is retained. The exact proof
  regression failed before this change and passed afterward.

## Additional boundaries and verification

Old peer reads abort when their route disconnects. Native-compatible deadlines
bound catalog/recent reads and failed requests produce retry state. Same-peer
cache scope uses peer identity rather than an ephemeral URL; another peer remains
isolated. Failed channel commits restore the old route and credentials.

46 directed tests cover native signal compatibility, request cancellation,
runtime endpoint changes, cache identity, navigation/read ordering, nonce startup
and exact WebSocket proof paths. Bridge/mobile/production-relay typechecks and
bridge lint passed. Phone/simulator `2026110110` built and were installed.

## Physical phone 110 transport result

The device debug tunnel initially disconnected; after USB reconnection and
unlock, the same native diagnostic completed using the saved peer credentials:

- Auto selection completed in 518 ms; the WebSocket was connected.
- Three Local network entries were probed: one authenticated with HTTP 200
  in 142 ms; the other two timed out at roughly 2.5 seconds.
- Cloudflare and Relay probes authenticated with HTTP 200.
- Catalog returned HTTP 200 in 432 ms with 187 lightweight records.
- This chat's recent endpoint returned HTTP 200 in 660 ms, 20 complete rows
  and original native status active.

The diagnostic finished at its complete stage. These are actual phone request
measurements, not fixture timings. The phone was then navigated to this chat for
user-visible loading/submission validation. The two unreachable private-interface
entries are not claimed usable on the phone's current network.

The native diagnostic records only channel index/kind, status and elapsed time,
plus catalog/recent counts. It dispatches no native session command. Its explicit
Auto mode exercises the already authenticated peer's channel selection.
