# CodeLight development

- This is the standalone CodeLight workspace. The current product is Codex-only. Keep the original Codex desktop as the session/runtime owner; do not launch replacement model runners or modify/restart the original desktop app.
- Other harnesses and window/AX control are deferred research. Preserve their historical sources and tests when unrelated to a change, but do not discover, activate or advertise them through the current CodeLight distribution. Window IDs and screenshots do not count as Codex session support.
- Update the corresponding spec before changing behavior. Preserve unrelated local work.
- Node 24.15.0 and pnpm 10.11.0 are the current toolchain.
- `pnpm typecheck:all` checks bridge, mobile and production relay; `pnpm lint` checks bridge code. Run targeted tests for changed protocol/state behavior and native UI verification for interactions.
- `pnpm build:native` builds Mac helper sources; `pnpm build:mac` packages the embedded relay, bridge, Node and cloudflared into the Mac App. Configure runtime paths as described in README.
- Mobile is in `apps/mobile`, embedded relay in `packages/relay`, shared licensed protocol in `packages/wire`, Mac UI in `apps/mac`, bridge in `src`.
- Never commit secrets, phone credentials, device registries, pairing invitations, private conversations, provisioning profiles, dependency/build directories or private QA evidence.
- Unknown native operations keep their command IDs and are not automatically replayed. Model/effort updates require original-owner confirmation. Worktree controls are deferred to text.
- Project activity is a lightweight foreground projection of original Codex state. Do not infer active/waiting status from message recency, open full conversation histories for status counts, or present stale/unknown data as zero. Keep status synchronization separate from selected-session message loading.
- Current product rules are in `spec/codelight-product.md`; old multi-harness/onboarding/window specs are historical or deferred where marked. Keep user-facing descriptions and localized strings aligned with the Codex-only scope.
