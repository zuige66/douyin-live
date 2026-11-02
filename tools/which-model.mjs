/* tools/which-model.mjs —— 一键查「现在到底用的是哪个模型」
 * ═══════════════════════════════════════════════════════════════
 * 起因：2026-11-02 深夜 zuige 连着三次问「为什么用了 pro，快换回 flash」，
 *       但翻配置每一处都是 flash。来回解释不如给一条命令自己看。
 *
 * 它做三件事：
 *   1. 读 zhibo/llm.json —— 直播间弹幕回复（reply.mjs）的唯一模型来源
 *   2. 读 zhibo-auto/config.json —— 抖音评论区/私信自动回复（auto-reply.mjs）
 *   3. 真发一次极小请求，把**服务端返回的 model 字段**打出来
 *      （配置写 flash 但网关静默换成 pro 这种事，只有这一步能抓到）
 *
 * 用法：node tools/which-model.mjs
 * 🔴 只读 + 一次 20 token 的调用，不碰任何账号数据。
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUTO_DIR = path.join(path.dirname(DIR), 'zhibo-auto')

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', dim: '\x1b[2m', n: '\x1b[0m' }
const bad = (m) => `${C.r}${m}${C.n}`
const ok = (m) => `${C.g}${m}${C.n}`

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
const mask = (k) => (!k ? '（无）' : k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : '***')

console.log('\n=== 1. 直播间弹幕回复（zhibo/reply.mjs）===')
const live = readJson(path.join(DIR, 'llm.json'))
if (!live) {
  console.log(bad('  llm.json 读不到'))
} else {
  console.log('  文件   ', path.join(DIR, 'llm.json'))
  try { console.log('  改于   ', fs.statSync(path.join(DIR, 'llm.json')).mtime.toLocaleString('zh-CN')) } catch { }
  console.log('  model  ', /pro/i.test(live.model || '') ? bad(live.model) : ok(live.model))
  console.log('  base   ', live.base || '（无）')
  console.log('  key    ', mask(live.key))
}

console.log('\n=== 2. 评论区 / 私信自动回复（zhibo-auto）===')
const autoCfg = readJson(path.join(AUTO_DIR, 'config.json'))
const autoLlm = (autoCfg && autoCfg.llm) || {}
console.log('  文件   ', path.join(AUTO_DIR, 'config.json'))
let autoModel = autoLlm.model
if (!autoModel && autoLlm.from) {
  const j = readJson(path.resolve(autoLlm.from))
  autoModel = (j && j.model) || ''
  console.log(`  （没写死，跟着 llm.from 走：${autoLlm.from}）`)
}
console.log('  model  ', /pro/i.test(autoModel) ? bad(autoModel) : ok(autoModel || '（没配，会报错）'))

console.log('\n=== 3. 实调一次，看服务端真正回的是哪个 ===')
const base = String(live?.base || '').replace(/\/+$/, '')
const key = live?.key || ''
const probeModel = autoModel || live?.model
if (!base || !key || !probeModel) {
  console.log(bad('  缺 base/key/model，跳过'))
} else {
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: probeModel,
        messages: [{ role: 'user', content: '只回一个字：好' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    let j = null
    try { j = JSON.parse(text) } catch { }
    if (!j) {
      console.log(bad(`  HTTP ${res.status}，返回非 JSON：${text.slice(0, 120)}`))
    } else {
      const real = j.model || '（服务端没回 model 字段）'
      const flag = /pro/i.test(real)
      console.log('  请求时指定 ', probeModel)
      console.log('  服务端返回 ', flag ? bad(real) : ok(real))
      console.log('  耗时       ', `${Date.now() - t0}ms`)
      console.log('  回话       ', JSON.stringify(j.choices?.[0]?.message?.content || '').slice(0, 40))
      console.log(flag ? '\n' + bad('  ⚠️ 服务端返回的是 pro —— 配置骗人了，去查网关') : '\n' + ok('  ✅ 确实是 flash'))
    }
  } catch (e) {
    console.log(bad('  调用失败：' + String(e.message || e).slice(0, 120)))
  }
}
console.log('')
