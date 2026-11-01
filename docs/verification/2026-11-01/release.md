# CodeLight 0.4.0 public preview

## Published artifacts

- Source snapshot: `3010163abea4c0080908bcd140b59e9552b0c226` at <https://github.com/mapix/CodeLight>.
- Release: <https://github.com/mapix/CodeLight/releases/tag/v0.4.0>.
- Static download page: <https://codelight.novarock.io/>.
- Mac archive: `CodeLight-0.4.0-macos-arm64.zip`, 110,291,784 bytes.
- SHA-256: `bc35659ac5452cb55d0afdfbf12620c1945d0f05eddd3fe4433516a600580494`.

The public repository starts with the reviewed source snapshot. The original
local development history was retained separately. Source and initial public
history Gitleaks scans returned no findings under the specific test/checksum
exceptions. The 2,031-file source ZIP passed structural checks; a fresh extracted
copy installed its pinned dependencies and passed bridge/mobile/production-relay
typechecks. The final CI file is an inactive template in `docs/ci/verify.yml`:
the publisher's OAuth scope cannot create GitHub workflows. Private vulnerability
reporting was enabled on the public repository.

## Mac and phone

The source history and old source ZIP were later cleaned with the repository
owner's authorization to replace a saved private Relay hostname in the deployment
example. Only that example changed in the historical source trees; source commit
identities changed. The revised source ZIP SHA-256 is
`5a8afdc61e79cebce8caab53bbac8aacbf3911b9a5386862b204f83454413ccc`.
The Mac ZIP, its checksum and release metadata did not change. This removes the
address from current reachable source and assets, not earlier external copies.

The final Mac was rebuilt with actual-version notices for Node 24.22.2 and
cloudflared 2026.10.7. Its six bundled executables passed signature checks.
Apple submission `c460aaf8-8c49-438c-807f-51dc4e891425` was `Accepted`. Ticket
stapling/validation, strict signature verification and Gatekeeper assessment
passed before the final ZIP was created. The installed application also passed
strict signature and Gatekeeper checks. Only CodeLight was restarted; the
original Codex owner remained running, and no new model test input was sent.

iPhone build `2026110102` and the dedicated simulator Release build succeeded.
The new iPhone package was installed and launched successfully. In the native
simulator preview, the question banner was visible while earlier history was
shown; opening the form, selecting single/multiple choices and enabling the
explicit submit button were verified. The preview was not submitted to a live
session. Production-layout regression covers late question arrival while the
dock details are hidden, single submission and prompt retirement. Physical-phone
confirmation of the originally reported missing prompt remains unverified.
See [the question investigation](phone-question.md) for the conditional cause.

## Verification

- `pnpm typecheck:all` and `pnpm lint` passed.
- 68 scoped native/backend/connector/source tests and 32 phone question tests passed.
- The dependency release gate passed: raw 0 critical, 2 high, 4 moderate and
  1 low findings. The two specific high advisories are the patched image-container
  findings; bounded malformed-input regressions passed. Other reachability and
  deployment limits remain documented in `SECURITY.md`.
- The deployed network Relay passed authenticated synthetic HTTP and WebSocket
  tests, including exact 512 KiB/2 MiB upload hashes and a 64 KiB binary echo.
  One earlier 10-second timeout was not reproduced; its cause is unconfirmed.
- The static image `codelight-website:0.4.0-dc52e46` uses the verified base image.
  Server-side manifest validation, the two-replica rollout and TLS certificate
  readiness passed in the dedicated namespace.
- Public HTTPS metadata matched the verified release. The full downloaded ZIP
  matched the exact byte count and SHA-256 and passed ZIP integrity checks.
  HTTP Range returned 206 and the requested 1,024 bytes. GitHub's uploaded Mac
  asset digest also matched the same SHA-256.
- The live page passed desktop and 390 px phone layout checks without horizontal
  overflow. Language switching, the Relay FAQ and the enabled download link were
  verified. Application assets are local. Cloudflare injected a beacon tag at
  its edge; the delivered `script-src 'self'` / `connect-src 'self'` CSP blocks
  that external script and its endpoint. It was not enabled by application code.

## Local connection limitation

At the installation check, this Mac's system resolver returned `ENOTFOUND` for
new Cloudflare Quick Tunnel hostnames, although a separate public DNS query
resolved them. CodeLight correctly refused to commit an unverified public entry.
No system DNS settings or validation checks were changed. After the user chose
the owned network Relay, the Mac's native Public access form was used to select
Relay and validate its server/access key. Independent HTTP/WebSocket probes
passed, the native UI reported Connection ready, and the actual routed Mac health
endpoint returned 200. Configuration was saved with mode 0600; the existing
account/box keys remained byte-for-byte unchanged. The fresh QR was displayed
for phone reconnection. Physical-phone prompt/reply confirmation remains pending.
This environmental result is not a claim that every Cloudflare installation
fails. Phone thermals and a broader OS/device matrix were not measured.
