import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeMessage, openStore } from '../lib/store.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-store-'))
}

test('插入、去重、按时间检索', () => {
  const dir = tmpDir()
  const store = openStore({ databasePath: path.join(dir, 'test.sqlite3'), logger: { info() {}, warn() {} } })
  const now = 1_800_000_000_000
  const rows = [
    normalizeMessage({
      qqKey: 'group:1',
      sessionId: 'session-1',
      now,
      message: { messageId: 'm1', seq: 1, time: now - 3000, sender: '甲', text: '第一句', isSelf: false },
    }),
    normalizeMessage({
      qqKey: 'group:1',
      sessionId: 'session-1',
      now,
      message: { messageId: 'm2', seq: 2, time: now - 2000, sender: '我', text: '第二句', isSelf: true },
    }),
  ].filter(Boolean)

  const first = store.upsertMany(rows)
  assert.equal(first.inserted, 2)
  assert.equal(first.updated, 0)
  assert.equal(store.count('group:1'), 2)

  // 同一条 messageId 重复导入不应增加行数
  store.upsertMany(rows)
  assert.equal(store.count('group:1'), 2)

  const candidates = store.candidates({ qqKey: 'group:1', before: now, limit: 10 })
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].text, '第二句')

  const found = store.list({ qqKey: 'group:1', query: '第一句', limit: 10 })
  assert.equal(found.length, 1)

  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('带控制字符的坏 sender 用 QQ 号兜底，不把二进制串带进 prompt', () => {
  const dir = tmpDir()
  const store = openStore({ databasePath: path.join(dir, 'test.sqlite3'), logger: { info() {}, warn() {} } })
  const row = normalizeMessage({
    qqKey: 'group:1',
    sessionId: null,
    now: Date.now(),
    message: {
      messageId: 'bad-1',
      time: Date.now(),
      sender: '\n\f%ĀĀ␇Ú\n\u0019суровая зима\u0010',
      userId: '3408504630',
      text: '你好',
      isSelf: false,
    },
  })
  assert.equal(row.sender, '群友4630')
  store.upsertMany([row])
  assert.equal(store.count('group:1'), 1)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('没有 messageId/seq 时按“同一天 + 文本”去重，跨天保留', () => {
  const dir = tmpDir()
  const store = openStore({ databasePath: path.join(dir, 'test.sqlite3'), logger: { info() {}, warn() {} } })
  const day = 24 * 60 * 60 * 1000
  const base = 1_800_000_000_000
  const a = normalizeMessage({
    qqKey: 'group:1', sessionId: null, now: base,
    message: { time: base, sender: '我', text: '晚安', isSelf: true },
  })
  const b = normalizeMessage({
    qqKey: 'group:1', sessionId: null, now: base + 1000,
    message: { time: base + 1000, sender: '我', text: '晚安', isSelf: true },
  })
  const c = normalizeMessage({
    qqKey: 'group:1', sessionId: null, now: base + day,
    message: { time: base + day, sender: '我', text: '晚安', isSelf: true },
  })
  store.upsertMany([a, b, c])
  assert.equal(store.count('group:1'), 2)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('没有 messageId 时用 seq 去重；两者都没有时用内容哈希', () => {
  const dir = tmpDir()
  const store = openStore({ databasePath: path.join(dir, 'test.sqlite3'), logger: { info() {}, warn() {} } })
  const now = Date.now()
  const base = { qqKey: 'private:1', sessionId: null, now }
  const a = normalizeMessage({ ...base, message: { seq: 7, time: now, sender: '甲', text: '只有 seq' } })
  const b = normalizeMessage({ ...base, message: { seq: 7, time: now, sender: '甲', text: '只有 seq' } })
  const c = normalizeMessage({ ...base, message: { time: now, sender: '甲', text: '没有 id 和 seq' } })
  const d = normalizeMessage({ ...base, message: { time: now, sender: '甲', text: '没有 id 和 seq' } })
  store.upsertMany([a, b, c, d])
  assert.equal(store.count('private:1'), 2)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
