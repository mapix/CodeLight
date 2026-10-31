import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
/** @typedef {Record<string,any>} Value */
/** Resolve presentation identity using readonly desktop metadata and Git files; never alter the original cwd.
 * @param {Value[]} rows @param {string} codexRoot */
export async function resolveCodeLightProjects(rows, codexRoot) {
  let saved = /** @type {Value} */ ({});
  try { saved = JSON.parse(await readFile(join(codexRoot, '.codex-global-state.json'), 'utf8')); } catch { /* Older desktops still resolve Git roots. */ }
  const pathCache = /** @type {Map<string,Promise<string>>} */ (new Map());
  /** @param {string} path */
  const canonical = path => {
    const normal = resolve(path); if (!pathCache.has(normal)) pathCache.set(normal, realpath(normal).catch(() => normal));
    return /** @type {Promise<string>} */ (pathCache.get(normal));
  };
  /** @type {Map<string,Value>} */ const projects = new Map(), roots = new Map();
  const localProjects = Object.values(saved['local-projects'] ?? {}).filter(p => p && typeof p === 'object');
  for (const raw of /** @type {Value[]} */ (localProjects)) {
    const paths = Array.isArray(raw.rootPaths) ? raw.rootPaths.filter((/** @type {unknown} */ p) => typeof p === 'string' && isAbsolute(p)) : [];
    if (!paths.length || typeof raw.id !== 'string') continue;
    const path = await canonical(paths[0]);
    const descriptor = { key: createHash('sha256').update(JSON.stringify(['local', path])).digest('hex'), path, label: raw.name || basename(path) };
    projects.set(raw.id, descriptor);
    for (const alias of paths) roots.set(await canonical(alias), descriptor);
  }
  for (const path of saved['electron-saved-workspace-roots'] ?? []) if (typeof path === 'string' && isAbsolute(path)) {
    const root = await canonical(path);
    if (!roots.has(root)) roots.set(root, { key: createHash('sha256').update(JSON.stringify(['local', root])).digest('hex'), path: root,
      label: saved['electron-workspace-root-labels']?.[path] || basename(root) });
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  /** @param {Value} row */
  const assigned = row => {
    const visited = new Set(); let id = row.id;
    while (id && !visited.has(id)) {
      visited.add(id); const assignment = saved['thread-project-assignments']?.[id];
      if (assignment?.projectKind === 'local' && projects.has(assignment.projectId)) return projects.get(assignment.projectId);
      id = byId.get(id)?.parentId;
    }
    return null;
  };
  const gitCache = /** @type {Map<string,Promise<string|null>>} */ (new Map());
  /** @param {string} directory @returns {Promise<string|null>} */
  const gitRoot = directory => {
    const path = resolve(directory);
    if (gitCache.has(path)) return /** @type {Promise<string|null>} */ (gitCache.get(path));
    const lookup = (async () => {
      const git = join(path, '.git');
      try {
        const info = await stat(git); let common = git;
        if (info.isFile()) {
          const match = (await readFile(git, 'utf8')).trim().match(/^gitdir:\s*(.+)$/u);
          if (!match) return null;
          const target = resolve(path, match[1]); common = target;
          try { common = resolve(target, (await readFile(join(target, 'commondir'), 'utf8')).trim()); } catch { /* A normal gitdir file has no commondir. */ }
        }
        // Worktree Git metadata names the main checkout; a standalone submodule stays its own workspace.
        return await canonical(basename(common) === '.git' ? dirname(common) : path);
      } catch { const parent = dirname(path); return parent === path ? null : gitRoot(parent); }
    })();
    gitCache.set(path, lookup); return lookup;
  };
  const aliases = new Map();
  for (const [root, project] of roots) {
    const name = basename(root); let candidates = aliases.get(name); if (!candidates) { candidates = new Map(); aliases.set(name, candidates); } candidates.set(project.key, project);
  }
  const orderedRoots = [...roots].sort((a, b) => b[0].length - a[0].length);
  /** @param {string} path */
  const rootMatch = path => orderedRoots.find(([root]) => path === root || path.startsWith(root + '/'))?.[1];
  /** @param {string} path */
  const descriptorForPath = path => rootMatch(path) ?? { key: createHash('sha256').update(JSON.stringify(['local', path])).digest('hex'), path, label: basename(path) || path };
  const managedRoot = resolve(codexRoot, 'worktrees');
  return Promise.all(rows.map(async row => {
    if (!row.workspace || !isAbsolute(row.workspace)) return row;
    let project = assigned(row); const cwd = await canonical(row.workspace);
    if (!project) {
      const git = await gitRoot(cwd); if (git) project = descriptorForPath(git);
    }
    if (!project) project = rootMatch(cwd);
    if (!project) {
      // 清理过的 Codex worktree 已无 .git；只在桌面项目根唯一匹配时恢复归属，同名独立仓库不会被合并。
      const rel = relative(managedRoot, resolve(row.workspace)), parts = rel.split('/');
      if (!rel.startsWith('..') && !isAbsolute(rel) && parts.length >= 2) {
        const candidates = aliases.get(parts[1]); if (candidates?.size === 1) project = [...candidates.values()][0];
      }
    }
    return { ...row, project: project ?? descriptorForPath(cwd) };
  }));
}
