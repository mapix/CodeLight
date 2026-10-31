# Current-turn question prompts

## Cause and rule

The phone's bottom banner previously included every unanswered asynchronous
question in loaded native history. Four questions from completed older turns
therefore remained pending after more recent questions were answered on Mac.
The recent answers were already recognized correctly.

The accepted rule is to prompt only for unanswered questions from the current
foreground turn, or the latest loaded turn when idle. Older questions retain
their actual answer evidence in native history. A newer empty turn retires the
previous prompts, and answering the latest question cannot reopen an older one.
Native blocking requests keep their existing lifecycle.

The connector and native dispatch use the same scope predicate. A fresh reply
to a retired question is rejected before native dispatch; existing command and
receipt identities retain their recorded outcomes.

## Verification

- 56 targeted native backend, connector and question-scope tests passed.
- `pnpm typecheck:all` and `pnpm lint` passed.
- The Mac build succeeded. The installed app passed deep strict signature
  verification; its service bundle matches the candidate containing this fix.
- The running relay reports a connected source and zero pending communications
  for the affected conversation, down from four before the change.
- A fresh read-only native snapshot also reports zero current pending questions
  and preserves four older unanswered questions. No model test input was sent.
- The public tunnel health check passed. Its temporary address changed when
  CodeLight restarted; the phone must scan the new Mac QR to reconnect.
- This fix is in the Mac bridge; iPhone build 2026103108 requires no reinstall.
- The user confirmed on the physical phone that the old questions disappeared
  after reconnection. The bottom-banner removal is accepted by user observation.

## Acceptance limits

No physical-phone screenshot was obtained. ScreenCaptureKit and the available
iOS screenshot/automation services failed. UI removal after reconnection was
confirmed by the user; data projection and live relay state were verified by the
agent. No automated screenshot verification is claimed.

The original Codex process from the earlier checkpoint is no longer running.
The resumed run sees a Codex process started before its first tool call, so
uninterrupted Codex process continuity across that checkpoint is not certified.
The other recorded application PIDs still match. The resumed deployment started
only CodeLight and issued no original-owner restart, stop or answer command.

Private conversation, device and credential evidence remains outside Git and
source exports.
