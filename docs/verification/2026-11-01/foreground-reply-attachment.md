# Foreground reply attachment and session header

## Failure evidence

The new phone submission recorded a transport error after about 15.1 s, then
its original-ID receipt query also failed after about 15.1 s. The Mac had no
receipt for that ID and a fresh original-owner view had no accepted input row
carrying it. The local RPC broker waits 15 s when its worker room is empty.
The daemon's remembered observer list was empty during the investigation.

Foreground presence was sent using captured old credentials/server URL and a
plain Bearer header. After same-peer channel changes the address check rejected
it; on LAN the gateway requires a sealed device proof. Those requests therefore
failed to protect the visible observer from the existing idle retirement rule.

## Changes

- Peer device/presence requests use the current authenticated API connection,
  sealed proof and latest stored peer credentials. A different peer is rejected
  before the request. Presence remains independent of APNs configuration.
- The broker marks failures before any worker emission as definitively unsent.
  Phone RPC propagates that fact; post-emission disconnects remain uncertain.
  Old unknown operations keep their original identities and are not replayed.
- The session input area's network pill is removed. A 44pt header icon and
  state dot open the existing picker beside the existing session-info control.
  Global settings keeps its full connection row.

## Checks and local install

29 scoped mobile tests and three broker tests passed, covering current-route
presence across a same-Mac switch, a different-peer guard, minute-long active
heartbeats without APNs, pre-emission versus post-emission failures, removal of
the input-area utility and the header-only picker. All bridge/mobile/relay
typechecks and bridge lint passed.

Simulator build 2026110113 showed the header icon/state dot without a visible
route label or input-area button, and clicking it opened the existing selector.
The local Mac 0.5.5 and phone 2026110113 were signed, installed and launched;
notarization remains deferred. The original desktop stayed running and the
stopped connector/previous app were retained.

Native diagnostic selection and catalog/recent reads succeeded. After the user
manually entered the chat, two real foreground snapshots 86 seconds apart had
the correct viewed-session identity and a remembered observer. This verifies
foreground protection for build 2026110113.

The subsequent local Mac 0.5.6 / phone 2026110114 check received explicit user
confirmation of a first submission without error and automatic form close.
Dispatch to confirmed completion took 471 ms. The phone removed the new pending
record, the same-ID Mac receipt was complete and acknowledged, and a fresh
original-owner row carried the same command ID with accepted status. Both old
unconfirmed phone operation identities remained present; they were not replayed.
