// 只读 qq-bridge 的 state/social-v2.json 与 state/sessions.json。
//
// 为什么不去拦 DSH 的 session/event：
//   qq-bridge 发给 DSH 的 user/message 是一大段“唤醒提示词”，真正的群消息在
//   mcp__snowluma__qq_get_* 的 tool result 里，按 DSH 事件反推既绕又容易漏。
//   桥接自己已经把入站/出站消息写进 social-v2.json 的 recentMessages，字段稳定，
//   直接读它是成本最低、最贴近 QQ 真实对话的做法。
//
// 这里只读文件，不修改桥接状态，也不要求桥接进程重启。
import fs from 'node:fs'
import path from 'node:path'

function statStamp(file) {
  try {
    const st = fs.statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function readJson(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  try {
    return JSON.parse(text)
  } catch {
    // bridge 用 atomicWriteJson（临时文件 + rename），正常不会读到半截 JSON。
    // 万一碰上了，重试一次，避免一轮注入因为一次瞬态读失败而空掉。
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      return null
    }
  }
}

function messageKey(message) {
  if (message?.messageId != null && String(message.messageId).trim() !== '') return `id:${message.messageId}`
  if (Number.isSafeInteger(Number(message?.seq))) return `seq:${message.seq}`
  return `hash:${message?.time ?? ''}|${message?.sender ?? ''}|${message?.text ?? ''}`
}

function mergeMessages(...lists) {
  const seen = new Set()
  const merged = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const message of list) {
      if (!message || typeof message !== 'object') continue
      const key = messageKey(message)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(message)
    }
  }
  merged.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0))
  return merged
}

export function createBridgeSource({ stateDir, logger = console } = {}) {
  if (!stateDir) throw new Error('qq-memory: 缺少 bridgeStateDir')
  const socialFile = path.join(stateDir, 'social-v2.json')
  const sessionsFile = path.join(stateDir, 'sessions.json')

  let socialStamp = ''
  let sessionsStamp = ''
  let conversations = new Map()
  let keyToSession = new Map()
  let sessionToKey = new Map()
  let lastError = ''

  function refresh({ force = false } = {}) {
    const nextSocialStamp = statStamp(socialFile) || 'missing'
    const nextSessionsStamp = statStamp(sessionsFile) || 'missing'
    const socialChanged = force || nextSocialStamp !== socialStamp
    const sessionsChanged = force || nextSessionsStamp !== sessionsStamp
    if (!socialChanged && !sessionsChanged) {
      return { changed: false, conversations: conversations.size, messages: countMessages() }
    }

    if (sessionsChanged) {
      const parsed = readJson(sessionsFile)
      const nextKeyToSession = new Map()
      const nextSessionToKey = new Map()
      const rows = parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
      for (const [key, sessionId] of Object.entries(rows)) {
        if (typeof sessionId !== 'string' || !sessionId) continue
        nextKeyToSession.set(key, sessionId)
        if (!nextSessionToKey.has(sessionId)) nextSessionToKey.set(sessionId, key)
      }
      keyToSession = nextKeyToSession
      sessionToKey = nextSessionToKey
      sessionsStamp = nextSessionsStamp || 'missing'
    }

    if (socialChanged) {
      const parsed = readJson(socialFile)
      const raw = parsed?.conversations && typeof parsed.conversations === 'object'
        ? parsed.conversations
        : parsed?.states && typeof parsed.states === 'object'
          ? parsed.states
          : {}
      const next = new Map()
      for (const [key, state] of Object.entries(raw)) {
        if (!key || !state || typeof state !== 'object') continue
        next.set(key, mergeMessages(state.recentMessages, state.unread))
      }
      conversations = next
      socialStamp = nextSocialStamp
    }

    const error = socialChanged && socialStamp === 'missing' ? `读不到 ${socialFile}` : ''
    if (error && error !== lastError) logger?.warn?.(`[qq-memory] ${error}`)
    lastError = error
    return { changed: true, conversations: conversations.size, messages: countMessages() }
  }

  function countMessages() {
    let count = 0
    for (const list of conversations.values()) count += list.length
    return count
  }

  function getMessages(qqKey) {
    if (!qqKey) return []
    if (!conversations.has(qqKey)) refresh({ force: false })
    return conversations.get(qqKey) ?? []
  }

  function getSessionKey(sessionId) {
    if (!sessionId) return null
    if (!sessionToKey.has(sessionId)) refresh({ force: false })
    return sessionToKey.get(sessionId) ?? null
  }

  function getSessionId(qqKey) {
    if (!qqKey) return null
    return keyToSession.get(qqKey) ?? null
  }

  function keys() {
    return [...conversations.keys()]
  }

  function entries() {
    const rows = []
    for (const [qqKey, list] of conversations) {
      const sessionId = keyToSession.get(qqKey) ?? null
      for (const message of list) rows.push({ qqKey, sessionId, message })
    }
    return rows
  }

  return {
    stateDir,
    socialFile,
    sessionsFile,
    refresh,
    getMessages,
    getSessionKey,
    getSessionId,
    keys,
    entries,
    countMessages,
  }
}
