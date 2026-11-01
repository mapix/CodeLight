# CodeLight 0.5.8 public preview

## Artifacts

- Website: <https://codelight.novarock.io/>.
- Release: <https://github.com/mapix/CodeLight/releases/tag/v0.5.8>.
- Public code: `4e5da5ca7df2b4fa844eca3ddb564ae06e89e9b5` (clean public parent history).
- Mac ZIP: 113,051,920 bytes; SHA-256 `013fa8dab4677b95a179a3097d7ec16c44b61627d979d3fc7f8d211571b00c58`.
- Source ZIP: 24,280,734 bytes; SHA-256 `02e6b7cb32fbe3d25d0937dccc9f04086d9aeb8c8071028036c5facd5b9c5f0b`.

## Native behavior

Mac Start/Pause controls the owned CodeLight service. Pause waits for helper,
database and tunnel children to exit before Start enables; original Codex stays
running. The phone restores encrypted title metadata and permits existing-session
navigation while titles refresh. Cold connection errors and retry status changes
activate the existing automatic selector. Both session loading views ignore
obsolete read errors during recovery, and fresh generations queue before
connected state appears. Same-peer route changes preserve selection authority.

The final installed Mac is 0.5.8 and the phone build is 2026110116. Without manual
network selection, the phone recovered an authenticated current route and
validated 50 recent native rows and the 32-byte session key. A cold selected read
in this diagnostic took about 12.7 seconds; this is not a claim that cold latency
is eliminated. The user confirmed latest messages were visible, the persistent
synchronization error disappeared and the first submission succeeded. Dispatch
through confirmed completion took 574 ms; phone completion, Mac acknowledgement
and the original accepted input carried the same operation identity. Old unknown
operations remain preserved and were not replayed.

62 scoped mobile regressions, six Mac lifecycle/owned-shutdown regressions and
all bridge/mobile/relay typechecks passed; root lint passed. The existing release
dependency gate had no blocked findings; its specific container patches and
moderate/low reachability limits remain documented in SECURITY.md.

## Signing and delivery

Developer ID verification, Apple Accepted, ticket stapling, strict signature and
Gatekeeper checks passed. Repacked ZIP extraction was verified again. Installed
Mac ticket/Gatekeeper checks passed, with the original desktop process unchanged.
The website uses an immutable release image, two ready replicas and a ready TLS
certificate. Public HTTPS metadata and full ZIP bytes/SHA-256 match the reviewed
artifact; Range returned 206 with 1,024 exact bytes. Browser verification checked
Chinese/English switching, the active 0.5.8 download and a 390px phone layout with
no horizontal overflow. Site assets are local and no session/account state is
served by the static site.

## Private Relay configuration

The deployment example now uses relay.example.com. Current source, public
reachable Git history and the expanded final Mac ZIP were scanned against the
saved private Relay URL, hostname and access key, including common string
encodings. No matches or private configuration files were found. No phone
provisioning package or private evidence was published.

With explicit owner authorization, historical source trees and the old source
ZIP were cleaned. Other old release assets remained unchanged. Current reachable
source and assets are clean; previously downloaded clones/files and external
caches cannot be recalled. Original private development history was retained
locally and was not pushed.
