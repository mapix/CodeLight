# Public release review

## Source packaging correction

The source export previously enumerated Git's cached list and called `lstat`
without handling deletions. Removed tracked Google configuration and the old
environment-specific runtime harness therefore blocked the archive. The current
export uses one shared `copyPublicSourceSnapshot` selection for source archives
and the initial public Git snapshot. Deleted files remain deleted; explicit roots
and private-file exclusions prevent unrelated workspace contents from entering
the snapshot. Allowed symlinks and symlink parent directories fail the export.
The upstream editor-specific `.cursorrules` symlink is explicitly excluded.

The historical archive test still expected the removed Happy-layout tarball
script. It now exercises the current standalone ZIP script against a small Git
fixture with a tracked deletion. Historical positive-copy and staging-only
metadata tests remain available.

## Checks completed

- Six source-packaging regressions passed, including actual ZIP extraction,
  tracked deletions, private network credentials, file symlinks and directory
  symlinks. Public artifact and local-resource website checks passed.
- The then-current source ZIP contained 2,028 files. Structural source verification
  and Gitleaks on its staged file selection passed. This is a checkpoint, not
  evidence that a later rebuilt archive or public Git history has been scanned.
- A separate bounded privacy scan checked paths, private network addresses,
  current device/team identifiers, session UUIDs and personal project names.
  One historical window-control spec contained dedicated QA process/window and
  session identifiers; its public documentation now preserves the behavior and
  removes those local identifiers. No current private conversation was found in
  the reviewed selection. Ordinary UUID fixtures use synthetic values.
- The inherited Happy `trace_0.json`, `trace_1.json` and `trace_2.json` fixtures
  contain upstream sample history and its original opaque IDs/paths. Their Git
  blob hashes were checked against the public Happy reference commit
  `ee5ccff79b046570dc7e62eeec90e7c8a9d7027e` and match exactly. They are unmodified
  public third-party test inputs, not CodeLight user's private histories. This
  provenance check is independent of Gitleaks; the secret scan alone does not
  establish privacy.
- Bridge `pnpm typecheck` and `pnpm lint` passed. The earlier final candidate logs
  also record `pnpm typecheck:all`, `pnpm lint` and 48 affected mobile tests passing.
  New question fixes require their own final gate.
- Thirteen scoped release/network/image tests passed. The dependency release
  gate reports 0 critical, 2 high, 4 moderate and 1 low raw findings. The two
  high findings match the specific patched image-container advisories and their
  bounded malformed-input tests passed; no unreviewed high/critical findings
  remained. Moderate/low reachability limits are documented in `SECURITY.md`.
- Bilingual website FAQ now explains Cloudflare and self-hosted Relay, fixed
  authenticated Relay routes and unchanged phone QR setup.

## Public network Relay

The deployed Relay service was tested with a temporary authenticated network
identity and a synthetic loopback HTTP/WebSocket backend. No personal sessions,
account keys or model commands were used. Under Node 24.15.0:

| Check | Result | Elapsed |
| --- | --- | --- |
| WSS registration | passed | 2.862 s |
| HTTP GET | 200 | 1.709 s |
| 512 KiB POST | 200, exact bytes and SHA-256 | 6.332 s |
| 2 MiB POST | 200, exact bytes and SHA-256 | 7.863 s |
| 64 KiB raw WebSocket echo | exact bytes | 4.738 s |

An earlier 10-second POST timeout was not reproduced. These timings leave limited
headroom for that deadline under network/load variation; the cause of that one
timeout is unconfirmed. No network code change was justified by the retest.
Private numeric evidence is kept outside source exports.

## Static deployment preparation

The separate public-only website build context contains three local page files,
the CodeLight icon and the Nginx Docker/configuration files. It contains no
release yet. The release owner must add only the verified final ZIP, checksum
and validated `release.json` before building.

The existing cluster Docker image `codelight-nginx-base:verified` is amd64 with
content ID `sha256:c243855693784bcf526c53692c4f82e9763d29a2467a3d90f4b22eb58cecd79b`.
Reuse the already verified image with `--pull=false` after checking its content
ID; no registry pull or Docker daemon change is needed. The website manifest
already provides two replicas, bounded resources, nonroot/read-only execution,
dropped capabilities, no service-account token and ingress-only network access.

## Remaining publication gates

Final tested source and fresh independent installation, the final Mac's Apple
`Accepted` result and stapled/Gatekeeper checks, clean initial public Git history
scan, actual GitHub publication, immutable website image and Kubernetes rollout,
certificate/HTTPS/Range/download SHA-256 checks and final browser/native UI
acceptance remain the release owner's responsibilities. This review does not
claim those gates are complete or certify physical-phone thermals.
