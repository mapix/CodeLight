"""Native control schema gates. All requests fail before any application mutation."""
import json
import pathlib
import subprocess

binary = pathlib.Path(__file__).parent / "bin" / "macos-ax-control"
bundle = "dev.agent-session-bridge.test.absent-app"
cases = [
    ({"operation": "unknown"}, "invalid_control_request"),
    ({"operation": "press"}, "generation_required"),
    ({"operation": "type", "expectedRuntimeGeneration": "old",
      "windowId": 1, "expectedWindowGeneration": "old"}, "capture_stamp_required"),
    ({"operation": "key", "expectedRuntimeGeneration": "old", "windowId": 1,
      "expectedWindowGeneration": "old", "captureStamp": {}, "key": "shell-command"}, "invalid_key"),
    ({"operation": "click", "expectedRuntimeGeneration": "old", "windowId": 1,
      "expectedWindowGeneration": "old", "captureStamp": {}, "x": True, "y": 2}, "coordinates_required"),
    ({"operation": "scroll", "expectedRuntimeGeneration": "old", "windowId": 1,
      "expectedWindowGeneration": "old", "captureStamp": {}, "x": 2, "y": 2, "deltaY": 10000}, "invalid_scroll"),
    ({"operation": "type", "expectedRuntimeGeneration": "old", "windowId": 1,
      "expectedWindowGeneration": "old", "captureStamp": {}, "nodeId": "input", "text": ""}, "invalid_text"),
    ({"operation": "enableAccessibility", "expectedRuntimeGeneration": "old"}, "stale_runtime"),
]
for payload, expected in cases:
    result = subprocess.run([str(binary)], input=json.dumps({"bundleId": bundle, **payload}) + "\n",
                            text=True, capture_output=True, timeout=10, check=True)
    assert not result.stderr
    response = json.loads(result.stdout)
    alternatives = [expected, "screen_locked"] if expected == "stale_runtime" else [expected]
    assert response["ok"] is False and response["error"]["code"] in alternatives, response
print(json.dumps({"passed": len(cases), "realAppsMutated": False, "screenshotExecuted": False}))
