import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntime, makeMemoryMessage, name } from '../lib/index.js'

test('插件消息带独立 source，不会被当成 QQ 用户消息', () => {
  const message = makeMemoryMessage('测试记忆')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, name)
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, '测试记忆')
  assert.match(message.id, /[0-9a-f-]{36}/)
})

test('createRuntime 能从桥接状态建表并导入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-plugin-'))
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify({
    sessions: { 'group:1': 'session-1' },
  }), 'utf8')
  fs.writeFileSync(path.join(stateDir, 'social-v2.json'), JSON.stringify({
    conversations: {
      'group:1': {
        recentMessages: [
          { messageId: 'm1', seq: 1, time: Date.now() - 1000, sender: '甲', text: '你好', isSelf: false },
        ],
      },
    },
  }), 'utf8')

  const runtime = createRuntime({
    bridgeStateDir: stateDir,
    databasePath: path.join(dir, 'memory.sqlite3'),
    logger: { info() {}, warn() {} },
  })
  assert.equal(runtime.store.count('group:1'), 1)
  assert.equal(runtime.bridge.getSessionKey('session-1'), 'group:1')
  runtime.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
