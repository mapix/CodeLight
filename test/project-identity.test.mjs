import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodeLightProjects } from '../src/happy/project-identity.mjs';
test('main checkout, worktree and subdirectory share a project without rewriting cwd', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), worktree = join(root, 'worktree');
  await mkdir(join(repo, '.git/worktrees/worker'), { recursive: true }); await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(worktree);
  await writeFile(join(worktree, '.git'), `gitdir: ${repo}/.git/worktrees/worker\n`); await writeFile(join(repo, '.git/worktrees/worker/commondir'), '../..\n');
  const result = await resolveCodeLightProjects([{ id: 'main', workspace: repo }, { id: 'subdir', workspace: join(repo, 'src') }, { id: 'worker', workspace: worktree }], root);
  assert.equal(new Set(result.map(r => r.project.key)).size, 1); assert.equal(result[2].workspace, worktree); assert.equal(result[2].project.path, await realpath(repo));
});
test('explicit assignments, child agents and removed managed worktrees use the original project root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-assignment-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workspaces/app'); await mkdir(path, { recursive: true });
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { id: 'p', name: 'Original project', rootPaths: [path] }, legacy: { id: 'legacy', rootPaths: [path] } },
    'thread-project-assignments': { parent: { projectKind: 'local', projectId: 'p' } } }));
  const result = await resolveCodeLightProjects([{ id: 'parent', workspace: join(root, 'worktrees/deleted/app') }, { id: 'child', parentId: 'parent', workspace: join(root, 'worktrees/other/app/src') },
    { id: 'unassigned', workspace: join(root, 'worktrees/gone/app') }], root);
  assert.equal(new Set(result.map(r => r.project.key)).size, 1); assert.equal(result[0].project.path, await realpath(path));
});
test('same-name independent projects and ambiguous worktree aliases remain distinct', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-distinct-')); t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a/app'), b = join(root, 'b/app'); await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { a: { id: 'a', rootPaths: [a] }, b: { id: 'b', rootPaths: [b] } } }));
  const result = await resolveCodeLightProjects([{ id: 'a', workspace: a }, { id: 'b', workspace: b }, { id: 'unknown', workspace: join(root, 'worktrees/gone/app') }], root);
  assert.equal(new Set(result.map(r => r.project.key)).size, 3);
});
