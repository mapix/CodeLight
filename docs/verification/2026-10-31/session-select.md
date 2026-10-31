# Native project session select

The native project conversation header now uses a single select box with the
current conversation title and down arrow. The platform picker displays all
conversation titles with a current-selection mark, while the closed control
truncates long titles to one line within a 44-point row.

The existing project checkout grouping, conversation ordering, pending-chat
handover and in-place route selection remain the state owners. Re-selecting the
current conversation does not navigate or discard its composer. Opening the
picker does not send native Agent commands or fetch history. The web retains
its existing tabs; native header actions and the new-chat button remain.

## Regression checks

- 27 targeted component/native-menu/pending-handover tests passed.
- A 150-conversation fixture verifies the full list and the exact selected ID;
  selection of the last conversation reaches the existing route callback.
- Current conversation re-selection and pending-to-real identity handover keep
  their route. The web still renders its tab strip.
- Bridge/mobile/production-relay typechecks and root Lint passed.

## Native acceptance

The current-source simulator Release build passed. Native UI opened the menu,
scrolled to conversation 150 and selected its exact fixture ID; the long closed
title stayed within one row. Final current-source iPhone build 2026103110 was
installed and launched, with inventory confirmation. The updated simulator
preview visibly includes individual active/waiting/idle/unconfirmed badges.
The preview uses 150 synthetic conversations without attaching to a real Agent.
See [codex-activity.md](codex-activity.md) for complete evidence and limits.
