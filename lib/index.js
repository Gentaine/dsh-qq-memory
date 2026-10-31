// DSH 插件入口：把 QQ 桥接的对话表变成“旧聊天记忆”，在每轮第一步追加给模型。
//
// 这个插件不注册新工具，所以不会被 qq-chat-v2 的 qq-tool-restrict 白名单挡住；
// 它只在 agent/pre-step 里追加一条带 source.kind 的 user 角色上下文。
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createBridgeSource } from './bridge-source.js'
import { createEngine, resolveConfig } from './engine.js'
import { openStore } from './store.js'

export const name = 'qq-table-memory'

function makeLogger(debug) {
  const prefix = '[qq-memory]'
  return {
    info: (...args) => {
      if (debug) console.error(prefix, ...args)
    },
    warn: (...args) => console.error(prefix, ...args),
  }
}

export function createRuntime(input = {}) {
  const workspace = process.cwd()
  const config = resolveConfig({
    bridgeStateDir: input.bridgeStateDir
      || process.env.QQ_MEMORY_BRIDGE_STATE
      || path.join(workspace, 'qq-bridge', 'state'),
    databasePath: input.databasePath
      || process.env.QQ_MEMORY_DB
      || path.join(os.homedir(), '.dsh', 'qq-memory', 'conversations.sqlite3'),
    ...input,
  })
  const logger = input.logger ?? makeLogger(config.debug)
  const store = openStore({ databasePath: config.databasePath, logger })
  const bridge = createBridgeSource({ stateDir: config.bridgeStateDir, logger })
  const engine = createEngine({ store, bridge, config, logger })

  try {
    engine.ingest({ force: true })
  } catch (error) {
    logger.warn(`首次导入桥接对话失败：${error?.message ?? error}`)
  }

  return {
    config,
    store,
    bridge,
    engine,
    close() {
      store.close()
    },
  }
}

export function makeMemoryMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: name,
      form: 'snapshot',
      sections: [{ name, text }],
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  let runtime
  try {
    runtime = createRuntime(rawConfig)
  } catch (error) {
    console.error(`[qq-memory] 插件未启用：${error?.message ?? error}`)
    return
  }

  const { config, engine } = runtime
  console.error(`[qq-memory] 已加载：state=${config.bridgeStateDir} db=${runtime.store.path}`)

  ctx.effect(() => () => runtime.close(), 'qq-memory.close')

  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        engine.ingest()
      } catch (error) {
        console.error(`[qq-memory] 定时导入失败：${error?.message ?? error}`)
      }
    }, config.pollMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'qq-memory.ingest')

  // 清理单独一个定时器：默认每 6 小时检查一次，启动 10 秒后再跑一次（避免挡住插件装配）。
  ctx.effect(() => {
    const runCleanup = () => {
      try {
        const result = engine.cleanup()
        if (result.deleted > 0) {
          console.error(`[qq-memory] 定期清理：删除 ${result.deleted} 条低价值旧消息`)
        }
      } catch (error) {
        console.error(`[qq-memory] 定期清理失败：${error?.message ?? error}`)
      }
    }
    const initial = setTimeout(runCleanup, 10_000)
    initial.unref?.()
    const timer = setInterval(runCleanup, Math.max(60_000, config.cleanup.intervalHours * 60 * 60 * 1000))
    timer.unref?.()
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, 'qq-memory.cleanup')

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'reject' || signal?.aborted) return decision
      if (step !== 1) return decision
      const result = engine.buildInjection({
        sessionId: agent?.session?.id,
        turn: Number(turn) || 0,
        step,
        now: Date.now(),
      })
      if (!result) return decision
      return {
        ...decision,
        messages: [...(decision.messages ?? []), makeMemoryMessage(result.text)],
      }
    } catch (error) {
      console.error(`[qq-memory] 注入失败：${error?.message ?? error}`)
      return decision
    }
  }, { prepend: true })
}
