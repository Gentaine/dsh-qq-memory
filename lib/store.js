// SQLite 对话表：把 QQ 消息按“一行一条”落盘，供检索、清理和导出使用。
//
// 用 Node 内置的 node:sqlite（DSH 0.2.x 已经自带这个依赖），不需要 better-sqlite3，
// 也就不需要为 Electron 重新编译原生模块。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { normalizeText, toSearchText } from './tokenize.js'

const require = createRequire(import.meta.url)

const TURN_VERSION = '1'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 4000;

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  qq_key       TEXT    NOT NULL,
  session_id   TEXT,
  seq          INTEGER,
  message_id   TEXT,
  sent_at      INTEGER NOT NULL,
  sender       TEXT,
  user_id      TEXT,
  direction    TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
  text         TEXT    NOT NULL,
  search_text  TEXT    NOT NULL DEFAULT '',
  recall_count INTEGER NOT NULL DEFAULT 0,
  turn_no      INTEGER NOT NULL DEFAULT 1,
  dedupe_key   TEXT    NOT NULL,
  raw          TEXT,
  ingested_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_dedupe
  ON messages (qq_key, dedupe_key);
CREATE INDEX IF NOT EXISTS messages_key_time
  ON messages (qq_key, sent_at);
CREATE INDEX IF NOT EXISTS messages_key_direction_time
  ON messages (qq_key, direction, sent_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const MAX_RAW_CHARS = 12_000

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex')
}

function localDayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    return text.length > MAX_RAW_CHARS ? `${text.slice(0, MAX_RAW_CHARS)}…` : text
  } catch {
    return null
  }
}

function nextTurn(last, direction) {
  if (!last) return 1
  if (last.direction === 'out' && direction === 'in') return last.turnNo + 1
  return last.turnNo || 1
}

/**
 * 把桥接状态里的一条消息规范化成表的一行。
 * 返回 null 表示这条消息没有可用正文（例如空消息）。
 */
export function normalizeMessage({ qqKey, sessionId, message, now = Date.now() }) {
  if (!message || typeof message !== 'object') return null
  if (!qqKey) return null

  // 展示正文保留原始标点（NFKC 会把全角逗号/引号改掉），检索正文另走 toSearchText。
  const text = String(message.text ?? message.plain ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null

  const sentAtRaw = Number(message.time)
  const sentAt = Number.isFinite(sentAtRaw) && sentAtRaw > 0 ? Math.round(sentAtRaw) : now
  const direction = message.isSelf === true ? 'out' : 'in'
  const messageId = message.messageId != null && String(message.messageId).trim() !== ''
    ? String(message.messageId).trim()
    : ''
  const seqRaw = Number(message.seq)
  const seq = Number.isSafeInteger(seqRaw) && seqRaw >= 0 ? seqRaw : null
  const userId = message.userId != null ? String(message.userId).trim() : ''
  const rawSender = String(message.sender ?? (direction === 'out' ? '我' : '')).trim()
  // SnowLuma 偶尔会把带控制字符的二进制串写进 sender（实测某些特殊群名片会这样）。
  // 这种名字不能原样带进 prompt；用 QQ 号兜底，至少还能区分是谁。
  const sender = /[\u0000-\u001F\u007F]/.test(rawSender) || rawSender.length > 80
    ? (direction === 'out' ? '我' : userId ? `群友${userId.slice(-4)}` : '某人')
    : normalizeText(rawSender) || (direction === 'out' ? '我' : '某人')

  let dedupeKey
  if (messageId) dedupeKey = `id:${messageId}`
  else if (seq != null) dedupeKey = `seq:${seq}`
  else {
    // 桥接自己的消息常常没有 messageId/seq。用“同一天 + 同方向 + 同发送者 + 同文本”
    // 去重：既能吸收会话日志回填带来的时间漂移，又不会把跨天的同一句话（比如每天的“晚安”）折叠掉。
    dedupeKey = `hash:${sha1([direction, sender, text, localDayKey(sentAt)].join('|'))}`
  }

  return {
    qqKey,
    sessionId: sessionId || null,
    seq,
    messageId: messageId || null,
    sentAt,
    sender: sender || null,
    userId: userId || null,
    direction,
    text,
    searchText: toSearchText(text),
    dedupeKey,
    raw: safeJson(message),
    ingestedAt: now,
  }
}

export function openStore({ databasePath, logger = console } = {}) {
  if (!databasePath) throw new Error('qq-memory: 缺少 databasePath')
  const absolute = path.resolve(databasePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })

  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(absolute)
  db.exec(SCHEMA)

  // 旧库升级：SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查 PRAGMA。
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name))
  if (!columns.has('recall_count')) {
    db.exec('ALTER TABLE messages ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!columns.has('turn_no')) {
    db.exec('ALTER TABLE messages ADD COLUMN turn_no INTEGER NOT NULL DEFAULT 1')
  }
  db.exec('CREATE INDEX IF NOT EXISTS messages_cleanup ON messages (qq_key, turn_no, sent_at)')

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (qq_key, session_id, seq, message_id, sent_at, sender, user_id, direction,
       text, search_text, recall_count, turn_no, dedupe_key, raw, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `)
  const update = db.prepare(`
    UPDATE messages
       SET text = ?, search_text = ?, sender = ?, user_id = ?,
           session_id = COALESCE(?, session_id), raw = ?, ingested_at = ?
     WHERE qq_key = ? AND dedupe_key = ?
  `)
  const selectCandidates = db.prepare(`
    SELECT id, seq, sent_at, sender, user_id, direction, text, search_text,
           recall_count, turn_no
      FROM messages
     WHERE qq_key = ? AND sent_at < ?
     ORDER BY sent_at DESC
     LIMIT ?
  `)
  const countKey = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE qq_key = ?')
  const latestKey = db.prepare(`
    SELECT id, seq, sent_at, sender, user_id, direction, text, search_text,
           recall_count, turn_no
      FROM messages
     WHERE qq_key = ?
     ORDER BY sent_at DESC
     LIMIT ?
  `)
  const lastTurnKey = db.prepare(`
    SELECT id, sent_at, direction, turn_no
      FROM messages
     WHERE qq_key = ?
     ORDER BY sent_at DESC, id DESC
     LIMIT 1
  `)
  const selectTurnRows = db.prepare(`
    SELECT id, direction FROM messages WHERE qq_key = ? ORDER BY sent_at ASC, id ASC
  `)
  const updateTurn = db.prepare('UPDATE messages SET turn_no = ? WHERE id = ?')
  const selectAllKeys = db.prepare('SELECT DISTINCT qq_key FROM messages ORDER BY qq_key')
  const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?')
  const metaSet = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)
  const conversationStatsStmt = db.prepare(`
    SELECT qq_key, COUNT(*) AS messages, MAX(turn_no) AS max_turn,
           MIN(sent_at) AS earliest, MAX(sent_at) AS latest,
           SUM(recall_count) AS recalled
      FROM messages
     GROUP BY qq_key
     ORDER BY messages DESC
  `)
  const turnSizesStmt = db.prepare(`
    SELECT turn_no, COUNT(*) AS count FROM messages WHERE qq_key = ? GROUP BY turn_no
  `)
  const cleanupCandidatesStmt = db.prepare(`
    SELECT id, qq_key, sent_at, recall_count, turn_no, text
      FROM messages
     WHERE qq_key = ? AND sent_at < ? AND turn_no <= ?
     ORDER BY sent_at ASC, id ASC
     LIMIT ?
  `)

  /**
   * 重新编号一个会话的轮次。
   *
   * 轮次定义：第一轮从第 1 条消息开始；当“上一条是我发的、下一条是对方发的”时进入下一轮。
   * 连续几条对方消息算同一轮，我连续补充几句也算同一轮。
   * 这样一轮通常就是“对方发起 → 我回应”，轮次长度 = 这一轮里的消息条数。
   */
  function recomputeTurns(qqKey) {
    const rows = selectTurnRows.all(qqKey)
    let turn = 1
    let previousDirection = null
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        if (previousDirection === 'out' && row.direction === 'in') turn += 1
        updateTurn.run(turn, row.id)
        previousDirection = row.direction
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
    return { messages: rows.length, turns: rows.length ? turn : 0 }
  }

  function recomputeAllTurns() {
    const result = []
    for (const row of selectAllKeys.all()) result.push({ qqKey: row.qq_key, ...recomputeTurns(row.qq_key) })
    return result
  }

  // 旧库第一次升级时按方向重算轮次；新库没数据，直接写版本。
  if (metaGet.get('turn_version')?.value !== TURN_VERSION) {
    recomputeAllTurns()
    metaSet.run('turn_version', TURN_VERSION)
  }

  function upsertMany(rows) {
    let inserted = 0
    let updated = 0
    const ordered = rows
      .filter(Boolean)
      .sort((a, b) => String(a.qqKey).localeCompare(String(b.qqKey)) || a.sentAt - b.sentAt)
    const lastByKey = new Map()
    const needsRecompute = new Set()

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of ordered) {
        if (!lastByKey.has(row.qqKey)) {
          const last = lastTurnKey.get(row.qqKey)
          lastByKey.set(row.qqKey, last
            ? { sentAt: Number(last.sent_at), direction: last.direction, turnNo: Number(last.turn_no) }
            : null)
        }
        const last = lastByKey.get(row.qqKey)
        const historical = Boolean(last) && row.sentAt < last.sentAt
        const turnNo = historical ? 1 : nextTurn(last, row.direction)

        const result = insert.run(
          row.qqKey, row.sessionId, row.seq, row.messageId, row.sentAt,
          row.sender, row.userId, row.direction, row.text, row.searchText,
          turnNo, row.dedupeKey, row.raw, row.ingestedAt,
        )
        if (result.changes > 0) {
          inserted += 1
          if (historical) needsRecompute.add(row.qqKey)
          else lastByKey.set(row.qqKey, {
            sentAt: row.sentAt,
            direction: row.direction,
            turnNo,
          })
          continue
        }
        const changed = update.run(
          row.text, row.searchText, row.sender, row.userId, row.sessionId,
          row.raw, row.ingestedAt, row.qqKey, row.dedupeKey,
        )
        if (changed.changes > 0) updated += 1
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }

    // 只对“插入了一条比现有最新消息还早的历史消息”的会话重算；正常新消息走增量轮次。
    const recomputed = []
    for (const qqKey of needsRecompute) recomputed.push({ qqKey, ...recomputeTurns(qqKey) })
    return { inserted, updated, recomputed }
  }

  function candidates({ qqKey, before = Date.now(), limit = 2500 }) {
    if (!qqKey) return []
    const safeLimit = Math.max(1, Math.min(20_000, Math.round(limit)))
    return selectCandidates.all(qqKey, before, safeLimit)
  }

  function latest({ qqKey, limit = 20 }) {
    if (!qqKey) return []
    return latestKey.all(qqKey, Math.max(1, Math.min(1000, Math.round(limit))))
  }

  function count(qqKey) {
    if (!qqKey) return 0
    return Number(countKey.get(qqKey)?.count ?? 0)
  }

  function list({ qqKey, limit = 50, offset = 0, direction = '', since = 0, query = '' } = {}) {
    const where = []
    const params = []
    if (qqKey) { where.push('qq_key = ?'); params.push(qqKey) }
    if (direction === 'in' || direction === 'out') { where.push('direction = ?'); params.push(direction) }
    if (since > 0) { where.push('sent_at >= ?'); params.push(since) }
    if (query) {
      const escaped = String(query).replace(/[\\%_]/g, (ch) => `\\${ch}`)
      where.push("(text LIKE ? ESCAPE '\\' OR search_text LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\')")
      params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`)
    }
    const sql = `
      SELECT id, qq_key, seq, message_id, sent_at, sender, user_id, direction,
             text, recall_count, turn_no
        FROM messages
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY sent_at DESC
       LIMIT ? OFFSET ?
    `
    return db.prepare(sql).all(...params, Math.max(1, Math.min(5000, Math.round(limit))), Math.max(0, Math.round(offset)))
  }

  function exportRows({ qqKey, limit = 100_000 } = {}) {
    const sql = `
      SELECT qq_key, seq, message_id, sent_at, sender, user_id, direction,
             text, recall_count, turn_no
        FROM messages
       ${qqKey ? 'WHERE qq_key = ?' : ''}
       ORDER BY sent_at ASC, id ASC
       LIMIT ?
    `
    return qqKey
      ? db.prepare(sql).all(qqKey, Math.max(1, Math.min(200_000, Math.round(limit))))
      : db.prepare(sql).all(Math.max(1, Math.min(200_000, Math.round(limit))))
  }

  function markRecalled(ids) {
    const unique = [...new Set((ids ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
    let updated = 0
    for (let i = 0; i < unique.length; i += 400) {
      const chunk = unique.slice(i, i + 400)
      const placeholders = chunk.map(() => '?').join(',')
      const result = db.prepare(`UPDATE messages SET recall_count = recall_count + 1 WHERE id IN (${placeholders})`).run(...chunk)
      updated += Number(result.changes ?? 0)
    }
    return updated
  }

  function conversationStats() {
    return conversationStatsStmt.all().map((row) => ({
      qqKey: row.qq_key,
      messages: Number(row.messages),
      maxTurn: Number(row.max_turn),
      earliest: row.earliest ? Number(row.earliest) : null,
      latest: row.latest ? Number(row.latest) : null,
      recalled: Number(row.recalled ?? 0),
    }))
  }

  function turnSizes(qqKey) {
    const map = new Map()
    for (const row of turnSizesStmt.all(qqKey)) map.set(Number(row.turn_no), Number(row.count))
    return map
  }

  function cleanupCandidates({ qqKey, before, maxTurn, limit = 20_000 }) {
    return cleanupCandidatesStmt.all(qqKey, before, maxTurn, Math.max(1, Math.min(50_000, Math.round(limit))))
  }

  function deleteMessages(ids) {
    const unique = [...new Set((ids ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
    let deleted = 0
    for (let i = 0; i < unique.length; i += 400) {
      const chunk = unique.slice(i, i + 400)
      const placeholders = chunk.map(() => '?').join(',')
      const result = db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...chunk)
      deleted += Number(result.changes ?? 0)
    }
    return deleted
  }

  function stats() {
    const totals = db.prepare(`
      SELECT COUNT(*) AS messages,
             COUNT(DISTINCT qq_key) AS conversations,
             MIN(sent_at) AS earliest,
             MAX(sent_at) AS latest,
             SUM(recall_count) AS recalled,
             MAX(turn_no) AS max_turn
        FROM messages
    `).get()
    const byKey = conversationStats()
    return {
      messages: Number(totals?.messages ?? 0),
      conversations: Number(totals?.conversations ?? 0),
      earliest: totals?.earliest ? Number(totals.earliest) : null,
      latest: totals?.latest ? Number(totals.latest) : null,
      recalled: Number(totals?.recalled ?? 0),
      maxTurn: Number(totals?.max_turn ?? 0),
      byKey,
    }
  }

  function close() {
    try { db.close() } catch {}
  }

  logger?.info?.(`[qq-memory] SQLite: ${absolute}`)
  return {
    path: absolute,
    db,
    upsertMany,
    candidates,
    latest,
    count,
    list,
    exportRows,
    markRecalled,
    conversationStats,
    turnSizes,
    cleanupCandidates,
    deleteMessages,
    recomputeTurns,
    recomputeAllTurns,
    stats,
    close,
  }
}
