/* 白饭对账：按 events.jsonl 重算礼物收入，并给出**音浪**合计。
 *
 * 为什么需要它：白饭的账被 events.jsonl 坑过三次，每次都是「看起来完全正常」的错：
 *   ① 上游每笔礼物发两遍（相隔 2~3 秒，除时间戳外一模一样）→ 账翻倍
 *   ② comboCount 是**这一串的累计数**，不是这一条新增几个（1→2→3→3→4…）
 *      → 直接相加，一串 5 连击会被算成 15 个
 *   ③ 天鹅羽翼 / 为你闪耀 是免费礼物，0 音浪（价表里写 0，不是「没查到」）
 * 桥里的 riceGift() 三条都兜住了，这个脚本照同一套规则重算，两边必须对得上。
 *
 * 用法：
 *   node tools/rice-recount.mjs                 # 本场（读账本里的 sessionAt）
 *   node tools/rice-recount.mjs --from=19:20     # 指定起点（不带日期就是今天）
 *   node tools/rice-recount.mjs --day=2026-10-29 --all   # 算整天
 *   node tools/rice-recount.mjs --write          # 写进 cache/rice.json 的 giftYuan
 *
 * ⚠️ 写完要重启桥才生效：桥把账本读进内存了，改文件它不知道。
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.cwd()
const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const WRITE = process.argv.includes('--write')
const WHOLE_DAY = process.argv.includes('--all')
const day = arg('day', new Date().toLocaleDateString('sv-SE')) // sv-SE = YYYY-MM-DD
const fromHHMM = arg('from', null)

/* ── 价格表（跟 bridge.giftDou 同一套规则）───────────────────────────
 * 精确匹配 → 正向包含（礼物名里带表里的名字）→ 都不中按 1 抖币。
 * 🔴 千万别加反向包含：那条会把「抖音」算成「抖音一号」。
 * 值为 0 = 免费礼物（不产生音浪），不是「没查到」。 */
const priceFile = JSON.parse(fs.readFileSync(path.join(DIR, 'cache', 'gift-price.json'), 'utf8'))
const PRICES = priceFile.prices || {}
const YUAN_PER_DOU = Number(process.env.ZY_YUAN_PER_DOU || 0.05) // 20 抖币 = 1 元（到手）
const YUAN_PER_BOWL = Number(process.env.ZY_RICE_BOWL || 1)

function douOf(name) {
  const g = String(name || '').trim()
  if (!g) return 0
  if (Number.isFinite(PRICES[g])) return PRICES[g]
  const hit = Object.keys(PRICES).find((k) => k.length >= 2 && k !== g && g.includes(k))
  return hit ? PRICES[hit] : 1
}

/* 连击断串的秒数直接从 bridge.mjs 里抠，别在这里写死第二份 —— 两边不一致时，
 * 脚本算的账和桥上跑的账会悄悄错开，那种 bug 最难查。 */
const bridgeSrc = fs.readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8')
const gapMatch = bridgeSrc.match(/const RICE_COMBO_GAP = (\d+)/)
const COMBO_GAP = gapMatch ? Number(gapMatch[1]) : 8000
if (!gapMatch) console.warn('⚠️ 没在 bridge.mjs 里找到 RICE_COMBO_GAP，按 8 秒算')

/* ── 扫事件，按连击合并 ─────────────────────────────────────────────── */
const lines = fs.readFileSync(path.join(DIR, 'events.jsonl'), 'utf8').trim().split('\n')

function recount(from, to) {
  const open = new Map() // uid|gift → 正在进行的这一串
  const combos = []
  let raw = 0

  for (const line of lines) {
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.t < from || ev.t >= to) continue
    const g = ev.d && ev.d.gift
    if (!g || !g.name) continue
    raw++

    const uid = String((ev.d.user && ev.d.user.id) || '')
    const n = Number(ev.d.comboCount) || 1
    const key = `${uid}|${g.name}`
    const cur = open.get(key)

    if (cur && ev.t - cur.last < COMBO_GAP) {
      cur.max = Math.max(cur.max, n) // 累计数，取最大，不是相加
      cur.last = ev.t
    } else {
      if (cur) combos.push(cur)
      open.set(key, { gift: g.name, max: n, last: ev.t })
    }
  }
  for (const c of open.values()) combos.push(c)

  const count = {}
  for (const c of combos) count[c.gift] = (count[c.gift] || 0) + c.max

  const rows = Object.entries(count)
    .map(([name, n]) => ({ name, n, dou: douOf(name), yuan: douOf(name) * n * YUAN_PER_DOU }))
    .sort((x, y) => y.yuan - x.yuan || y.n - x.n)

  return {
    raw,
    combos: combos.length,
    rows,
    totalDou: rows.reduce((s, r) => s + r.dou * r.n, 0),
    totalYuan: rows.reduce((s, r) => s + r.yuan, 0),
  }
}

/* ── 定窗口：默认「本场」（账本里记的 sessionAt）────────────────────── */
const riceFile = path.join(DIR, 'cache', 'rice.json')
let book = null
try {
  book = JSON.parse(fs.readFileSync(riceFile, 'utf8'))
} catch {}

const dayStart = new Date(`${day}T00:00:00+08:00`).getTime()
const dayEnd = dayStart + 86400000
let from = dayStart
let label = `${day} 全天`
if (fromHHMM) {
  from = new Date(`${day}T${fromHHMM}:00+08:00`).getTime()
  label = `${day} ${fromHHMM} 之后`
} else if (!WHOLE_DAY && book && book.sessionAt) {
  from = Number(book.sessionAt)
  label = `本场（${new Date(from).toTimeString().slice(0, 5)} 起）`
}

const r = recount(from, dayEnd)

console.log(`\n白饭对账 · ${label}（20 抖币 = 1 元；一碗 = ${YUAN_PER_BOWL} 元）`)
console.log(`原始事件 ${r.raw} 条 → 连击合并后 ${r.combos} 串\n`)
for (const row of r.rows) {
  const tag = row.dou === 0 ? '（免费礼物）' : `${String(row.dou).padStart(5)} 抖币/份`
  console.log(`  ${row.name.padEnd(6, '　')} ×${String(row.n).padEnd(4)} ${tag}  = ${row.yuan.toFixed(2)} 元`)
}
console.log(`\n  音浪（抖币）合计 ${r.totalDou}`)
console.log(`  折合 ${r.totalYuan.toFixed(2)} 元 = ${(r.totalYuan / YUAN_PER_BOWL).toFixed(2)} 碗`)
console.log(`  ↳ 跟直播间左上角的「音浪」对一下：数字应该一样。不一样就是价表里有礼物填错了。\n`)

/* 跟账本对比 */
if (book) {
  const had = Number(book.giftYuan) || 0
  const diff = r.totalYuan - had
  console.log(`账本里记的是 ${had.toFixed(2)} 元（${(had / YUAN_PER_BOWL).toFixed(2)} 碗），差 ${diff.toFixed(2)} 元`)
  if (Math.abs(diff) > 0.01) console.log('⚠️ 对不上。确认后用 --write 覆盖；不写就只看看。')
  else console.log('✅ 账本跟事件流一致')
}

if (WRITE) {
  const j = book || {}
  j.day = day
  j.giftYuan = Math.round(r.totalYuan * 100) / 100
  if (label.startsWith('本场') || fromHHMM) j.sessionAt = from
  fs.writeFileSync(riceFile, JSON.stringify(j, null, 2), 'utf8')
  console.log(`\n已写入 cache/rice.json：giftYuan = ${j.giftYuan}${j.sessionAt ? `，sessionAt = ${new Date(j.sessionAt).toTimeString().slice(0, 5)}` : ''}`)
  console.log('⚠️ 桥把账本读在内存里了 —— 要重启桥（POST /ctl/restart）才生效。')
}
