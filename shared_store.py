"""Transactional shared strategy library. PostgreSQL in production, SQLite locally."""
import copy
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Conflict(Exception):
    pass


def seed_strategy():
    return json.loads((ROOT / 'data/shared_strategy_seed.json').read_text(encoding='utf-8'))


def validate(strategy):
    if not isinstance(strategy, dict) or not isinstance(strategy.get('name'), str):
        raise ValueError('A strategy name is required')
    versions = strategy.get('versions')
    if not isinstance(versions, list) or not versions:
        raise ValueError('Keep at least one strategy version')
    def unique(items):
        if not isinstance(items, list) or any(not isinstance(x, dict) or not isinstance(x.get('id'), str) or not x['id'] for x in items):
            raise ValueError('Every version and category needs an ID')
        if len({x['id'] for x in items}) != len(items):
            raise ValueError('Duplicate version or category ID')
    unique(versions)
    for version in versions:
        if not isinstance(version.get('name'), str):
            raise ValueError('Every version needs a name')
        unique(version.get('categories'))
        if not version['categories'] or not isinstance(version.get('civs'), list):
            raise ValueError('Version needs categories and a civilization pool')
        for category in version['categories']:
            if not isinstance(category.get('name'), str) or not isinstance(category.get('civs'), list):
                raise ValueError('Invalid category')
            if not all(isinstance(c, str) for c in category['civs']):
                raise ValueError('Civilizations must be names')
            overrides = category.get('mapCivs', {})
            if not isinstance(overrides, dict) or any(not isinstance(v, list) or not all(isinstance(c, str) for c in v) for v in overrides.values()):
                raise ValueError('Invalid map ranking')
    if len(json.dumps(strategy)) > 5_000_000:
        raise ValueError('Strategy library is too large')


def member(parent, key):
    if isinstance(parent, dict):
        return parent.get(key)
    if isinstance(parent, list):
        return next((x for x in parent if isinstance(x, dict) and x.get('id') == key), None)
    raise ValueError('Invalid patch path')


def assign(parent, key, value, remove=False):
    if isinstance(parent, dict):
        if remove:
            parent.pop(key, None)
        else:
            parent[key] = value
    elif isinstance(parent, list):
        index = next((i for i, x in enumerate(parent) if isinstance(x, dict) and x.get('id') == key), None)
        if remove:
            if index is not None:
                parent.pop(index)
        else:
            if not isinstance(value, dict) or value.get('id') != key:
                raise ValueError('Version/category ID does not match its path')
            if index is None:
                parent.append(value)
            else:
                parent[index] = value
    else:
        raise ValueError('Invalid patch target')


def apply_patches(previous, patches):
    if not isinstance(patches, list) or len(patches) > 2000:
        raise ValueError('Invalid strategy changes')
    result = copy.deepcopy(previous)
    for patch in patches:
        path = patch.get('path', [])
        if not path or len(path) > 12 or path[0] not in ('name', 'versions') or any(not isinstance(k, str) or k in ('__proto__', 'prototype', 'constructor') for k in path):
            raise ValueError('Invalid strategy patch path')
        parent = result
        for key in path[:-1]:
            parent = member(parent, key)
            if parent is None:
                raise Conflict('A version or category was removed by another editor')
        old = member(parent, path[-1])
        if old != patch.get('before') and old != patch.get('value'):
            raise Conflict('Another editor changed the same ranking. Your work has been kept for export.')
        assign(parent, path[-1], patch.get('value'), patch.get('remove', False))
    validate(result)
    for version in previous['versions']:
        updated = next((v for v in result['versions'] if v['id'] == version['id']), None)
        if version.get('locked') and updated and updated.get('locked') and any(updated.get(k) != version.get(k) for k in ('categories', 'civs')):
            raise ValueError('Unlock or copy this version before editing its rankings')
    return result


class StrategyStore:
    def __init__(self, database_url=None, sqlite_path=None):
        self.url = database_url if database_url is not None else os.getenv('DATABASE_URL', '')
        self.path = Path(sqlite_path or os.getenv('STRATEGY_DB_PATH', str(ROOT / 'shared-strategies.sqlite3')))
        self.durable = bool(self.url) or os.getenv('STRATEGY_STORAGE_DURABLE') == '1'

    @contextmanager
    def connection(self):
        if self.url:
            import psycopg
            connection = psycopg.connect(self.url, connect_timeout=10)
        else:
            if os.getenv('REQUIRE_DURABLE_STRATEGIES', '1' if os.getenv('RENDER') == 'true' else '0') == '1' and not self.durable:
                raise RuntimeError('Permanent strategy storage has not been connected')
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.path, timeout=20)
        try:
            if self.url:
                connection.execute('SELECT pg_advisory_xact_lock(17021985)')
            else:
                connection.execute('BEGIN IMMEDIATE')
            connection.execute('CREATE TABLE IF NOT EXISTS strategy_library (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at BIGINT NOT NULL)')
            connection.execute('CREATE TABLE IF NOT EXISTS strategy_history (library_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (library_id, revision))')
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def execute(self, connection, query, values=()):
        return connection.execute(query.replace('?', '%s') if self.url else query, values)

    def document(self, connection):
        row = self.execute(connection, 'SELECT revision, payload, updated_at FROM strategy_library WHERE id=?', ('team',)).fetchone()
        if row is None:
            row = (1, json.dumps(seed_strategy()), int(time.time() * 1000))
            self.execute(connection, 'INSERT INTO strategy_library VALUES (?, ?, ?, ?)', ('team', *row))
            self.execute(connection, 'INSERT INTO strategy_history VALUES (?, ?, ?, ?)', ('team', *row))
        return {'revision': row[0], 'strategy': json.loads(row[1]), 'updatedAt': row[2], 'durable': self.durable}

    def read(self):
        with self.connection() as connection:
            return self.document(connection)

    def update(self, patches):
        with self.connection() as connection:
            document = self.document(connection)
            strategy = apply_patches(document['strategy'], patches)
            if strategy == document['strategy']:
                return document
            revision = document['revision'] + 1
            timestamp = max(int(time.time() * 1000), document['updatedAt'] + 1)
            payload = json.dumps(strategy, ensure_ascii=False)
            self.execute(connection, 'UPDATE strategy_library SET revision=?, payload=?, updated_at=? WHERE id=?', (revision, payload, timestamp, 'team'))
            self.execute(connection, 'INSERT INTO strategy_history VALUES (?, ?, ?, ?)', ('team', revision, payload, timestamp))
            return {'revision': revision, 'strategy': strategy, 'updatedAt': timestamp, 'durable': self.durable}

    def history(self):
        with self.connection() as connection:
            self.document(connection)
            rows = self.execute(connection, 'SELECT revision, updated_at FROM strategy_history WHERE library_id=? ORDER BY revision DESC LIMIT 100', ('team',)).fetchall()
            return [{'revision': row[0], 'updatedAt': row[1]} for row in rows]
