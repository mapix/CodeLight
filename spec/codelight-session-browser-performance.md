# CodeLight project browser performance and hierarchy safety

## Existing API and state ownership

`buildCodeLightBrowserRows(sessions, query, projects, parents)` remains a pure
projection of the session catalog. The catalog owns session identity and parent
facts; this projection does not navigate, read history, update sessions or infer
runtime activity. The existing project/session row fields remain unchanged.

## Codex-only viewer boundary

`isCodeLightCodexSession(session)` is the shared field-only viewer predicate.
Only records whose `metadata.bridge.source.app` is `codex` are candidates.
`controlMode: 'session'` and legacy records with no `controlMode` are accepted;
explicit window mode or an unknown mode is excluded. Missing/unverified source
identity and other harness records are excluded even when their flavor/title
mentions Codex. A Codex conversation in a project named ZCode remains visible.

The browser applies this predicate before search or grouping; the phone total
uses the same predicate. Cached/database records are retained and metadata is
never changed by the predicate. Owner availability and activity are separate
facts: a verified Codex session may remain in the catalog while offline.

`codeLightProjectKey(session)` exposes the existing complete project-row key:
`project:${JSON.stringify([machineId, source.hostId, source.app])}:${projectKey || path || '/'}`.
It is shared with project status consumers. Native project identity continues to
fold the main checkout, worktrees and nested directories together; equal paths
on different machines, hosts or source apps remain isolated.

## Projection rules

- A project is ordered by the greatest original native recency among its matched
  sessions. Compute this maximum during grouping, without spreading a whole
  group into `Math.max` or rescanning members in the project comparator.
- Cache the original recency and visible/search title per matched session during
  one projection. Build hierarchy indices only for expanded projects or search
  results; a folded project does not build or sort its child lists.
- Resolve native parent IDs within the same project and source scope. A native
  ID duplicated in another project cannot steal a child's parent. Missing or
  ambiguous native IDs do not establish a parent link.
- Ordinary roots keep the existing pinned-first, recency-descending order.
  Children keep the existing recency-descending order. Stable input order breaks
  ties; the source catalog is not mutated by sorting.
- Hierarchy traversal uses an explicit stack, so a deep but valid parent chain
  cannot overflow the JavaScript call stack.
- If malformed parent facts form a cycle, sever one display edge at the smallest
  stable relay ID in that cycle. This creates a deterministic visible root while
  preserving every session and normal fold behavior. Self-parent facts become a
  root. The underlying parent facts remain unchanged.
- Search exposes matching child sessions even when project/parent folds are
  closed, with the same search fields and case normalization as before.

## Regression evidence

Targeted tests cover normal ordering and folds, canonical cross-worktree parents,
machine/host/source isolation, repeated native IDs in different projects,
ambiguous/missing native identities, self/cyclic parents, a deep chain and a
minimal large folded catalog exceeding normal JavaScript argument limits.
They also cover foreign/window/missing-source caches, the legacy Codex mode
fallback and retention of the input records.

Synthetic work-count assertions verify that recency is read once per matched
session instead of once per sort comparison. They establish algorithm behavior,
not physical-phone frame rate, battery consumption or temperature.
