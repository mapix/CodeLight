import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';

/** @typedef {Record<string,any>} Value */
try {
  // 独立包原先丢失 Python 脚本导致会话列表为空；内置 SQLite 只读连接不写原数据库，也不启动任何会话。
  const db = new DatabaseSync(join(workerData.root, 'state_5.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const fields = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
    const title = fields.has('name') ? "COALESCE(NULLIF(name,''),title)" : 'title';
    const optional = ['first_user_message', 'agent_nickname', 'agent_path', 'source', 'recency_at_ms', 'updated_at_ms', 'is_pinned', 'attached_thread_parent_id'].filter(field => fields.has(field));
    const statement = db.prepare(`SELECT id,${title} AS title,cwd,created_at,updated_at,model_provider${optional.length ? ',' + optional.join(',') : ''} FROM threads WHERE archived=0 ORDER BY updated_at DESC,id DESC LIMIT 200 OFFSET ?`);
    /** @type {Value[]} */ const result = []; let offset = Math.min(Math.max(Number(workerData.offset) || 0, 0), 100000);
    while (true) {
      const rows = statement.all(offset);
      for (const row of /** @type {Value[]} */ (rows)) {
        let source = /** @type {Value} */ ({}); try { source = JSON.parse(row.source || '{}'); } catch { /* older plain source labels */ }
        const parentId = row.attached_thread_parent_id || source.subagent?.thread_spawn?.parent_thread_id || null;
        const agentName = row.agent_nickname || source.subagent?.thread_spawn?.agent_nickname || '';
        const role = row.agent_path?.split('/').at(-1) || source.subagent?.thread_spawn?.agent_path?.split('/').at(-1) || '';
        const preview = String(row.first_user_message || '').replace(/\s+/gu, ' ').slice(0, 160);
        const name = String(row.title || '').trim() || [agentName, role].filter(Boolean).join(' · ') || preview.slice(0, 80) || row.id.slice(0, 8);
        result.push({ app: 'codex', id: row.id, title: name, workspace: row.cwd, createdAt: row.created_at * 1000,
          updatedAt: row.recency_at_ms || row.updated_at_ms || row.updated_at * 1000, provider: row.model_provider, parentId, agentName, preview, isPinned: row.is_pinned === 1 });
      }
      if (rows.length < 200) break; offset += rows.length;
    }
    parentPort?.postMessage({ ok: true, rows: result });
  } finally { db.close(); }
} catch { parentPort?.postMessage({ ok: false }); }
