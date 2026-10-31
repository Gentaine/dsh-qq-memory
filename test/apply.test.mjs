import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, name } from '../lib/index.js'

const HOUR = 60 * 60 * 1000

test('apply 注册 pre-step，并把旧消息追加到 decision.messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-apply-'))
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify({
    sessions: { 'group:1': 'session-1' },
  }), 'utf8')
  fs.writeFileSync(path.join(stateDir, 'social-v2.json'), JSON.stringify({
    conversations: {
      'group:1': {
        recentMessages: [
          { messageId: 'old', seq: 1, time: now - 10 * HOUR, sender: '甲', text: '上次说的训练集标签要整理', isSelf: false },
          { messageId: 'old-reply', seq: 2, time: now - 9 * HOUR, sender: '我', text: '好，我记一下', isSelf: true },
          { messageId: 'new', seq: 3, time: now - 10 * 60_000, sender: '甲', text: '训练集标签怎么整理', isSelf: false },
        ],
      },
    },
  }), 'utf8')

  const handlers = new Map()
  const disposers = []
  const ctx = {
    on(event, handler) { handlers.set(event, handler) },
    effect(fn) { disposers.push(fn()) },
  }

  apply(ctx, {
    bridgeStateDir: stateDir,
    databasePath: path.join(dir, 'memory.sqlite3'),
    minAgeHours: 1,
    cooldownTurns: 0,
    logger: { info() {}, warn() {} },
  })

  const handler = handlers.get('agent/pre-step')
  assert.equal(typeof handler, 'function')

  const decision = { kind: 'step', messages: [{ role: 'user', content: [{ type: 'text', text: 'QQ 唤醒提示词' }] }] }
  const result = await handler({
    agent: { session: { id: 'session-1' } },
    turn: 1,
    step: 1,
  }, async () => decision)

  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[1].source.kind, name)
  assert.match(result.messages[1].content[0].text, /训练集/)
  assert.match(result.messages[1].content[0].text, /旧聊天记忆/)

  for (const dispose of disposers) dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})
