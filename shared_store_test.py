import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from shared_store import StrategyStore, Conflict


class SharedStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent.parent)
        self.path = Path(self.temp.name) / 'library.sqlite3'
        self.store = StrategyStore(database_url='', sqlite_path=self.path)
        self.initial = self.store.read()

    def tearDown(self):
        self.temp.cleanup()

    def ranking(self, category, civ):
        return {'path': ['versions', 'shared-v1', 'categories', category, 'civs'], 'before': [], 'value': [civ]}

    def test_fresh_process_reads_saved_strategy(self):
        self.store.update([self.ranking('flank', 'Britons')])
        script = 'import json,sys;from shared_store import StrategyStore;print(json.dumps(StrategyStore(database_url="",sqlite_path=sys.argv[1]).read()))'
        result = json.loads(subprocess.check_output([sys.executable, '-c', script, str(self.path)], cwd=Path(__file__).parent, text=True))
        self.assertEqual(result['strategy']['versions'][0]['categories'][0]['civs'], ['Britons'])

    def test_disjoint_concurrent_edits_merge(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda p: self.store.update([p]), [self.ranking('flank', 'Britons'), self.ranking('halbso', 'Celts')]))
        categories = self.store.read()['strategy']['versions'][0]['categories']
        self.assertEqual(categories[0]['civs'], ['Britons'])
        self.assertEqual(categories[1]['civs'], ['Celts'])
        self.assertEqual({r['revision'] for r in results}, {2, 3})

    def test_same_ranking_conflict_is_atomic(self):
        self.store.update([self.ranking('flank', 'Britons')])
        with self.assertRaises(Conflict):
            self.store.update([self.ranking('halbso', 'Celts'), self.ranking('flank', 'Mayans')])
        self.assertEqual(self.store.read()['strategy']['versions'][0]['categories'][1]['civs'], [])
        self.assertEqual(len(self.store.history()), 2)

    def test_retry_is_idempotent(self):
        change = self.ranking('flank', 'Britons')
        first = self.store.update([change])
        self.assertEqual(self.store.update([change])['revision'], first['revision'])

    def test_locked_rankings_cannot_be_changed(self):
        self.store.update([{'path': ['versions', 'shared-v1', 'locked'], 'before': False, 'value': True}])
        with self.assertRaises(ValueError):
            self.store.update([self.ranking('flank', 'Britons')])

    def test_versions_add_independently_and_keep_history(self):
        version = copy.deepcopy(self.initial['strategy']['versions'][0])
        version['id'] = 'v2'
        self.store.update([{'path': ['versions', 'v2'], 'before': None, 'value': version}])
        self.store.update([self.ranking('flank', 'Britons')])
        self.assertEqual(len(self.store.read()['strategy']['versions']), 2)
        self.assertEqual([r['revision'] for r in self.store.history()], [3, 2, 1])

    def test_no_empty_library_or_invalid_paths(self):
        for change in [
            {'path': ['versions', 'shared-v1'], 'before': self.initial['strategy']['versions'][0], 'remove': True},
            {'path': ['__proto__'], 'value': {}},
        ]:
            with self.assertRaises(ValueError):
                self.store.update([change])

    def test_production_refuses_temporary_fallback(self):
        with patch.dict(os.environ, {'REQUIRE_DURABLE_STRATEGIES': '1', 'STRATEGY_STORAGE_DURABLE': '0'}):
            with self.assertRaises(RuntimeError):
                StrategyStore(database_url='', sqlite_path=self.path).read()


@unittest.skipUnless(os.getenv('TEST_DATABASE_URL'), 'PostgreSQL integration database not configured')
class PostgresIntegrationTests(unittest.TestCase):
    def test_cross_connection_merge_and_conflict(self):
        import psycopg
        url = os.environ['TEST_DATABASE_URL']
        store = StrategyStore(database_url=url)
        with psycopg.connect(url) as connection:
            # This URL belongs to the disposable CI database, never DATABASE_URL.
            connection.execute('DROP TABLE IF EXISTS strategy_history')
            connection.execute('DROP TABLE IF EXISTS strategy_library')
        document = store.read()
        self.assertTrue(document['durable'])
        def ranking(category, civ):
            return {'path': ['versions', 'shared-v1', 'categories', category, 'civs'], 'before': [], 'value': [civ]}
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda p: StrategyStore(database_url=url).update([p]), [ranking('flank', 'Britons'), ranking('halbso', 'Celts')]))
        latest = StrategyStore(database_url=url).read()
        self.assertEqual(latest['revision'], 3)
        with self.assertRaises(Conflict):
            store.update([ranking('flank', 'Mayans')])
        self.assertEqual(len(store.history()), 3)


if __name__ == '__main__':
    unittest.main()
