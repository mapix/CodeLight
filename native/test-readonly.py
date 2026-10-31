"""Validation smoke tests. No actions, screenshots or user conversation reads."""
import json
import pathlib
import subprocess

BINARY = pathlib.Path(__file__).parent / "bin" / "macos-ax-readonly"
ABSENT_APP = "dev.agent-session-bridge.test.absent-app"


def request(data):
    result = subprocess.run(
        [str(BINARY)], input=json.dumps(data) + "\n", text=True,
        capture_output=True, timeout=10, check=True,
    )
    assert not result.stderr, "Helper must not log native/user content."
    lines = result.stdout.splitlines()
    assert len(lines) == 1, "Exactly one JSON response is required."
    return json.loads(lines[0])


cases = [
    ({"operation": "press"}, "unsupported_operation"),
    ({"operation": "send"}, "unsupported_operation"),
    ({"operation": "probe", "extra": "invalid"}, "invalid_request"),
    ({"operation": "probe", "pid": True}, "invalid_request"),
    ({"operation": "probe", "pid": 0}, "invalid_request"),
    ({"operation": "probe", "maxNodes": 5001}, "invalid_request"),
    ({"operation": "probe", "maxDepth": -1}, "invalid_request"),
    ({"operation": "probe", "includeText": "yes"}, "invalid_request"),
    ({"operation": "snapshot", "windowId": 1}, "generation_required"),
    ({"operation": "screenshot", "windowId": 1,
      "expectedRuntimeGeneration": "a", "expectedWindowGeneration": "b"}, "invalid_request"),
]
for data, expected in cases:
    response = request({"id": "validation-test", "bundleId": ABSENT_APP, **data})
    assert response["ok"] is False and response["readOnly"] is True
    assert response["error"]["code"] == expected, response
    assert response["id"] == "validation-test"

response = request({"id": "absent-probe", "operation": "probe", "bundleId": ABSENT_APP})
assert response["ok"] and response["result"]["readOnly"]
assert response["result"]["running"] is False and response["result"]["windows"] == []
source = (BINARY.parent.parent / "MacOSAXReadOnly.swift").read_text()
for forbidden in ["AXUIElementPerformAction(", "AXUIElementSetAttributeValue(", "CGEventPost(", ".activate("]:
    assert forbidden not in source, "A mutation API was introduced."
print(json.dumps({"passed": len(cases) + 2, "realAppsAccessed": False,
                  "screenshotExecuted": False, "actionsImplemented": False}))
