import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBridgeSource } from '../lib/bridge-source.js'
import { createEngine } from '../lib/engine.js'
import { openStore } from '../lib/store.js'

function makeFixture(messages, sessionId = 'session-1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-engine-'))
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify({
    sessions: { 'group:1': sessionId },
  }), 'utf8')
  fs.writeFileSync(path.join(stateDir, 'social-v2.json'), JSON.stringify({
    conversations: {
      'group:1': {
        recentMessages: messages,
        unread: [],
      },
    },
  }), 'utf8')
  const dbPath = path.join(dir, 'memory.sqlite3')
  const store = openStore({ databasePath: dbPath, logger: { info() {}, warn() {} } })
  const bridge = createBridgeSource({ stateDir, logger: { info() {}, warn() {} } })
  const engine = createEngine({
    store,
    bridge,
    config: { minAgeHours: 3, cooldownTurns: 5, memoryIntentCooldownTurns: 1, minScore: 2.2 },
    logger: { info() {}, warn() {} },
  })
  engine.ingest({ force: true })
  return {
    dir,
    store,
    bridge,
    engine,
    cleanup() {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const HOUR = 60 * 60 * 1000
const NOW = new Date(2026, 9, 31, 15, 0, 0).getTime()

function message(time, text, { isSelf = false, id = undefined, seq = undefined, sender = '甲' } = {}) {
  return {
    ...(id ? { messageId: id } : {}),
    ...(seq ? { seq } : {}),
    time,
    sender: isSelf ? '我' : sender,
    text,
    isSelf,
  }
}

test('关键词命中时只注入更早的消息，不碰最近上下文', () => {
  const fixture = makeFixture([
    message(NOW - 26 * HOUR, '昨晚聊到 Stable Diffusion 训练集要整理标签', { id: 'old-1', seq: 1 }),
    message(NOW - 25 * HOUR, '好，我记一下', { id: 'old-2', seq: 2, isSelf: true }),
    message(NOW - 20 * HOUR, '今天天气不错', { id: 'old-3', seq: 3 }),
    message(NOW - 30 * 60_000, '训练集标签怎么整理', { id: 'new-1', seq: 4 }),
  ])

  const result = fixture.engine.buildInjection({ sessionId: 'session-1', turn: 1, step: 1, now: NOW })
  assert.ok(result)
  assert.match(result.text, /旧聊天记忆/)
  assert.match(result.text, /Stable Diffusion/)
  assert.match(result.text, /训练集/)
  assert.doesNotMatch(result.text, /今天天气不错/)
  for (const id of result.ids) {
    const row = fixture.store.db.prepare('SELECT recall_count FROM messages WHERE id = ?').get(id)
    assert.equal(row.recall_count, 1)
  }

  // 同一个 turn 不重复注入
  assert.equal(fixture.engine.buildInjection({ sessionId: 'session-1', turn: 1, step: 1, now: NOW }), null)
  // 冷却期内（turn 2）不重复
  assert.equal(fixture.engine.buildInjection({ sessionId: 'session-1', turn: 2, step: 1, now: NOW + 1000 }), null)
  // 过了冷却且同一批旧消息超过 30 分钟，可以再次注入
  const later = fixture.engine.buildInjection({ sessionId: 'session-1', turn: 6, step: 1, now: NOW + 31 * 60_000 })
  assert.ok(later)

  fixture.cleanup()
})

test('“你还记得昨晚…”会按昨天时间窗兜底取旧消息', () => {
  const fixture = makeFixture([
    message(new Date(2026, 9, 30, 20, 0, 0).getTime(), '昨天说的那部电影是《深海》', { id: 'y-1', seq: 1 }),
    message(new Date(2026, 9, 30, 20, 1, 0).getTime(), '嗯嗯', { id: 'y-2', seq: 2, isSelf: true }),
    message(new Date(2026, 9, 31, 10, 0, 0).getTime(), '早上好', { id: 't-1', seq: 3 }),
    message(new Date(2026, 9, 31, 14, 50, 0).getTime(), '你还记得昨晚聊了什么吗', { id: 't-2', seq: 4 }),
  ])

  const result = fixture.engine.buildInjection({ sessionId: 'session-1', turn: 1, step: 1, now: NOW })
  assert.ok(result)
  assert.equal(result.reason, 'intent')
  assert.equal(result.range, '昨天')
  assert.match(result.text, /电影/)
  assert.match(result.text, /检索范围：昨天/)
  assert.doesNotMatch(result.text, /早上好/)
  fixture.cleanup()
})

test('未映射的 DSH 会话不会读到 QQ 记忆', () => {
  const fixture = makeFixture([
    message(NOW - 26 * HOUR, '训练集标签怎么整理', { id: 'old-1', seq: 1 }),
    message(NOW - 30 * 60_000, '训练集标签怎么整理', { id: 'new-1', seq: 2 }),
  ])
  assert.equal(fixture.engine.buildInjection({ sessionId: 'session-other', turn: 1, step: 1, now: NOW }), null)
  fixture.cleanup()
})
