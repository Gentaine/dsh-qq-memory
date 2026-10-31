#!/usr/bin/env node
// 对话表命令行：stats / list / search / export / cleanup。
// 例：
//   node scripts/qq-memory.mjs stats
//   node scripts/qq-memory.mjs list --key group:123456789 --limit 20
//   node scripts/qq-memory.mjs search --query 训练集 --limit 10
//   node scripts/qq-memory.mjs export --format markdown --out ./exports/对话表.md
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from '../lib/engine.js'
import { openStore } from '../lib/store.js'

function parseArgs(argv) {
  const result = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      result._.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      result[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      result[name] = next
      i += 1
    } else {
      result[name] = true
    }
  }
  return result
}

function usage() {
  console.log(`qq-memory — 查看/导出 QQ 对话表

用法：
  node scripts/qq-memory.mjs stats [--json]
  node scripts/qq-memory.mjs list [--key group:123] [--limit 30] [--direction in|out] [--since 2026-10-30]
  node scripts/qq-memory.mjs search --query 关键词 [--key group:123] [--limit 20]
  node scripts/qq-memory.mjs export [--key group:123] [--format markdown|csv|json] [--out 文件]
  node scripts/qq-memory.mjs cleanup [--dry-run] [--max 5000] [--min-age-days 14] [--keep-turns 30]

通用参数：
  --db <path>    SQLite 路径，默认 $DSH_HOME 或 ~/.dsh/qq-memory/conversations.sqlite3
  --key <key>    group:群号 / private:QQ号
  --limit <n>    最多返回条数
  --since <日期> 只显示该日期（本地时区）之后的消息
`)
}

function localDate(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function parseSince(value) {
  if (!value) return 0
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function markdownCell(value) {
  return oneLine(value).replace(/\|/g, '\\|')
}

function csvCell(value) {
  const text = oneLine(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function printTable(rows) {
  if (!rows.length) {
    console.log('（没有记录）')
    return
  }
  const headers = ['时间', '轮', '回想', '会话', '方向', '发送者', '内容']
  const data = rows.map((row) => [
    localDate(row.sent_at),
    String(row.turn_no ?? ''),
    String(row.recall_count ?? 0),
    row.qq_key,
    row.direction === 'out' ? '我' : '对方',
    row.sender ?? '',
    oneLine(row.text).slice(0, 80),
  ])
  const widths = headers.map((header, i) => Math.max(header.length, ...data.map((line) => line[i].length)))
  const render = (line) => line.map((cell, i) => cell.padEnd(widths[i])).join('  ')
  console.log(render(headers))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const line of data) console.log(render(line))
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] || 'stats'
if (args.help || command === 'help') {
  usage()
  process.exit(0)
}

const dbPath = args.db
  ? path.resolve(args.db)
  : path.join(os.homedir(), '.dsh', 'qq-memory', 'conversations.sqlite3')
if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}\n先启动 DSH（插件会自动建表），或用 --db 指定路径。`)
  process.exit(2)
}

const store = openStore({ databasePath: dbPath, logger: { info() {}, warn() {} } })
try {
  if (command === 'stats') {
    const stats = store.stats()
    if (args.json) {
      console.log(JSON.stringify({ database: store.path, ...stats }, null, 2))
      process.exit(0)
    }
    console.log(`数据库：${store.path}`)
    console.log(`消息数：${stats.messages}    会话数：${stats.conversations}    总回忆次数：${stats.recalled}`)
    if (stats.earliest) console.log(`最早：${localDate(stats.earliest)}    最新：${localDate(stats.latest)}    最大轮次：${stats.maxTurn}`)
    if (stats.byKey.length) {
      console.log('')
      for (const row of stats.byKey) {
        console.log(`${row.qqKey}  ${String(row.messages).padStart(6)} 条  ${String(row.recalled).padStart(4)} 次回忆  最大轮次 ${row.maxTurn}  ${localDate(row.earliest)} ~ ${localDate(row.latest)}`)
      }
    }
    process.exit(0)
  }

  if (command === 'cleanup') {
    const pick = (...names) => names.find((name) => args[name] !== undefined)
    const maxName = pick('max', 'max-messages', 'maxMessagesPerConversation')
    const minAgeName = pick('min-age-days', 'minAgeDays')
    const keepTurnsName = pick('keep-turns', 'keepRecentTurns')
    const batchName = pick('batch', 'batchSize')
    const ageSatName = pick('age-saturation-days', 'ageSaturationDays')
    const cleanup = {
      enabled: true,
      maxMessagesPerConversation: maxName ? Number(args[maxName]) : 5_000,
      minAgeDays: minAgeName ? Number(args[minAgeName]) : 14,
      keepRecentTurns: keepTurnsName ? Number(args[keepTurnsName]) : 30,
      batchSize: batchName ? Number(args[batchName]) : 200,
      ageSaturationDays: ageSatName ? Number(args[ageSatName]) : 90,
    }
    const engine = createEngine({
      store,
      bridge: {},
      config: { cleanup },
      logger: { info() {}, warn: console.error },
    })
    const result = engine.cleanup({ dryRun: Boolean(args['dry-run']), force: true })
    console.log(`清理检查：${result.dryRun ? 'dry-run（未写入）' : '已执行'}，候选 ${result.wouldDelete} 条，实际删除 ${result.deleted} 条`)
    for (const detail of result.details) {
      console.log(`  ${detail.qqKey}: ${detail.before} → ${detail.after} 条，删除 ${detail.deleted} 条`)
    }
    process.exit(0)
  }

  if (command === 'list' || command === 'search') {
    const query = command === 'search' ? String(args.query ?? args.search ?? '') : ''
    if (command === 'search' && !query) {
      console.error('search 需要 --query 关键词')
      process.exit(2)
    }
    const rows = store.list({
      qqKey: args.key || '',
      limit: Number(args.limit) || 30,
      offset: Number(args.offset) || 0,
      direction: args.direction || '',
      since: parseSince(args.since),
      query,
    })
    if (args.json) console.log(JSON.stringify(rows, null, 2))
    else printTable(rows)
    process.exit(0)
  }

  if (command === 'export') {
    const format = String(args.format || 'markdown').toLowerCase()
    const rows = store.exportRows({ qqKey: args.key || '', limit: Number(args.limit) || 100_000 })
    let output
    if (format === 'json') {
      output = JSON.stringify(rows, null, 2)
    } else if (format === 'csv') {
      const header = 'time,qq_key,turn_no,recall_count,direction,sender,user_id,text'
      output = [header, ...rows.map((row) => [
        localDate(row.sent_at), row.qq_key, row.turn_no, row.recall_count,
        row.direction, row.sender ?? '', row.user_id ?? '', row.text,
      ].map(csvCell).join(','))].join('\n')
    } else if (format === 'markdown' || format === 'md') {
      const header = '| 时间 | 轮次 | 回想次数 | 会话 | 方向 | 发送者 | 内容 |'
      const divider = '| --- | --- | --- | --- | --- | --- | --- |'
      output = [header, divider, ...rows.map((row) => `| ${[
        localDate(row.sent_at), row.turn_no, row.recall_count,
        row.qq_key, row.direction === 'out' ? '我' : '对方', row.sender ?? '', row.text,
      ].map(markdownCell).join(' | ')} |`)].join('\n')
    } else {
      console.error('未知格式，只支持 markdown / csv / json')
      process.exit(2)
    }
    if (args.out) {
      const out = path.resolve(args.out)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, `${output}\n`, 'utf8')
      console.log(`已导出 ${rows.length} 条到 ${out}`)
    } else {
      console.log(output)
    }
    process.exit(0)
  }

  console.error(`未知命令：${command}`)
  usage()
  process.exit(2)
} finally {
  store.close()
}
