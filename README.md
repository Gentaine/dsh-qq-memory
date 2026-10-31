# dsh-qq-memory

给 **qq-bridge + DeepSeek Harness** 用的“对话表记忆”插件。

它把 QQ 聊天记录一行一条写进 SQLite，按话题自动召回旧消息；同时记录每条消息
**被回忆的次数**和**所在对话轮次**，并定期清理低价值旧消息。

不调用额外的模型，不注册新工具，因此不会被 `qq-chat-v2` 的
`qq-tool-restrict` 白名单挡住，也不需要修改 qq-bridge。

---

## 功能

- **落表**：读取 qq-bridge 的 `state/social-v2.json`，把入站/出站消息写进 SQLite。
- **自动回忆**：在 DSH 每轮第一步，从旧消息里按关键词 + 时间窗挑 1–8 条，作为
  `source.kind = "qq-table-memory"` 的上下文追加给模型。
- **回忆计数**：消息真正进入 prompt 时 `recall_count + 1`。
- **对话轮次**：按“对方发起 → 我回应”的规则给每条消息标 `turn_no`。
- **定期清理**：按“时间越久、被回忆越少、所在轮次越短”的优先级删除旧消息。
- **同会话隔离**：不会把 A 群的旧账带进 B 群或私聊。
- **可导出**：`list`、`search`、Markdown / CSV / JSON 导出。
- **可回填**：可选脚本从 DSH 会话日志里补更早的消息快照。

---

## 前置条件

- DeepSeek Harness **0.2.x**（插件在 0.2.1-rc.3 上开发和测试）
- Node.js **>= 24**（使用内置 `node:sqlite`）
- 已安装并运行的 [qq-bridge](https://github.com/Derpyu520/qq-bridge)
- qq-bridge 处于 `reserved2` 模式，并且 `state/social-v2.json` 正在更新

---

## 安装

### 1. 放到本机

```powershell
git clone https://github.com/Gentaine/dsh-qq-memory.git `
  "$HOME\.dsh\plugins\dsh-qq-memory"
```

也可以放在任意目录，后面把路径换成实际路径。

### 2. 注册到 DSH profile

编辑 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-qq-memory": "link:<绝对路径>/dsh-qq-memory"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-qq-memory"
      ]
    }
  }
}
```

在 profile 的 `node_modules` 里建立链接：

```powershell
# Windows
New-Item -ItemType Junction `
  -Path "$HOME\.dsh\profiles\<profile>\node_modules\dsh-qq-memory" `
  -Target "<绝对路径>\dsh-qq-memory"

# Linux / macOS
ln -s "<绝对路径>/dsh-qq-memory" "$HOME/.dsh/profiles/<profile>/node_modules/dsh-qq-memory"
```

> 如果 profile 里有 `pnpm-lock.yaml`，还需要让 lock 指向同一个本地路径，
> 否则 DSH 启动时可能按旧 lock 重装。桌面版没有 lock 时直接重启即可。

### 3. 配置路径

插件自带的 `cordis.patch.yml` 使用以下默认值：

- `bridgeStateDir`：`./qq-bridge/state`（相对于 DSH 进程的 cwd）
- `databasePath`：`~/.dsh/qq-memory/conversations.sqlite3`

如果你的 qq-bridge 不在 DSH 工作区的 `qq-bridge/` 下，打开
`dsh-qq-memory/cordis.patch.yml`，取消注释并改成实际路径：

```yaml
- insert:
    - id: qq-memory
      name: dsh-qq-memory
      config:
        enabled: true
        bridgeStateDir: '/absolute/path/to/qq-bridge/state'
        databasePath: '/absolute/path/to/conversations.sqlite3'
        # ...
```

Windows 路径请用单引号包起来，例如：

```yaml
        bridgeStateDir: 'D:\qq-bridge\state'
```

### 4. 重启 DSH

插件在 bundle 装配阶段加载，改完必须重启 DSH。

### 5. 确认

```powershell
node dsh-qq-memory/scripts/qq-memory.mjs stats `
  --db "$HOME/.dsh/qq-memory/conversations.sqlite3"
```

看到消息数、会话数、总回忆次数、最大轮次就说明表已经建好。

---

## 表结构

```sql
CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  qq_key       TEXT    NOT NULL,       -- group:群号 / private:QQ号
  session_id   TEXT,                   -- qq-bridge 映射的 DSH session
  seq          INTEGER,                -- 桥接本地序号
  message_id   TEXT,                   -- QQ message_id
  sent_at      INTEGER NOT NULL,       -- 毫秒时间戳
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
```

索引：

```sql
CREATE UNIQUE INDEX messages_dedupe ON messages (qq_key, dedupe_key);
CREATE INDEX messages_key_time ON messages (qq_key, sent_at);
CREATE INDEX messages_key_direction_time ON messages (qq_key, direction, sent_at);
CREATE INDEX messages_cleanup ON messages (qq_key, turn_no, sent_at);
```

去重优先级：`message_id` → `seq` → `内容哈希`。同一条消息被
`recentMessages` 和 `unread` 同时带上时只会留一行。

### 轮次 `turn_no`

- 第一轮从第 1 条消息开始；
- 当“上一条是我发的、下一条是对方发的”时，进入下一轮；
- 连续几条对方消息算同一轮，我连续补充几句也算同一轮。

所以一轮通常就是“对方发起 → 我回应”。这一轮里有多少条消息，就是清理规则里的
“轮次长度”。

### 回忆次数 `recall_count`

`buildInjection` 真正把某条旧消息塞进注入块时，调用 `store.markRecalled(usedIds)`，
对应行 `recall_count + 1`。被长度截断、没进入 prompt 的消息不计数；用 CLI 查看也不计数。

旧库第一次打开时会自动补 `recall_count=0` 并按上述规则重算 `turn_no`。

---

## 定期清理

默认每 **6 小时**检查一次，启动 10 秒后也检查一次。

只有单个会话超过 `maxMessagesPerConversation`（默认 5000 条）才触发；并且：

- 只清 `minAgeDays`（默认 14 天）以前的消息；
- 不动最近 `keepRecentTurns`（默认 30）轮。

对剩下的候选，按清理优先级从高到低删，每次最多 `batchSize` 条：

```text
priority = ageScore * 0.5
         + recallScore * 0.3
         + turnLengthScore * 0.2

ageScore        = min(1, 消息年龄天数 / ageSaturationDays)  // 越老越高
recallScore     = 1 / (1 + recall_count)                    // 越少被回忆越高
turnLengthScore = 1 / (1 + 这一轮的消息条数)                 // 轮次越短越高
```

默认 `ageSaturationDays = 90`，权重为 `age=0.5, recall=0.3, turnLength=0.2`。
优先级越高越先删：

- 很久没提、从没被回忆、当时只有一两句的寒暄最先走；
- 经常被想起的、最近 30 轮的、长讨论里的关键消息留得更久。

---

## 配置

配置在 `cordis.patch.yml` 的 `config` 块：

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `bridgeStateDir` | `./qq-bridge/state` | 桥接状态目录 |
| `databasePath` | `~/.dsh/qq-memory/conversations.sqlite3` | SQLite 路径 |
| `minAgeHours` | `3` | 只把 N 小时以前的消息当“旧记忆” |
| `maxInjectedMessages` | `8` | 一次最多注入几条 |
| `maxInjectedChars` | `1800` | 注入块字符上限 |
| `cooldownTurns` | `5` | 普通关键词命中的冷却轮数 |
| `memoryIntentCooldownTurns` | `1` | 明确记忆问法的冷却轮数 |
| `queryLookbackMinutes` | `120` | 用最近多少分钟的消息当查询 |
| `candidateLimit` | `2500` | 单次检索最多扫多少条旧消息 |
| `minScore` | `2.2` | 关键词命中门槛 |
| `pollMs` | `15000` | 定时补录间隔 |
| `timeZone` | `Asia/Shanghai` | 展示时间用的时区 |
| `debug` | `false` | 打印每次导入的条数 |
| `cleanup.enabled` | `true` | 定期清理总开关 |
| `cleanup.intervalHours` | `6` | 每隔多少小时检查一次 |
| `cleanup.minAgeDays` | `14` | 只清 N 天以前的消息 |
| `cleanup.keepRecentTurns` | `30` | 保留最近 N 轮 |
| `cleanup.maxMessagesPerConversation` | `5000` | 单会话超过多少条才触发 |
| `cleanup.batchSize` | `200` | 单次最多删多少条 |
| `cleanup.ageSaturationDays` | `90` | 年龄多少天后 `ageScore` 达到 1 |
| `cleanup.weights.age` | `0.5` | 时间权重 |
| `cleanup.weights.recall` | `0.3` | 被回忆次数权重 |
| `cleanup.weights.turnLength` | `0.2` | 轮次长度权重 |

改 `cordis.patch.yml` 后重启 DSH。

---

## 命令行

```bash
DB="$HOME/.dsh/qq-memory/conversations.sqlite3"
node scripts/qq-memory.mjs stats --db "$DB"
node scripts/qq-memory.mjs list --db "$DB" --limit 30
node scripts/qq-memory.mjs search --db "$DB" --query '训练集'
node scripts/qq-memory.mjs export --db "$DB" --format markdown --out ./exports/对话表.md
```

Windows PowerShell：

```powershell
$db = "$HOME\.dsh\qq-memory\conversations.sqlite3"
node scripts/qq-memory.mjs list --db $db --limit 30
```

`list` 和导出都带 `turn_no`（轮次）与 `recall_count`（被回忆次数）两列。

### 预览 / 执行清理

```powershell
# 只算不删（用很小的上限做演示）
node scripts/qq-memory.mjs cleanup --db $db `
  --dry-run --max 100 --min-age-days 0 --keep-turns 0

# 按默认参数真正执行
node scripts/qq-memory.mjs cleanup --db $db
```

默认规则下，只有会话超过 5000 条、消息超过 14 天、且不在最近 30 轮，才可能进入候选。

### 回填更早的会话日志

qq-bridge 的 `recentMessages` 只保留最近 100–200 条。DSH 会话日志里还留着模型过去读过的
`qq_get_*` 消息快照，可以补进表里：

```powershell
node scripts/backfill-session-logs.mjs --db $db --dry-run
node scripts/backfill-session-logs.mjs --db $db
```

脚本只读 `~/.dsh/sessions` 和桥接 `sessions.json`，不会改桥接状态；重复跑不会翻倍。

---

## 工作方式

qq-bridge 发给 DSH 的 `user/message` 是一大段唤醒提示词，真正的群消息在
`mcp__snowluma__qq_get_*` 的 tool result 里。按 DSH 事件反推既绕又容易漏。

桥接自己已经把入站/出站消息写进 `state/social-v2.json` 的 `recentMessages`，
字段稳定（`seq/messageId/sender/userId/text/isSelf/time`），直接读它最贴近 QQ 的真实对话。

插件读取文件，不修改桥接状态，也不要求桥接进程额外装插件。

注入形式是一条 `user` 角色、`source.kind = "qq-table-memory"` 的上下文消息，不是系统提示词，
也不是 QQ 群消息。这样：

- 不破坏 system prompt 的前缀缓存；
- 不会在 transcript 里被误认为群友发言；
- qq-bridge 不会把它当成新 QQ 消息。

---

## 已知限制

- **历史来源有限**：桥接只保留最近 100–200 条；回填脚本也只能补到模型当时读过的快照。
- **纯词法检索**：没有向量/同义词语义，“昨晚那个东西”这类没有具体词的问法只能靠时间窗兜底。
- **不生成摘要**：注入原始片段，不是人物小传。
- **清理是硬删除**：被清掉的消息不会进归档；需要留档请定期备份 SQLite 文件。
- **同会话作用域**：默认不做跨群/跨私聊共享。
- **明文落盘**：聊天内容原样进 SQLite，目录应按隐私数据处理。
- **坏 sender 兜底**：SnowLuma 偶尔会把带控制字符的二进制串写进 `sender`，插件会用
  `群友<QQ 后四位>` 代替。

---

## License

MIT
