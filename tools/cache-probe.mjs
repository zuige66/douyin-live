/**
 * tools/cache-probe.mjs —— 量 DeepSeek 上下文缓存到底命中没
 *
 * 为什么要有它：主人看平台用量发现「缓存命中好低」，但缓存是按**前缀**算的，
 * 光看控制台看不出是「请求太稀」还是「前缀不稳定」。这里直接打三次同样的请求，
 * 把 usage 里的 prompt_cache_hit_tokens / prompt_cache_miss_tokens 打出来。
 *
 * 用法：node tools/cache-probe.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONF = JSON.parse(fs.readFileSync(path.join(DIR, 'llm.json'), 'utf8'))

const persona = fs
  .readFileSync(path.join(DIR, 'prompts', 'dafeiyu-live.md'), 'utf8')
  .replace(/^\s*<!--[\s\S]*?-->/, '')
  .trim()

const FALLBACK = '你是直播间的虚拟主播「zuige大肥鱼」。一句话，20 个汉字以内。'

async function ask(sys, user, tag) {
  const body = {
    model: CONF.model,
    temperature: 0.9,
    max_tokens: 120,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  }
  if (/deepseek/i.test(CONF.base)) body.thinking = { type: 'disabled' }

  const t0 = Date.now()
  const res = await fetch(`${CONF.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CONF.key}` },
    body: JSON.stringify(body),
  })
  const j = await res.json()
  const u = j.usage || {}
  const ms = Date.now() - t0
  const hit = u.prompt_cache_hit_tokens ?? 0
  const miss = u.prompt_cache_miss_tokens ?? 0
  const inTok = u.prompt_tokens ?? 0
  const pct = inTok ? ((hit / inTok) * 100).toFixed(1) : '—'
  console.log(
    `${tag}  ${String(ms).padStart(5)}ms  输入 ${String(inTok).padStart(4)}  ` +
      `命中 ${String(hit).padStart(4)}  未命中 ${String(miss).padStart(4)}  命中率 ${pct}%`,
  )
  if (j.error) console.log('   ERROR', JSON.stringify(j.error).slice(0, 200))
  return { hit, miss, inTok }
}

const q = [
  '阿伟 说：这歌真好听。回他一句。',
  'momo 说：主播今天状态不错啊。回他一句。',
  '小蒋 说：这是 AI 吗 好像真人。回他一句。',
]

console.log(`模型 ${CONF.model} · 人设 ${persona.length} 字`)
console.log('--- 第 1 轮：连打三次（同一个 system 前缀）---')
const r1 = []
for (let i = 0; i < q.length; i++) r1.push(await ask(persona, q[i], `#${i + 1}`))

console.log('--- 第 2 轮：换成内置短人设（前缀变了，应该全 miss）---')
await ask(FALLBACK, q[0], '#4')

console.log('--- 第 3 轮：换回长人设（前缀回到第一次，看还在不在）---')
await ask(persona, q[1], '#5')

const totIn = r1.reduce((a, b) => a + b.inTok, 0)
const totHit = r1.reduce((a, b) => a + b.hit, 0)
console.log(`\n前三次合计：输入 ${totIn} tok，命中 ${totHit}，命中率 ${((totHit / totIn) * 100).toFixed(1)}%`)
