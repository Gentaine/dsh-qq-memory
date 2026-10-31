// 记忆引擎：把桥接状态写进 SQLite，再在每轮第一步挑出“旧聊天片段”交给模型。
//
// 设计取舍：
//   - 只注入“旧”消息（默认 3 小时前），避免和当前上下文重复；
//   - 不调用模型做摘要，不产生额外 token 成本；检索是本地同步计算；
//   - 默认按关键词 + 时间范围检索；用户说“还记得/上次/昨晚”时放宽门槛；
//   - 每个会话每 N 轮最多注入一次，避免每轮都塞一段旧账。
import { normalizeMessage } from './store.js'
import { normalizeText, tokenize } from './tokenize.js'

export const DEFAULT_CLEANUP = Object.freeze({
  enabled: true,
  intervalHours: 6,
  minAgeDays: 14,
  keepRecentTurns: 30,
  maxMessagesPerConversation: 5_000,
  batchSize: 200,
  ageSaturationDays: 90,
  weights: { age: 0.5, recall: 0.3, turnLength: 0.2 },
})

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  bridgeStateDir: '',
  databasePath: '',
  pollMs: 15_000,
  minAgeHours: 3,
  maxInjectedMessages: 8,
  maxInjectedChars: 1_800,
  cooldownTurns: 5,
  memoryIntentCooldownTurns: 1,
  candidateLimit: 2_500,
  queryLookbackMinutes: 120,
  minScore: 2.2,
  timeZone: 'Asia/Shanghai',
  debug: false,
  cleanup: DEFAULT_CLEANUP,
})

const MEMORY_INTENT = /(记得|还记得|记不记得|记忆|上次|上回|之前|以前|昨天|昨晚|前天|上周|历史|聊过|说过|提过|忘了|忘了吗|回忆|那次|当时|那会儿|继续|后来)/

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function resolveConfig(input = {}) {
  const rawCleanup = input.cleanup && typeof input.cleanup === 'object' ? input.cleanup : {}
  const rawWeights = rawCleanup.weights && typeof rawCleanup.weights === 'object' ? rawCleanup.weights : {}
  const weights = {
    age: clampNumber(rawWeights.age, DEFAULT_CLEANUP.weights.age, 0, 100),
    recall: clampNumber(rawWeights.recall, DEFAULT_CLEANUP.weights.recall, 0, 100),
    turnLength: clampNumber(rawWeights.turnLength, DEFAULT_CLEANUP.weights.turnLength, 0, 100),
  }
  if (weights.age + weights.recall + weights.turnLength === 0) {
    Object.assign(weights, DEFAULT_CLEANUP.weights)
  }
  return {
    ...DEFAULT_CONFIG,
    ...input,
    pollMs: clampInt(input.pollMs, DEFAULT_CONFIG.pollMs, 2_000, 10 * 60_000),
    minAgeHours: clampNumber(input.minAgeHours, DEFAULT_CONFIG.minAgeHours, 0, 24 * 365),
    maxInjectedMessages: clampInt(input.maxInjectedMessages, DEFAULT_CONFIG.maxInjectedMessages, 1, 30),
    maxInjectedChars: clampInt(input.maxInjectedChars, DEFAULT_CONFIG.maxInjectedChars, 300, 12_000),
    cooldownTurns: clampInt(input.cooldownTurns, DEFAULT_CONFIG.cooldownTurns, 0, 1000),
    memoryIntentCooldownTurns: clampInt(input.memoryIntentCooldownTurns, DEFAULT_CONFIG.memoryIntentCooldownTurns, 1, 1000),
    candidateLimit: clampInt(input.candidateLimit, DEFAULT_CONFIG.candidateLimit, 50, 20_000),
    queryLookbackMinutes: clampInt(input.queryLookbackMinutes, DEFAULT_CONFIG.queryLookbackMinutes, 5, 24 * 60),
    minScore: clampNumber(input.minScore, DEFAULT_CONFIG.minScore, 0.1, 1000),
    timeZone: typeof input.timeZone === 'string' && input.timeZone.trim() ? input.timeZone.trim() : DEFAULT_CONFIG.timeZone,
    cleanup: {
      ...DEFAULT_CLEANUP,
      ...rawCleanup,
      enabled: rawCleanup.enabled !== false,
      intervalHours: clampNumber(rawCleanup.intervalHours, DEFAULT_CLEANUP.intervalHours, 0.1, 24 * 365),
      minAgeDays: clampNumber(rawCleanup.minAgeDays, DEFAULT_CLEANUP.minAgeDays, 0, 3650),
      keepRecentTurns: clampInt(rawCleanup.keepRecentTurns, DEFAULT_CLEANUP.keepRecentTurns, 0, 1_000_000),
      maxMessagesPerConversation: clampInt(rawCleanup.maxMessagesPerConversation, DEFAULT_CLEANUP.maxMessagesPerConversation, 1, 1_000_000),
      batchSize: clampInt(rawCleanup.batchSize, DEFAULT_CLEANUP.batchSize, 1, 10_000),
      ageSaturationDays: clampNumber(rawCleanup.ageSaturationDays, DEFAULT_CLEANUP.ageSaturationDays, 1, 3650),
      weights,
    },
  }
}

function startOfLocalDay(now) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const DAY = 24 * 60 * 60 * 1000

/**
 * 清理优先级：越高越先删。
 *
 * 三个因子都归一到 0..1：
 *   - age：越老越高，到达 ageSaturationDays 后封顶 1；
 *   - recall：被回忆次数越少越高，0 次=1、1 次=0.5、2 次≈0.33；
 *   - exchange：这一轮里**对方发的消息条数**越少越高，0 条=1、1 条=0.5、2 条≈0.33。
 *
 * 注意 exchange 不是这一轮的总消息条数：我连续回很多句会把总消息条数撑大，
 * 但不会让这一轮显得更有交流价值。默认权重 age .5 / recall .3 / exchange .2。
 */
export function cleanupPriority({ sentAt, recallCount = 0, exchangeCount, turnSize, now = Date.now(), ageSaturationDays = 90, weights = DEFAULT_CLEANUP.weights }) {
  const ageDays = Math.max(0, (now - Number(sentAt || 0)) / DAY)
  const age = Math.min(1, ageDays / Math.max(1, Number(ageSaturationDays) || 90))
  const recall = 1 / (1 + Math.max(0, Number(recallCount) || 0))
  const exchanges = Math.max(0, Number(exchangeCount ?? turnSize ?? 0) || 0)
  const exchange = 1 / (1 + exchanges)
  return age * weights.age + recall * weights.recall + exchange * weights.turnLength
}

/**
 * 从自然的“昨晚/昨天/前天/上周”里推出一个时间窗。
 * 日期边界按运行机器的本地时区算（这台机器是 Asia/Shanghai）；timeZone 只用于展示。
 */
export function detectDateRange(query, now = Date.now()) {
  const text = normalizeText(query)
  if (!text) return null
  const today = startOfLocalDay(now)
  if (/昨晚|昨天|昨日/.test(text)) {
    return { from: today - DAY, to: today, label: '昨天' }
  }
  if (/前天/.test(text)) {
    return { from: today - 2 * DAY, to: today - DAY, label: '前天' }
  }
  if (/上周/.test(text)) {
    return { from: today - 14 * DAY, to: today - 7 * DAY, label: '上周' }
  }
  if (/今天|今日/.test(text)) {
    return { from: today, to: now, label: '今天' }
  }
  if (/最近|这几天/.test(text)) {
    return { from: today - 3 * DAY, to: now, label: '最近三天' }
  }
  return null
}

export function detectMemoryIntent(query) {
  return MEMORY_INTENT.test(normalizeText(query))
}

function scoreCandidates(candidates, queryTerms, now) {
  if (!candidates.length || !queryTerms.length) return []
  const querySet = new Set(queryTerms)
  const docs = candidates.map((candidate) => ({
    candidate,
    terms: new Set(tokenize(candidate.search_text)),
  }))
  const df = new Map()
  for (const doc of docs) {
    for (const term of doc.terms) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const total = docs.length
  const scored = []
  for (const doc of docs) {
    let rawScore = 0
    let hits = 0
    let specificHit = false
    for (const term of querySet) {
      if (!doc.terms.has(term)) continue
      hits += 1
      const idf = Math.log((total + 1) / ((df.get(term) ?? 0) + 1)) + 1
      const weight = term.length >= 4 ? 1.35 : term.length === 3 ? 1.12 : term.length === 1 ? 0.25 : 1
      rawScore += idf * weight
      if (term.length >= 4) specificHit = true
    }
    if (hits === 0) continue
    // 只命中一个非常常见的二字词时，宁可不用；命中一个四字以上的具体词则放行。
    if (hits < 2 && !specificHit) continue
    const ageDays = Math.max(0, (now - Number(doc.candidate.sent_at)) / DAY)
    const recency = 0.72 + 0.28 * Math.exp(-ageDays / 21)
    const shortPenalty = String(doc.candidate.search_text ?? '').length < 4 ? 0.85 : 1
    scored.push({
      ...doc.candidate,
      score: rawScore * recency * shortPenalty,
      hits,
    })
  }
  scored.sort((a, b) => b.score - a.score || b.sent_at - a.sent_at)
  return scored
}

function formatDate(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms))
    const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
  } catch {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

function displayText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function shorten(text, max) {
  const value = displayText(text)
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function formatMemoryBlock({ messages, reason, range, maxChars, timeZone }) {
  const header = '【旧聊天记忆｜本机对话表自动检索】\n'
    + '下面是从这个会话更早的聊天记录里找到的片段，不是本轮新消息，不需要回复这一段；只在确实相关时自然用上，不要逐字复述，也不要说“根据我的记忆数据库”。旧记录可能记错人名或时间，重要事实以当前对话为准。\n'
  const scope = range ? `检索范围：${range.label}。\n` : ''
  const footer = '\n（以上是历史片段，不是群里刚发生的事。）'
  const budget = Math.max(300, maxChars)
  const lines = []
  const usedIds = []
  // meta 里的“以下 N 条”必须和真正塞进去的行数一致，所以先按不含 meta 的预算收行，
  // 再用实际行数补 meta。
  let length = header.length + scope.length + footer.length + 80
  for (const message of messages) {
    const who = message.sender || (message.direction === 'out' ? '我' : '某人')
    const line = `- ${formatDate(message.sent_at, timeZone)} ${who}：${shorten(message.text, 180)}\n`
    if (length + line.length > budget) break
    lines.push(line)
    if (Number.isSafeInteger(message.id)) usedIds.push(message.id)
    length += line.length
  }
  if (!lines.length) return null
  const meta = `以下 ${lines.length} 条是本次挑出的旧片段。\n`
  const text = `${header}${scope}${meta}${lines.join('')}${footer}`
  return { text, lines: lines.length, reason, usedIds }
}

function uniqueMessages(messages) {
  const seen = new Set()
  const result = []
  for (const message of messages) {
    const key = `${message.sent_at}|${message.direction}|${message.sender ?? ''}|${normalizeText(message.text)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(message)
  }
  return result
}

export function createEngine({ store, bridge, config, logger = console } = {}) {
  if (!store) throw new Error('qq-memory: 缺少 store')
  if (!bridge) throw new Error('qq-memory: 缺少 bridge')
  const resolved = resolveConfig(config)
  const injectionState = new Map()
  let lastIngestAt = 0
  let lastIngest = { inserted: 0, updated: 0, messages: 0, changed: false }
  let lastCleanup = { deleted: 0, at: 0, details: [], skipped: 'not-run' }

  function ingest({ force = false } = {}) {
    const snapshot = bridge.refresh({ force })
    if (!snapshot.changed && !force) {
      lastIngest = { ...lastIngest, changed: false }
      return lastIngest
    }
    const now = Date.now()
    const rows = []
    for (const entry of bridge.entries()) {
      const row = normalizeMessage(entry)
      if (row) rows.push(row)
    }
    const result = store.upsertMany(rows)
    lastIngestAt = now
    lastIngest = {
      ...result,
      messages: rows.length,
      changed: true,
      conversations: snapshot.conversations,
      at: now,
    }
    if (resolved.debug) {
      logger?.info?.(`[qq-memory] ingest +${result.inserted} ~${result.updated} / ${rows.length} rows`)
    }
    return lastIngest
  }

  /**
   * 按“老、少被回忆、所在轮次短”优先清理。
   *
   * 触发条件：某个会话的消息数超过 maxMessagesPerConversation。
   * 双重保护：只清 minAgeDays 以前的消息，且不动最近 keepRecentTurns 轮。
   * 每次最多删 batchSize 条，给下一轮留出重新计算的机会。
   */
  function cleanup({ now = Date.now(), force = false, dryRun = false } = {}) {
    const cfg = resolved.cleanup
    if (!cfg.enabled && !force) {
      return { deleted: 0, at: now, details: [], skipped: 'disabled' }
    }
    const cutoff = now - cfg.minAgeDays * DAY
    let deleted = 0
    const details = []
    for (const conversation of store.conversationStats()) {
      const excess = conversation.messages - cfg.maxMessagesPerConversation
      if (excess <= 0) continue
      const maxTurn = conversation.maxTurn - cfg.keepRecentTurns
      if (maxTurn < 1) continue
      const candidates = store.cleanupCandidates({
        qqKey: conversation.qqKey,
        before: cutoff,
        maxTurn,
        limit: 50_000,
      })
      if (!candidates.length) continue
      // 只数对方消息。我连续发的一串消息不参与“交流次数”，否则刷屏越多越难被清。
      const exchanges = store.turnExchangeCounts(conversation.qqKey)
      const ranked = candidates
        .map((row) => ({
          ...row,
          priority: cleanupPriority({
            sentAt: row.sent_at,
            recallCount: row.recall_count,
            exchangeCount: exchanges.get(Number(row.turn_no)) ?? 0,
            now,
            ageSaturationDays: cfg.ageSaturationDays,
            weights: cfg.weights,
          }),
        }))
        .sort((a, b) => b.priority - a.priority || a.sent_at - b.sent_at)
      const take = ranked.slice(0, Math.min(excess, cfg.batchSize))
      if (!take.length) continue
      const removed = dryRun ? take.length : store.deleteMessages(take.map((row) => row.id))
      if (!dryRun) deleted += removed
      details.push({
        qqKey: conversation.qqKey,
        before: conversation.messages,
        after: conversation.messages - removed,
        deleted: removed,
        dryRun,
        ids: take.map((row) => row.id),
      })
    }
    const wouldDelete = details.reduce((sum, item) => sum + item.deleted, 0)
    lastCleanup = { deleted, wouldDelete, at: now, details, skipped: '', dryRun }
    if (deleted > 0) logger?.info?.(`[qq-memory] cleanup 删除 ${deleted} 条旧消息`)
    return lastCleanup
  }

  function lastIncomingTexts(messages, { max = 6, now = Date.now() } = {}) {
    const incoming = messages.filter((message) => message && message.isSelf !== true)
    const lookback = resolved.queryLookbackMinutes * 60 * 1000
    const recent = incoming.filter((message) => {
      const time = Number(message.time)
      return Number.isFinite(time) && time >= now - lookback
    })
    // 如果这段时间没人说话，就退回最近两条：至少让“你还记得吗”能带上一点上下文。
    const chosen = recent.length ? recent.slice(-max) : incoming.slice(-2)
    return chosen
      .map((message) => normalizeText(message.text ?? message.plain ?? ''))
      .filter(Boolean)
  }

  function buildInjection({ sessionId, turn = 0, step = 1, now = Date.now() } = {}) {
    if (!resolved.enabled || step !== 1) return null
    if (!sessionId) return null

    // 先把桥接状态里新到的消息补进表；失败不能影响主对话。
    try {
      bridge.refresh()
      const key = bridge.getSessionKey(sessionId)
      if (!key) return null
      const all = bridge.getMessages(key)
      if (all.length < 3) return null

      const incoming = lastIncomingTexts(all, { now })
      const queryText = incoming.join(' ')
      if (!queryText) return null
      // 意图和日期范围只看“最后一条别人说的话”。如果把更早的“昨晚”也算进来，
      // 一条 26 小时前的旧消息会把这次检索误判成“昨天”，把候选窗口裁错。
      const latestText = incoming[incoming.length - 1] ?? ''
      const intent = detectMemoryIntent(latestText)
      const range = detectDateRange(latestText, now)
      const cutoff = now - resolved.minAgeHours * 60 * 60 * 1000
      let candidates = store.candidates({ qqKey: key, before: cutoff, limit: resolved.candidateLimit })
      if (range) {
        candidates = candidates.filter((row) => row.sent_at >= range.from && row.sent_at < range.to)
      }
      if (!candidates.length) return null

      const scored = scoreCandidates(candidates, tokenize(queryText), now)
      let selected = []
      let reason = 'keyword'
      if (intent) {
        reason = 'intent'
        selected = scored.filter((row) => row.score >= resolved.minScore).slice(0, resolved.maxInjectedMessages)
        if (selected.length < 2) {
          // “你还记得吗”这种没有具体关键词的问法：直接给时间窗内最近的旧消息。
          const fallback = [...candidates].sort((a, b) => a.sent_at - b.sent_at).slice(-resolved.maxInjectedMessages)
          const seen = new Set(selected.map((row) => row.id))
          selected = [...selected, ...fallback.filter((row) => !seen.has(row.id))]
        }
      } else {
        if (!scored.length || scored[0].score < resolved.minScore) return null
        selected = scored.slice(0, resolved.maxInjectedMessages)
      }

      selected = uniqueMessages(selected).slice(0, resolved.maxInjectedMessages)
      if (!selected.length) return null

      const ids = selected.map((row) => row.id).sort((a, b) => a - b)
      const previous = injectionState.get(sessionId)
      if (previous?.turn === turn) return null
      // 同一批旧消息在 30 分钟内不重复塞；超过 30 分钟再问起同一件事时可以重新给。
      if (previous && previous.selectedIds === ids.join(',') && now - previous.at < 30 * 60 * 1000) return null
      if (!intent && previous && turn - previous.turn < resolved.cooldownTurns) return null
      if (intent && previous && turn - previous.turn < resolved.memoryIntentCooldownTurns) return null

      const formatted = formatMemoryBlock({
        messages: [...selected].sort((a, b) => a.sent_at - b.sent_at),
        reason,
        range,
        maxChars: resolved.maxInjectedChars,
        timeZone: resolved.timeZone,
      })
      if (!formatted || !formatted.usedIds.length) return null

      try {
        store.markRecalled(formatted.usedIds)
      } catch (error) {
        logger?.warn?.(`[qq-memory] 回忆计数失败：${error?.message ?? error}`)
      }
      injectionState.set(sessionId, {
        turn,
        at: now,
        ids: formatted.usedIds.join(','),
        selectedIds: ids.join(','),
      })
      return {
        text: formatted.text,
        key,
        reason,
        count: formatted.lines,
        ids: formatted.usedIds,
        range: range?.label ?? null,
      }
    } catch (error) {
      logger?.warn?.(`[qq-memory] buildInjection 失败：${error?.message ?? error}`)
      return null
    }
  }

  return {
    config: resolved,
    ingest,
    buildInjection,
    cleanup,
    getStats: () => ({
      ...lastIngest,
      lastIngestAt,
      cleanup: lastCleanup,
      store: store.stats(),
    }),
    _injectionState: injectionState,
  }
}
