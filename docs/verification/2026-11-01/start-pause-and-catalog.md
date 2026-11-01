# Service pause and immediately usable session catalog

## Changes and ownership

The Mac controller owns starting, running, pausing, paused and failed service
states. Pause uses the existing graceful service shutdown; Start is unavailable
until the helper and its owned database/tunnel processes have exited. Late stdout
cannot restore ready state while pausing. Saved device authorization, configuration
and operation journals stay on disk. The original Codex owner keeps running.

The phone restores an account-bound encrypted peer catalog before making its UI
ready. Cached descriptors enable navigation and have unknown runtime activity.
Startup, reconnect and Retry queue a new discovery generation before asynchronous
directory work. A disconnected/connecting transport displays synchronization;
an old directory error cannot disable an existing session row. Each chat's fresh
recent read runs independently of title pagination. Malformed, cross-peer or
wrong-key cache data is ignored so fresh synchronization can proceed.

```mermaid
sequenceDiagram
    participant User
    participant Mac as Mac controller
    participant Service as CodeLight service
    participant Phone as Phone sync runtime
    User->>Mac: Pause
    Mac->>Mac: Pausing; disable Start
    Mac->>Service: Graceful shutdown
    Service-->>Mac: Helper and owned children exited
    Mac->>Mac: Paused; enable Start
    User->>Mac: Start
    Mac->>Service: Reopen existing saved state
    Phone->>Phone: Restore encrypted catalog; queue title sync
    User->>Phone: Open a cached session
    Phone->>Service: Independent fresh recent read
    Note over Phone: Title refresh remains in the background
```

## Checks

38 targeted mobile tests passed, including a known chat's fresh read while its
catalog request is still unresolved, a pressable list during title loading and
an obsolete connection error, queued discovery generations, encrypted cache
storage, peer/key isolation and account-change fences. Six Mac lifecycle/owned
shutdown tests passed. All bridge/mobile/relay typechecks and bridge lint passed.

Native Mac testing showed disabled Start/enabled Pause while running. After a
real Pause, the app stayed open and all helper/database/tunnel children exited;
Start enabled and the status became Paused. A real Start reopened exactly one
service with its owned children, local health returned 200, and persisted identity
files and account secret matched. Phone build 2026110115 built and installed.
Physical phone cold-entry acceptance is pending.

## Release privacy

The self-hosted Relay deployment example contained the publisher's saved private
hostname. The example now uses `relay.example.com`. An expanded final Mac candidate
scan covered 2,659 files, including native binaries: no saved private Relay URL or
hostname and no device/account/network credential configuration files were found.
Public-source and reachable Git history scans are separate publication gates.
