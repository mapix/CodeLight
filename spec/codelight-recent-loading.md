# Recent-first catalog and session entry

## Rules and owners

The original Codex owner is the authority for runtime status and latest public
messages. The Mac's index supplies lightweight directory identity/recency; the
phone owns the selected viewport and history cursor. Recency uses native update
time, not the CodeLight mirror's provisioning/update timestamp. Active state is
never inferred from message recency. A source with older public content may be
active, and an unavailable fresh view must not be called idle.

Directory data is ordered most recent first. Records whose native update is
older than 72 hours default to title and basic identity/project/time fields,
without last-message bodies, heavy agent state or message prefetch. Rich data
loads only when the user opens that session. Newer sessions are published first;
older basic entries can arrive later without blocking the first list.
Pinned markers are preserved, but recency is the primary directory order and
pins break equal-recency ties. A root family ranks by its own and descendant
native recency, without changing its parent's actual update time or ancestry.

Entering a session starts the existing observation and fetches a fresh latest
window after it is ready. A speculative/cached page cannot satisfy that fresh
entry. The initial viewport opens at the newest part; prior scroll restoration
must not reopen an old position. Runtime status and freshness are displayed
independently from the age of the last public message.
For authenticated peers, the combined recent API owns observation preparation.
An explicit desktop navigation runs independently; a lost navigation RPC cannot
prevent that authoritative recent read or keep the message viewport loading.

Recent message responses must be self-contained enough to render current text,
tools and revisions, even when prior protocol fragments are outside the window.
Streaming text fragments carry the original native row identity, prefix offset
and correction revision. The phone joins only that identity, retains gaps until
the missing prefix or a fresh full row arrives, and never renders each suffix as
an independent message. Full recent rows, corrections and older wire fragments
share one canonical display row through their explicit identity/alias mappings.
A provisional native user row is replaced by the confirmed original row through
its client command identity; identical text from different native rows is retained.
An admitted phone input's full recent row also carries its original broker/local
aliases. It joins the existing optimistic/echo row even before the POST ACK,
keeps that input's actual timestamp, and confirms its pending display only when
the original connector has recorded input admission.
Existing fragment-only checkpoints publish one identity-based full replacement
when next observed, even if the original text has not changed, so an already
paired legacy phone can repair its visible messages without deleting history.
Historical data remains available on the original owner/Mac; only explicit
upward scrolling advances the earlier-history cursor. Background/list/hover
work cannot walk older pages. Concurrent entry requests coalesce; a superseded
selection cannot overwrite the newest selected viewport.
The real Codex observer mirrors only the latest 100 public rows by default.
Command admission evidence and current question/request mapping still use the
full native view, and existing historical records remain intact. Loading a
complete native view on an explicit history gesture must not broadcast every
new older row to the phone; the history response remains a bounded page.
CodeLight's list layout/content-size events cannot request older pages on entry.
The reader must scroll toward older content (or explicitly retry/load more).
When the native view explicitly reports incomplete history, that history gesture
may request the original owner's complete history before returning a bounded
earlier page. Unknown completeness never becomes an invented end-of-history.

MAC activation/latest-window and catalog/status work should use combined or
parallel requests where the owners allow it. Avoid sequential per-session
descriptor/key/history calls for the entire catalog. Message updates must not
sort/decrypt the whole directory. Channel changes retain the same peer/session
cache and recover latest data without starting another runtime.

## Authenticated peer read interface

The Mac peer box seals the authenticated HTTP response. `/api/peer/catalog`
returns plaintext lightweight descriptors within that sealed response, ordered
by native `source.updatedAt`. The first page defaults to 200 records; subsequent
pages may request 1000, with a hard cap of 2000. The cursor binds its recency/id
boundary and excludes newly moved entries from earlier pages. Entries older
than 72 hours omit preview, last-message, heavy state and session keys. Directory
reads do not activate observers.

`POST /api/peer/sessions/:id/recent` coalesces existing observer activation and a
genuinely fresh original-owner snapshot. It returns the selected full descriptor,
its existing session key and checkpoint field versions, self-contained public
rows, real revision/owner/status, observation time, transport sequence watermark,
and an opaque earlier-row cursor. `/history` uses that session-bound cursor only
after explicit upward scroll and does not start a second runtime. Text rows
carry connector-known fragment identities so a full recent row replaces its
prior fragments rather than duplicating them; tool rows contain both call and
current result/status seeds. Unknown native timestamps remain unknown, separate
from observation time.

Peer credentials and endpoint fencing own channel changes. Phone loading captures
the credential owner and selected session before requests; results from a replaced
peer/account/selection cannot publish. Touch preload does not substitute stale
mirror history for the fresh selected-session request. Legacy non-peer CodeLight
visits still await observation before their bounded latest page.
Descriptor field versions are monotonic: late responses cannot replace newer
metadata or agent state. Basic directory records update index labels without
erasing already-opened rich cache; live actors may include their small current
capability flags, while heavy controls/state/history remain omitted. A response
from an older known native owner cannot replace the viewport after a newer owner
has been published. Local draft changes during key initialization remain local.

Recent seed versions are owned by the CodeLight projection and advance when the
original content stamp changes, including silent snapshots at the same native
revision. They are separate from stream correction counters. A seed records the
stream counter it includes; it cannot replace a later stream correction, and a
large seed version cannot suppress the next lower-numbered stream correction.
Full tool seeds are guarded native upserts, not ordinary tool-start/end replay.
They can create a missing call/result without earlier wire fragments, but an old
running seed cannot reopen a genuinely completed approved tool. Approval-only
placeholders retain their existing transition when the actual tool appears.
Native item `startedAtMs`/`completedAtMs` and the owner's per-item timestamp maps
take precedence over a long turn's start time. Equal native timestamps use
original row order for stable positioning without changing displayed message
time or inventing message activity from observation time.

```mermaid
sequenceDiagram
    participant User
    participant Phone as Phone viewport/history owner
    participant Mac as Index/observation owner
    participant Codex as Original native owner
    User->>Phone: Open session
    Phone->>Mac: Select + request fresh recent window
    Mac->>Codex: Existing observation/fresh tail
    Codex-->>Mac: Current public rows and native status
    Mac-->>Phone: Self-contained recent data + history cursor
    Phone->>Phone: Newest viewport; no old-page prefetch
    User->>Phone: Explicit upward history scroll
    Phone->>Mac: Earlier page using owned cursor
    Mac-->>Phone: Prepend earlier data
```

## Acceptance

Cover a large mixed-age catalog, native vs mirror update timestamps, only basic
old entries, active source with stale cache, activation before fresh entry,
preload/focus races, recent patch/tool dependencies, old cursor only on scroll,
superseded selections and route changes retaining identity. Measure request
counts/RTTs, bytes and time to first recent display; don't substitute fixture
timing for physical-phone acceptance.
