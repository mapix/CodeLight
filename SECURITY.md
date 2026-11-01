# Security and trust boundaries

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/mapix/CodeLight/security/advisories/new).
Do not post pairing URLs, credentials, conversation bodies, private screenshots
or provisioning profiles in public issues. Include the CodeLight version,
affected boundary and a minimal synthetic reproduction.

CodeLight is an independent preview project, not an OpenAI product. A review,
signature or notarization is evidence for a particular release; none proves
that every future configuration is risk-free.

## What you authorize when pairing

- A paired phone is a trusted controller of the Mac's CodeLight account and its
  exposed Codex sessions. There is currently no separate per-project or
  per-session ACL. Pair only phones you control and trust.
- QR invitations contain a random 256-bit invitation and a pinned Mac public
  key. The encrypted exchange binds the response to one phone public key.
  Unused invitations expire after three minutes. Same-phone acknowledgment
  retries reuse the existing encrypted response; another key cannot consume it.
- Revoke a lost phone from the Mac App. Revocation is persisted before its
  owned gateway sockets are closed. Previously downloaded history on that
  phone is not remotely erased.
- Original Codex owns the session, runtime and command admission. CodeLight
  does not launch a replacement model runner or modify/restart Codex.
  Unknown outcomes retain command identity and are not automatically replayed.

## Encryption, storage and metadata

Conversation records and control RPC use the Happy-derived encrypted transport.
The paired Mac and phone hold the account key. The desktop owner already has
access to the original conversation; CodeLight is not a protection against a
compromised Mac, malicious local software or an authorized phone.

The Mac stores its local account/key files with private file permissions in its
application-support directory. These files are not encrypted by an additional
CodeLight disk-encryption layer; protect your macOS account and backups. Phone
credentials use native secure storage. Relay databases store encrypted message
content, while routing identities, timing, sizes and operational metadata remain
observable. TLS is additionally used for the public tunnel.

CodeLight's normal build disables upstream analytics, public Happy fallback and
the upstream OTA publisher. The distribution website uses no third-party
scripts, fonts or analytics. Its web server still produces ordinary access logs.
The website hosts only public release bytes and metadata, never sessions,
pairing endpoints, account keys or device-specific IPAs.

The optional public network Relay is separate from the encrypted Mac relay.
It keeps authenticated network bindings and bounded transient stream buffers only.
It can observe transit headers/ciphertext, routing and timing, so choose a trusted
server. Registration uses an access key and an independent Mac signing identity;
no account encryption key is sent to it. TLS validation and independent HTTP/WS
probes are required before switching a working entry. A saved access key is not
reused for another server. Prefix-aware phone transports keep other Macs on the
same hostname outside the credential boundary. See `spec/codelight-network-relay.md`.

Local LAN, Cloudflare and configured Relay can run concurrently around the same
Mac/account identity. A v2 QR contains the pinned Mac key and enabled candidates;
the phone accepts endpoint updates only inside that Mac's sealed peer response.
Changing a verified route retains its cache and operation identity. The phone's
automatic choice does not continuously poll every channel or replay mutations.

Private-LAN requests do not transmit a reusable bearer token in cleartext.
The device uses its retained box key to seal time/nonce/request-scoped proof to
the Mac. All owned gateways share one approved-device registry and nonce verifier;
the backend token is unwrapped only on the owned loopback link. Revocation applies
across entries. Public TLS validation remains enabled.

## Gateway and native protocol

The public gateways bind to distinct loopback ports and are exposed through
their owned outbound tunnels. Enabled LAN gateways bind only actual private
IPv4 interface addresses, with at most three listeners. Public requests need
an approved device token except the small health
endpoint and encrypted pairing exchange. Public auth-registration routes are
blocked. Expensive unauthenticated pairing admission has a bounded burst/refill
budget; connection count, body size, header time and request time are bounded.

Native operations preserve source/host identity, owner generation, leases,
request ordering and receipt fencing. Missing or unsupported native state is
unconfirmed, never an invented idle state. The native desktop interface can
change across Codex versions; unsupported versions must fail visibly.

## Dependency review

The public release updates security fixes in Fastify, Socket.IO, Axios, XML
parsing, Sharp, Zod, crypto/build dependencies and Vitest, while retaining the
Expo 55 / React Native 0.83 SDK line. Public Mac runtime inputs are downloaded
from the official Node.js and Cloudflare releases and checked against vendor
release digests before signing. The public source includes the exact pnpm lockfile.

Metro uses image-size 1.x's legacy callable API. The repository carries a
reviewed package patch for malformed ICNS and HEIF/JXL container progress/bounds,
with bounded malformed-input regressions. Advisory tools can still report the
old image-size package version; this is recorded rather than hidden by a global
advisory allowlist.

`pnpm security:release` retains those raw counts, verifies the configured patch,
runs its malformed-input regressions, and blocks every other high/critical
advisory. Its two specific reviewed exceptions are GHSA-5p2g-fcmc-qvqq and
GHSA-w3rx-r6r6-pgpr; they do not exempt new findings in the same package.

Remaining moderate stream-json findings concern the optional MinIO backend.
The distributed Mac uses local file storage and clears inherited S3 host/key
configuration before starting its embedded server. MinIO activates only when
S3 configuration is explicitly supplied to the separate standalone server. The inherited standalone server
and S3 deployment examples are not certified production deployments. Legacy
glob/minimatch and deepmerge findings are build/configuration paths; never expose
Metro or development servers publicly or build untrusted source/assets with
credentials available. See the release verification report for actual scanner
results and their limits.

## Public source checks

The initial public Git history is a reviewed source snapshot. Private development
history, extracted proprietary applications, environment-bound acceptance
harnesses, Google service configuration, signing material, device registries and
private QA are excluded. Gitleaks exceptions cover only CocoaPods integrity
digests and deterministic test-seed derivation outputs, with file/line-pattern
constraints. Do not widen these exceptions to whole source directories.

## Mac distribution

Public Mac artifacts must pass expected Developer ID signature and secure
timestamp checks, Apple `Accepted` notarization, ticket stapling/validation and
Gatekeeper assessment. The ZIP is created after stapling, and its SHA-256 is
published with the release. A signed app without accepted notarization is not a
public release. Current builds target Apple Silicon with macOS 14 or later.
