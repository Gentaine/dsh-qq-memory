import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { openStore } from '../lib/store.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

test('旧库没有 recall_count/turn_no 时自动补列并重算轮次', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-migrate-'))
  const dbPath = path.join(dir, 'old.sqlite3')
  const old = new DatabaseSync(dbPath)
  old.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qq_key TEXT NOT NULL,
      session_id TEXT,
      seq INTEGER,
      message_id TEXT,
      sent_at INTEGER NOT NULL,
      sender TEXT,
      user_id TEXT,
      direction TEXT NOT NULL,
      text TEXT NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT NOT NULL,
      raw TEXT,
      ingested_at INTEGER NOT NULL
    );
  `)
  const insert = old.prepare(`
    INSERT INTO messages
      (qq_key, session_id, seq, message_id, sent_at, sender, user_id, direction,
       text, search_text, dedupe_key, raw, ingested_at)
    VALUES (?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)
  `)
  const now = 1_800_000_000_000
  insert.run('group:1', 'o1', now + 1, '甲', 'in', '第一轮', '第一轮', 'id:o1', now)
  insert.run('group:1', 'o2', now + 2, '我', 'out', '回一', '回一', 'id:o2', now)
  insert.run('group:1', 'o3', now + 3, '甲', 'in', '第二轮', '第二轮', 'id:o3', now)
  old.close()

  const store = openStore({ databasePath: dbPath, logger: { info() {}, warn() {} } })
  const columns = store.db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name)
  assert.ok(columns.includes('recall_count'))
  assert.ok(columns.includes('turn_no'))
  const rows = store.db.prepare('SELECT text, turn_no, recall_count FROM messages ORDER BY sent_at').all()
  assert.deepEqual(rows.map((row) => row.turn_no), [1, 1, 2])
  assert.deepEqual(rows.map((row) => row.recall_count), [0, 0, 0])
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
