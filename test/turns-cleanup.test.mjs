import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine, cleanupPriority } from '../lib/engine.js'
import { normalizeMessage, openStore } from '../lib/store.js'

const DAY = 24 * 60 * 60 * 1000

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-turn-'))
  const store = openStore({ databasePath: path.join(dir, 'test.sqlite3'), logger: { info() {}, warn() {} } })
  return { dir, store, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

function msg({ id, time, text, direction = 'in' }) {
  return normalizeMessage({
    qqKey: 'group:1',
    sessionId: 'session-1',
    now: time,
    message: {
      messageId: id,
      seq: Number(id.replace(/\D/g, '')) || undefined,
      time,
      sender: direction === 'out' ? '我' : '甲',
      text,
      isSelf: direction === 'out',
    },
  })
}

test('轮次按“对方发起 → 我回应”递增；连续同方向不新增轮次', () => {
  const db = tmpDb()
  const base = 1_800_000_000_000
  db.store.upsertMany([
    msg({ id: 'm1', time: base + 1, text: '对方一', direction: 'in' }),
    msg({ id: 'm2', time: base + 2, text: '我回一', direction: 'out' }),
    msg({ id: 'm3', time: base + 3, text: '对方二', direction: 'in' }),
    msg({ id: 'm4', time: base + 4, text: '我回二', direction: 'out' }),
    msg({ id: 'm5', time: base + 5, text: '对方三', direction: 'in' }),
  ])
  const rows = db.store.db.prepare('SELECT text, turn_no FROM messages ORDER BY sent_at').all()
  assert.deepEqual(rows.map((row) => row.turn_no), [1, 1, 2, 2, 3])

  const first = db.store.list({ qqKey: 'group:1', query: '对方一', limit: 1 })[0]
  db.store.markRecalled([first.id])
  const recalled = db.store.list({ qqKey: 'group:1', query: '对方一', limit: 1 })[0]
  assert.equal(recalled.recall_count, 1)
  db.close()
})

test('交流次数只数对方消息，我连续刷屏不把轮次撑长', () => {
  const db = tmpDb()
  const base = 1_800_000_000_000
  db.store.upsertMany([
    msg({ id: 'e1', time: base + 1, text: '对方一', direction: 'in' }),
    msg({ id: 'e2', time: base + 2, text: '我回一', direction: 'out' }),
    msg({ id: 'e3', time: base + 3, text: '对方二', direction: 'in' }),
    msg({ id: 'e4', time: base + 4, text: '对方三', direction: 'in' }),
    msg({ id: 'e5', time: base + 5, text: '我回二', direction: 'out' }),
    msg({ id: 'e6', time: base + 6, text: '我补三', direction: 'out' }),
    msg({ id: 'e7', time: base + 7, text: '我补四', direction: 'out' }),
    msg({ id: 'e8', time: base + 8, text: '对方四', direction: 'in' }),
  ])
  const counts = db.store.turnExchangeCounts('group:1')
  assert.equal(counts.get(1), 1) // 对方一
  assert.equal(counts.get(2), 2) // 对方二 + 对方三
  assert.equal(counts.get(3), 1) // 对方四
  db.close()
})

test('清理优先级：更老、更少被回忆、这一轮交流次数更少 → 更高', () => {
  const now = 1_800_000_000_000
  const oldShort = cleanupPriority({ sentAt: now - 100 * DAY, recallCount: 0, exchangeCount: 0, now, ageSaturationDays: 90 })
  const oldLong = cleanupPriority({ sentAt: now - 100 * DAY, recallCount: 0, exchangeCount: 20, now, ageSaturationDays: 90 })
  const oldRecalled = cleanupPriority({ sentAt: now - 100 * DAY, recallCount: 100, exchangeCount: 0, now, ageSaturationDays: 90 })
  const newShort = cleanupPriority({ sentAt: now - 1 * DAY, recallCount: 0, exchangeCount: 0, now, ageSaturationDays: 90 })
  assert.ok(oldShort > oldLong)
  assert.ok(oldShort > oldRecalled)
  assert.ok(oldShort > newShort)
})

test('定期清理会删掉最老、最少被回忆、轮次最短的旧消息，保留高价值消息', () => {
  const db = tmpDb()
  const now = 1_800_000_000_000
  const old = now - 100 * DAY
  const recent = now - 1 * DAY
  const rows = [
    msg({ id: 'old-low-1', time: old + 1, text: 'old-low-1', direction: 'in' }),
    msg({ id: 'old-low-2', time: old + 2, text: 'old-low-2', direction: 'out' }),
    msg({ id: 'old-high-1', time: old + 3, text: 'old-high-1', direction: 'in' }),
    msg({ id: 'old-high-2', time: old + 4, text: 'old-high-2', direction: 'out' }),
    msg({ id: 'new-1', time: recent + 1, text: 'new-1', direction: 'in' }),
    msg({ id: 'new-2', time: recent + 2, text: 'new-2', direction: 'out' }),
    msg({ id: 'new-3', time: recent + 3, text: 'new-3', direction: 'in' }),
    msg({ id: 'new-4', time: recent + 4, text: 'new-4', direction: 'out' }),
    msg({ id: 'new-5', time: recent + 5, text: 'new-5', direction: 'in' }),
    msg({ id: 'new-6', time: recent + 6, text: 'new-6', direction: 'out' }),
  ]
  db.store.upsertMany(rows)

  const high = db.store.list({ qqKey: 'group:1', query: 'old-high-1', limit: 1 })[0]
  for (let i = 0; i < 20; i += 1) db.store.markRecalled([high.id])

  const engine = createEngine({
    store: db.store,
    bridge: {},
    config: {
      cleanup: {
        enabled: true,
        minAgeDays: 0,
        keepRecentTurns: 0,
        maxMessagesPerConversation: 9,
        batchSize: 10,
        ageSaturationDays: 90,
      },
    },
    logger: { info() {}, warn() {} },
  })
  const result = engine.cleanup({ now })
  assert.equal(result.deleted, 1)
  assert.equal(db.store.count('group:1'), 9)
  const texts = db.store.list({ qqKey: 'group:1', limit: 20 }).map((row) => row.text)
  assert.ok(!texts.includes('old-low-1'))
  assert.ok(texts.includes('old-high-1'))
  assert.ok(texts.includes('new-1'))
  db.close()
})
