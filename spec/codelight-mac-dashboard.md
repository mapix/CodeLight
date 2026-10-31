# Mac connection dashboard

After a device has paired, the Mac App defaults to a statistics dashboard. The
QR screen remains reachable through a visible switch; renewing an invitation
does not replace the dashboard or regenerate QR artwork while it is hidden.
Before the first pairing the QR screen is the default onboarding view.

The dashboard shows current gateway throughput, connection-session byte totals,
persisted cumulative gateway byte totals, request/RPC interaction counts and
connected devices. Metrics count bytes crossing the owned HTTP/WebSocket gateway;
they do not claim ISP/TLS/IP overhead or model token usage. No request bodies,
credentials, conversation text or device secrets are retained by metrics.

One sampler publishes small numeric snapshots at most once per second. Durable
cumulative totals are coalesced, not written on every chunk; shutdown flushes the
owned counter file. Live throughput uses monotonic elapsed time. Connection
closure and concurrent sockets must not double-count bytes.

The UI and current docs clearly remind users: only desktop Codex connected through
gateway mode is supported. This wording must not imply support for other harnesses
or arbitrary desktop connection modes.

The Mac controller owns the selected statistics/pairing panel. Before pairing it
defaults to pairing; the first non-revoked saved or newly paired device selects
statistics unless the user already selected a panel. Later ready messages, device
updates and invitation renewals preserve that selection. The numeric metrics
store is observed separately from the device list. Missing, invalid or unsupported
metrics display an unmeasured placeholder; rates use bytes per second and byte
totals use binary units. Closing a service makes live rates unavailable.
If cumulative storage cannot be read or validated, the volatile sampler still
measures this connection, but emits null cumulative totals and never overwrites
the existing counter file. The UI displays those totals as unmeasured.

QR artwork is cached by the complete pairing URL. Rendering is requested only
while the pairing panel is visible; an unchanged URL reuses the image and Core
Image context. Metrics samples never regenerate the QR image.

Verify the post-pair default view, QR/statistics switching, persistent cumulative
totals, real HTTP and WebSocket byte counts, interaction counters, sampling/write
budgets and clean shutdown. Original Codex applications and runtimes remain owned
by their existing processes.
