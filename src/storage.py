"""Read-only, bounded native session readers. No target files are written."""
import argparse
import json
import sqlite3
from pathlib import Path


def connect(path):
    path = Path(path).resolve()
    if not path.is_file():
        raise FileNotFoundError("session-store-unavailable")
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    return db


def columns(db, table):
    if table not in {"threads", "session", "message", "part", "thread_items", "thread_realtime_items", "thread_turns", "turn_usage"}:
        raise ValueError("invalid-table")
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})")}


def decode(value):
    try:
        return json.loads(value or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}


def lists(app, root, limit=100, offset=0):
    limit = min(max(int(limit), 1), 200)
    offset = min(max(int(offset), 0), 100000)
    path = Path(root) / ("state_5.sqlite" if app == "codex" else "cli/db/db.sqlite")
    with connect(path) as db:
        if app == "codex":
            fields = columns(db, "threads")
            name = "COALESCE(NULLIF(name,''),title)" if "name" in fields else "title"
            rows = db.execute(f"SELECT id,{name} AS title,cwd,created_at,updated_at,model_provider FROM threads WHERE archived=0 ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
            return [dict(app=app, id=r["id"], title=r["title"], workspace=r["cwd"], createdAt=r["created_at"] * 1000, updatedAt=r["updated_at"] * 1000, provider=r["model_provider"]) for r in rows]
        fields = columns(db, "session")
        guards = ["time_archived IS NULL"]
        if "time_deleted" in fields:
            guards.append("time_deleted IS NULL")
        rows = db.execute("SELECT id,title,directory,time_created,time_updated FROM session WHERE " + " AND ".join(guards) + " ORDER BY time_updated DESC,id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        return [dict(app=app, id=r["id"], title=r["title"], workspace=r["directory"], createdAt=r["time_created"], updatedAt=r["time_updated"]) for r in rows]


def snapshot(app, root, session_id, limit=200, before=None):
    limit = min(max(int(limit), 1), 500)
    path = Path(root) / ("state_5.sqlite" if app == "codex" else "cli/db/db.sqlite")
    with connect(path) as db:
        if app == "codex":
            meta = db.execute("SELECT id,title,cwd,history_mode,rollout_path FROM threads WHERE id=?", (session_id,)).fetchone()
            if meta is None:
                raise ValueError("session-not-found")
            metadata = dict(id=meta["id"], title=meta["title"], workspace=meta["cwd"], historyMode=meta["history_mode"])
        else:
            meta = db.execute("SELECT id,title,directory FROM session WHERE id=?", (session_id,)).fetchone()
            if meta is None:
                raise ValueError("session-not-found")
            metadata = dict(id=meta["id"], title=meta["title"], workspace=meta["directory"])
            # Re-read mutable parts: streaming/native updates may overwrite the same ID.
            if before:
                rows = db.execute("SELECT * FROM message WHERE session_id=? AND COALESCE(sequence,0)<? ORDER BY COALESCE(sequence,0) DESC,time_created DESC,id DESC LIMIT ?", (session_id, int(before), limit)).fetchall()
            else:
                rows = db.execute("SELECT * FROM message WHERE session_id=? ORDER BY COALESCE(sequence,0) DESC,time_created DESC,id DESC LIMIT ?", (session_id, limit)).fetchall()
            messages = []
            for r in reversed(rows):
                parts = db.execute("SELECT id,data,time_updated FROM part WHERE session_id=? AND message_id=? ORDER BY COALESCE(sequence,0),time_created,id", (session_id, r["id"])).fetchall()
                messages.append(dict(id=r["id"], sequence=r["sequence"], data=decode(r["data"]), parts=[dict(id=p["id"], data=decode(p["data"]), updatedAt=p["time_updated"]) for p in parts]))
            usage = db.execute("SELECT turn_id,status,started_at,completed_at FROM turn_usage WHERE session_id=? ORDER BY started_at DESC LIMIT 1", (session_id,)).fetchone() if columns(db, "turn_usage") else None
            return dict(app=app, session=metadata, messages=messages, nativeStatus=dict(usage) if usage else None, source="persisted", live=False, hasMore=len(rows) == limit, before=rows[-1]["sequence"] if rows else None)

    # Independent read transaction in the native paginated history store.
    history = Path(root) / "thread_history_1.sqlite"
    if history.is_file() and metadata["historyMode"] == "paginated":
        with connect(history) as db:
            rows = db.execute("SELECT item_id,turn_id,item_json,rollout_ordinal FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT ?", (session_id, limit)).fetchall()
            items = [dict(id=r["item_id"], turnId=r["turn_id"], data=decode(r["item_json"]), ordinal=r["rollout_ordinal"]) for r in reversed(rows)]
            if columns(db, "thread_realtime_items"):
                live_rows = db.execute("SELECT item_id,item_json,rollout_ordinal FROM thread_realtime_items WHERE thread_id=? ORDER BY rollout_ordinal", (session_id,)).fetchall()
                seen = {item["id"]: i for i, item in enumerate(items)}
                for row in live_rows:
                    item = dict(id=row["item_id"], data=decode(row["item_json"]), ordinal=row["rollout_ordinal"])
                    if item["id"] in seen:
                        items[seen[item["id"]]] = item
                    else:
                        items.append(item)
            turn = db.execute("SELECT turn_id,status,started_at,completed_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1", (session_id,)).fetchone()
            return dict(app=app, session=metadata, items=items, nativeStatus=dict(turn) if turn else None, source="persisted", live=False, hasMore=len(rows) == limit)
    # Legacy logs are append-only. Bound the read, ignore an incomplete final line.
    rollout = Path(meta["rollout_path"]).resolve()
    allowed = Path(root).resolve()
    if not rollout.is_relative_to(allowed):
        raise ValueError("rollout-outside-store")
    with rollout.open("rb") as stream:
        size = rollout.stat().st_size
        start = max(0, size - 2 * 1024 * 1024)
        stream.seek(start)
        blob = stream.read(2 * 1024 * 1024)
    lines = blob.split(b"\n")
    if start:
        lines = lines[1:]
    items = []
    for line in lines[:-1]:
        event = decode(line)
        if event.get("type") == "response_item":
            items.append(dict(data=event.get("payload", {}), timestamp=event.get("timestamp")))
    return dict(app=app, session=metadata, items=items[-limit:], source="persisted", live=False, hasMore=start > 0 or len(items) > limit)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["list", "snapshot"])
    parser.add_argument("--app", choices=["codex", "zcode"], required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--id")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    try:
        result = lists(args.app, args.root, args.limit, args.offset) if args.action == "list" else snapshot(args.app, args.root, args.id, args.limit)
        print(json.dumps(dict(ok=True, result=result), ensure_ascii=False))
    except (sqlite3.Error, OSError, ValueError) as error:
        code = str(error) if str(error) in {"session-not-found", "rollout-outside-store"} else "session-store-unavailable"
        print(json.dumps(dict(ok=False, error=code)))


if __name__ == "__main__":
    main()
