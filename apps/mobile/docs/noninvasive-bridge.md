# Non-invasive desktop source seam

This fork retains Happy's native SessionView, FlatSessionRow, AgentInput,
Markdown/tool/file rendering, navigation, themes, pairing and E2EE transport.
The connector attaches an existing desktop owner; it never starts a Happy
model runner or resumes history into a second writer.

## Encrypted metadata

`client.id = noninvasive-bridge`, `rigMetadataVersion = 1` selects the shipped
capability-driven UI behavior, while `client.name` reports the real desktop
client. The connector is not identified as a Rig runner. Required capabilities
are fully explicit. Unsupported models, reasoning, permissions, shell, files,
resume and spawn remain unavailable. An optional `bridge` version 1 object
carries `source { app, id, hostId, runtimeGeneration, windowGeneration }`,
`currentTurnId`, `controlMode`, and `sourceStatus`. Happy's record id remains
different from the original session/window identity.

## Native admission and RPC

Encrypted user messages retain Happy's stable `localId`; the connector maps
it to one native command id and persists unknown outcomes before dispatch.
`user-message-accepted` is emitted only after original admission, not after
Happy server storage. Its `ref` identifies the original Happy server message.
Retries/reconnects may restore encrypted logs; they never blindly replay
native side effects.

- `abort`: non-invasive sources carry `{ commandId, turnId }` from the current
  original foreground turn. No current turn means no supported abort.
- `permission`: existing `{ id, approved, ... }` response, with connector
  binding to the exact original native request. Never widen requested grants.
- `communication`: existing `{ id, kind, status, answers }`, joined to the
  published original question identity. Duplicate replies cannot admit twice.
- File/image refs use Happy's authenticated encrypted attachment store; no
  arbitrary native path endpoint. Attachment send capability is false until
  original admission for that media has been verified.

Model/permission selection and runner-backed resume/fork are not allowed for
non-invasive sources. Unsupported RPC is rejected by the connector as well.
The shipped original client flows continue unchanged for other Happy sources.

## Local native development

Only command-scoped `HAPPY_NONINVASIVE_LOCAL=1`, APP_ENV=development selects a
separate native bundle identifier and disables OTA. Use the existing debug
harness on an explicit loopback Happy self-host server and isolated test
credentials. Do not use public Happy accounts, modify existing configuration,
invoke EAS/OTA/store release commands, or use the model-running CLI path.

The release skill was read. This task is explicitly authorized local fork
simulator development; its EAS/OTA/store publishing paths do not apply here.

RPC replies use `{receipt:{id,status,result?,error?}}`. The phone persists the
command identity and payload digest before dispatch. `bridge-receipt` queries
the same Happy session/native scope by that original commandId. An unknown
result stays pending: the next gesture queries first and never silently
replays it under a new id. No question answer or permission payload is saved
as plaintext in this journal. Model mode metadata is omitted entirely for
non-invasive sends; busy input advertises steering, not Happy runner queues.

The original FileView thumbnail now opens a native Happy Modal image preview,
with pinch/pan, explicit zoom/reset/close and loading/error/retry states. This
is a fork addition, not a claim that upstream shipped full-screen preview.
Authenticated decrypt/cache keys include server, current account and source;
switching source hides the old image in the same render. Uploaded bytes and
preview success are never asserted as original model image admission.
