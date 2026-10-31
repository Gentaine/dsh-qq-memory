#!/usr/bin/env node
// 可选的一次性回填：从 DSH 会话日志里提取 qq_get_unread_messages / qq_wait_for_messages /
// qq_get_recent_messages 的 tool result，把桥接 recentMessages 里已经滚掉的旧消息补进表。
//
// 为什么只补这些：桥接的 social-v2.json 只保留最近 100~200 条；会话日志里还有模型过去
// 读过的消息快照。它们不是完整聊天记录，但能把“上周聊过什么”的记忆往前推一段。
//
// 默认只读；--dry-run 只统计不落盘。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { normalizeMessage, openStore } from '../lib/store.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[name] = next; i += 1 } else out[name] = true
  }
  return out
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

function decompress(file) {
  if (file.endsWith('.zstd')) return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  return fs.readFileSync(file, 'utf8')
}

function collectMessages(node, context, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectMessages(item, context, out)
    return
  }
  if (typeof node.key === 'string' && /^(group|private):/.test(node.key)) {
    if (context.allowedKeys.has(node.key)) {
      for (const field of ['newMessages', 'messages', 'recent', 'unread', 'recentMessages']) {
        if (!Array.isArray(node[field])) continue
        for (const message of node[field]) {
          if (!message || typeof message !== 'object') continue
          if (typeof message.text !== 'string' || !message.text.trim()) continue
          // 有些工具回执只带 at（HH:mm）不带 time。用 tool/result 事件自己的时间兜底，
          // 这样重复回填同一条日志不会因为“现在几点”变化而生成不同的哈希。
          const normalized = { ...message }
          if (!Number.isFinite(Number(normalized.time)) && context.fallbackTime > 0) {
            normalized.time = context.fallbackTime
          }
          if (!Number.isFinite(Number(normalized.time)) && normalized.messageId == null && normalized.seq == null) {
            continue
          }
          const id = String(normalized.messageId ?? normalized.seq ?? `${normalized.time}|${normalized.sender}|${normalized.text}`)
          const dedupe = `${node.key}|${id}`
          if (!out.has(dedupe)) out.set(dedupe, { key: node.key, message: normalized })
        }
      }
    }
  }
  for (const value of Object.values(node)) collectMessages(value, context, out)
}

function findSessionFiles(root) {
  const files = []
  if (!fs.existsSync(root)) return files
  for (const dir of fs.readdirSync(root)) {
    const sessionRoot = path.join(root, dir)
    if (!fs.statSync(sessionRoot).isDirectory()) continue
    for (const sub of fs.readdirSync(sessionRoot)) {
      const folder = path.join(sessionRoot, sub)
      if (!fs.statSync(folder).isDirectory()) continue
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const file = path.join(folder, name)
        if (fs.existsSync(file)) files.push(file)
      }
    }
  }
  return files
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(`从 DSH 会话日志回填旧 QQ 消息

用法：
  node scripts/backfill-session-logs.mjs [--dry-run] [--key group:123]
       [--db <sqlite>] [--sessions-dir <dir>] [--bridge-state <dir>]

默认：
  db            ~/.dsh/qq-memory/conversations.sqlite3
  sessions-dir  ~/.dsh/sessions
  bridge-state  ./qq-bridge/state
`)
  process.exit(0)
}

const dbPath = path.resolve(args.db || path.join(os.homedir(), '.dsh', 'qq-memory', 'conversations.sqlite3'))
const sessionsDir = path.resolve(args['sessions-dir'] || path.join(os.homedir(), '.dsh', 'sessions'))
const bridgeState = path.resolve(args['bridge-state'] || path.join(process.cwd(), 'qq-bridge', 'state'))
const sessionsFile = path.join(bridgeState, 'sessions.json')
if (!fs.existsSync(sessionsFile)) {
  console.error(`找不到 ${sessionsFile}`)
  process.exit(2)
}
const sessions = readJson(sessionsFile).sessions ?? {}
let allowedKeys = new Set(Object.keys(sessions))
if (args.key) allowedKeys = new Set([String(args.key)])

const files = findSessionFiles(sessionsDir)
if (!files.length) {
  console.log(`没有在 ${sessionsDir} 找到会话日志`)
  process.exit(0)
}

const collected = new Map()
for (const file of files) {
  try {
    const text = decompress(file)
    for (const line of text.split('\n')) {
      if (!line) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type !== 'tool/result') continue
      const fallbackTime = Number(event.time) || Number(event.data?.message?.time) || 0
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue
        const raw = block.text.trim()
        if (!raw.startsWith('{')) continue
        let parsed
        try { parsed = JSON.parse(raw) } catch { continue }
        collectMessages(parsed, { allowedKeys, fallbackTime }, collected)
      }
    }
  } catch (error) {
    console.error(`跳过 ${file}: ${error?.message ?? error}`)
  }
}

const stats = new Map()
const rows = []
for (const { key, message } of collected.values()) {
  const sessionId = sessions[key] ?? null
  const row = normalizeMessage({ qqKey: key, sessionId, message, now: Date.now() })
  if (!row) continue
  rows.push(row)
  stats.set(key, (stats.get(key) ?? 0) + 1)
}
console.log(`扫描 ${files.length} 个会话日志，找到 ${rows.length} 条可用旧消息`)
for (const [key, count] of stats) console.log(`  ${key}: ${count} 条`)

if (args['dry-run']) {
  console.log('dry-run：未写入')
  process.exit(0)
}

const store = openStore({ databasePath: dbPath, logger: { info() {}, warn: console.error } })
try {
  const result = store.upsertMany(rows)
  console.log(`写入 ${store.path}：新增 ${result.inserted}，更新 ${result.updated}`)
} finally {
  store.close()
}
