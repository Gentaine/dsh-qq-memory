import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toSearchText, tokenize } from '../lib/tokenize.js'

test('中文切出 bigram/trigram，英文转小写，停用词被移除', () => {
  const terms = tokenize('昨晚聊 Stable Diffusion 训练集，你还记得吗')
  assert.ok(terms.includes('训练'))
  assert.ok(terms.includes('练集'))
  assert.ok(terms.includes('stable'))
  assert.ok(terms.includes('diffusion'))
  assert.ok(!terms.includes('昨晚'))
  assert.ok(!terms.includes('记得'))
})

test('媒体占位符不进入检索正文', () => {
  assert.equal(toSearchText('[图片] 你好 [表情123]'), '你好')
  assert.equal(toSearchText('[引用 某人：上一句] 下一句'), '下一句')
})
