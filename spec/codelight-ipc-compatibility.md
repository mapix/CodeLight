# Codex IPC client compatibility

## Verified scope

This pass compares CodeLight's independent IPC client with the current packaged
JavaScript client/router. The extracted JavaScript hashes were checked against
the extraction manifest:

- `.vite/build/early-bootstrap-339-aea964a206c655e4.js`:
  `2c67d735b4465fd07dc5fca7c5e9429b1ccd100a53ed010bb8e9cd13efbdec7e`.
- `.vite/build/early-bootstrap.js`:
  `5a4fe13a7371e73302b1cf10b54a035d16a77692ddb1c8de3c28c1c7e6fc5071`.

The observations are scoped to these packaged JavaScript files. The full ASAR
analysis had a separate unpacked-native integrity mismatch and is not treated as
a successful package-wide analysis. Private extracted source and runtime
conversation evidence remain outside Git.

The client request handling is at byte offsets approximately 1123400–1126600 in
the first file; router discovery/forwarding is at 1114900–1119100. The native
version table and its matching rules are at approximately 175000–176600 in the
second file. Offsets are retrieval aids for these exact hashes, not stable API
identities across versions.

## Incoming request contract

CodeLight is a follower client and provides no original-owner request handlers.
It must explicitly decline a forwarded `request`, preserving the router's
`requestId`. The native client uses these exact error envelopes:

```json
{"type":"response","requestId":"fixture-request","resultType":"error","error":"no-handler-for-request"}
```

An unsupported request version uses `request-version-mismatch` in the same
envelope. Neither error claims an owner, acknowledges a business operation, or
dispatches a native command.

Native version matching uses the packaged method table, defaulting an unknown
method to version 0. A follower method with a non-null top-level `hostId` uses
the base version plus one. A local interruption also accepts legacy version 3
alongside current version 4. This compatibility matcher is used only to reject
incoming requests; the existing outbound command surface is not expanded.

`client-discovery-request` continues to receive
`client-discovery-response` with `{ "canHandle": false }`. This was already
implemented before this pass. CodeLight never announces itself as a request
handler or original session owner.

## Cold discovery and uncertainty

The native router probes all other clients and uses `Promise.any` to select a
handler. Each discovery probe has a 10-second timeout. Its catch path collapses
all probe failures—including false capability responses and probe timeouts—to
the same `no-client-found` response. That response means no owner was verified;
it does not establish that a session is idle or that no owner exists.

CodeLight's owner discovery returns `null` for that explicit router result,
with this uncertainty retained by its callers. A local discovery response
timeout or the router's `request-timeout` is classified as
`codex-discovery-timeout` and remains an error. No timeout is converted into an
idle status and no timeout duration is reduced to disguise the condition.
Mutation timeouts retain their existing unknown-outcome handling and are not
automatically replayed.

The missing forwarded-request error response is a confirmed compatibility gap.
It is not established as the cause of cold owner discovery timeouts: the
discovery capability response was already present and false.

```mermaid
sequenceDiagram
    participant Requester
    participant Router as Existing Codex IPC router
    participant Client as CodeLight follower
    Requester->>Router: Existing owner discovery
    Router->>Client: client-discovery-request
    Client-->>Router: canHandle false
    Note over Router: All other clients may reject or time out
    Router-->>Requester: no-client-found if no client was verified
    Note over Requester: Unconfirmed owner; never infer idle
    Router->>Client: Forwarded request
    Client-->>Router: Version mismatch or no-handler-for-request
```

## Regression and runtime checks

Targeted socket tests cover immediate explicit declines, unknown methods,
current/remote/legacy versions, no owner or handler registration, discovery
failure classification, and preservation of uncertain mutation identities.
Read-only runtime discovery checks use known original session IDs and do not
send model input, change settings, claim ownership, or restart the original App.
Observed runtime results are recorded separately from the static comparison.
