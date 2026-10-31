import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("storage", Path(__file__).parents[1] / "src/storage.py")
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class NativeStorageTests(unittest.TestCase):
    def test_zcode_old_schema_and_upsert_are_read_without_writes(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "cli/db/db.sqlite"
            path.parent.mkdir(parents=True)
            db = sqlite3.connect(path)
            db.executescript('''
                CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_created INT,time_updated INT,time_archived INT);
                CREATE TABLE message(id TEXT,session_id TEXT,time_created INT,time_updated INT,data TEXT,sequence INT);
                CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INT,time_updated INT,data TEXT,sequence INT);
                INSERT INTO session VALUES('ses_one','Test','/test',1,2,NULL);
                INSERT INTO session VALUES('ses_archived','Archived','/test',1,3,3);
                INSERT INTO message VALUES('m1','ses_one',1,1,'{"role":"assistant"}',1);
                INSERT INTO part VALUES('p1','m1','ses_one',1,1,'{"type":"text","text":"first"}',1);
            ''')
            db.commit()
            before = path.read_bytes()
            self.assertEqual(len(storage.lists('zcode', root)), 1)
            self.assertEqual(storage.snapshot('zcode', root, 'ses_one')['messages'][0]['parts'][0]['data']['text'], 'first')
            self.assertEqual(path.read_bytes(), before)
            db.execute('UPDATE part SET data=? WHERE id=?', (json.dumps(dict(type='text',text='updated')), 'p1'))
            db.commit()
            self.assertEqual(storage.snapshot('zcode', root, 'ses_one')['messages'][0]['parts'][0]['data']['text'], 'updated')
            db.close()

    def test_pagination_order_and_missing_session(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "state_5.sqlite"
            db = sqlite3.connect(path)
            db.executescript('''CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,created_at INT,updated_at INT,archived INT,model_provider TEXT,history_mode TEXT,rollout_path TEXT);
                INSERT INTO threads VALUES('one','One','/test',1,1,0,'test','legacy','/test');
                INSERT INTO threads VALUES('two','Two','/test',1,2,0,'test','legacy','/test');''')
            db.commit()
            self.assertEqual(storage.lists('codex', root, 1)[0]['id'], 'two')
            self.assertEqual(storage.lists('codex', root, 1, 1)[0]['id'], 'one')
            with self.assertRaises(ValueError): storage.snapshot('codex', root, 'missing')
            db.close()


if __name__ == '__main__': unittest.main()
