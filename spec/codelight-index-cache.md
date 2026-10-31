# Read-only index work budget

Unchanged Codex DB/WAL and desktop project metadata must reuse the completed
catalog rather than spawn another worker and repeat Git/project path resolution.
The cache key includes the caller offset and high-resolution file signatures.
Git-only presentation changes get a bounded sixty-second refresh. Failures do not
publish an empty catalog or advance a cache entry. Concurrent identical reads
share one flight; consumers receive independent rows. Cache entries are bounded.

This optimization does not cache live runtime status and never writes the original
Codex database. Activity remains on its native owner stream.
