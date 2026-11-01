# Native control responsiveness and observer load

## New failure evidence

Phone build 110 displayed latest messages, but submission retained an unknown
native receipt. The exact operation had no accepted original input row in a
fresh read; a different desktop reply later answered the question. It cannot be
confirmed from that unrelated answer. The scoped native capture subsequently
recorded codex-discovery-timeout for this chat's read-controls request, while a
new direct read-only client found the same owner in 581 ms. A fresh attached
single-source client repeated discovery in 85/3/1 ms.

The existing helper sampled at about 278–300% CPU and roughly 2.9 GB RSS. Its
remembered observer list had eight entries with large encrypted checkpoints.
The three complete checkpoints audited by the performance review had no pending
inbox/outbox/events and empty bootstrap, but contained 5.8–8.6 MB plaintext each.
No old hot-process CPU profile was captured; the measured load and source
amplifiers do not establish one exclusive cause.

## Source and shipped-contract findings

- The IPC decoder concatenated the entire accumulated body for every chunk.
  An 8 MiB frame in 64 KiB chunks cumulatively copies about 516 MiB; a 32 MiB
  frame about 8 GiB. A fragmented-frame copy-budget regression failed before
  the linear header/body decoder and passed afterward.
- Empty bootstrap processing still cloned, encrypted and persisted the whole
  connector state. Empty/already-seeded work now returns immediately; an
  identical completed projection stamp also skips checkpoint work.
- Unchanged state plaintext still generated a new encrypted CAS update. Exact
  canonical wire content now returns before encryption/network persistence.
- Remembered full observers restored without current viewing interest. When
  notifications are unavailable, pending transport work restores, selected
  sources activate on demand, and unviewed quiescent observers retire through
  existing safety checks. History/command/receipt files remain.

The current installed Codex ASAR members were hash matched in a read-only
contract review. Local start/steer versions and fields matched. Repeated follow
supports same-revision snapshots. Native follower code routes directly to its
live role ownerClientId; the router still performs target canHandle/version
checks. The bridge now uses a matching live subscription/epoch for that route,
with discovery fallback for absent/stale subscriptions.

The native outer forwarder has a 5-second default while renderer steering can
wait 30 seconds, so an outer unknown does not prove rejection or cancellation.
Question-reply recovery now requires an accepted native input with the exact
original command ID under the same owner/epoch. Pending/rejected steering and
other-device answers cannot confirm it; original unknown receipt evidence stays.

## Checks

92 scoped IPC/connector/transport/daemon tests, bridge/mobile/production-relay
typechecks and bridge lint passed. Coverage includes frame limits, fragmented
headers, following control responses, live-owner routing/epoch rejection,
unchanged checkpoint bytes, strict late reply recovery and pending inbox restore.
Mac 0.5.3 is the new candidate; final native response/load and phone acceptance
are recorded after installation. The temporary observer-isolation list has a
private backup and is not a claim that transport acceptance already passed.

## Installed candidate and channel recovery

Mac 0.5.3 was notarized, stapled and installed. Ticket validation, strict nested
signature verification and Gatekeeper assessment passed. The rebuilt helper
bundle byte hash matched the current owning sources. All four 0.5.2 owned
processes stopped through the parent shutdown path before replacement; the
temporary isolated observer list was restored from its private backup.

The installed local health and routed Relay health returned 200. A fresh
original-owner snapshot read took 317 ms and contained no outstanding question.
An idle helper sample after unviewed observer retirement was about 0.1% CPU and
172 MiB RSS. This idle sample does not establish responsiveness under all loads.

Phone 110 retained expired LAN/Cloudflare endpoints after the Mac restart. Its
fresh diagnostic authenticated HTTP through Relay, but the realtime switch
failed and automatic selection restored the old endpoint/list. The exact
Relay socket failure remains unconfirmed. Source inspection independently
confirmed that the selector stopped after the first HTTP winner's socket
failure, discarding newly authenticated candidates.

Phone candidate 111 now continues through the same Mac's latest authenticated
candidate list after a realtime failure. Manual selection retains its original
single-candidate semantics. The new relay-HTTP-success/realtime-failure/new-LAN
regression failed before this change and passed afterward. Sixteen targeted
mobile tests passed; all bridge/mobile/relay typechecks passed. Seven network
relay tests passed, including the composed sealed-proof, relay-prefix and
actual Socket.IO backend-header authentication case. These fixture checks do
not prove the live public Relay realtime path. Native phone synchronization
and first-submit feedback still require installation and acceptance.

## Physical acceptance after phone 111 installation

Phone 111 built, passed signature/version checks and installed with its existing
pairing. Automatic recovery reached the refreshed LAN channel and established
the realtime connection. Catalog and latest 20 original rows returned HTTP 200.
The first restored recent read took 37.7 s; a repeat took 3.1 s. After actual
phone termination and unviewed actor retirement, another cold recent read took
10.0 s. Cold restoration remains slow; the 5-second CPU sample was collected
after that read and cannot assign its latency to one function.

The user explicitly reported that synchronization was normal, this new question
was displayed, and the first submission had no error and closed automatically.
The phone recorded dispatch followed by complete in 1.332 s and removed that
operation's pending record. The Mac's same-ID receipt was complete/acknowledged,
and a fresh original-owner read contained one accepted user row carrying the
same command ID with no pending question. The earlier unknown operation remains
unknown in both journals and was not replayed or inferred successful.

A manual Relay switch established realtime in 4.8 s, but the following catalog
request timed out. Public Relay reads still show intermittent failure. Automatic
selection was restored: 115 ms selection, connected socket, catalog 407 ms and
recent rows 2.7 s, all successful. Local and Cloudflare probes also returned 200;
two unreachable private interfaces remained correctly unavailable. This is a
successful physical synchronization/submission acceptance, with cold-load and
public Relay limitations retained separately. It does not establish fresh visual
acceptance of every message deduplication or manual-channel UI scenario.
