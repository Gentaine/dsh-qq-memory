// 轻量中文/英文关键词切分。
//
// 这个插件故意不引入 jieba、不要 FTS5 的三叉分词器：对话量通常只有几千到几万条，
// 用汉字 bigram/trigram + 英文单词做倒排打分已经够用，而且不依赖任何原生扩展。
// 目的是“把旧对话找出来”，不是做搜索质量竞赛。

const HAN_RUN = /\p{Script=Han}+/gu
const LATIN_WORD = /[A-Za-z][A-Za-z0-9_'-]{1,}|[0-9]{2,}/g

// 这些词在聊天里高频但几乎没有区分度；不剔掉的话，每轮都会把无关旧消息捞上来。
const STOPWORDS = new Set([
  '这个', '那个', '这些', '那些', '什么', '怎么', '为什么', '如何', '可以', '不是', '就是',
  '我们', '你们', '他们', '她们', '它们', '大家', '自己', '别人', '现在', '刚才', '刚刚',
  '时候', '一个', '一下', '一点', '一直', '一起', '一样', '没有', '知道', '觉得', '还是',
  '但是', '因为', '所以', '如果', '然后', '而且', '已经', '真的', '可能', '应该', '需要',
  '今天', '昨天', '明天', '后天', '前天', '昨晚', '晚上', '早上', '中午', '下午',
  '这里', '那里', '这样', '那样', '这么', '那么', '多少', '几个', '东西', '事情',
  '感觉', '有点', '比较', '非常', '特别', '其实', '反正', '不过', '只是', '还有',
  '哈哈', '哈哈哈', '呵呵', '嘿嘿', '草', '确实', '完全', '直接', '开始', '结束',
  '记得', '还记', '得吗', '记不', '不记', '忘了', '忘吗',
  '你好', '在吗', '在么', '有人', '没人', '说话', '聊天', '回复', '消息',
])

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把一段聊天文本切成检索词。
 *
 * - 汉字连续段：bigram + trigram + 整段（整段不超过 8 字时）
 * - 英文/数字：长度 >= 2 的整词，统一小写
 * - 去停用词、去重、长词优先（长词更具体，打分时也更值钱）
 *
 * 例：「昨晚聊的 Stable Diffusion 训练集」→ sd? 不，是 stable / diffusion / 训练 / 练集 / 昨晚…
 * 单字「我」「你」等只在整段只有一个汉字时才保留，避免噪声。
 */
export function tokenize(value) {
  const text = normalizeText(value)
  if (!text) return []
  const terms = new Set()

  for (const match of text.matchAll(HAN_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      terms.add(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2))
    for (let i = 0; i + 3 <= run.length; i += 1) terms.add(run.slice(i, i + 3))
    if (run.length <= 8) terms.add(run)
  }

  for (const match of text.matchAll(LATIN_WORD)) {
    const word = match[0].toLowerCase()
    if (word.length >= 2) terms.add(word)
  }

  return [...terms]
    .filter((term) => !STOPWORDS.has(term))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
}

/** 只保留适合做检索正文的文本：媒体占位符和引用前缀会干扰关键词。 */
export function toSearchText(value) {
  return normalizeText(value)
    .replace(/\[(?:图片|表情|语音|视频|文件|转发消息|动画表情)[^\]]*\]/g, ' ')
    .replace(/\[引用[^\]]*\]/g, ' ')
    .replace(/\[(?:at|@)[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
