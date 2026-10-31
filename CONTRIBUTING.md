# Contributing

CodeLight currently supports existing desktop Codex sessions connected through
gateway mode. Other harnesses and window control are deferred. Read `AGENTS.md`,
`spec/codelight-product.md` and the relevant protocol spec before changing behavior.

## Setup

```sh
git clone https://github.com/mapix/CodeLight.git
cd CodeLight
pnpm install --frozen-lockfile
pnpm typecheck:all
pnpm lint
```

Use Node 24.15.0 or a compatible Node 24 LTS patch and pnpm 10.11.0. Native phone
development additionally needs Xcode, CocoaPods and your own signing team.
See [build and verification](docs/BUILD-AND-VERIFY.md).

## Changes and verification

- Update the matching spec first. Identify state ownership, ordering, idempotency,
  foreground/background behavior and the affected native interface.
- Preserve original Codex ownership, host/source identity, lease and unknown
  operation outcomes. Do not validate by sending model prompts to an existing
  personal conversation. Use synthetic tests and an explicitly authorized test
  session when live write acceptance is needed.
- Add scoped regressions for changed protocol/state behavior. For UI changes,
  verify a native or browser view appropriate to the surface, including narrow
  layouts, keyboard access and language switching.
- Run `pnpm typecheck:all`, `pnpm lint` and the relevant tests. Tests use package
  entry points; phone tests run with `pnpm --filter @codelight/mobile exec vitest run <files>`.
- Keep changes focused. Explain the trigger, evidence, owner and fix mechanism
  in the pull request, along with actual results and unverified limits.

Never commit credentials, QR invitations, device information, private chat
content, Apple profiles, generated dependencies or private acceptance artifacts.
Use [private security reporting](SECURITY.md) for vulnerabilities.

## Licensing

New contributions use MIT, consistent with the repository license. Preserve
upstream copyright and license notices; do not redistribute installed Codex
application code or private extracted research artifacts.
