import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BundledCodexStorage } from '../src/happy/bundled-codex-storage.mjs';

test('bundled index worker returns current title/path and excludes archives without changing the original DB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-index-'));
  try {
    const file = join(root, 'state_5.sqlite'), db = new DatabaseSync(file);
    db.exec("CREATE TABLE threads(id TEXT, name TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, model_provider TEXT, archived INTEGER); INSERT INTO threads VALUES ('fixture-id','Current title','Old title','/fixture',1,2,'fixture',0),('archive','','Archive','/fixture',1,3,'fixture',1)"); db.close();
    const before = await readFile(file), storage = new BundledCodexStorage({ codex: root });
    const rows = await storage.list('codex'); assert.equal(rows.length, 1); assert.equal(rows[0].title, 'Current title'); assert.equal(rows[0].workspace, '/fixture');
    assert.deepEqual(await readFile(file), before); assert.deepEqual(await storage.list('codex', 1), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
