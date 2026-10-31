# macOS native read helper

Build with `sh native/build.sh`. The binary is `native/bin/macos-ax-readonly`.
It reads one JSON line from stdin, emits one JSON line to stdout, and exits.
Errors are structured responses with `ok:false`; Node must inspect `ok`, not
only the process exit code. Use a bounded child-process timeout.

Only `probe`, `snapshot`, and `screenshot` exist. No input, activation, AXPress,
navigation, permission request, launch, or target configuration change exists.

## Probe

```json
{"id":"probe-zcode","operation":"probe","bundleId":"dev.zcode.app"}
```

Codex installed at `/Applications/ChatGPT.app` uses `com.openai.codex`.
`includeText` defaults to false. Probe returns the app PID, launch-based
`runtimeGeneration`, and CG windows with `windowId`, `windowGeneration`, and
bounds. AX window geometry is returned only when existing AX permission is
granted. Hidden/onScreen flags are observations; no window is activated.

## Snapshot

Copy both generations and the selected window id from a fresh probe:

```json
{"id":"layout","operation":"snapshot","bundleId":"dev.zcode.app","pid":12345,"windowId":678,"expectedRuntimeGeneration":"COPY_FROM_PROBE","expectedWindowGeneration":"COPY_FROM_PROBE","maxNodes":1500,"maxDepth":18}
```

Response nodes have structural path, role/subrole, AXIdentifier when exposed,
bounds, supported action names, enabled/focused/selected flags and valueSettable.
Action names describe capability; the helper never performs them. Titles,
descriptions, values and placeholders are omitted unless includeText:true.

CGWindowID does not appear as a public AX window attribute. The helper maps
the verified CG window to exactly one AX window with the same position/size.
The logical inventory unions AXWindows, AXMainWindow and AXFocusedWindow. Absent bounds or multiple matching windows fail closed.
It does not use AXWindowNumber, inject JavaScript, or set AXEnhancedUserInterface.
Node IDs and snapshotGeneration cannot verify a session ID. Future actions
need separate session identity verification and fresh state checks.

## Window screenshot

```json
{"id":"capture","operation":"screenshot","bundleId":"dev.zcode.app","pid":12345,"windowId":678,"expectedRuntimeGeneration":"COPY_FROM_PROBE","expectedWindowGeneration":"COPY_FROM_PROBE","outputDirectory":"/absolute/existing/directory"}
```

Requires macOS 14+ and already-granted ScreenCapture permission. The
ScreenCaptureKit desktopIndependentWindow filter selects only that application
window, excludes child windows and cursor, and never captures the whole desktop.
Output PNG has a random file name and mode 0600. No existing file is overwritten.
The request and target generation are verified before and after capture.

## Verification

`python3 native/test-readonly.py` tests validation and an absent synthetic app;
it does not access real conversation contents, perform actions, or capture images.

Current product acceptance is recorded in `CODELIGHT-DELIVERY.md` at the project
root. Historical private probes and screenshots are not shipped. An empty
AXWindows array alone does not prove that an app is stopped or the Mac is locked;
the current helper also checks legitimate AXMainWindow/AXFocusedWindow objects.

## Explicit window controls

User authorization on 2026-10-28 added a separate `native/bin/macos-ax-control`
binary. The read-only binary still has no mutation operations. The control
binary supports probe/mirror plus explicit launch, activate,
enableAccessibility, press, click, type, key, and scroll. Its contract is in
`spec/zcode-window-control.md`; Node integration is
`src/adapters/zcode-ax.mjs` (`ZCodeAxBackend`).

`mirror` requires the same window/runtime fields as screenshot and an existing
outputDirectory. It returns imagePath, controls, localBounds and captureStamp.
Every input action must carry the previously observed captureStamp. Both AX
control structure and a 64x64 grayscale/16-level screenshot layout fingerprint
are rechecked before action. AX control state is sampled before and after the
image read; inconsistent frames fail with stale_read. A control action raises
only the verified window and confirms AXFocusedWindow before input. A non-empty
text input fails with draft_conflict; typing never overwrites a desktop draft
and uses a single standard Cmd+V with a complete in-memory clipboard snapshot and changeCount-guarded restoration. Clipboard representations are never logged or saved.

An OS `performed:true` response does not assert model/session admission. Actual
business acceptance needs the resulting native UI and dedicated test session
evidence. Mac lock state can prevent AX window identity/focus confirmation;
input must fail instead of attempting to unlock or writing to another app.


Current input mechanism is only standard Cmd+V, after exact owner/window/editable focus verification. All pasteboard items and their advertised representations stay in RAM; unreadable/oversized/changing snapshots reject input. Restoration uses the token from clearContents and skips a later user copy. Semantic editable key actions use the same exact focus; typing never implicitly clears a draft or sends it. Native receipts expose clipboardRestoration without content/type data.

Current composer/Stop CAS uses exact target descriptors and the actual composer AX subtree plus header/sidebar context. Fixed bottom percentages included streaming body tail lines and were replaced after real Stop preflight rejection. Coordinate clicks remain strict image/layout CAS; general permission/question actions reject a truncated full context. Protected controls keep their labels/full bounded editor values even when body preview budget is exhausted.

AX-only background observations may be cached after native cancellation/completion. contentFreshness= ax-observation-only and presentationVerified=false make this explicit; normal explicit activation and a fresh capture restore current presentation. Backend windows remain windows, not native session IDs.

2026-10-29 original ZCode window verification: complete two-line Chinese/emoji input without automatic admission, explicit Send and assistant echo, original model cancellation through Stop, recovery and queue admission 2007ms before the previous assistant completed. The sanitized scope is in the root `CODELIGHT-DELIVERY.md`; detailed records remain private. Model tests have ended; ZCode permission/question tools were not triggered.
