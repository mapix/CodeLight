# Phone question submission and operation scopes

## Corrected physical-phone outcome after takeover

The first replacement-chat answer reached the original desktop and its exact
native receipt is complete. The user then corrected the apparent success: the
phone had shown several failures before the form was closed, and the message
arrived afterward. Its phone v3 journal still contained the same pending operation
when inspected. This is not a successful end-to-end UI acceptance.

A read-only loopback query returned the completed original-ID receipt in 5 ms
with the expected encrypted scalar reply. This excludes a permanently missing
receipt and a scalar/array mismatch in that tested local server path. The exact
lost/late phone ACK cause remains unconfirmed because its transient error and
timing were not retained. The user recalled the same computer-not-responding
message with one extra line; that line had disappeared before capture.

The current repair queries the original receipt after lost ACKs or missing
receipt payloads, reserves receipt recovery against concurrent submissions,
rejects offline mutation buffering, and resumes read-only recovery after reconnect
or selected-key initialization. Remaining unknown outcomes preserve the original
answer and offer Check result; closing that state sends no cancellation. A
bounded private journal records stage/time/status only, without answer text,
credentials or endpoints. A new physical-phone attempt must pass before acceptance.

```mermaid
sequenceDiagram
    participant Phone as Phone journal and form
    participant Mac as Existing connector receipt owner
    participant Codex as Original native owner
    Phone->>Phone: Persist original command identity
    Phone->>Mac: Explicit answer once
    Mac->>Codex: Existing start or steer admission
    Codex-->>Mac: Native acknowledgment
    Mac--xPhone: ACK may be lost
    Phone->>Mac: Read-only receipt query with same command ID
    Mac-->>Phone: Complete, failed or unconfirmed
    Phone->>Phone: Close if complete; preserve answer and Check result if unknown
```

## Version 0.5 extension

The earlier address/entity fix below is preserved as failure evidence. Version
0.5 uses authenticated peer/entity/operation-target journals so a same-Mac route
change retains identity and a known different question target stays independent.
Legacy records are preserved and inspected through original-ID receipts before
recovery; unknown outcomes never trigger automatic mutation replay. The final
0.5 physical-phone acceptance is recorded by the release owner separately from
this earlier build checkpoint.

## Confirmed failure

After the user reconnected through Relay, the latest question was visible but
submission reported `The computer did not respond`. A read-only copy of the
phone's AsyncStorage metadata contained a legacy pending communication from
October 31, for another session on an earlier Cloudflare entry. Its original
command identity remained pending. The current Mac connector had no new command
for the tested question.

The legacy journal was global. Its `run` method rejected the current server
context before calling the transport, so the unrelated old operation blocked
the new session locally. Increasing the network timeout cannot fix that path.
Private IDs, endpoint details and phone data remain outside source exports.

## Fix and ownership

### Second submission failure and current candidate

The physical phone still reported no response on build `2026110103` after the
local scope fix. In that attempt, the Mac received the command and retained its
original unknown receipt. A running native turn requires the existing follower
steering input path. `answer-question` previously used start-turn unconditionally;
the current implementation reads a fresh original-owner snapshot and chooses
steer when a current turn exists, or start-turn when none exists. It does not
interrupt the original turn or automatically replay the earlier unknown command.

The targeted fresh-control regression confirms coalesced reads cannot resolve
from an already-cached view and verifies active-question steering. This test uses
a controlled native adapter; the second physical-phone failure is not considered
resolved until a new explicit answer is accepted by the original owner. The
signed Mac 0.5.0 and installed phone `2026110104` contain the current change.

Session and machine RPC journals are now separate for each authenticated server
address/entity ID. Their in-flight merge and persistent record use the same
scope. A legacy record participates only in its original server/entity context;
it is not deleted when another scope succeeds. Recovery still queries the
original command ID and never replays a mutation. The existing model journal
retains its separate scope.

The socket adapter captures its configuration, socket and encryption owner
before asynchronous encryption. A changed connection rejects the request before
emission; scoped callers also supply the expected endpoint. These checks apply
to session and machine RPC without increasing acknowledgment timeouts.

The event diagram and acceptance rules are in `spec/codelight-product.md`.

## Executed checks

- 18 targeted journal, socket and question tests passed. Coverage includes the
  old-entry/other-session blocker, independent scopes, concurrent gestures,
  original-ID read-only recovery, legacy preservation and connection changes
  during encryption. The normal encrypted request/reply path also passed.
- Two existing model-control hook tests passed.
- `pnpm typecheck:all`, `pnpm lint` and diff checks passed.
- Phone build `2026110103` is the candidate for native submission verification.
  Installation and a fresh physical-phone answer must be recorded before live
  submission is accepted. Earlier prompt visibility was confirmed by the user;
  that observation did not prove successful submission.
