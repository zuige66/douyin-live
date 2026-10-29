#!/usr/bin/env node
/**
 * 抖音直播弹幕桥 · douyin-mcp → HTTP 快照(/state.json) + SSE(/events)（画面走原生 Win32 窗口）
 *
 * 为什么需要这层：
 *   1) get_live_events 返回的是「监听开始以来的全量累积数组」，没有 id、不清空，
 *      所以必须自己维护游标做增量，否则每次轮询都会把历史弹幕重播一遍。
 *   2) 它的 service 层只 append 了 ev.Data，把 ev.Kind 丢了（service.go:549），
 *      所以事件类型只能靠字段形状反推。
 *   3) 画面是原生 Win32 窗口，跨进程没法直接 postMessage，所以用 SSE 推。
 *
 * 用法：
 *   node bridge.mjs --rid 123456789          # 真直播间
 *   node bridge.mjs --demo                   # 假数据，验证链路
 *   node bridge.mjs --rid 123456789 --port 18081 --member
 *
 * 画面是原生 Win32 窗口，直播伴侣里用「窗口捕捉」抓它；面板/音乐台走 /settings.html、/music.html。
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  makeReply, replyMode, probeLLM, llmConfigured, cacheStats, llmHealth,
  isSongRequest, songAsk, isSongHelp, SONG_TIP, personaInfo,
  kbInfo, kbSet, kbPick, skinInfo,
  isVideoRequest,
  isSkipRequest,
  setReplyMode, replyModeText,
} from './reply.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ 参数 */
const argv = process.argv.slice(2)
function arg(name, def) {
  const eq = argv.find((a) => a.startsWith('--' + name + '='))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf('--' + name)
  if (i >= 0) {
    const v = argv[i + 1]
    if (v && !v.startsWith('--')) return v
    return true
  }
  return def
}
const has = (n) => argv.includes('--' + n)

const HTTP_PORT = Number(arg('port', 18081))
const MCP_PORT = Number(arg('mcp-port', 18080))
const TOKEN = String(arg('token', 'dsh-live-local'))
const MCP_EXE = String(
  arg('mcp', 'C:/Users/lirui/.dsh/douyin-duty/douyin-mcp-windows-amd64.exe')
)
const DEMO = has('demo')
const SHOW_MEMBER = has('member') // 进场消息默认不刷屏
const LOG_FILE = has('no-log') ? null : path.join(DIR, 'events.jsonl')
const HB_FILE = has('no-log') ? null : path.join(DIR, 'hb.log')
const RID_RAW = String(arg('rid', '') || '')
const SHARE = String(arg('share', '') || '')
// 也认位置参数：node bridge.mjs <房间号/链接>（手打命令时少写 --rid）
const POSITIONAL = argv.find((a) => !a.startsWith('--') && a !== String(arg('rid', '')) && a !== String(arg('share', ''))) || ''

/**
 * 从「用户手上那坨东西」里把房间抠出来。
 *
 * 🔴 2026-10-26 实测踩到的：抖音「分享 → 复制链接」复制出来的是**一整段话**：
 *     1- #在抖音，记录美好生活#【zuige大肥鱼】正在直播，来和我一起支持Ta吧。
 *     复制下方链接，打开【抖音】，直接观看直播！ https://v.douyin.com/TWAPzHsvdgc/ 4@1.com :8pm
 *   旧代码只认「整串就是一个链接/数字」，于是这坨东西被当成房间号 ⇒ 认不出来 ⇒
 *   桥照样起来了（HTTP 服务还在），但一条事件都没有 —— 最难查的那种"绿着但没数据"。
 *   现在：先把链接/长数字抠出来，抠到就用，抠不到才报错。
 */
function extractTarget(s) {
  const t = String(s || '').trim()
  if (!t) return ''
  // ① 分享短链 / 直播间链接（后面可能跟一堆中文和 @ 符号，截到空白或中文为止）
  const link = t.match(/https?:\/\/(?:v|live)\.douyin\.com\/[A-Za-z0-9_\-]+/i)
  if (link) return link[0]
  // ② live.douyin.com/<数字>
  const live = t.match(/live\.douyin\.com\/(\d{8,14})/i)
  if (live) return live[1]
  // ③ 一长串数字（19 位 room_id / 12 位 web_rid），允许夹在文字里
  const num = t.match(/\d{8,20}/)
  if (num) return num[0]
  return ''
}

const TARGET = extractTarget(RID_RAW) || extractTarget(SHARE) || extractTarget(POSITIONAL)
let RID = normalizeRid(TARGET)
let ROOM_OWNER = '' // 房间是谁的（reflow 里带的昵称），面板用来核对"是不是我登录的号"

/* ── 待机（2026-10-27）────────────────────────────────────────────────
 * 主人原话：「现在没开播还不能登录」「开播之后还是识别不到房间，要我重新分享
 * 链接才行，然后我就要全停再重启画面跟桥」。
 *
 * 旧行为：解析不出房间就 `return` —— HTTP 还在、进程还活着，但 RID 是空的：
 *   · 监听没起、直播状态不轮询 ⇒ 一条弹幕都没有
 *   · 面板看着"桥在跑"，其实是个空壳
 *   · 唯一的出路是重新粘一条分享链接 + 全停再重启
 *
 * 新行为：认不出房间 ⇒ **待机**（IDLE），进程不退出：
 *   · 账号登录、礼物设置、媒体设置全都照常可用（它们不依赖房间）
 *   · 每 30 秒拿上次给的那坨东西重试一次解析，开播后自己就接上了
 *   · POST /room/set 随时换房间，不用重启
 * 注意 RID 必须清空：留着 19 位 room_id 去 start_live_listen 会「启动成功但
 * 一条事件都没有」，那比直接失败更难查。 */
let ROOM_TARGET = TARGET // 用户给的原始输入（链接 / room_id / web_rid），重试和换房间都靠它
let IDLE_WHY = '' // 上次没认出房间的原因（面板直接显示）
const isIdle = () => !DEMO && !(RID && LISTEN_OK)

const UA_M =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

function normalizeRid(s) {
  if (!s) return ''
  const m = String(s).match(/live\.douyin\.com\/(\d+)/)
  if (m) return m[1]
  // 纯数字直接当房间号；其他形式（?room_id=）兜底取最后一段数字
  const n = String(s).match(/(\d{5,})/)
  return n ? n[1] : ''
}

/**
 * 把「用户手上有的任何东西」变成 web_rid。
 *
 * 三种输入都吃：
 *   1. https://v.douyin.com/xxxxxx/   分享短链（会先 302 到 reflow/<room_id>）
 *   2. 7700964960230214434            19 位 room_id
 *   3. 208717515082                   12 位 web_rid，原样返回
 *
 * 为什么要转：start_live_listen 只认 web_rid，而抖音分享出来的是 room_id。
 * 这两个不是一回事，直接拿 19 位去连会「启动成功但一条事件都没有」。
 * reflow/info 这个接口免登录，拿 room_id 换 owner.web_rid 就够。
 */
async function resolveRoom(input) {
  const s = String(input).trim()

  if (/^https?:\/\//i.test(s)) {
    const direct = s.match(/live\.douyin\.com\/(\d{8,14})/)
    if (direct) return { webRid: direct[1], nickname: '', live: null, roomId: '' }
    const r = await fetch(s, { redirect: 'manual', headers: { 'user-agent': UA_M } })
    const loc = r.headers.get('location') || ''
    const m = loc.match(/reflow\/(\d+)/) || loc.match(/room_id=(\d+)/) || s.match(/reflow\/(\d+)/)
    if (!m) throw new Error(`这个链接里找不到 room_id（location=${loc.slice(0, 120) || '无'}）`)
    return await roomIdToWebRid(m[1])
  }
  if (/^\d{15,}$/.test(s)) return await roomIdToWebRid(s)
  if (/^\d{8,14}$/.test(s)) return { webRid: s, nickname: '', live: null, roomId: '' }
  throw new Error('看不懂这个房间标识：' + s)
}

async function roomIdToWebRid(roomId) {
  const api =
    'https://webcast.amemv.com/webcast/room/reflow/info/?type_id=0&live_id=1' +
    `&room_id=${roomId}&version_code=180800&app_id=1128`
  const r = await fetch(api, { headers: { 'user-agent': UA_M } })
  const j = await r.json()
  const room = j?.data?.room
  if (!room) throw new Error(`reflow 没返回房间（room_id=${roomId}），可能已失效`)
  const owner = room.owner || {}
  if (!owner.web_rid) throw new Error('房间信息里没有 web_rid')
  // 注意别用 finish_time 判断：那是开播时按下播时长算出来的「计划下播时间」，
  // 正常直播也会有一个已经过去的 finish_time。真信号是 status：
  // 0 未开播 / 2 直播中 / 4 已结束。
  const live = room.status === 2 ? true : room.status === 4 ? false : null
  return {
    webRid: String(owner.web_rid),
    nickname: owner.nickname || '',
    live,
    roomId,
    status: room.status,
  }
}

/* --------------------------------------------------------------- 小工具 */
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a)
const toNum = (v) => {
  if (typeof v === 'number') return v
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
function parseCn(s) {
  if (typeof s === 'number') return s
  const m = String(s ?? '').replace(/,/g, '').match(/([\d.]+)\s*(万|w|W|亿)?/)
  if (!m) return 0
  let n = parseFloat(m[1])
  if (!Number.isFinite(n)) return 0
  if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') n *= 1e4
  if (m[2] === '亿') n *= 1e8
  return Math.round(n)
}
function tcpAlive(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      try { s.destroy() } catch {}
      res(v)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.setTimeout(500, () => done(false))
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------ MCP 客户端 */
class Mcp {
  constructor(port, token) {
    this.url = `http://127.0.0.1:${port}/mcp`
    this.token = token
    this.sid = null
    this.id = 0
  }

  async rpc(method, params) {
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${this.token}`,
    }
    if (this.sid) headers['mcp-session-id'] = this.sid
    const body = { jsonrpc: '2.0', method, params }
    if (method !== 'notifications/initialized') body.id = ++this.id
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sid = sid
    const text = await res.text()
    if (!text.trim() || text.trim() === 'null') return null
    let payload = text
    const m = text.match(/^data:\s*(.*)$/m)
    if (m) payload = m[1]
    const msg = JSON.parse(payload)
    if (msg?.error) {
      const e = new Error(msg.error.message || 'mcp error')
      e.code = msg.error.code
      throw e
    }
    return msg?.result ?? null
  }

  async init() {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'douyin-live-bridge', version: '0.1.0' },
    })
    await this.rpc('notifications/initialized', {})
  }

  /** 调工具，content[0].text 是 JSON 字符串（也可能是纯文本） */
  async call(name, args = {}) {
    const r = await this.rpc('tools/call', { name, arguments: args })
    const text = (r?.content ?? []).map((c) => c?.text ?? '').join('\n').trim()
    if (r?.isError) throw new Error(text || `${name} failed`)
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

/* --------------------------------------------------- 事件归一化（关键） */
/**
 * 先解决键名。这个 MCP 吐出来的 JSON 是 **camelCase**（displayLong / giftId），
 * 而 proto 定义本身是 snake_case（display_long / gift_id）。
 * 原来只按 snake_case 查，导致真房间每一条事件都被判成 unknown 扔掉
 * （demo 假数据不走这条路，所以一直没暴露出来）。
 * G() 两套都认。
 */
const _camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const G = (o, name) => {
  if (!o || typeof o !== 'object') return undefined
  if (o[name] !== undefined) return o[name]
  return o[_camel(name)]
}
const HAS = (o, name) => G(o, name) !== undefined

/**
 * 因 service 层丢了 Kind，只能按 proto 字段形状反推。
 */
function classify(d) {
  if (!d || typeof d !== 'object') return 'unknown'
  if (HAS(d, 'display_long') || HAS(d, 'display_short') || HAS(d, 'display_value'))
    return 'room_stats'
  if (HAS(d, 'gift_id') || HAS(d, 'gift') || HAS(d, 'repeat_count') || HAS(d, 'combo_count'))
    return 'gift'
  if (typeof G(d, 'content') === 'string') return 'chat'
  if (HAS(d, 'member_count')) return 'member'
  if (HAS(d, 'count') && HAS(d, 'total')) return 'like'
  if (HAS(d, 'share_type') || HAS(d, 'follow_count') || HAS(d, 'share_target'))
    return 'social'
  if (HAS(d, 'stage') || HAS(d, 'pk_id')) return 'pk'
  /* 只剩一个 user 字段 —— **不是礼物**，是「进场」的一个变体（2026-10-27 22:15 订正）。
   *
   * 以前这里判成 gift，理由是「主人说有人送了礼，日志里正好是 `[未知事件] 字段：user`」。
   * 那是**巧合**，而且代价很实在：2026-10-27 22:02~22:04 连着四条这种事件，
   * 桥把四个只是进来看一眼的人当成送礼的，一个个谢过去、还播了 1 档视频；
   * 主人对着抖音的互动消息一看 —— 那会儿真正送礼的只有一个人。
   *
   * 真正的礼物长什么样（同一晚、登录态正常时实测）：
   *   `comboCount, gift, user`  ← 有 gift 对象和连击数，所以上面第 2 条规则就能认出来。
   * 换句话说：**登录之后礼物本来就不缺字段**，用不着靠「只剩 user」去猜。
   * proto3 的 JSON 不序列化默认值，member_count 为 0 的进场消息就只剩 user ——
   * 这是最合理的解释，也跟「同一秒来了人数变化」对得上。
   *
   * 归到 member 而不是 unknown：他们确实进来了，欢迎一句是对的；
   * 但不能感谢、不能播礼物视频（那才是主人看到的问题）。 */
  if (HAS(d, 'user') && Object.keys(d).length <= 1) return 'member'
  return 'unknown'
}

function nick(d) {
  const u = G(d, 'user') || {}
  const id = G(u, 'id')
  return (
    u.nickname ||
    G(u, 'display_id') ||
    (id != null ? '用户' + String(id).slice(-4) : '') ||
    '观众'
  )
}

/** 归一化成一个叠加层能直接吃的消息；返回 null 表示这事件不展示 */
function normalizeRaw(d) {
  const kind = classify(d)
  switch (kind) {
    case 'chat': {
      const text = String(G(d, 'content') || '').trim()
      if (!text) return null
      return { kind, user: nick(d), text, gift: false, show: true }
    }
    case 'gift': {
      const g = G(d, 'gift') || {}
      const name = g.name || G(d, 'gift_name') || ''
      const n = toNum(G(d, 'repeat_count') ?? G(d, 'combo_count') ?? G(d, 'group_count') ?? 1) || 1
      // 名字读不到（这个 MCP 经常只给 user）就别说「送出「礼物」」这种怪话
      const text = name ? `送出「${name}」` + (n > 1 ? ` ×${n}` : '') : '送了个礼物'
      return { kind, user: nick(d), text, gift: true, show: true, giftName: name, giftCount: n }
    }
    case 'member': {
      const text = G(d, 'action_description') || '来了'
      return { kind, user: nick(d), text, gift: false, show: SHOW_MEMBER }
    }
    case 'like': {
      return {
        kind,
        user: nick(d),
        text: `点了 ${toNum(G(d, 'count')) || 1} 个赞`,
        gift: false,
        show: false,
        totalLike: toNum(G(d, 'total')),
      }
    }
    case 'social': {
      const follow = G(d, 'follow_count')
      const t = follow != null ? '关注了' : G(d, 'share_target') != null ? '分享了直播间' : '来了'
      return { kind, user: nick(d), text: t, gift: false, show: follow != null }
    }
    case 'room_stats': {
      // displayValue 最干净（"1"），displayShort/Long 可能带后缀（"1在线观众"）
      const online = parseCn(
        G(d, 'display_value') || G(d, 'display_short') || G(d, 'display_long') || G(d, 'total')
      )
      return { kind, online, show: false }
    }
    default:
      return { kind, show: false }
  }
}

/**
 * 用户主键（2026-10-27 加，记忆系统要用）。
 *
 * 🔴 以前 normalize 只留了昵称，把 `user.id` 丢了。
 *    昵称会改、会重、带表情符号，拿它当主键迟早串号（两个人同名就成了一本账）。
 *    这里有 id 就用 id；没有才退回昵称，并加 `n:` 前缀标出来 ——
 *    以后发现串号，一眼能看出是哪条路径造成的。
 */
function uidOf(d) {
  const u = G(d, 'user') || {}
  // 没有 user 字段的事件（在线人数那种）根本没有人，别给它编一个「观众」出来
  if (!u || !Object.keys(u).length) return ''
  const id = G(u, 'id')
  if (id != null && String(id) !== '' && String(id) !== '0') return String(id)
  const n = nick(d)
  return n ? 'n:' + n : ''
}

/** 归一化 = 原来的归一 + 补一个主键。包一层，省得六个 return 逐个改。 */
function normalize(d) {
  const n = normalizeRaw(d)
  if (n) n.uid = uidOf(d)
  return n
}

/* --------------------------------------------------------------- SSE 广播 */
const clients = new Set()
let lastHb = null
let lastOverlayAt = 0 // 画面最近一次来拉 /state.json 的时间（0 = 从没来过）
let stat = { online: 0, chat: 0, gift: 0, member: 0, like: 0, total: 0, replied: 0, dup: 0 }
/* 最后一次收到礼物事件的时刻。2026-10-27 加的「礼物通道自检」——
 * 那天抖音 cookie 在 17:11 被刷成了游客态，从此礼物一条都收不到，
 * 而弹幕/进场/点赞全都正常，光看统计根本发现不了（只有「收到礼物 0」这一个信号）。
 * 面板和 /healthz 拿它跟 upSec 一比就知道礼物通道是不是断了。
 * 注意：别叫 giftSeen —— 下面那句「礼物去重表」已经占了这个名字。 */
let lastGiftAt = 0
let giftEvents = 0
let giftWarned = false // 断流警告只报一次，别每分钟刷一行
const START = Date.now()
const recent = [] // 最近弹幕，给 /state.json 用（原生渲染器读这个）
const seenUnknown = new Set() // 已经提示过的未知事件形状，避免刷屏
const REPLY_ON = !has('no-reply') // --no-reply 关掉自动回复，只看弹幕
let say = null // { text, until } —— 正在说的话，做成底部字幕

/* ── 饭钱（2026-10-27 加）───────────────────────────────────────────────
 * 面板右下角原来显示「token 余量」，但那个数是假的（桥根本没有 token 计费）。
 * 换成「饭钱」：开局 17.54 元，每开口一次扣 0.05，存盘。
 *
 * 为什么必须存盘：不存的话每次重启又变回 17.54，等于「重启就有钱」，
 * 这个数就没有任何意义了。所以写 cache/money.json，重启接着上次的数。
 *
 * 加钱：curl "127.0.0.1:18081/money?add=50"
 *       curl "127.0.0.1:18081/money?set=100"
 * 扣到 0 也不会闭麦（她还得说话），只是数字停在 0.00。
 */
const MONEY_START = Number(process.env.ZY_MONEY_START || 17.54)
const MONEY_COST = Number(process.env.ZY_MONEY_COST || 0.05)
const MONEY_FILE = path.join(DIR, 'cache', 'money.json')
const r2 = (n) => Math.round(n * 100) / 100

let money = loadMoney()

function loadMoney() {
  try {
    const j = JSON.parse(fs.readFileSync(MONEY_FILE, 'utf8'))
    const left = Number(j.left)
    if (Number.isFinite(left)) {
      return {
        left: Math.max(0, r2(left)),
        spent: r2(Number(j.spent) || 0),
        added: r2(Number(j.added) || 0),
        at: Number(j.at) || 0,
      }
    }
  } catch {
    // 文件不存在 / 坏了 —— 第一次跑就是这条路径
  }
  return { left: r2(MONEY_START), spent: 0, added: 0, at: Date.now() }
}

function saveMoney() {
  try {
    fs.mkdirSync(path.dirname(MONEY_FILE), { recursive: true })
    fs.writeFileSync(MONEY_FILE, JSON.stringify(money, null, 2), 'utf8')
  } catch (e) {
    log('  [money] 存盘失败：', e?.message || e)
  }
}

function spendMoney(n = MONEY_COST) {
  money.left = Math.max(0, r2(money.left - n))
  money.spent = r2(money.spent + n)
  money.at = Date.now()
  saveMoney()
}

function addMoney(n) {
  if (!Number.isFinite(n) || n === 0) return money
  money.left = Math.max(0, r2(money.left + n))
  money.added = r2(money.added + n)
  money.at = Date.now()
  saveMoney()
  return money
}

/* ── 用户记忆（2026-10-27 加）──────────────────────────────────────────
 * 主人要「按用户记档案」：昵称、首次/最近时间、送礼记录、互动次数、手动备注。
 * 存 cache/users.json —— 跟 money/gift 一个套路：文件坏了就当没有，
 * 不能因为一个存档读不出来，整场直播就不说话了。
 *
 * 三个设计决定：
 *   1. **按 uid 存，不按昵称**。昵称会改会重，理由见 uidOf() 上面那段。
 *   2. **内存改，1.5 秒后统一落盘**。一个人能连刷十几条弹幕，每条都写盘是白烧 IO；
 *      1.5 秒的窗口就算断电，最多丢一两条，比每条都同步写值。
 *   3. **成长值/服装阶段字段先留着不启用**。服装那套暂时不做，
 *      但存档格式先定好，以后接上不用改文件结构（改了就要写迁移，最烦）。
 */
const USERS_FILE = path.join(DIR, 'cache', 'users.json')
const USERS_MAX = 2000 // 超过就淘汰最久没来的，别让一个 json 涨到几 MB
const GIFTS_KEEP = 20 // 每人只留最近 20 条送礼，更早的只进累计数

function loadUsers() {
  const m = new Map()
  try {
    const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    const arr = Array.isArray(j?.users) ? j.users : []
    for (const p of arr) if (p && p.uid) m.set(String(p.uid), p)
    if (m.size) log(`  [users] 读回 ${m.size} 个用户档案`)
  } catch {
    // 第一次跑就是这个路径；坏文件也走这儿 —— 当作从零开始，不报错
  }
  return m
}

let users = loadUsers()
let usersDirty = false
let usersTimer = null

function saveUsersSoon(now = false) {
  usersDirty = true
  /* 面板上的「改成长值 / 删档案 / 清空」必须立刻落盘 —— 那些是人为操作，
   * 不能等 1.5 秒的防抖窗口，万一这会儿断电，用户会以为没生效。 */
  if (now) {
    if (usersTimer) {
      clearTimeout(usersTimer)
      usersTimer = null
    }
    saveUsers()
    return
  }
  if (usersTimer) return
  usersTimer = setTimeout(() => {
    usersTimer = null
    saveUsers()
  }, 1500)
  if (usersTimer.unref) usersTimer.unref()
}

function saveUsers() {
  if (!usersDirty) return
  usersDirty = false
  try {
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true })
    /* 先写 .tmp 再 rename：写到一半断电，磁盘上要么是旧的完整文件，
     * 要么是新的完整文件，不会留下半个 JSON 把下次启动搞崩。 */
    const tmp = USERS_FILE + '.tmp'
    const body = JSON.stringify({ version: 1, savedAt: Date.now(), users: [...users.values()] })
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, USERS_FILE)
  } catch (e) {
    log('  [users] 存盘失败：', e?.message || e)
  }
}

function trimUsers() {
  if (users.size <= USERS_MAX) return
  const arr = [...users.values()].sort((a, b) => (a.lastAt || 0) - (b.lastAt || 0))
  const drop = users.size - USERS_MAX
  for (let i = 0; i < drop; i++) users.delete(String(arr[i].uid))
  log(`  [users] 档案超过 ${USERS_MAX} 个，清掉最久没来的 ${drop} 个`)
}

/**
 * 记一笔，返回**这一次**要用的摘要。
 *
 * isNew 必须在写入前判断 —— 写完之后人人都"不是新用户"了。
 * 同一个人连刷三条：第一条 isNew=true，后两条 false，正好。
 *
 * kind: chat / gift / member / like / song
 */
function touchUser(uid, nick, kind, gift) {
  if (!uid) return null
  const now = Date.now()
  let p = users.get(uid)
  const isNew = !p
  if (!p) {
    p = {
      uid,
      nick: nick || '',
      firstAt: now,
      lastAt: now,
      chat: 0,
      gift: 0,
      like: 0,
      member: 0,
      song: 0,
      // 服装阶段那套还没做，字段先占位（见文件头第 3 条）
      growth: 0,
      stage: 0,
      tags: [],
      note: '',
      gifts: [],
    }
    users.set(uid, p)
    trimUsers()
  }
  const prevAt = p.lastAt || now
  if (nick) p.nick = nick
  p.lastAt = now
  if (kind === 'gift') {
    p.gift = (p.gift || 0) + 1
    if (!Array.isArray(p.gifts)) p.gifts = []
    p.gifts.push({ name: (gift && gift.name) || '', n: (gift && gift.n) || 1, at: now })
    if (p.gifts.length > GIFTS_KEEP) p.gifts = p.gifts.slice(-GIFTS_KEEP)
  } else if (kind && typeof p[kind] === 'number') {
    p[kind]++
  }
  saveUsersSoon()
  return {
    isNew,
    visits: (p.chat || 0) + (p.gift || 0) + (p.member || 0),
    daysAgo: isNew ? 0 : Math.floor((now - prevAt) / 86400000),
    gift: p.gift || 0,
    growth: p.growth || 0,
    tags: (p.tags || []).slice(0, 3),
    note: p.note ? String(p.note).slice(0, 20) : '',
  }
}

/** 面板用：列档案（按最近活跃排序） */function listUsers({ q = '', limit = 50 } = {}) {
  const kw = String(q || '').trim().toLowerCase()
  const arr = [...users.values()]
    .filter((p) => !kw || String(p.nick || '').toLowerCase().includes(kw) || String(p.uid).includes(kw))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  return {
    total: users.size,
    users: arr.slice(0, Math.max(1, Math.min(500, Number(limit) || 50))),
  }
}

/* ── 性格配置（2026-10-27 加）────────────────────────────────────────
 * 三套性格的正文写在 reply.mjs（它才是拼 prompt 的那个），这里只负责
 * 读写 cache/persona.json 的「当前是哪套」和「主播自己加的覆盖项」。
 *
 * 为什么正文不在这里：prompt 的组装必须只有一处，分散到两个文件迟早打架。
 */
const PERSONA_CFG_FILE = path.join(DIR, 'cache', 'persona.json')

function readPersonaCfgFile() {
  try {
    const j = JSON.parse(fs.readFileSync(PERSONA_CFG_FILE, 'utf8'))
    return {
      active: j.active || 'meme',
      over: j.over && typeof j.over === 'object' ? j.over : {},
    }
  } catch {
    // 没建过 / 写坏了 —— 用默认性格，别因为一个 json 让整场直播哑掉
    return { active: 'meme', over: {} }
  }
}

function writePersonaCfgFile(j) {
  try {
    fs.mkdirSync(path.dirname(PERSONA_CFG_FILE), { recursive: true })
    fs.writeFileSync(PERSONA_CFG_FILE, JSON.stringify(j, null, 2), 'utf8')
  } catch (e) {
    log('  [persona] 存盘失败：', e?.message || e)
  }
}

/* ── 礼物感谢设置（2026-10-27 加）──────────────────────────────────────
 * 面板「抖音直播 → 礼物感谢设置」写这里，桥按它决定要不要谢、怎么谢、谢多快。
 * 存 cache/gift.json —— 跟 money.json 一个套路：文件坏了就当没设置过，
 * 不能因为一个配置文件读不出来就让整场直播不说话。
 *
 * 为什么要有「模板」这一层：这个 MCP 把礼物名丢光了（礼物事件只有 user 一个键），
 * 所以模板里 {gift} 常常渲染成空。渲染完如果只剩「谢谢XX的」这种半截话，
 * 会自动回退到本地话术 —— 宁可随机一点，也别在直播间说病句。
 */
const GIFT_FILE = path.join(DIR, 'cache', 'gift.json')
const GIFT_DEFAULTS = {
  on: true, // 自动感谢总开关
  template: '', // 文案模板；空 = 用本地话术
  cooldown: 0, // 两条礼物感谢之间至少隔几秒（0 = 不额外限制）
  dedupe: 120, // 同一人 + 同一礼物，多少秒内只谢一次
  /* 2026-10-27 改成 true：礼物感谢要走性格（毒嘴/女仆/有梗），本地模板只有一种口气。
   * 代价是每条礼物多花一次 token、多等约 1 秒；换来的是「榜一和新用户听到的话不一样」。
   * 点名这件事不靠模型自觉 —— 出口有校验，漏了名字就退回本地模板（见 reply.mjs）。 */
  useLlm: true, // 模板为空时：false = 本地话术（快且稳），true = 交给模型
}
let giftCfg = loadGiftCfg()
const giftSeen = new Map() // 'user|gift' → 上次感谢的毫秒时间戳
let giftLastAt = 0

function loadGiftCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(GIFT_FILE, 'utf8'))
    const out = { ...GIFT_DEFAULTS }
    if (typeof j.on === 'boolean') out.on = j.on
    if (typeof j.template === 'string') out.template = j.template.slice(0, 200)
    if (Number.isFinite(Number(j.cooldown))) out.cooldown = Math.max(0, Math.min(3600, Number(j.cooldown)))
    if (Number.isFinite(Number(j.dedupe))) out.dedupe = Math.max(0, Math.min(3600, Number(j.dedupe)))
    if (typeof j.useLlm === 'boolean') out.useLlm = j.useLlm
    return out
  } catch {
    return { ...GIFT_DEFAULTS }
  }
}

function saveGiftCfg() {
  try {
    fs.mkdirSync(path.dirname(GIFT_FILE), { recursive: true })
    fs.writeFileSync(GIFT_FILE, JSON.stringify(giftCfg, null, 2), 'utf8')
  } catch (e) {
    log('  [gift] 设置存盘失败：', e?.message || e)
  }
}

/** 模板渲染。变量：{user} 昵称、{gift} 礼物名、{count} 数量 */
function renderGiftTpl(tpl, { user, gift, count }) {
  const t = String(tpl || '')
    .replace(/\{user\}/g, user || '你')
    .replace(/\{gift\}/g, gift || '礼物')
    .replace(/\{count\}/g, String(count || 1))
    .replace(/\s+/g, ' ')
    .trim()
  /* 礼物名读不到时模板会变成「谢谢XX的礼物」这种还算通顺的句子；
   * 但如果用户把模板写成「{gift}收到！」，渲染出来是「礼物收到！」也还行。
   * 真正要防的是「谢谢XX的」结尾没东西 —— 交给调用方判空。 */
  return t
}

/** 这条礼物该不该谢。返回 null 表示要谢，返回字符串表示不谢的原因（日志用）。 */
function giftGate(n, now = Date.now()) {
  if (!giftCfg.on) return '自动感谢已关'
  const key = `${n.user || ''}|${n.giftName || ''}`
  const dedupeMs = giftCfg.dedupe * 1000
  if (dedupeMs > 0) {
    const last = giftSeen.get(key) || 0
    if (now - last < dedupeMs) return `去重（${Math.round((dedupeMs - (now - last)) / 1000)} 秒内谢过）`
  }
  if (giftCfg.cooldown > 0 && now - giftLastAt < giftCfg.cooldown * 1000) {
    return `冷却中（还差 ${Math.ceil((giftCfg.cooldown * 1000 - (now - giftLastAt)) / 1000)} 秒）`
  }
  if (giftSeen.size > 500) {
    for (const [k, t] of giftSeen) if (now - t > 600000) giftSeen.delete(k)
  }
  giftSeen.set(key, now)
  giftLastAt = now
  return null
}

let giftThanked = 0

/**
 * 礼物入队。pushEvent 和面板的「测试」按钮都走这里，保证测的就是真实链路。
 * @param {boolean} force 绕过冷却/去重（测试按钮用，也不写进去重表）
 */
function enqueueGift(n, force = false) {
  const why = force ? null : giftGate(n)
  if (why) {
    log(`  🎁 ${n.user} 送了礼物 —— 不谢：${why}`)
    return { how: '跳过：' + why, text: '' }
  }
  giftThanked++
  if (giftCfg.template) {
    const text = renderGiftTpl(giftCfg.template, { user: n.user, gift: n.giftName, count: n.giftCount })
    if (text) {
      queueReply({ user: n.user, text: n.text, kind: 'gift', forceText: text, uid: n.uid, profile: n.profile })
      return { how: '模板', text }
    }
  }
  queueReply({ user: n.user, text: n.text, kind: 'gift', uid: n.uid, profile: n.profile, forceLocal: !giftCfg.useLlm })
  return { how: '默认话术', text: '' }
}

/* ══════════════════════ 礼物档位媒体（2026-10-27 加） ══════════════════════
 *
 * 观众送礼 → 按礼物名归到 1~4 档 → 从 media/ 里挑一个同档素材 → 在直播画面
 * 右侧那台「电脑」上播出来。
 *
 * 素材归属只认**文件名开头的数字**：`1-小心心.mp4`、`3-跑车.gif`。
 * 这样加素材不用改任何配置 —— 丢文件进目录就行，桥每 3 秒扫一次。
 *
 * 分工（重要，别搞混）：
 *   桥    = 队列 + 打断规则 + 冷却 + 挑哪个文件（**唯一的决策方**）
 *   画面  = 只负责把当前这一份解码出来画上去，播完回 /media/done
 * 决策放桥这边，是因为「画面没开」的时候队列也得能往前走（靠超时兜底）。
 */
const MEDIA_FILE = path.join(DIR, 'cache', 'media.json')

/* 常见礼物的默认归属。认不出来的走 tierDefault（默认 1 档，小额）。
 * 主人可以在设置页里改，改完覆盖写回 cache/media.json。 */
const MEDIA_GIFT_MAP = {
  小心心: 1, 玫瑰: 1, 大啤酒: 1, 棒棒糖: 1, 小星星: 1, 气球: 1, 你最好看: 1, 加油鸭: 1,
  抖音: 1, 抱抱: 1, 鲜花: 1, 点赞: 1,
  墨镜: 2, 甜甜圈: 2, 亲吻: 2, 甜甜圈2: 2, 小心心2: 2, 音符: 2, 麦克风: 2, 拳套: 2,
  跑车: 3, 火箭: 3, 抖音一号: 3, 直升机: 3, 游艇: 3, 皇冠: 3, 花海: 3, 城堡: 3,
  嘉年华: 4, 浪漫马车: 4, 火箭飞船: 4, 星际: 4, 独角兽: 4,
}

const MEDIA_DEFAULTS = {
  on: true, // 总开关：关掉后礼物只发感谢，不播媒体
  /* 音乐总开关（2026-10-28）。跟上面的 on 是两件事：on 管「电脑展示区的素材」，
   * musicOn 管「背景音乐」。关掉 = 不轮询音源、给播放器发 pause、不垫热榜、不闪避。
   * 存这儿是因为它必须跨重启记住 —— 原来只有 --no-music / ZY_MUSIC=0 两个启动参数，
   * 起桥之后没有任何办法关，主人只能全停再起。 */
  musicOn: true,
  dir: '', // 空 = 用 <项目>/media
  idle: 'standby', // 空闲画面：standby（待机）/ black（纯黑）/ wallpaper（壁纸）
  tierDefault: 1, // 认不出礼物名时归哪一档（0 = 认不出就不播）
  giftMap: { ...MEDIA_GIFT_MAP },
  tiers: {
    /* 0 档 = 闲时素材。不是礼物触发的，是「场子冷了自己放一段」的那种。
     * mode 默认 sequence：`0-a.mp4`、`0-b.mp4` 按文件名轮流放，不会连着同一段。 */
    0: { mode: 'sequence', volume: 1.0, maxSec: 120, loop: false },
    1: { mode: 'random', volume: 0.8, maxSec: 15, loop: false },
    2: { mode: 'random', volume: 0.85, maxSec: 20, loop: false },
    3: { mode: 'random', volume: 0.9, maxSec: 30, loop: false },
    4: { mode: 'random', volume: 1.0, maxSec: 40, loop: false },
  },
  /* 闲时播放规则（2026-10-27 加）。全都能用环境变量覆盖，见 maybeIdleMedia()。 */
  idlePlay: {
    on: true, // 总开关
    quietSec: 100, // 多少秒没新弹幕才算「无聊」
    gapSec: 240, // 两段闲时视频之间至少隔多久
    startSec: 120, // 开播多少秒之后才开始考虑（刚开播先让她打招呼）
  },
  rules: {
    interrupt: true, // 高档位播放中来了更高档 → 立刻打断
    sameTier: 'queue', // 同档位连发：queue 排队 / merge 合并成一次
    cooldown: 3, // 全局冷却秒（0 = 不限制）
    duckMusic: true, // 播放期间把背景音乐压下去
    maxQueue: 5, // 队列最多压几首，超了丢最新的
    /* 礼物不分档（2026-10-27 深夜，主人要求）：
     * 「只要刷礼物，那四个视频就随机选一个播放」。
     * 打开后**不看礼物名**、也不看 giftMap，任何礼物都从 1–4 档里随机抽一个。
     * 抽法是「洗牌袋」—— 四个轮完一轮才重洗，所以不会连着放同一段。
     * 档位只保留一个用处：音量 / 单次时长上限还是按那个文件自己那一档走。 */
    flatGift: false,
    /* 0 档（闲时 / 点播）视频「放完为止」（2026-10-28，主人选的方案）：
     * 她开口说话时**不收掉**，改成把视频音量压到 20%（见 mediaVolumeNow）；
     * 有礼物进来也**不顶掉**，改成排队。
     * 关掉就回到老行为：她一开口视频直接收，礼物也能顶掉它。 */
    idleFull: true,
  },
  /* 音量（2026-10-27 主人要求搬进设置页）。单位都是 %，桥内部再换算：
   *   voice = 她说话（TTS）
   *   media = 素材视频（**乘在**档位音量上，不覆盖它 —— 档位之间还有相对大小）
   *   music = 音乐基准音量（说话前后都回到这个值）
   *   duck  = 她说话时音乐压到这个比例
   * 之所以放在 media.json 里，是因为「电脑展示区」和「声音」本来就是同一套
   * 播放链路，分两个文件存迟早对不上。 */
  audio: { voice: 100, media: 100, music: 100, duck: 60 },
}

const MEDIA_KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp'],
  anim: ['.gif'],
  video: ['.mp4', '.webm', '.mov', '.mkv', '.m4v'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
}

let mediaCfg = loadMediaCfg()

function loadMediaCfg() {
  const out = JSON.parse(JSON.stringify(MEDIA_DEFAULTS))
  try {
    const j = JSON.parse(fs.readFileSync(MEDIA_FILE, 'utf8'))
    if (typeof j.on === 'boolean') out.on = j.on
    if (typeof j.musicOn === 'boolean') out.musicOn = j.musicOn
    if (typeof j.dir === 'string') out.dir = j.dir.slice(0, 400)
    if (['standby', 'black', 'wallpaper'].includes(j.idle)) out.idle = j.idle
    if (Number.isFinite(Number(j.tierDefault))) out.tierDefault = Math.max(0, Math.min(4, Number(j.tierDefault)))
    if (j.giftMap && typeof j.giftMap === 'object') {
      out.giftMap = {}
      for (const [k, v] of Object.entries(j.giftMap)) {
        const n = Number(v)
        if (String(k).trim() && n >= 0 && n <= 4) out.giftMap[String(k).trim().slice(0, 20)] = n
      }
    }
    for (const t of [0, 1, 2, 3, 4]) {
      const s = (j.tiers && j.tiers[t]) || (j.tiers && j.tiers[String(t)]) || {}
      const d = out.tiers[t]
      if (['random', 'sequence'].includes(s.mode)) d.mode = s.mode
      if (Number.isFinite(Number(s.volume))) d.volume = Math.max(0, Math.min(1, Number(s.volume)))
      if (Number.isFinite(Number(s.maxSec))) d.maxSec = Math.max(1, Math.min(600, Number(s.maxSec)))
      if (typeof s.loop === 'boolean') d.loop = s.loop
    }
    if (j.idlePlay) {
      const ip = out.idlePlay
      if (typeof j.idlePlay.on === 'boolean') ip.on = j.idlePlay.on
      if (Number.isFinite(Number(j.idlePlay.quietSec))) ip.quietSec = Math.max(10, Math.min(3600, Number(j.idlePlay.quietSec)))
      if (Number.isFinite(Number(j.idlePlay.gapSec))) ip.gapSec = Math.max(30, Math.min(7200, Number(j.idlePlay.gapSec)))
      if (Number.isFinite(Number(j.idlePlay.startSec))) ip.startSec = Math.max(0, Math.min(3600, Number(j.idlePlay.startSec)))
    }
    if (j.rules) {
      if (typeof j.rules.interrupt === 'boolean') out.rules.interrupt = j.rules.interrupt
      if (['queue', 'merge'].includes(j.rules.sameTier)) out.rules.sameTier = j.rules.sameTier
      if (Number.isFinite(Number(j.rules.cooldown))) out.rules.cooldown = Math.max(0, Math.min(600, Number(j.rules.cooldown)))
      if (typeof j.rules.duckMusic === 'boolean') out.rules.duckMusic = j.rules.duckMusic
      if (Number.isFinite(Number(j.rules.maxQueue))) out.rules.maxQueue = Math.max(1, Math.min(20, Number(j.rules.maxQueue)))
      if (typeof j.rules.flatGift === 'boolean') out.rules.flatGift = j.rules.flatGift
      if (typeof j.rules.idleFull === 'boolean') out.rules.idleFull = j.rules.idleFull
    }
    if (j.audio) {
      for (const k of ['voice', 'media', 'music', 'duck']) {
        if (Number.isFinite(Number(j.audio[k]))) {
          out.audio[k] = Math.max(0, Math.min(100, Math.round(Number(j.audio[k]))))
        }
      }
    }
  } catch {
    /* 没有配置文件就用默认 —— 第一次跑就是这条路径 */
  }
  return out
}

function saveMediaCfg() {
  try {
    fs.mkdirSync(path.dirname(MEDIA_FILE), { recursive: true })
    fs.writeFileSync(MEDIA_FILE, JSON.stringify(mediaCfg, null, 2), 'utf8')
  } catch (e) {
    log('  [media] 设置存盘失败：', e?.message || e)
  }
}

const mediaDir = () => (mediaCfg.dir || path.join(DIR, 'media')).replace(/[\\/]+$/, '')

function kindOfExt(ext) {
  const e = String(ext || '').toLowerCase()
  for (const [k, list] of Object.entries(MEDIA_KINDS)) if (list.includes(e)) return k
  return ''
}

/**
 * 扫一遍素材目录，按 `1-xxx` 的前缀分档。
 * 3 秒缓存 —— 设置页 3 秒刷一次，不缓存等于每 3 秒读一次盘。
 */
let mediaScanAt = 0
let mediaScanCache = null

function scanMedia(force = false) {
  if (!force && mediaScanCache && Date.now() - mediaScanAt < 3000) return mediaScanCache
  const dir = mediaDir()
  const byTier = { 1: [], 2: [], 3: [], 4: [] }
  /* 0 档 = 闲时素材（2026-10-27 主人放了个「0-梁圣巡演.mp4」）。
   * 它不属于任何礼物档：没人说话、场子冷下来的时候自己播，
   * 播的时候把音乐**暂停**（不是压低）—— 视频自己有声音，压低了会打架。 */
  const idle = []
  const others = []
  const bad = []
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    mediaScanCache = { dir, exists: false, error: String(e?.code || e?.message || e), byTier, idle, others, bad, total: 0 }
    mediaScanAt = Date.now()
    return mediaScanCache
  }
  for (const name of names) {
    const full = path.join(dir, name)
    let st = null
    try {
      st = fs.statSync(full)
      if (!st.isFile()) continue
    } catch {
      continue
    }
    const ext = path.extname(name)
    const kind = kindOfExt(ext)
    if (!kind) {
      if (!/^说明|readme/i.test(name)) bad.push({ name, why: '不支持的格式' })
      continue
    }
    const m = name.match(/^\s*([0-4])\s*[-_－—.、]/)
    const item = { name, file: full, kind, ext: ext.toLowerCase(), size: st.size, mtime: st.mtimeMs }
    if (!m) {
      others.push(item)
      continue
    }
    const t = Number(m[1])
    /* 把档位挂到条目上（2026-10-27 加）。「礼物不分档」模式下池子是 1–4 混的，
     * 音量 / 单次时长还得按文件自己那一档走，所以得知道它原来属于哪档。 */
    item.tier = t
    if (t === 0) idle.push(item) // 0- = 闲时素材，不是礼物档
    else byTier[t].push(item)
  }
  for (const t of [1, 2, 3, 4]) byTier[t].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  idle.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  mediaScanCache = {
    dir,
    exists: true,
    byTier,
    idle,
    others,
    bad,
    total: Object.values(byTier).reduce((n, a) => n + a.length, 0) + idle.length + others.length,
    at: Date.now(),
  }
  mediaScanAt = Date.now()
  return mediaScanCache
}

/** 礼物名 → 档位。先精确匹配，再按包含匹配（「送出小心心」也算小心心）。 */
function tierOfGift(giftName) {
  const g = String(giftName || '').trim()
  if (!g) return mediaCfg.tierDefault
  const map = mediaCfg.giftMap || {}
  if (map[g]) return map[g]
  const hit = Object.keys(map).find((k) => k && (g.includes(k) || k.includes(g)))
  return hit ? map[hit] : mediaCfg.tierDefault
}

/* ── 播放队列 ──────────────────────────────────────────────────────────
 * cur 是「画面此刻该放的那一份」，seq 每换一次 +1 —— 画面靠它判断要不要重开。
 * queue 里存的是还没轮到的。 */
const MEDIA = {
  seq: 0,
  cur: null,
  queue: [],
  lastStartAt: 0,
  lastEndAt: 0,
  rot: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
  log: [], // 最近 30 条播放留痕（设置页「播放队列」里显示）
  endTimer: null,
}

/* 「礼物不分档」用的洗牌袋：抽完一轮才重洗。
 * 为什么不用 Math.random 直接抽：四个视频纯随机，连着两次抽到同一个很常见
 * （1/4 概率），观众看着就像「卡住了 / 没换」。洗牌袋保证四个轮着来。 */
let flatBag = []

function mediaLog(line, tone) {
  MEDIA.log.unshift({ at: Date.now(), line: String(line), tone: tone || '' })
  if (MEDIA.log.length > 30) MEDIA.log.length = 30
}

/** 从某一档里挑一个文件：random 随机 / sequence 按文件名顺序轮。
 *  0 档不是「礼物档」，池子在 scanMedia().idle 里（`0-xxx.mp4`）。 */
function pickFile(tier) {
  const scan = scanMedia()
  /* 'any' = 礼物不分档：所有素材混成一个池子。
   * 主人 2026-10-27 深夜：「只要刷礼物，那四个视频就随机选一个播放」。
   * 2026-10-28 加了 0 档：主人原话「发礼物也可以放 0 档」——
   * 0 档那几条（闲时/点播用的）现在也会被礼物带出来。
   * 想让礼物只放 1–4 档，就在设置页关掉「礼物不分档」。 */
  if (tier === 'any') {
    const pool = [...(scan.idle || []), ...[1, 2, 3, 4].flatMap((t) => scan.byTier[t] || [])]
    if (!pool.length) return null
    const ids = pool.map((x) => x.file)
    /* 池子变了（加了 / 删了素材）就重洗，别拿着已经不存在的文件名去找 */
    if (flatBag.some((f) => !ids.includes(f))) flatBag = []
    if (!flatBag.length) {
      flatBag = ids.slice()
      for (let i = flatBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = flatBag[i]
        flatBag[i] = flatBag[j]
        flatBag[j] = tmp
      }
    }
    const want = flatBag.shift()
    return pool.find((x) => x.file === want) || pool[0]
  }
  const pool = tier === 0 ? (scan.idle || []) : (scan.byTier[tier] || [])
  if (!pool.length) return null
  const mode = (mediaCfg.tiers[tier] && mediaCfg.tiers[tier].mode) || 'random'
  if (mode === 'sequence') {
    const i = MEDIA.rot[tier] % pool.length
    MEDIA.rot[tier] = (MEDIA.rot[tier] + 1) % pool.length
    return pool[i]
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

function clearEndTimer() {
  if (MEDIA.endTimer) {
    clearTimeout(MEDIA.endTimer)
    MEDIA.endTimer = null
  }
}

/* 闲时视频要把音乐**停掉**（不是压低）。
 * 这两个函数管「谁暂停的、谁负责恢复」—— 只有 musicPausedByMedia 为真时才恢复，
 * 免得和 duckMusic（TTS 闪避那套）互相踩。 */
let musicPausedByMedia = false

function pauseMusicForMedia() {
  if (!musicOn) return
  if (musicPausedByMedia) return
  if (!music.found) return // 本来就没在放，不用暂停，也就没有恢复可言
  musicPausedByMedia = true
  if (musicSrc === 'box') {
    boxJson('/bridge/command', { method: 'POST', body: { type: 'pause' }, timeout: 4000 }).catch(() => {})
  } else if (musicOn && !mediaDead) {
    mediaCmd('pause').catch(() => {})
  }
  log('  ♫ 闲时视频开播 → 音乐暂停')
}

function resumeMusicAfterMedia() {
  if (!musicPausedByMedia) return
  musicPausedByMedia = false
  /* 🔴 总开关关着时**不许**恢复（2026-10-28）。
   * 这是"关了又自己响"最典型的入口：视频播完走到这儿，一句 resume 就把
   * 主人刚关掉的音乐重新放起来，而面板上开关还是关的。 */
  if (!musicOn) return
  /* 🔴 不能用 `music.playing` 判断「要不要恢复」。它是 1.5 秒轮询拿到的快照，
   * 刚发完暂停时它还是上一轮的值（true），于是会走进「本来就在放，不动它」，
   * 音乐就**真停在暂停上**了 —— 实测试播 1 秒就结束的情况，歌直接不响了。
   * 只认 musicPausedByMedia：暂停是我们发的，恢复也只能我们来。
   * `resume` 是幂等的，本来就在放的时候再发一次没有副作用。 */
  if (musicSrc === 'box') {
    boxJson('/bridge/command', { method: 'POST', body: { type: 'resume' }, timeout: 4000 }).catch(() => {})
  } else if (musicOn && !mediaDead) {
    mediaCmd('play').catch(() => {})
  }
  log('  ♫ 闲时视频结束 → 音乐继续')
}

/**
 * 真正开播一份素材。seq++ 让画面立刻切过去。
 * @param {object} item   scanMedia 出来的条目
 * @param {object} meta   {tier, user, gift}
 */
function mediaBegin(item, meta) {
  /* 🔴 不能用 `Number(meta.tier) || 1`：闲时档就是 0，`||` 会把它改成礼物 1 档。
   * 这个坑以前没暴露，是因为 0 开头的文件压根没被扫进来。 */
  const rawTier = Number(meta.tier)
  const tier = Number.isFinite(rawTier) ? rawTier : 1
  const t = mediaCfg.tiers[tier] || mediaCfg.tiers[1]
  const maxMs = Math.max(1, Number(t.maxSec) || 15) * 1000
  const label = tier === 0
    ? (meta.request ? '点播视频' : '闲时视频')
    : (meta.flat ? '礼物视频' : `档位${tier}`)
  MEDIA.seq++
  MEDIA.cur = {
    seq: MEDIA.seq,
    file: item.file,
    name: item.name,
    kind: item.kind,
    tier,
    /* 打断比较用的优先级（2026-10-27 加）。正常模式 = 档位数字；
     * 「礼物不分档」模式下所有礼物都是同一级（1）。
     * ⚠️ 2026-10-28 改：当初以为「礼物之间只排队」是主人要的，结果碰上
     * 4-瑞克摇（212 秒）后面的礼物要等三分半 —— 看着像「刷了没反应」。
     * 现在 flat 模式下新礼物直接换掉正在放的礼物视频（见 triggerGiftMedia
     * 的 flatCut），rank 只留着给「礼物能顶掉闲时视频」这条用。 */
    rank: Number.isFinite(Number(meta.rank)) ? Number(meta.rank) : tier,
    flat: Boolean(meta.flat),
    user: String(meta.user || ''),
    gift: String(meta.gift || ''),
    /* 0 档有两种来源：场子冷了自动放（闲时）/ 观众喊「放个视频」（点播）。
     * 徽标要靠这个字段分开写，否则点播也显示「闲时」，看画面的人（和排查的我）
     * 都分不清这段是谁让它放的。 */
    request: Boolean(meta.request),
    /* 档位音量 × 设置页的「素材总音量」。
     * 用乘法不用覆盖：档位之间本来就有相对大小（1 档 0.8 / 4 档 1.0），
     * 总音量只该整体收放，不该把档位差抹平。 */
    volume: Math.min(1, Math.max(0, Number(t.volume) * (mediaCfg.audio.media / 100))),
    loop: Boolean(t.loop),
    maxMs,
    at: Date.now(),
  }
  MEDIA.lastStartAt = Date.now()
  mediaLog(
    `▶ ${label} 播《${item.name}》` +
    (meta.user ? ` · 来自 ${meta.user}` : '') +
    (meta.gift ? ` · ${meta.gift}` : ''),
    'play'
  )
  log(`  🖥 ${tier === 0 ? (meta.request ? '点播视频' : '闲时视频') : (meta.flat ? '礼物视频（不分档）' : `礼物媒体·档位${tier}`)}：${item.name}（${Math.round(maxMs / 1000)}s 上限）`)

  /* 闲时视频**自带声音**，所以音乐要暂停，不是压低 —— 压到 60% 两个声音还是打架。
   * 礼物媒体只是压低（真停了观众会觉得直播断了）。 */
  if (tier === 0) {
    pauseMusicForMedia()
  } else if (mediaCfg.rules.duckMusic) {
    try { duckMusic(maxMs + 600) } catch { /* 音乐没接管就算了 */ }
  }

  /* 兜底超时：画面没开 / 画面卡住 / 没回 done，到点也要往下走。
   * +2.5 秒是留给解码启动和尾帧的。 */
  clearEndTimer()
  MEDIA.endTimer = setTimeout(() => mediaFinish(MEDIA.cur && MEDIA.cur.seq, '超时'), maxMs + 2500)
  if (MEDIA.endTimer.unref) MEDIA.endTimer.unref()
}

/** 结束当前这一份，并把队列里的下一份顶上来。seq 不匹配说明已经换人了，忽略。 */
function mediaFinish(seq, why) {
  if (!MEDIA.cur) return
  if (seq != null && Number(seq) !== MEDIA.cur.seq) return
  const done = MEDIA.cur
  MEDIA.cur = null
  MEDIA.lastEndAt = Date.now()
  clearEndTimer()
  /* 闲时视频收工 → 音乐接着放。礼物媒体的 duck 由 scheduleUnduck 自己恢复。 */
  if (done.tier === 0) resumeMusicAfterMedia()
  if (why) mediaLog(`■ ${done.tier === 0 ? '闲时' : `档位${done.tier}`} 结束（${why}）`, 'end')
  if (MEDIA.queue.length) {
    const nx = MEDIA.queue.shift()
    mediaBegin(nx.item, nx.meta)
  }
}

/* ── 闲时播放：场子冷了自己放一段（2026-10-27 加）───────────────────
 *
 * 主人放了个 `0-梁圣巡演.mp4`，想让大肥鱼「无聊的时候播一下」。
 * 「无聊」的判据全在这一段，想调行为只改这几个数：
 *   · 开播满 startSec 秒（刚开播先让她打招呼，别一上来就放片）
 *   · 距最后一条弹幕/礼物超过 quietSec 秒（quietSince）
 *   · 没在说话（say）、没在回复（replying）、没有媒体在播或在排队
 *   · 距上一段闲时视频超过 gapSec 秒
 *
 * 播的时候音乐**暂停**（视频自带声音），播完恢复 —— 见 pauseMusicForMedia()。
 * 礼物随时能打断它（1 档 > 0 档，走 triggerGiftMedia 的 interrupt 规则）。
 *
 * 环境变量：ZY_IDLE=0 关掉；ZY_IDLE_QUIET / ZY_IDLE_GAP / ZY_IDLE_START 调阈值。
 */
const IDLE_OFF = String(process.env.ZY_IDLE ?? '1') === '0'
let idleAt = 0 // 上一段闲时视频的起点（也是「下次最早什么时候能再放」）
let idlePick = 0 // sequence 模式轮到第几个

function idleCfg() {
  const ip = mediaCfg.idlePlay || {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    on: ip.on !== false,
    quietSec: num(process.env.ZY_IDLE_QUIET, num(ip.quietSec, 100)),
    gapSec: num(process.env.ZY_IDLE_GAP, num(ip.gapSec, 240)),
    startSec: num(process.env.ZY_IDLE_START, num(ip.startSec, 120)),
  }
}

function maybeIdleMedia() {
  if (IDLE_OFF || !mediaCfg.on) return
  const cfg = idleCfg()
  if (!cfg.on) return
  if (MEDIA.cur || MEDIA.queue.length) return // 有东西在播/排队，轮不到闲时
  if (replying) return // 正在组织回复
  if (say && Date.now() < say.until) return // 正在出声
  if (Date.now() - START < cfg.startSec * 1000) return
  /* quietSince 在「刚说过话」时被推到未来（+15s/+20s），差值会是负数，
   * 自然小于阈值，不用额外判。 */
  const quietFor = Date.now() - (quietSince || START)
  if (quietFor < cfg.quietSec * 1000) return
  if (idleAt && Date.now() - idleAt < cfg.gapSec * 1000) return

  const pool = scanMedia().idle || []
  if (!pool.length) {
    /* 没有 0- 素材就别在这儿空转。记一笔时间，免得每 5 秒扫一次盘还刷日志。 */
    idleAt = Date.now()
    return
  }
  const mode = (mediaCfg.tiers[0] && mediaCfg.tiers[0].mode) || 'sequence'
  const item = mode === 'random'
    ? pool[Math.floor(Math.random() * pool.length)]
    : pool[idlePick++ % pool.length]
  idleAt = Date.now()
  log(`  🖥 场子冷了 ${Math.round(quietFor / 1000)} 秒，放段闲时视频（${pool.length} 个素材）`)
  mediaBegin(item, { tier: 0 })
}

/**
 * 观众点播：放一段 0 档素材（2026-10-27 主人要求）。
 *
 * 「用户说放视频什么的，就播放刚刚的 0 视频」—— 跟闲时播放共用同一批素材、
 * 同一个播放通道（mediaBegin tier 0），区别只在**谁触发**：
 *   · maybeIdleMedia()：场子冷了，自己放
 *   · 这里：观众喊了，马上放
 *
 * 三条规矩：
 *   ① 有礼物视频在放（档位≥1）就不抢 —— 那是花钱买的
 *   ② 已经在放 0 档就复用，不重头开始（观众会连着喊好几遍）
 *   ③ 有冷却，别被刷屏的人当成「重新播放」按钮
 *
 * 返回值直接进 ctx.video，回复按它说的是实话。
 */
const CLIP_GAP = Number(process.env.ZY_CLIP_GAP || 90) * 1000
let clipAt = 0
function playClipNow(user) {
  if (!mediaCfg.on) return { ok: false, why: '媒体总开关关着' }
  const pool = scanMedia().idle || []
  if (!pool.length) return { ok: false, why: `没有 0 档素材（${mediaDir()}）` }
  if (MEDIA.cur) {
    if (MEDIA.cur.tier === 0) return { ok: true, already: true }
    return { ok: false, why: '正在放' }
  }
  if (clipAt && Date.now() - clipAt < CLIP_GAP) {
    return { ok: false, why: '刚放过' }
  }
  const mode = (mediaCfg.tiers[0] && mediaCfg.tiers[0].mode) || 'sequence'
  const item = mode === 'random'
    ? pool[Math.floor(Math.random() * pool.length)]
    : pool[idlePick++ % pool.length]
  clipAt = Date.now()
  /* 记一笔 idleAt：这一段放完别让闲时逻辑马上又接一段，
   * 否则观众看到的就是「一段接一段，没完没了」。 */
  idleAt = Date.now()
  mediaBegin(item, { tier: 0, user, request: true })
  /* 打个记号：这是**观众点的**，不是闲时自己放的。
   * 记号的作用见 replyWorker 里「她要说话了」那一段 —— 闲时视频一开口就收，
   * 但观众点的那段刚放一秒就被收掉，等于白点。 */
  if (MEDIA.cur) MEDIA.cur.keep = 'request'
  const name = String(item.name || item || '').replace(/^0-/, '')
  log(`  🖥 观众点播（${user || '?'}）→ 放 ${name}`)
  return { ok: true, name }
}

/**
 * 礼物来了 → 决定播不播、打断还是排队。
 * 返回 {how, why}，只用于日志和面板显示。
 */function triggerGiftMedia(n) {
  if (!mediaCfg.on) return { how: '跳过', why: '媒体总开关关着' }
  /* 「礼物不分档」（2026-10-27 深夜，主人要求）：
   * 「只要刷礼物，那四个视频就随机选一个播放」——
   * 打开后完全不看礼物名 / giftMap，1–4 档混成一个池子随机抽。
   * 档位只剩一个用处：音量 / 单次时长上限按那个文件原来那一档走。 */
  const flat = Boolean(mediaCfg.rules.flatGift)
  const tier = flat ? 'any' : tierOfGift(n.giftName)
  if (!tier) return { how: '跳过', why: `礼物「${n.giftName || '?'}」认不出档位` }
  const item = pickFile(tier)
  if (!item) {
    const why = flat
      ? '1–4 档目录里一个素材都没有'
      : `档位${tier} 目录里没有素材`
    mediaLog(`✕ ${why}`, 'warn')
    log(`  🖥 礼物媒体没播：${why}（${mediaDir()}）`)
    return { how: '跳过', why }
  }
  /* 不分档时：tier 用**文件自己**的（音量/时长），rank 统一 1（打断比较） */
  const fileTier = flat ? (Number(item.tier) || 1) : Number(tier)
  const meta = {
    tier: fileTier,
    rank: flat ? 1 : Number(tier) || 0,
    flat,
    user: n.user,
    gift: n.giftName,
  }
  const tag = flat ? '礼物视频' : `档位${tier}`
  const now = Date.now()

  /* 全局冷却：高频礼物不至于把素材刷成幻灯片 */
  const cd = Number(mediaCfg.rules.cooldown) || 0
  if (cd > 0 && MEDIA.lastStartAt && now - MEDIA.lastStartAt < cd * 1000) {
    const why = `冷却中（还差 ${Math.ceil((cd * 1000 - (now - MEDIA.lastStartAt)) / 1000)} 秒）`
    mediaLog(`✕ ${tag} 没播：${why}`, 'warn')
    return { how: '跳过', why }
  }

  if (!MEDIA.cur) {
    mediaBegin(item, meta)
    return { how: '播放', tier: meta.tier }
  }

  /* 正在播着 —— 三条规则依次判 */
  const curRank = Number.isFinite(Number(MEDIA.cur.rank))
    ? Number(MEDIA.cur.rank)
    : (Number(MEDIA.cur.tier) || 0)
  /* 「0 档放完为止」（2026-10-28）：**观众点播**的视频不因为来了礼物就被顶掉，
   * 改成排队。理由和「她说话不收」一样 —— 83 秒的片子放 51 秒就断，看着像坏了。
   *
   * ⚠️ 只保护 request（点播）。闲时素材（场子冷了自己放的那种）**照样被顶掉**：
   * 那是填空场的东西，送礼的人等 83 秒才看到反应才是真问题。
   * 礼物之间（1–4 档）的打断规则不受影响。 */
  const keepIdle = Boolean(mediaCfg.rules.idleFull)
    && MEDIA.cur.tier === 0
    && Boolean(MEDIA.cur.request)
  /* 「礼物不分档」下 rank 全是 1 —— `meta.rank > curRank` 永远不成立，
   * 于是第二个礼物只会排队。碰上 `4-瑞克摇.mp4`（212 秒）就得干等三分半，
   * 观众那边看着就是「刷了礼物没反应」，和「刷了就放一个」完全相反。
   * 所以 flat 模式下：新礼物直接换掉正在放的**礼物视频**。
   * 连刷不会抽搐 —— 上面那道 cooldown（默认 3 秒）挡着；
   * 观众点播的 0 档仍然受 keepIdle 保护，闲时素材照旧让位。 */
  const flatCut = flat
    && Boolean(mediaCfg.rules.interrupt)
    && Number(MEDIA.cur.tier) >= 1
  if (mediaCfg.rules.interrupt && (meta.rank > curRank || flatCut) && !keepIdle) {
    /* 闲时视频（0 档）被礼物顶掉：先把音乐恢复，否则它一直停在暂停上，
     * 新礼物媒体的 duck 也就没东西可压了。 */
    if (MEDIA.cur.tier === 0) resumeMusicAfterMedia()
    const curTag = MEDIA.cur.tier === 0
      ? '闲时视频'
      : (MEDIA.cur.flat ? '礼物视频' : `档位${MEDIA.cur.tier}`)
    mediaLog(`⤵ ${curTag} 被${tag} 打断`, 'cut')
    clearEndTimer()
    MEDIA.cur = null
    mediaBegin(item, meta)
    return { how: '打断', tier: meta.tier }
  }
  if (mediaCfg.rules.sameTier === 'merge' && meta.rank === curRank) {
    mediaLog(`＝ ${tag} 连发，合并（不重复播）`, 'merge')
    return { how: '合并', tier: meta.tier }
  }
  if (MEDIA.queue.length >= mediaCfg.rules.maxQueue) {
    mediaLog(`✕ ${tag} 队列满了（${mediaCfg.rules.maxQueue}），丢掉`, 'warn')
    return { how: '丢弃', why: '队列满' }
  }
  MEDIA.queue.push({ item, meta })
  mediaLog(`… ${tag} 排队（第 ${MEDIA.queue.length} 个）`, 'queue')
  return { how: '排队', tier: meta.tier }
}

/* ── 她说话时把 0 档视频的音量压下去（2026-10-28 加）──────────────────
 * 以前是「她一开口就把 0 档视频**收掉**」：`mediaFinish(..., '她要说话了')`。
 * 代价是 83 秒的点播视频只放 20 秒就没了 —— 主人：「还有一个普通视频呢！」
 * （日志对得上：00:01:42 点播 → 00:02:02 被收掉，正好 20 秒宽限期）。
 *
 * 现在改成**压低不中断**：画面继续放，她的声音也听得清。
 * 只压 0 档（闲时 / 点播，自带声音的那种）。礼物视频不压 ——
 * 它们本来就短，而且是观众花钱换来的「正片」，压了反而没意思。
 * 0.2 这个值没做成配置项：再高（0.6 那种）人声还是会被盖住，等于没压。 */
const VIDEO_DUCK_WHEN_SPEAKING = 0.2

/** 这一刻该用多少音量（画面每 0.4 秒读一次，所以这里是「现算」不是「记状态」） */
function mediaVolumeNow(cur) {
  if (!cur) return 0
  const base = Number(cur.volume) || 0
  /* 0 档说话时压低 —— 但**礼物带出来的 0 档不压**（2026-10-28）：
   * 那是观众花了钱换来的「正片」，压了就没意思，跟 1–4 档礼物视频一个道理。
   * 用 cur.gift 区分来源，别用 tier 一刀切。 */
  if (cur.tier === 0 && !cur.gift && Date.now() < speakUntil) {
    return Math.min(1, Math.max(0, base * VIDEO_DUCK_WHEN_SPEAKING))
  }
  return base
}

/** 给 /state.json 和设置页用的当前状态 */
function mediaOut() {  const scan = scanMedia()
  return {
    on: mediaCfg.on,
    dir: mediaDir(),
    dirExists: scan.exists,
    idle: mediaCfg.idle,
    /* 闲时播放的现状：为什么没放、下一个素材是哪个、上次放的时刻。
     * 排查「怎么一直不放视频」就看这三个数。 */
    idlePlay: {
      ...idleCfg(),
      pool: (scan.idle || []).length,
      lastAt: idleAt,
      quietFor: Math.max(0, Math.round((Date.now() - (quietSince || START)) / 1000)),
    },
    seq: MEDIA.seq,
    cur: MEDIA.cur
      ? {
        seq: MEDIA.cur.seq, name: MEDIA.cur.name, kind: MEDIA.cur.kind,
        /* 🔴 file 必须给 —— 解码在画面那边（native/media.py），
         *    它得拿到绝对路径才能开文件。只给 name 的话画面只会一直待机。 */
        file: MEDIA.cur.file,
        tier: MEDIA.cur.tier, user: MEDIA.cur.user, gift: MEDIA.cur.gift,
        request: MEDIA.cur.request,
        /* 音量发的是「此刻该用多少」，不是素材的原始音量：
         * 她说话的时候 0 档视频要压下去（见 mediaVolumeNow）。 */
        volume: mediaVolumeNow(MEDIA.cur), loop: MEDIA.cur.loop,
        maxMs: MEDIA.cur.maxMs, at: MEDIA.cur.at,
        leftMs: Math.max(0, MEDIA.cur.at + MEDIA.cur.maxMs - Date.now()),
      }
      : null,
    queue: MEDIA.queue.map((q) => ({ name: q.item.name, tier: q.meta.tier, user: q.meta.user, gift: q.meta.gift })),
    log: MEDIA.log.slice(0, 12),
    counts: {
      0: (scan.idle || []).length,
      1: scan.byTier[1].length, 2: scan.byTier[2].length,
      3: scan.byTier[3].length, 4: scan.byTier[4].length,
      others: scan.others.length,
    },
  }
}



/* ── TTS（2026-10-26 加）──────────────────────────────────────────────
 * 主人拍板用 edge-tts（晓伊），因为它更甜；piper 只要 0.39 秒但音色偏平。
 * 代价是每条冷启动 2.2 秒 —— 所以**缓存是命门**：
 * 直播里短句重复率极高，命中缓存就是 0 延迟（见 tools/tts.py 头注释）。
 *
 * 关掉：--no-tts 或环境变量 REPLY_TTS=0
 * 换音色：REPLY_TTS_VOICE=zh-CN-XiaoxiaoNeural
 *
 * 🔴 demo 模式默认**不出声**（2026-10-27 加）：拿 --demo 验链路时如果还开麦，
 *    这台机器上就真的会念「谢谢 K 的抖音一号」—— 主人正在直播，观众全听见了。
 *    想在 demo 里听声音，显式加 --speak。
 */
const TTS_ON = !has('no-tts') && String(process.env.REPLY_TTS ?? '1') !== '0'
  && !(DEMO && !has('speak'))
const TTS_VOICE = String(process.env.REPLY_TTS_VOICE || 'zh-CN-XiaoyiNeural')
const TTS_RATE = String(process.env.REPLY_TTS_RATE || '-8%')

/** 优先用项目里的 .venv（edge-tts 装在那儿），没有才退回系统 python。
 *
 * 🔴 一定要用 **pythonw.exe**（2026-10-27 修「一直有弹窗」）：
 *    venv 的 python.exe 只是个 launcher，它再拉起 base 解释器时**不带**
 *    CREATE_NO_WINDOW —— 屏幕上就闪一个空的黑窗口。`windowsHide: true`
 *    管得住第一层（launcher），管不住 launcher 自己创建的第二层。
 *    pythonw.exe 本身不分配控制台，stdin/stdout 走管道照常工作，实测没问题。
 */
function pyExe() {
  const w = path.join(DIR, '.venv', 'Scripts', 'pythonw.exe')
  if (fs.existsSync(w)) return w
  const v = path.join(DIR, '.venv', 'Scripts', 'python.exe')
  return fs.existsSync(v) ? v : 'pythonw'
}

/** 跑一个 python 小工具，收它第一行 JSON。超时就放弃，别把回复卡死。 */
function pyOnce(script, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const child = spawn(pyExe(), [path.join(DIR, 'tools', script), ...args], {
      cwd: DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.stdout.on('data', (b) => {
      out += b.toString('utf8')
      const nl = out.indexOf('\n')
      if (nl >= 0) {
        try { finish(JSON.parse(out.slice(0, nl))) } catch { finish(null) }
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', () => finish(null))
    child.on('close', () => {
      if (done) return
      try { finish(JSON.parse(out.trim().split('\n')[0])) } catch { finish(null) }
    })
  })
}

/* ── 常驻子进程工厂（tts / player 用）─────────────────────────────────
 * 为什么要常驻（2026-10-27）：
 *   以前每说一句话要 spawn 两个 python（tts.py 合成、play.py 播放），
 *   每个都要 250~400ms 才起来。观众的感受是「字幕先出来，声音一秒后才响」。
 *   常驻之后一条命令 20ms，音画基本同步。
 *
 * 顺带治了另一个病：短时间连续 spawn 好几个进程，Windows 会弹
 *   「出现错误 2147942632 (0x800700e8)（没有足够的配额来处理此命令）」
 * 那个对话框还会浮在直播伴侣上面，得手动点掉。
 *
 * 回包规则：python 那边**一条命令回一行**，严格串行。
 * 所以超时不能把等待者从队列里删掉（删了后面的回包就错位到别人头上），
 * 只能标 dead，让回包来了照样消耗掉。
 */
function makeService(tag, script, bootArgs = []) {
  let proc = null
  let buf = ''
  const queue = []
  let dead = false
  let restartAt = 0
  let gap = 2000

  function start() {
    if (dead || proc) return
    const file = path.join(DIR, 'tools', script)
    if (!fs.existsSync(file)) {
      log(`  [${tag}] 没有 tools/${script}，关掉`)
      dead = true
      return
    }
    const child = spawn(pyExe(), [file, ...bootArgs], {
      cwd: DIR,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc = child
    buf = ''
    child.stdout.on('data', (b) => {
      buf += b.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const w = queue.shift()
        if (!w) continue
        clearTimeout(w.timer)
        if (w.dead) continue
        try { w.resolve(JSON.parse(line)) } catch { w.resolve({ ok: false, why: '返回不是 JSON' }) }
      }
    })
    let errBuf = ''
    child.stderr.on('data', (b) => {
      const s = b.toString('utf8')
      errBuf = (errBuf + s).slice(-600)
      /* 常驻进程平时 stderr 是空的，有内容就是出事了 —— 打出来，
       * 不然崩了只看到「退出（code=1）」，完全不知道为什么。
       * 启动时 tts/player 各会打一行「xx 常驻就绪」，那是正常的。 */
      const line = s.trim()
      if (line) log(`  [${tag}] ${line.slice(0, 240)}`)
    })
    child.on('error', (e) => log(`  [${tag}] 起不来：`, e?.message || e))
    child.on('exit', (code) => {
      proc = null
      buf = ''
      for (const w of queue.splice(0)) {
        clearTimeout(w.timer)
        w.resolve({ ok: false, why: `${tag} 退出了` })
      }
      if (dead) return
      restartAt = Date.now() + gap
      gap = Math.min(30000, gap * 2)
      log(`  [${tag}] 退出（code=${code}），${Math.round((restartAt - Date.now()) / 1000)} 秒后重启`)
    })
    log(`  [${tag}] 常驻就绪`)
  }

  function cmd(payload, timeoutMs = 15000) {
    return new Promise((resolve) => {
      if (dead) return resolve({ ok: false, why: `${tag} 不可用` })
      if (!proc) {
        if (Date.now() >= restartAt) start()
        return resolve({ ok: false, why: `${tag} 还没起来` })
      }
      const w = { resolve }
      w.timer = setTimeout(() => {
        w.dead = true
        resolve({ ok: false, why: '超时' })
      }, timeoutMs)
      queue.push(w)
      try {
        proc.stdin.write(JSON.stringify(payload) + '\n')
      } catch (e) {
        clearTimeout(w.timer)
        w.dead = true
        resolve({ ok: false, why: String(e?.message || e) })
      }
    })
  }

  return {
    start,
    cmd,
    stop() {
      dead = true
      try { proc?.stdin.end() } catch {}
      try { proc?.kill() } catch {}
      proc = null
    },
    get ready() { return !!proc },
    get dead() { return dead },
  }
}

const TTS_SVC = makeService('tts', 'tts.py', ['--serve'])
const PLAY_SVC = makeService('player', 'play.py', ['--serve'])

/* ── 音乐：直接控制本机 QQ 音乐（2026-10-27 加）────────────────────────
 * 走 Windows 自己的 SMTC（就是 Win+G 那个「正在播放」浮窗背后的接口），
 * 所以不用扫码登录、不用 QQ 音乐开 API、换播放器也不用改代码。
 * 音量单独走 WASAPI（pycaw），因为 SMTC 只管「播/停」，不管「多大声」——
 * 有了它才能做 TTS 闪避：她开口时音乐自己压下去，说完抬回来。
 *
 * 为什么常驻：一次性调用要 300ms 起进程，画面每 1.5 秒要一次曲目。
 * 常驻一个进程，一条命令 20ms。崩了自动重启，不会把直播带崩。
 */
/* 音乐总开关分两层（2026-10-28）：
 *   · `--no-music` / `ZY_MUSIC=0` = **强制关**，面板也打不开（起桥参数最高优先级）
 *   · 其余读 cache/media.json 的 `musicOn` —— 面板那个开关改的就是它，重启桥后还记得
 * 不把面板的值写回环境变量的原因：环境变量只在起桥那一刻生效，改一次就得全停重启，
 * 而「关个背景音乐」不该有这种代价。 */
const MUSIC_FORCED_OFF = has('no-music') || String(process.env.ZY_MUSIC ?? '1') === '0'
let musicOn = !MUSIC_FORCED_OFF && mediaCfg.musicOn !== false
const MUSIC_POLL = Number(process.env.ZY_MUSIC_POLL || 1500)

let mediaProc = null
let mediaBuf = ''
let mediaQueue = [] // 按顺序等回包的请求（python 那边是串行处理的）
let mediaRestartAt = 0
let mediaGap = 2000 // 重启间隔，连续失败就翻倍，最多 30 秒
let mediaDead = false // 素材/依赖没装好时彻底放弃，别每 2 秒刷一次日志

/** 当前曲目快照。画面和面板都读它，不直接去问 python（1.5 秒一次够了）。 */
let music = {
  ok: false, why: '还没连上', found: false, playing: false, status: 'none',
  title: '', artist: '', album: '', pos: 0, dur: 0, volume: null, at: 0,
}

function startMusic() {
  if (!musicOn || mediaDead || mediaProc) return
  const script = path.join(DIR, 'tools', 'media.py')
  if (!fs.existsSync(script)) {
    log('  [music] 没有 tools/media.py，音乐控制关掉')
    mediaDead = true
    return
  }
  const child = spawn(pyExe(), [script, '--serve'], {
    cwd: DIR,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  mediaProc = child
  mediaBuf = ''

  child.stdout.on('data', (b) => {
    mediaBuf += b.toString('utf8')
    let nl
    while ((nl = mediaBuf.indexOf('\n')) >= 0) {
      const line = mediaBuf.slice(0, nl).trim()
      mediaBuf = mediaBuf.slice(nl + 1)
      if (!line) continue
      const w = mediaQueue.shift()
      if (!w) continue
      clearTimeout(w.timer)
      if (w.dead) continue // 已经超时告知调用方了，回包直接丢掉（但顺序不能乱）
      try {
        w.resolve(JSON.parse(line))
      } catch {
        w.resolve({ ok: false, why: '返回不是 JSON' })
      }
    }
  })
  let errBuf = ''
  child.stderr.on('data', (b) => {
    errBuf = (errBuf + b.toString('utf8')).slice(-800)
  })
  child.on('error', (e) => {
    log('  [music] 起不来：', e?.message || e)
  })
  child.on('exit', (code) => {
    mediaProc = null
    mediaBuf = ''
    // 挂掉的请求全部失败掉，不然画面那边会一直等
    for (const w of mediaQueue.splice(0)) {
      clearTimeout(w.timer)
      w.resolve({ ok: false, why: '音乐进程退出了' })
    }
    if (!musicOn) return
    // ModuleNotFoundError 这种是「依赖没装」，重启一万次也没用
    if (/ModuleNotFoundError|No module named/i.test(errBuf)) {
      mediaDead = true
      music = { ...music, ok: false, why: '缺依赖（见 tools/media.py 头注释）', at: Date.now() }
      log('  [music] 缺 python 依赖，音乐控制关掉：', errBuf.trim().split('\n').pop())
      return
    }
    mediaRestartAt = Date.now() + mediaGap
    mediaGap = Math.min(30000, mediaGap * 2)
    log(`  [music] 进程退出（code=${code}），${Math.round((mediaRestartAt - Date.now()) / 1000)} 秒后重启`)
  })
  log('  [music] 已接入系统播放器（QQ 音乐等）')
}

/** 发一条命令给常驻进程，返回它的 JSON。超时/没起来都返回 {ok:false}。 */
function mediaCmd(cmd, extra = {}, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!musicOn || mediaDead) return resolve({ ok: false, why: '音乐控制没开' })
    if (!mediaProc) {
      startMusic()
      return resolve({ ok: false, why: '音乐进程还没起来' })
    }
    const w = { resolve }
    w.timer = setTimeout(() => {
      /* ⚠️ 超时**不能**从 mediaQueue 里删掉（2026-10-27 修）。
       * python 那边是一条命令回一行、严格串行；把等待者删掉，
       * 后面的回包就会错位到别人头上 —— 实测点歌时画面歌名乱跳、
       * 队列读到一半变空，全是这个错位造成的。
       * 正确做法：标成 dead，回包来了照样把它消耗掉，只是没人接。 */
      w.dead = true
      resolve({ ok: false, why: '超时' })
    }, timeoutMs)
    mediaQueue.push(w)
    try {
      mediaProc.stdin.write(JSON.stringify({ cmd, ...extra }) + '\n')
    } catch (e) {
      clearTimeout(w.timer)
      w.dead = true
      resolve({ ok: false, why: String(e?.message || e) })
    }
  })
}

/** 慢命令（切歌 / 翻歌单）：期间不要让画面轮询去插队。
 *  get 每 1.5 秒发一次，一个 10 秒的切歌会积 7 个 get 在队列里排着，
 *  它们各自 2.5 秒就超时 —— 虽然现在超时不再错位，但日志会刷一堆「超时」。 */
let mediaLong = 0
async function mediaCmdSlow(cmd, extra = {}, timeoutMs = 26000) {
  mediaLong++
  try {
    return await mediaCmd(cmd, extra, timeoutMs)
  } finally {
    mediaLong--
  }
}

/** 拉一次曲目，更新 music 快照 */
async function pollMusic() {
  if (!musicOn || mediaDead) return
  /* 音乐现在由插件放的时候，别让 QQ 音乐的快照盖掉它 ——
   * 两边都写同一个 music 对象，谁后写谁赢，会看到歌名每 1.5 秒来回跳。 */
  if (musicSrc === 'box') return
  if (mediaLong > 0) return // 正在切歌/翻歌单，这会儿插队只会挤出一堆「超时」
  if (!mediaProc) {
    if (Date.now() >= mediaRestartAt) {
      mediaGap = 2000
      startMusic()
    }
    return
  }
  const r = await mediaCmd('get')
  if (!r) return
  const prevTitle = music.title
  const changed = r.title !== music.title || r.artist !== music.artist || r.playing !== music.playing
  music = {
    ok: !!r.ok,
    why: r.why || '',
    found: !!r.found,
    playing: !!r.playing,
    status: r.status || 'none',
    title: r.title || '',
    artist: r.artist || '',
    album: r.album || '',
    pos: Number(r.pos) || 0,
    dur: Number(r.dur) || 0,
    volume: r.volume ?? null,
    at: Date.now(),
  }
  if (changed && music.title) {
    log(`  ♫ ${music.title}${music.artist ? ' - ' + music.artist : ''}${music.playing ? '' : '（暂停）'}`)
    broadcast('music', music)
    // 换歌了：把快照往前滚一格（不翻歌单，见 noteSong 的注释）
    noteSong(prevTitle)
  }
  // 还没快照过：连上就抓一次，不然点歌台一直空着。
  // 抓一次要 7 秒（翻歌单），越早抓越好 —— 开播时还没人说话，正好错开。
  if (music.found && !queue.list.length && !queue.busy) {
    setTimeout(() => refreshQueue(true), 1200)
  }
}

/* ── 音乐：单身汉播放器（dsh-music-huazai 插件，2026-10-27 加）──────────
 *
 * 为什么要换：QQ 音乐那条路走的是 SMTC + UI 自动化 ——
 *   · SMTC 只能「上一首/下一首」，**没有「播第 N 首」**，所以点歌只能靠按 next 硬翻，
 *     翻 18 首 ≈ 12 秒，翻完还得一首首退回来，退回来进度归零；
 *   · UI 自动化要抢焦点（屏幕上闪一下）、会冲掉整个播放队列、还得登录着。
 * 观众点一首歌，代价是切十几首 + 画面乱跳 —— 这不是能上直播的方案。
 *
 * 单身汉播放器是 DSH 的原生插件：真的搜索接口、真的队列、真能指定哪一首。
 * 播放发生在 **DSH 的网页端**（HTMLAudio），宿主这边只通过 HTTP 下命令：
 *
 *   GET  /api/dsh-music/state            → { clientAlive, nowPlaying, pending }
 *   GET  /api/dsh-music/search?keyword=  → { tracks: [...] }
 *   POST /api/dsh-music/bridge/command   → { type:'play'|'queue_add'|'volume'|'next' ... }
 *
 * 🔴 两个坑（都是「假绿灯」的老毛病）：
 *   1. clientAlive 是浏览器每 2 秒轮询打的心跳。为 false 就说明**播放器界面没开**，
 *      这时候下命令只是塞进队列躺着，永远不会响 —— 必须先说「播放器没开」。
 *   2. 下完命令要**回读一次** nowPlaying 才算数。跟点歌那三层谎话一个道理：
 *      发出去了 ≠ 放上了。
 *
 * 插件本体在 D:\develop\SinglePlayer（GPL-3.0），
 * 我给它打了个小补丁：/bridge/command 放行 play / queue_add（见 .patch/）。
 */
const BOX_ON = !has('no-box') && String(process.env.ZY_BOX ?? '1') !== '0'
const BOX_POLL = Number(process.env.ZY_BOX_POLL || 1500)

/* 🔴 DSH 的 web 端口是**动态的**，每次重启都可能换一个。
 * 写死 http://127.0.0.1:8140 的话，主人重启一次 DSH 点歌就全废了，
 * 而且报错还是「连不上 DSH」—— 明明 DSH 开得好好的，最难查。
 *
 * 桥是 DSH 拉起来的子进程，process.ppid 就是宿主进程：
 * 拿它去 netstat 里翻监听端口，再挨个问一句「你是不是 DSH」，问出来的才用。
 * 环境变量 DSH_MUSIC_API / DSH_BASE 优先（调试时可以手动指）。 */
let boxApi = String(process.env.DSH_MUSIC_API || process.env.DSH_BASE || '').replace(/\/+$/, '')
let boxApiAt = 0

/** 跑一条命令，异步拿 stdout（🔴 不能用 execSync：它会把整个事件循环堵死，
 *  实测端口扫描那几秒里 demo 弹幕、TTS、画面轮询全停，像卡死一样） */
function sh(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: 6000, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''))
    })
  })
}

/** 这批 pid 在本机监听的端口（只认 loopback / 通配绑定） */
async function scanListeners(pids) {
  const want = new Set(pids.map(Number))
  if (!want.size) return []
  const text = await sh('netstat -ano')
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (!m) continue
    if (!want.has(Number(m[3]))) continue
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])$/.test(m[1])) continue
    const port = Number(m[2])
    if (!out.includes(port)) out.push(port)
  }
  return out
}

/** 进程名匹配的 pid（用来兜底找 DSH 宿主） */
async function pidsMatching(re) {
  const text = await sh('tasklist /fo csv /nh')
  const pids = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/)
    if (m && re.test(m[1])) pids.push(Number(m[2]))
  }
  return pids
}

/** 这个端口是不是 DSH 的 web 服务 */
async function looksLikeDsh(port) {
  const base = `http://127.0.0.1:${port}`
  /* 先问弹幕插件自己的路由：它一定挂在 DSH 的 webServer 上，
   * 而且不需要鉴权（音乐插件没装的时候 /health 会 401，认不出来）。 */
  for (const probe of ['/api/douyin-duty/zhibo/status', '/api/dsh-music/health']) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 900)
    try {
      const res = await fetch(base + probe, { signal: ctl.signal })
      if (res.status === 200) {
        const text = await res.text()
        if (text.trim().startsWith('{')) return true
      }
    } catch {
      /* 这个端口不是 */
    } finally {
      clearTimeout(t)
    }
  }
  return false
}

/** 拿到插件接口的 base（带缓存，60 秒内不重复找） */
async function boxBase() {
  if (boxApi && Date.now() - boxApiAt < 60000) return boxApi
  if (process.env.DSH_MUSIC_API || process.env.DSH_BASE) {
    boxApiAt = Date.now()
    return boxApi
  }
  /* 🔴 2026-10-29：这里以前是
   *      const cands = await scanListeners([process.ppid])
   *      if (!cands.length) { ...按进程名找 DSH... }
   *   —— 把「ppid 有没有端口」当成了「ppid 是不是 DSH」。
   *
   *  桥一旦不是由 DSH 直接拉起（实测：被 WorkBuddy 的 server.mjs 拉起，
   *  ppid 只监听 18082），cands 就非空，按进程名兜底那段**永远不执行**，
   *  于是扫不到 DSH（监听 5217 / 3444 / 3443 / 8326），一直回落到
   *  127.0.0.1:8140 —— 症状是「连不上 DSH（没开？）」：点歌全废、
   *  音源回落 qq、热榜停摆。而 curl 直连 5217 一切正常，极难排查。
   *
   *  所以两个来源**无条件合并**，一次 netstat 全拿到，不再用「有没有端口」猜。
   *  父进程排前面：DSH 直接起桥时它最快命中，不用等后面那几个探针。 */
  const pids = [process.ppid, ...(await pidsMatching(/deepseek|dsh/i))]
  const cands = await scanListeners(pids)
  for (const p of cands) {
    if (await looksLikeDsh(p)) {
      const next = `http://127.0.0.1:${p}/api/dsh-music`
      if (next !== boxApi) log(`  ♫ DSH 在 ${p} 端口，音乐接口 ${next}`)
      boxApi = next
      boxApiAt = Date.now()
      return boxApi
    }
  }
  /* 找不到就退回上次的（可能只是这一秒刚好没起来），下次再找 */
  boxApiAt = Date.now() - 55000
  return boxApi || 'http://127.0.0.1:8140/api/dsh-music'
}

/** 插件现状。alive=false 表示 DSH 开着但音乐界面没打开。 */
let box = { ok: false, alive: false, why: '还没连上', at: 0, now: null, pending: 0, queue: [], qIndex: -1 }
/** 音乐从哪儿来：'box' = 插件（DSH 里放），'qq' = 本机 QQ 音乐 */
let musicSrc = 'box'
/* 插件从什么时候开始连不上（0 = 现在连着）。用来做「心跳抖动宽限」，
 * 见 pollMusicLoop 里那段注释。 */
let boxDeadSince = 0
/* 我们下发过的音量（闪避要用它算）。初值取配置里的「音乐基准音量」，
 * 这样重启后不会先把音乐顶到 100% 再被改回来。 */
let boxVol = Math.min(1, Math.max(0, Number(mediaCfg.audio.music) / 100))
let boxDuckSaved = null // 闪避前的音量，恢复时还原
/* 观众点过的歌（点歌台显示「接下来」用）。**每项都带时间戳**，原因见下面 boxQueueSettle。
 * 形状：[{ name, id, at, hot }]  —— hot 表示这首是热榜垫的，不是观众点的。
 * **id 是 2026-10-28 加的**：只靠歌名对账会误删，见 sameTrack() 那段。 */
let boxQueue = []

/* 队列对账参数。
 * STALE：在放的东西不是观众点的那首时，队里等多久算「已经被跳过」。
 * MAX_WAIT：不管什么情况，等多久都从点歌台撤掉（这是最后的兜底）。 */
const QUEUE_STALE_MS = Number(process.env.ZY_QUEUE_STALE || 10 * 60 * 1000)
const QUEUE_MAX_WAIT = Number(process.env.ZY_QUEUE_MAXWAIT || 20 * 60 * 1000)

function boxQueueNames() {
  return boxQueue.map((x) => x.name)
}
function boxQueuePush(name, hot = false, id = '') {
  const n = String(name || '').trim()
  if (!n) return
  boxQueue.push({ name: n, id: String(id || ''), at: Date.now(), hot: !!hot })
  while (boxQueue.length > QUEUE_MAX) boxQueue.shift()
}

/** 队列对账专用：这两条**是不是同一首**。
 *
 *  🔴 2026-10-28 的「歌被顶了」事故就是这里判错造成的。
 *  `sameTitle()` 用的是 `x.includes(y) || y.includes(x)`，而 `normTitle()` 会把
 *  括号里的内容整段删掉 —— 于是：
 *      《DAMIDAMI(哈基米版)》 → damidami
 *      《DAMIDAMI》          → damidami      ← 两首不同的歌被判成同一首
 *  播 Sihan 的《DAMIDAMI》时，对账从后往前找到《DAMIDAMI(哈基米版)》那一项，
 *  把它和它前面的**全部**当成"已经放过"清掉 → 队列账本清空 →
 *  后面每首点歌的 offset 都算成 0 → 后点的插到最前 → **播放顺序整个倒过来**，
 *  而《我不难过》这类还没播的直接从点歌台消失（主人：「我的歌曲被顶了」）。
 *
 *  所以对账一律先比 trackId（`netease:xxx` 这种，唯一且不会被标题规范化影响），
 *  只有拿不到 id 的老数据才退回歌名比较，且**要求归一化后完全相等**，
 *  不再用包含关系。搜索打分那边仍然用宽松的 sameTitle()，两件事分开。 */
function sameTrack(item, id, title) {
  const a = String((item && item.id) || '')
  const b = String(id || '')
  if (a && b) return a === b
  const x = normTitle(item && item.name)
  const y = normTitle(title)
  return Boolean(x) && x === y
}

/* 观众点过的歌（2026-10-28）。画面现在**只显示观众点的歌**，热榜只后台放。
 *
 * 判断方式故意选成"点过的才显示"，而不是"热榜的不显示"：
 *   热榜那条路认不全 —— 播放器可能自己切、桥重启过、切歌切到队列里的旧歌，
 *   这些都不是"刚垫的热榜"，用 id 白名单永远会漏（实测过：切歌切到《逆光》，
 *   它不在任何热榜记录里，就被画面当成观众点的显示出来了）。
 *   反过来记"谁点过"是完备的：没点过的一律不显示。
 *
 * 落盘：桥一重启就清空的话，正在放的那首点歌会突然从画面消失。
 */
const REQ_ID_FILE = path.join(DIR, 'cache', 'requested-ids.json')
const requestedIds = new Set()
try {
  const j = JSON.parse(fs.readFileSync(REQ_ID_FILE, 'utf8'))
  /* 超过一天丢掉：点歌记录隔天没意义，只会让今天的同名歌被误判。 */
  if (Date.now() - Number(j.at || 0) < 24 * 3600 * 1000) {
    for (const x of (j.ids || [])) requestedIds.add(String(x))
  }
} catch { /* 第一次跑没有这个文件 */ }

function saveRequestedIds() {
  try {
    fs.mkdirSync(path.dirname(REQ_ID_FILE), { recursive: true })
    fs.writeFileSync(REQ_ID_FILE, JSON.stringify({ at: Date.now(), ids: [...requestedIds].slice(-300) }), 'utf8')
  } catch (e) {
    log(`  [music] 点歌记录存盘失败（不影响播放）：${e?.message ?? e}`)
  }
}

function markRequested(id) {
  const k = String(id || '')
  if (!k) return
  requestedIds.add(k)
  if (requestedIds.size > 300) {
    const arr = [...requestedIds]
    requestedIds.clear()
    for (const x of arr.slice(-150)) requestedIds.add(x)
  }
  saveRequestedIds()
}
/** 对账：让 boxQueue 重新等于「播放器里真正还没轮到的那几首」。
 *
 *  🔴 2026-10-27 深夜的播出事故（主人原话：「点了歌曲，一直不往下播放，我的唯一都好久之前了」）。
 *  根因就在这个队列**只增不减** —— 原来唯一的清理点是「标题变了、且新标题跟队里某首同名」。
 *  于是只要有一首被跳过的歌留在队里，它就永远出不去：
 *    · 22:47 / 22:52 热榜垫的《周旋》《回到你身边》进队后一首都没放成；
 *    · 23:16 观众又点了一次《唯一》，进队；
 *    · 三笔老账把队列撑到 3 首，而 HOT_KEEP 是 2 —— hotNeed() 永远是 0，
 *      **热榜补歌从 22:52 起彻底停工 55 分钟**（日志里这段时间一条「热榜垫上」都没有），
 *      后备歌放完就没了下一首。点歌台里那三首歌也就一直挂着，几小时前点的。
 *
 *  现在靠两条规矩算账：
 *    ① 播放器是 FIFO —— 正在放的这首如果在队里，它和它**前面**的一律已经过去；
 *    ② 正在放的**不在**队里（热榜 play 跳走 / 操作员手点 / 换源失败被自动跳过），
 *       就按时间算：等太久的认它是被跳过了。
 *  返回「有没有变」，方便调用方决定要不要广播。 */
function boxQueueSettle(nowTitle, nowId) {
  const before = boxQueueNames().join('|')
  const now = Date.now()
  const title = String(nowTitle || '')
  const id = String(nowId || '')

  /* 🔴 有真实队列就以它为准（2026-10-29）。这条是根治：
   * 播放器现在每 2 秒把**整条队列**报上来，桥不用再靠歌名猜「排了哪几首」。
   *
   * 做法：取「当前曲之后」那一段，按顺序去 boxQueue 里取同名条目 ——
   * 取到的沿用原来的 hot 标记和时间戳（点歌台靠 hot 分「谁点的」、靠 at 算等了多久）；
   * 取不到的是热榜垫的 / 桥重启后不认识的老歌，补一条按热榜记（这样不会
   * 冒充成观众点的挂在点歌台上）。
   * 反过来：队里有、播放器里没有的，说明已经被跳过或早唱完了 —— 直接丢掉。
   *
   * 以前没有这段，全靠「标题变了」推演，一旦播放器那边被跳过/重排，
   * 账就永远对不回来，表现就是「点歌台显示的和实际放的不一样」。 */
  if (box.queue.length && box.qIndex >= 0) {
    const pool = boxQueue.slice()
    const used = new Set()
    const next = []
    const takeIdx = (nm) => {
      let k = pool.findIndex((x, i) => !used.has(i) && normTitle(x.name) === normTitle(nm))
      if (k < 0) k = pool.findIndex((x, i) => !used.has(i) && sameTitle(x.name, nm))
      return k
    }
    for (const t of box.queue.slice(box.qIndex + 1)) {
      const nm = String((t && t.name) || '').trim()
      if (!nm) continue
      const k = takeIdx(nm)
      if (k >= 0) {
        used.add(k)
        next.push(pool[k])
      } else {
        next.push({ name: nm, at: now, hot: true, assumed: true })
      }
    }
    /* 刚点进去的那几首要护一下（2026-10-29）。
     * 命令发出去到浏览器下一次轮询（最多 2 秒）之间，真实队列里还看不到它；
     * 这时候直接按真实队列重建，会把刚点的歌当场删掉 —— 点歌台闪一下就没，
     * 而那首歌 2 秒后其实正常放上了。8 秒内的条目一律保留（按原顺序补在后面）。
     * ⚠️ 但**正在放的这首要排除**：它已经在 qIndex 上，不属于「接下来」，
     *    不排掉的话点歌台会多出一行正在唱的歌（实测踩过）。 */
    for (const x of pool) {
      if (now - x.at >= 8000) continue
      if (title && sameTitle(x.name, title)) continue
      if (next.some((y) => normTitle(y.name) === normTitle(x.name))) continue
      next.push(x)
    }
    boxQueue = next
    queue.list = boxQueueNames().slice(0, QUEUE_MAX)
    return before !== boxQueueNames().join('|')
  }

  let hit = -1
  if (title || id) {
    /* 从后往前找：同一首在队里出现两次时，以最后一次为准（前面的肯定已经放过） */
    for (let i = boxQueue.length - 1; i >= 0; i--) {
      if (sameTrack(boxQueue[i], id, title)) {
        hit = i
        break
      }
    }
  }
  if (hit >= 0) boxQueue = boxQueue.slice(hit + 1)
  else if (title) boxQueue = boxQueue.filter((x) => now - x.at < QUEUE_STALE_MS)
  /* 🔴 播放器空着的时候，账本里超过 12 秒的条目一律丢掉（2026-10-29 加）。
   *
   * 场景：点歌命令发出去了、桥也记了账，但播放器那边没落住（服务重启 /
   * 页面取走命令后丢了 / 音源失败被自己跳过）。播放器空了，账本还留着，
   * 于是 hotNeed() 看到「还有观众点的歌没放完」→ **热榜永远让路** →
   * 没人再点歌就一直静着，而且自己永远好不了（今天 14:14 就是这个状态，
   * 最后靠观众点了首歌才拉起来）。
   *
   * 12 秒是给「命令发出 → 浏览器下一次轮询（2 秒）→ 上报」留的余量；
   * 只在页面真的连着（box.alive）时才丢，页面关着的时候命令还压在
   * 播放器服务里，账不能提前清掉。 */
  else if (box.alive && !box.now && !box.queue.length) {
    boxQueue = boxQueue.filter((x) => now - x.at < 12000)
  }
  boxQueue = boxQueue.filter((x) => now - x.at < QUEUE_MAX_WAIT)
  queue.list = boxQueueNames().slice(0, QUEUE_MAX)
  return before !== boxQueueNames().join('|')
}
/* ⚠️ 别塞进 box 对象里：boxState() 每次都整个换一个新对象，塞进去就丢了，
 * 结果「播放中」这个判断永远成立，日志每 1.5 秒刷一行。 */
let boxLastPlaying = null

/** 调插件接口。连不上 / 401 / 不是 JSON 都折成 {ok:false, why}，绝不抛。 */
async function boxJson(pathname, { method = 'GET', body, timeout = 3000 } = {}) {
  const base = await boxBase()
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(`${base}${pathname}`, {
      method,
      signal: ctl.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    /* 401 = 路由没挂上，请求落到了要鉴权的兜底处理上。
     * 换句话说：插件装了但 DSH 还没重启（或者没加进 profile.bundles）。 */
    if (res.status === 401) return { ok: false, why: '插件没加载（要重启 DSH）' }
    if (res.status === 404) return { ok: false, why: '插件没装（/api/dsh-music 不存在）' }
    try {
      return { ok: true, ...JSON.parse(text) }
    } catch {
      return { ok: false, why: `插件回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 80)}` }
    }
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return { ok: false, offline: true, why: aborted ? `插件 ${Math.round(timeout / 1000)} 秒没回话` : '连不上 DSH（没开？）' }
  } finally {
    clearTimeout(t)
  }
}

/** 问一次现状 */
async function boxState() {
  const r = await boxJson('/state', { timeout: 2500 })
  if (!r.ok) {
    box = { ...box, ok: false, alive: false, why: r.why || '问不到', at: Date.now() }
    return box
  }
  /* 播放器里的**真实队列**（2026-10-29 起浏览器每次上报都带）。
   * 以前桥只能自己记账 + 靠歌名对账，一旦播放器那边被跳过/重排，
   * 账就永远歪着 —— 这就是「点歌台显示的跟实际播放的不一样」。 */
  const np = r.nowPlaying || null
  const realQ = Array.isArray(np && np.queue) ? np.queue : []
  box = {
    ok: true,
    alive: !!r.clientAlive,
    why: r.clientAlive ? '' : '播放器界面没开（打开控制台 http://127.0.0.1:18082/ 那一页）',
    at: Date.now(),
    now: np,
    pending: Number(r.pending) || 0,
    queue: realQ,
    /* 🔴 np 可能是 null（播放器没在放）。写成 `np && np.index` 不行：
     * null && x 得到 null，而 Number(null) === 0 被当成有限数，
     * 下一句 Number(np.index) 直接 TypeError，桥**根本起不来**。
     * 必须先判 np.index 存在再转数字。 */
    qIndex: np && np.index != null && Number.isFinite(Number(np.index)) ? Number(np.index) : -1,
  }
  return box
}

/** 把插件状态映射进 music 快照 —— 画面/面板/闪避都只读这一个对象，别处不用改。 */
function boxToMusic() {
  const n = box.now
  const prevTitle = music.title
  if (!box.alive || !n || !n.trackId) {
    /* 播放器开着但没在放：**必须清空歌名**。
     * 留着上一首的名字，画面会一直显示那首，观众以为还在放。 */
    music = {
      ...music, ok: box.ok, why: box.why, found: false, playing: false, status: 'none',
      title: '', artist: '', album: '', pos: 0, dur: 0, volume: boxVol, at: Date.now(), trackId: '',
    }
    return
  }
  music = {
    ok: true,
    why: '',
    found: true,
    playing: !!n.playing,
    status: n.playing ? 'playing' : 'paused',
    title: String(n.name || ''),
    artist: Array.isArray(n.artists) ? n.artists.join('/') : String(n.artists || ''),
    album: String(n.album || ''),
    pos: Number(n.positionSec) || 0,
    dur: Number(n.durationSec) || 0,
    volume: boxVol,
    at: Date.now(),
    trackId: String(n.trackId || ''),
    /* 这首是不是观众点的。false = 热榜/自动续播 → 画面不显示，只后台放。 */
    hot: !requestedIds.has(String(n.trackId || '')),
  }
  if (music.title && (music.title !== prevTitle || music.playing !== boxLastPlaying)) {
    log(`  ♫ ${music.title}${music.artist ? ' - ' + music.artist : ''}${music.playing ? '' : '（暂停）'}`)
    broadcast('music', music)
  }
  /* 顺手把封面抓下来（异步，不 await —— 别让网络拖慢 1.5 秒的轮询）。
   * coverKick 自己会去重：同一个 trackId 只抓一次，抓不到就记空串不再试。 */
  coverKick(music.trackId, music.title, music.artist)
  /* 点歌队列对账。**每次轮询都要跑**，不能只在换歌时跑 ——
   * 一首歌能放四五分钟，而「等太久就算被跳过」这条是跟时间赛跑的：
   * 只在换歌时跑的话，卡住的那几分钟里 hotNeed() 一直以为还有歌，
   * 热榜就一直不补。n 最多 20 项，1.5 秒一次的开销可以忽略。
   *
   * 2026-10-29：有真实队列时**没在放也要跑** —— 播放器停着但队里还排着歌，
   * 正是最需要把账摆正的时候（以前 `if (music.title)` 一挡就什么都不做）。 */
  if (music.title || box.queue.length) boxQueueSettle(music.title, music.trackId)
  boxLastPlaying = music.playing
  checkStuck()
}

/* ── 专辑封面（2026-10-28）─────────────────────────────────────────────
 * 画面右边那台「电脑」放歌时要显示封面。但播放器的 /state 里 nowPlaying
 * **没有封面字段**（只有 trackId / name / artists / album / position / duration），
 * 所以必须自己补，两条路：
 *
 *   ① 网易云：按 songId 问公开详情接口，拿 album.picUrl —— 精确，不靠猜。
 *   ② 其它源：拿「歌名 + 歌手」去插件的 /search 搜一遍，**按 id 精确匹配**再取 cover。
 *      不能直接拿第一条：搜「我爱你 王菲」第二条起就是翻唱，贴错封面比没封面还怪。
 *   ③ 都拿不到 → 返回空串，画面画一个唱片占位块（不塌版、观众也看不出是失败）。
 *
 * 为什么由桥来抓、不交给画面：画面每帧都要出图，在里面发网络请求必然掉帧；
 * 而且断网 / VIP 曲 / 换源这些情况全都要有兜底。桥抓一次落盘，画面只读本地文件。
 *
 * 缓存：cache/covers/<provider>_<songId>.jpg，同一个 trackId 只抓一次 ——
 * **抓失败的也记成空串**，不然每轮轮询都会重试一遍，白烧流量还拖慢主循环。
 */
const COVER_DIR = path.join(DIR, 'cache', 'covers')
const coverDone = new Map() // trackId -> 本地绝对路径（'' = 抓不到，别再试）
const coverBusy = new Set() // 正在抓的，防重复发请求

function coverPathOf(trackId) {
  return coverDone.get(String(trackId || '')) || ''
}

function coverKick(trackId, name, artist) {
  const id = String(trackId || '')
  if (!id || coverDone.has(id) || coverBusy.has(id)) return
  coverBusy.add(id)
  grabCover(id, name, artist)
    .then((f) => coverDone.set(id, f || ''))
    .catch(() => coverDone.set(id, ''))
    .finally(() => coverBusy.delete(id))
}

async function grabCover(trackId, name, artist) {
  const cut = trackId.indexOf(':')
  const provider = cut > 0 ? trackId.slice(0, cut) : 'netease'
  const songId = cut > 0 ? trackId.slice(cut + 1) : trackId
  if (!/^[\w-]{1,40}$/.test(songId)) return ''
  const file = path.join(COVER_DIR, `${provider}_${songId}.jpg`)
  try {
    if (fs.statSync(file).size > 2048) return file // 上次抓过，直接用
  } catch {
    /* 还没有，往下抓 */
  }
  let url = ''
  if (provider === 'netease') url = await neteaseCover(songId)
  if (!url) url = await boxSearchCover(trackId, name, artist)
  if (!url) return ''
  return (await saveCover(url, file)) ? file : ''
}

/** 网易云公开详情接口。不用登录态 —— 它给的是元数据，不是音源。 */
async function neteaseCover(songId) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 8000)
  try {
    const u = `https://music.163.com/api/song/detail?ids=%5B${encodeURIComponent(songId)}%5D`
    const r = await fetch(u, {
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://music.163.com/' },
    })
    if (!r.ok) return ''
    const j = await r.json()
    const s = j && Array.isArray(j.songs) ? j.songs[0] : null
    const pic = s && s.album && s.album.picUrl
    return pic ? String(pic) : ''
  } catch {
    return ''
  } finally {
    clearTimeout(t)
  }
}

/** 兜底：走插件的搜索，按 id 精确匹配回同一首。 */
async function boxSearchCover(trackId, name, artist) {
  if (!name) return ''
  const kw = [name, artist].filter(Boolean).join(' ')
  const r = await boxJson('/search?keyword=' + encodeURIComponent(kw), { timeout: 8000 })
  const list = (r && r.tracks) || []
  const hit = list.find((x) => String(x.id || '') === trackId) || null
  return hit && hit.cover ? String(hit.cover) : ''
}

async function saveCover(url, file) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 10000)
  try {
    /* 网易云的图床支持 ?param=300y300 直接要一张小图 —— 原图动辄 1MB，
     * 画面只用到 200px，没必要拖那么大下来。别的图床不认这个参数，别乱加。 */
    let full = url
    if (full.includes('music.126.net')) {
      full += (full.includes('?') ? '&' : '?') + 'param=300y300'
    }
    const r = await fetch(full, {
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://music.163.com/' },
    })
    if (!r.ok) return false
    if (!/^image\//.test(String(r.headers.get('content-type') || ''))) return false
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 2048) return false
    fs.mkdirSync(COVER_DIR, { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, file)
    pruneCovers()
    return true
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/* 封面只增不减迟早把盘吃满（一首一个 66KB，播一晚上几十首）。
 * 超过 400 张就按最旧的删到 400 —— 十分钟最多跑一次，别每张都去 listdir。 */
let coverPrunedAt = 0
function pruneCovers() {
  if (Date.now() - coverPrunedAt < 600000) return
  coverPrunedAt = Date.now()
  try {
    const all = fs.readdirSync(COVER_DIR).filter((f) => f.endsWith('.jpg'))
    if (all.length <= 400) return
    const items = all
      .map((f) => {
        const p = path.join(COVER_DIR, f)
        try {
          return { p, t: fs.statSync(p).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t)
    for (const x of items.slice(0, items.length - 400)) {
      try {
        fs.unlinkSync(x.p)
      } catch {
        /* 删不掉就算了，下一轮再说 */
      }
    }
  } catch {
    /* 目录还没建，正常 */
  }
}

/* ── 卡带检测（2026-10-28）───────────────────────────────────────────
 * 播放器会报 `playing: true`，但 audio 卡在缓冲 / 打不开输出流 ——
 * currentTime 一动不动，观众那边是**完全没声音**，而面板一片绿。
 * 实测：系统输出切到蓝牙耳机后，位置卡在 0.02 十几分钟，没人发现，
 * 主人只能自己去猜"为什么没声"。
 *
 * 规矩：位置 20 秒没动 → 换下一首（单曲音源坏了能自愈）；
 *       连续两次还卡 → 停手并标红（那是设备/浏览器的问题，换歌没用）。 */
let posMark = { pos: -1, at: 0, tries: 0 }
function checkStuck() {
  if (!musicOn || !music.playing || music.pos <= 0) {
    posMark = { pos: -1, at: 0, tries: posMark.tries }
    return
  }
  if (Math.abs(music.pos - posMark.pos) > 0.3) {
    posMark = { pos: music.pos, at: Date.now(), tries: 0 }
    return
  }
  if (!posMark.at) { posMark.at = Date.now(); return }
  if (Date.now() - posMark.at < 20000) return
  if (posMark.tries >= 2) {
    musicWatch.ok = false
    musicWatch.why = '音乐卡住了（位置 20 秒没动，换歌也没用）—— 大概率是系统输出设备'
    if (Date.now() - (musicWatch.naggedAt || 0) > 60000) {
      musicWatch.naggedAt = Date.now()
      log('  ♫ 自检：音乐一直卡着，位置不动 —— 检查系统输出设备（是不是切到蓝牙耳机、或者静音了）')
    }
    return
  }
  posMark.tries += 1
  posMark.at = Date.now()
  log(`  ♫ 自检：位置 20 秒没动（${music.pos.toFixed(1)}s），换下一首试试`)
  boxJson('/bridge/command', { method: 'POST', body: { type: 'next' }, timeout: 6000 }).catch(() => {})
}

/** 每 1.5 秒一次：先问插件，插件不在再问 QQ 音乐。 */
async function pollMusicLoop() {
  /* 总开关关着就**连问都不要问**。只停止轮询还不够——box 那边照样会回歌名，
   * 画面又出现「正在播放」，于是面板写着关、屏幕上却在放，是最难查的那种假状态。 */
  if (!musicOn) return
  if (BOX_ON) {
    const s = await boxState()
    if (s.ok && s.alive) {
      boxDeadSince = 0
      if (musicSrc !== 'box') log('  ♫ 音乐切到单身汉播放器（DSH 内播放）')
      musicSrc = 'box'
      boxToMusic()
      /* 垫热榜：不 await，别拖慢 1.5 秒的轮询；里面自己节流 + 防重入。 */
      maybeHot()
      return
    }
    /* 🔴 心跳抖一下**不许**立刻切走（2026-10-28 实测的串台）。
     *
     * 播放器是 DSH 里的网页，标签切到后台会被浏览器节流到一分钟一次，
     * 而它的 clientAlive 窗口只有 8 秒 —— 所以每 40 秒左右就"掉线"一次。
     * 以前一掉就切 qq，画面歌名在《Marry》和
     * 「下载dsh抖音刷视频插件 — DeepSeek Harness」（浏览器里别的视频！）之间
     * 来回跳，主人看到的就是"怎么会有这种歌，串台了？"。
     *
     * 现在给 25 秒宽限：这段时间什么都不做，保持上一首的快照和 src，
     * 真回不来才认输。宽限期内不调用 boxToMusic，所以歌名不会闪。 */
    if (!boxDeadSince) boxDeadSince = Date.now()
    if (Date.now() - boxDeadSince < 25000) return
    if (musicSrc === 'box') {
      musicSrc = 'qq'
      log(`  ♫ 播放器连不上超过 25 秒（${s.why}），音乐回落到本机 QQ 音乐`)
    }
  }
  await pollMusic()
}

/**
 * 音乐总开关（2026-10-28，面板启动页那个「背景音乐」）。
 *
 * 关掉必须**主动**把播放器按停，不能只停轮询 —— 桥不管了，歌还在响，
 * 观众听到的是「一段没人闪避、没人切歌、点歌也没人接的背景音」，
 * 比直接静音更难查。三件事一起做：暂停当前音源 / 清空快照 / 清空点歌台。
 *
 * 三层状态，优先级从高到低：
 *   1. `--no-music`、`ZY_MUSIC=0`  → MUSIC_FORCED_OFF，面板打不开（起桥参数最大）
 *   2. `cache/media.json` 的 `musicOn` → 面板改的就是它，重启桥后记得
 *   3. 都没有 → 默认开
 */
function setMusicOn(v, from = '') {
  const want = !!v
  if (want && MUSIC_FORCED_OFF) {
    return { ok: false, on: false, error: '起桥时带了 --no-music / ZY_MUSIC=0，面板上打不开' }
  }
  if (want === musicOn) return { ok: true, changed: false, on: musicOn }
  musicOn = want
  mediaCfg.musicOn = want
  saveMediaCfg()
  if (!want) {
    musicPausedByMedia = false
    duckUntil = 0
    clearTimeout(duckTimer)
    duckTimer = null
    if (musicSrc === 'box') {
      boxJson('/bridge/command', { method: 'POST', body: { type: 'pause' }, timeout: 4000 }).catch(() => {})
    } else if (!mediaDead) {
      mediaCmd('pause').catch(() => {})
    }
    /* 快照要清干净：画面上那行「正在播放 · 歌名」必须立刻消失。
     * 留着上一首 = 屏幕上写着在放、音箱里没有，观众第一反应是「卡了」。 */
    music = {
      ok: false, why: '音乐关着', found: false, playing: false, status: 'none',
      title: '', artist: '', album: '', pos: 0, dur: 0, volume: null, at: Date.now(),
    }
    queue.list = []
    queue.why = '背景音乐关着，没读歌单'
    log(`  ♫ 背景音乐关掉了${from ? '（' + from + '）' : ''} —— 播放器已暂停，热榜不再补`)
    broadcast('music', music)
  } else {
    log(`  ♫ 背景音乐打开了${from ? '（' + from + '）' : ''}`)
    /* 立刻问一次，让面板/画面 0.2 秒内就有反馈，不用等下一轮 1.5 秒的定时器 */
    pollMusicLoop().catch(() => {})
  }
  return { ok: true, changed: true, on: musicOn }
}

/* ── 音乐自检（2026-10-28）──────────────────────────────────────────
 * 主人：「之前老是会断连，然后一直不放歌，看看能不能做一个自检，
 *        除非手动点击这个开关关闭，其他就拉起」。
 *
 * 断连的真实机制（这次实测出来的）：
 *   · 播放器的 `clientAlive` 是「8 秒内有没有 poll 过」—— SinglePlayer 里写死 `8e3`；
 *   · 那个播放器是 DSH 里的网页，**标签切到后台会被浏览器节流**，
 *     setInterval 压到一分钟一次 ⇒ 心跳必然超过 8 秒 ⇒ 桥上判"界面没开"；
 *   · 桥一判死就把音源切成 QQ 音乐，而 QQ 音乐根本没开 ⇒ 全场静音，
 *     而且页面还在后台，永远等不回来 —— 这就是"一直不放歌"。
 *
 * 自检只做三件事，全部在 musicOn=true 的前提下：
 *   ① 抖一下不算死（25 秒容忍），同时逼 `boxBase()` 重扫端口 ——
 *      DSH 重启会把端口从 4612 换到 14428，缓存里那个未必还活着；
 *   ② 有播放器但没歌、队列也空 → 补热榜；
 *   ③ 歌在，但停在暂停上 → 替主人按「继续」。
 * 两种情况不插手：总开关关着；暂停是我们自己干的（闲时视频要静音）
 * 或者主人刚手动按过暂停（给 3 分钟面子）。 */
const WATCH_EVERY = 15 * 1000
const WATCH_PAUSE_GRACE = 3 * 60 * 1000
/* 系统输出（2026-10-28）：默认设备名 + 总音量 + 是否静音。
 * 这一层以前完全不可见 —— 主人说「没声音」，桥这边一切正常，
 * 实际是蓝牙耳机被静音、系统音量 2%。现在 30 秒读一次，面板直接写出来，
 * 再也不用靠"猜是不是设备问题"。 */
let sysAudio = { ok: false, dev: '', vol: null, mute: null, at: 0, why: '' }
let sysAudioAt = 0
let musicWatch = {
  ok: true, why: '', checks: 0, fixes: 0, lastFix: '', lastFixAt: 0,
  deadSince: 0, pausedSince: 0, emptySince: 0, naggedAt: 0,
}
/* 面板/遥控手动下过的播放命令时间。自检拿它判断「这个暂停是主人按的」。 */
let lastUserCmdAt = 0

async function musicWatchdog() {
  if (!musicOn) {
    musicWatch = { ...musicWatch, ok: true, why: '', deadSince: 0, pausedSince: 0, emptySince: 0 }
    return
  }
  musicWatch.checks++
  const now = Date.now()

  /* 系统音量 30 秒读一次，放在最前面：就算播放器连不上、队列空着，
   * 「系统被静音」这件事也必须能看见 —— 这是最常见、也最容易被当成
   * "代码坏了"的那种没声音（实测：蓝牙耳机静音 + 音量 2%）。 */
  if (now - sysAudioAt > 30000) {
    sysAudioAt = now
    mediaCmd('sysvol', {}, 4000)
      .then((r) => {
        if (!r) return
        if (r.ok) {
          sysAudio = {
            ok: true, dev: String(r.dev || ''), vol: r.vol,
            mute: Boolean(r.mute), at: Date.now(), why: '',
          }
        } else {
          sysAudio = { ...sysAudio, ok: false, why: r.why || '读不到系统音量', at: Date.now() }
        }
      })
      .catch(() => {})
  }
  const sysVol = Number(sysAudio.vol)
  const sysBad = sysAudio.ok && (sysAudio.mute || (Number.isFinite(sysVol) && sysVol < 0.1))
  const sysWhy = sysBad
    ? `系统音量 ${Math.round((Number.isFinite(sysVol) ? sysVol : 0) * 100)}%`
      + `${sysAudio.mute ? '（静音）' : ''} · ${sysAudio.dev || '默认设备'}`
    : ''

  if (!box.ok || !box.alive) {
    if (!musicWatch.deadSince) musicWatch.deadSince = now
    const deadFor = now - musicWatch.deadSince
    if (deadFor < 25000) return // 25 秒内算浏览器节流的正常抖动，别乱动
    musicWatch.ok = false
    musicWatch.why = `播放器连不上 ${Math.round(deadFor / 1000)} 秒，正在重连${sysWhy ? `；${sysWhy}` : ''}`
    boxApiAt = 0 // 逼 boxBase() 下一轮重扫端口
    if (now - musicWatch.naggedAt > 60000) {
      musicWatch.naggedAt = now
      log('  ♫ 自检：播放器一直连不上，已重扫 DSH 端口（看一眼音乐页面是不是被关了，或者电脑睡了）')
    }
    return
  }
  musicWatch.deadSince = 0
  /* 连得上 ≠ 有声音。系统静音/音量过低时这里必须报红，否则面板一片绿、
   * 主人只能自己去猜"是不是又坏了"。 */
  musicWatch.ok = !sysBad
  musicWatch.why = sysWhy

  const n = box.now
  if (!n || !n.trackId) {
    musicWatch.pausedSince = 0
    if (!musicWatch.emptySince) musicWatch.emptySince = now
    const emptyFor = now - musicWatch.emptySince
    /* 🔴 播放器连上了、但一首歌都没有 —— 这正是「面板写着自检正常、音箱没声」
     * 的来源（主人重启 DSH 后截图的那个状态）：队列被页面重载清空，
     * 旧代码只看"连不连得上"，于是绿灯亮着、音乐静着。
     * 超过 20 秒就标成异常，面板才会显示「播放器空着，正在补歌」。 */
    if (emptyFor > 20000) {
      musicWatch.ok = false
      musicWatch.why = `播放器空着 ${Math.round(emptyFor / 1000)} 秒，正在补歌`
        + `${hotWhy ? `（${hotWhy}）` : ''}${sysWhy ? `；${sysWhy}` : ''}`
    }
    /* 25 秒就补，不再等 45 秒 —— 重启 DSH 后主人等的是"多久有声音"，不是省几次请求。 */
    if (emptyFor > 25000) {
      musicWatch.emptySince = now
      maybeHot() // 里面自己节流 + 防重入
    }
    return
  }
  musicWatch.emptySince = 0

  if (n.playing) {
    musicWatch.pausedSince = 0
    return
  }
  if (musicPausedByMedia) return // 闲时视频主动暂停的，别抢
  if (now - lastUserCmdAt < WATCH_PAUSE_GRACE) return // 主人刚按的暂停，先听他的
  if (!musicWatch.pausedSince) musicWatch.pausedSince = now
  if (now - musicWatch.pausedSince < 15000) return
  musicWatch.pausedSince = 0
  boxJson('/bridge/command', { method: 'POST', body: { type: 'resume' }, timeout: 4000 }).catch(() => {})
  musicWatch.fixes++
  musicWatch.lastFix = 'resume'
  musicWatch.lastFixAt = now
  log(`  ♫ 自检：停在暂停上 15 秒，已自动继续${n.name ? `《${n.name}》` : ''}`)
}

/** 下发音量（0-1）。闪避走这条 —— 插件的音量是网页播放器自己的，跟系统音量无关。 */
function boxSetVolume(v) {
  const val = Math.min(1, Math.max(0, Number(v)))
  if (!Number.isFinite(val)) return
  boxVol = val
  boxJson('/bridge/command', { method: 'POST', body: { type: 'volume', value: val }, timeout: 4000 }).catch(() => {})
}

/** 给「正在放的那个」下命令。
 *
 *  🔴 2026-10-27 晚修的大坑：`/media?cmd=` 原来**一律**走 mediaCmd() ——
 *  那是 QQ 音乐那条 python 链路（SMTC + WASAPI）。可是点歌早就换到单身汉
 *  网页播放器了（musicSrc === 'box'），于是面板「声音」页的上一首/播放暂停/下一首、
 *  还有 music.html 的整排按钮，全部打给了**没在用的 QQ 音乐**：
 *  命令递过去没人接 → 网页播放器一动不动 → 主人看到的就是「点了没反应 / 没声音」。
 *
 *  命令名两边不一样，这里做一次翻译：
 *    box: play(空 track = 切歌) / pause / resume / next / prev / volume
 *    桥:  playpause / play / pause / next / prev / stop / vol
 *  box 没有 stop，用 pause 代替（它的语义就是「别放了」）。
 */
async function boxCmd(cmd, extra = {}) {
  if (cmd === 'vol') {
    boxSetVolume(extra.v)
    return { ok: true, src: 'box', why: '' }
  }
  if (!box.alive) return { ok: false, src: 'box', why: box.why || '播放器界面没开（打开控制台 http://127.0.0.1:18082/ 那一页）' }
  /* 音乐关着时，面板上的播放/暂停/切歌一律不执行 —— 否则点一下就把
   * 刚关掉的音乐又放起来了，而开关还显示"关着"。（vol 在上面已经放过。） */
  if (!musicOn) return { ok: false, src: 'box', why: '背景音乐关着（启动页可以打开）' }
  const map = {
    playpause: 'play', play: 'resume', pause: 'pause',
    next: 'next', prev: 'prev', stop: 'pause',
  }
  const type = map[cmd]
  if (!type) return { ok: false, src: 'box', why: `单身汉播放器没有 ${cmd} 这个命令` }
  const r = await boxJson('/bridge/command', { method: 'POST', body: { type }, timeout: 6000 })
  if (!r.ok) return { ok: false, src: 'box', why: r.why || '命令没递进去' }
  /* 下完命令回读一次 —— 递进去了 ≠ 真放上了（这插件的老毛病，见上面那两个坑） */
  const s = await boxState()
  if (s.alive) boxToMusic()
  return { ok: true, src: 'box', type, playing: Boolean(music.playing), why: '' }
}

/** 把「音乐基准音量」落到当前播放器上。
 *  面板拖完就立刻生效 —— 否则观众那边还是旧音量，得等下一首才「碰巧」对上。
 *  两条链路分开：插件放歌（网页播放器，走 /bridge/command）和系统播放器
 *  （QQ 音乐，走 python 的 vol 命令）。 */
function applyMusicVolume() {
  const v = Math.min(1, Math.max(0, Number(mediaCfg.audio.music) / 100))
  if (musicSrc === 'box') {
    boxSetVolume(v)
    return
  }
  if (!musicOn || mediaDead) return
  mediaCmd('vol', { v }).catch(() => {})
}

/** 点歌时给候选打分，返回 {best, rest}（rest 是备选，取流失败时依次再试）。
 *
 *  为什么不能只看歌名像不像：搜「稻香」回来 8 个版本 ——
 *  深情版 / 童声 / 女声 / 钢琴版 / 三个叫「稻香」的翻唱 / 周杰伦原唱。
 *  只比歌名的话，第一个精确匹配是某个翻唱，观众点周杰伦结果听到别人唱。
 *
 *  🔴 2026-10-27 晚重写：原来「vip 一律扣 25 分」是错的。
 *  实测搜「孤勇者 陈奕迅」（QQ 移动端搜索，12 条）：
 *    孤勇者/陈奕迅  pay_play=1（正版付费）  100 -25 +4 +2 =  81
 *    孤勇者/陈奕迅  pay_play=0（免费版）    100      +4 +2 = 106  ← 被选中
 *    孤勇者/熊昱琦（翻唱）                  100      +4 +2 = 106
 *  正版被自己的扣分挤到翻唱后面，观众听到的自然「不是原唱」。
 *  更根本的是：**歌手压根没参与打分**，`artists` 只被用来判「是不是单人署名」。
 *
 *  现在的规则 —— 歌名负责「是不是这首歌」，歌手负责「是不是这个人唱的」：
 *    · 歌手命中且单人署名 = 原唱（+60），多歌手 = 晚会/综艺合唱版（+20），
 *      完全不沾 = 翻唱（-25，不排除，搜不到原唱时还得靠它）
 *    · vip 不再扣分，改成 +8：正版排前面，取不到流由 boxRequestSong 自动退备选
 *    · 酷狗仍然 -30（只能搜不能放，取流必失败）
 *
 *  实测（2026-10-27）能不能放出流：
 *    qq 非 VIP  → 有流（128k MP3）
 *    qq VIP     → QQ_URL_EMPTY（未登录取不到）
 *    netease    → 有流（exhigh）
 *    kugou      → KUGOU_URL_UNAVAILABLE（只能当搜索源）
 *  「能不能真放出来」由后面的逐个试流兜着，不靠提前扣分来赌。
 */
/* 各家的登录状态（VIP 曲能不能放整首就看它）。
 * 🔴 2026-10-27 深夜实测：网易云**没登录**、QQ **已登录**，
 *    可 pickTrack 里 `vip === true` 是无条件 +8 分，
 *    于是「网易云 + 正版 VIP」永远排第一 → 观众点《唯一》放 30 秒就断，
 *    而同一个 QQ 源上明明有整首。观众的原话是「今天一直在抽」。
 *    规则改成：**登录了才叫正版加分，没登录的 VIP 曲是坑，要扣分。** */
let authState = { at: 0, ok: {} }
async function boxAuth() {
  if (Date.now() - authState.at < 5 * 60 * 1000) return authState.ok
  const r = await boxJson('/auth/status', { timeout: 4000 })
  const ok = {}
  if (r.ok) for (const p of r.providers || []) ok[String(p.provider)] = Boolean(p.loggedIn)
  /* 拿不到就当全都登录着 —— 别因为一次 401 把候选排序带歪 */
  authState = { at: Date.now(), ok }
  return ok
}

function pickTrack(tracks, want, artist = '', auth = {}) {
  const w = normTitle(want)
  if (!w) return null
  const a = normTitle(artist)
  const scored = []
  for (const t of tracks || []) {
    const n = normTitle(t && t.name)
    if (!n) continue
    let s = 0
    if (n === w) s = 100
    else if (n.includes(w)) s = 82 - Math.min(22, n.length - w.length)
    else if (w.includes(n)) s = 72 - Math.min(22, w.length - n.length)
    else {
      const chars = [...new Set(w)]
      let hit = 0
      for (const ch of chars) if (n.includes(ch)) hit++
      const cov = hit / Math.max(1, chars.length)
      if (cov >= 0.6) s = Math.round(cov * 62)
    }
    if (s <= 0) continue

    const names = (Array.isArray(t.artists) ? t.artists : [])
      .map((x) => normTitle(x))
      .filter(Boolean)
    if (a) {
      /* 「陈奕迅」对「陈奕迅」精确算命中；「陈奕迅」对「陈奕迅/赵允哲」也算沾边，
       * 但那是合唱版，只给三分之一的分 —— 歌名对、人也对，就是不是原版。 */
      const hit = names.some((x) => x === a || x.includes(a) || a.includes(x))
      if (hit) s += names.length === 1 ? 60 : 20
      else s -= 25
    } else if (names.length === 1) {
      s += 2 // 没给歌手时，「单人署名」仍旧是最弱的原唱信号
    }

    /* VIP 曲费不费，看这家**登录没登录**，别再一刀切当风险扣了。
     * 2026-10-28 实测推翻原来的「VIP 一律扣分」：网易云 SVIP / QQ 登录后，
     * 《刻在我心底的名字》《我不难过》等 VIP 曲全都能取到完整 mp3
     * （/url 回 trial:false, vipRequired:false）。原唱绝大多数是 VIP，
     * 给 VIP 扣分、给非 VIP 翻唱加分，等于亲手把原唱往下压、翻唱往上抬
     * —— 观众点《体面》听到「老王同学吖」就是这么来的。
     * 现在只对**没登录**那家的 VIP 扣分（那才是真取不到，只能放 30 秒）。 */
    if (t.vip === true) {
      const known = Object.prototype.hasOwnProperty.call(auth, t.provider)
      if (!known || !auth[t.provider]) s -= 20      // 没登录那家的 VIP，可能只有试听
      else s += 10                                  // 已登录能放完整 → 保留原唱优势
    }
    if (t.provider === 'kugou') s -= 30 // 酷狗只能搜不能放
    if (t.provider === 'qq') s -= 20 // 2026-10-28：QQ「已登录」但 VIP 音源一律取不到（缺权限），只能放非 VIP 翻唱 —— 让位给真正能放 VIP 的网易云
    else if (t.provider === 'netease') s += 12 // 网易云 SVIP 实测能放 VIP 完整音源（《演员》《我不难过》等），真正的正版来源优先
    if (Number(t.durationMs) && Number(t.durationMs) < 90000) s -= 10 // 一分半的大概率是片段
    scored.push({ t, s })
  }
  scored.sort((a, b) => b.s - a.s)
  if (!scored.length || scored[0].s < 42) return null
  return { best: scored[0].t, rest: scored.slice(1).map((x) => x.t) }
}

/**
 * 点歌主流程：搜 → 挑 → 播/排队 → 回读确认。
 * 返回 {ok:true, title, how} 或 {ok:false, why} 或 {ok:false, fallback:true}（插件压根没有 → 走 QQ 老路）
 */
async function boxRequestSong(want, artist = '') {
  if (!BOX_ON) return { ok: false, fallback: true, why: '没开播放器插件' }
  /* 🔴 音乐总开关关着时**不许偷偷放歌**（2026-10-28）。
   * 不挡这一下的话：主人关了背景音乐，观众点一首，插件照样 play ——
   * 音箱里突然出声，而面板上开关还是关的。这里不设 fallback，
   * 免得掉进 QQ 那条老路又放一遍；reply 那边会照实说「音乐关着呢」。 */
  if (!musicOn) return { ok: false, why: '背景音乐关着，点歌没法放' }
  const s = await boxState()
  if (!s.ok) return { ok: false, fallback: true, why: s.why }
  if (!s.alive) return { ok: false, why: s.why || '播放器界面没开' }

  /* 2026-10-28 点歌优先闸：从进来这一刻起（搜索+预检最慢，热榜最容易趁虚而入）
   * 就让热榜让路，等这首真正进队/播完再放开。finally 兜底，任何退路都会减回去。 */
  songRequesting++
  try {

  /* 搜索词带上歌手能显著提高命中率（同名歌太多），
   * 但**打分时必须把歌名和歌手拆开** —— 拿「孤勇者 陈奕迅」整串去比歌名，
   * 没有一首歌叫这个，于是所有结果都掉进「包含」分支，歌手彻底不参与判断。 */
  const q = artist ? `${want} ${artist}` : want
  const r = await boxJson(`/search?keyword=${encodeURIComponent(q)}&limit=8`, { timeout: 9000 })
  if (!r.ok) return { ok: false, why: r.why || '搜索失败' }
  const tracks = Array.isArray(r.tracks) ? r.tracks : []
  if (!tracks.length) return { ok: false, why: '搜不到这首歌' }
  /* 把「哪家登录了」交给打分：没登录那家的 VIP 曲只能放 30 秒，得让它往后站 */
  const auth = await boxAuth()
  const picked = pickTrack(tracks, want, artist, auth)
  if (!picked) return { ok: false, why: `搜到 ${tracks.length} 首，但都不叫这个` }

  /* 取流预检：挑出来的这首**真能放**才往下走。
   * 不做这一步的话，VIP 曲目会一路「下发成功」，观众那边一片安静，
   * 我们只能说一句含糊的「下发了但没响起来」。预检还能顺手换到备选版本
   * （同一首歌常有 VIP 原唱 + 非 VIP 翻唱，取不到就退一个）。 */
  let hit = null
  let lastWhy = ''
  let trialHit = null // 只有试听片段的候选：整张候选表都找不到正片时才退回来用它
  /* 候选从 3 个放宽到 5 个，2026-10-28 再放宽到 8 个。
   * 一次搜索最多 24 条（三家各 8 条），前面几名常常是同一首歌在 VIP / 不同音质 /
   * 不同平台上的多个条目，占满名额却一个都放不出来 —— 00:04 那次《一半一半》
   * 就是前 5 个全是 QQ 的 VIP 版、全回 QQ_URL_EMPTY，而第 9 条开始就有能放的原版。
   * 每个候选多花一次 /url（约 0.3~1 秒），点歌本来就要等，换来得是「真能放」。 */
  for (const cand of [picked.best, ...picked.rest].slice(0, 8)) {
    const u = await boxJson(`/url?id=${encodeURIComponent(cand.id)}`, { timeout: 12000 })
    const res = u.result
    if (u.ok && res && res.url) {
      /* 🔴 试听片段不是正片。网易云对 VIP 曲会返回 freeTrialInfo + 一条 30 秒的流，
       * 只看「url 有没有值」的话，这首会被当成成功播出去 ——
       * 观众听到 30 秒就断，还以为是「放了盗版」。
       * 先记下来，整个候选表都拿不到正片时才退回来放片段。 */
      if (res.trial) {
        if (!trialHit) trialHit = cand
        lastWhy = '只有试听片段'
        continue
      }
      hit = cand
      break
    }
    lastWhy = (res && res.reason) || u.why || '取不到音源'
  }
  if (!hit && trialHit) {
    hit = trialHit
    log(`  ♫ ⚠ 只有试听片段：${trialHit.name}（VIP 曲，没登录或没会员）`)
  }
  if (!hit) return { ok: false, why: `取不到音源（${lastWhy}）` }

  /* 实际演唱者：给回复用。观众点陈奕迅、放出来是别人，模型得知道这件事，
   * 不然它会照着「大肥鱼放的是原唱」往下瞎编。 */
  const by = (Array.isArray(hit.artists) ? hit.artists.join('/') : String(hit.artists || '')).trim()
  const trialOnly = hit === trialHit

  /* 「在放」还是「停住了」？（2026-10-27 深夜补）
   * 插件默认 order 模式，队列放到底会停在最后一首的末尾但 trackId 还在。
   * 只看 trackId 的话这里会判成 `cur` 有值 → 只发 queue_add →
   * 歌进了队尾而 index 已经到底，永远轮不到 —— 观众点了个寂寞。
   * 认「停在末尾」这个特征就够了；手动暂停停在中间的不算。 */
  const cur0 = s.now && s.now.trackId ? s.now : null
  const curStuck = Boolean(
    cur0 && cur0.playing === false && Number(cur0.durationSec) > 0
    && Number(cur0.positionSec) >= Number(cur0.durationSec) - 3
    && !musicPausedByMedia
  )
  const cur = curStuck ? null : cur0
  /* 正在放闲时视频 → 先收掉它，不然视频的声音和音乐打架。
   * 注意这里**不** resume 音乐：紧接着的 play / queue_add 会接管播放，
   * 先 resume 一下只会让旧歌响半秒再被切走。 */
  if (MEDIA.cur && MEDIA.cur.tier === 0) {
    clearEndTimer()
    MEDIA.cur = null
    musicPausedByMedia = false
    mediaLog('■ 有人点歌，闲时视频让位', 'end')
    log('  🖥 有人点歌，闲时视频提前收掉')
  }
  /* 什么都没在放 → 直接播这首；有歌但暂停着 → 先继续放再把新的排后面；
   * 正在放 → 只排队尾，绝不打断观众正在听的。 */
  /* 点歌插队（2026-10-28，主人原话「点了歌不是应该排下一首吗」）。
   *
   * **每一首点歌都插到当前曲后面，offset = 已在等的点歌数**：
   *   队里没有待播点歌 → offset 0，紧接当前曲
   *   已经有人点了 1 首 → offset 1，排在它后面（FIFO，不抢别人的位）
   * 这样播放器里的真实顺序 = 点歌台下单顺序，画面显示和实际播放终于一致；
   * 热榜照旧 append 到队尾，永远排在所有点歌后面。
   *
   * 以前只有 queue_add（队尾追加），点歌会排在热榜后面 ——
   * 观众点了《演员》，下一首却是热榜的《雨爱》，点歌台显示和实际播放对不上。 */
  const waitingSongs = boxQueue.filter((x) => !x.hot)
  const cmds = []
  if (!cur) cmds.push({ type: 'play', track: hit })
  else {
    if (!cur.playing) cmds.push({ type: 'resume' })
    cmds.push({ type: 'queue_next', tracks: [hit], offset: waitingSongs.length })
  }
  for (const c of cmds) {
    let cmdR = await boxJson('/bridge/command', { method: 'POST', body: c, timeout: 6000 })
    /* 播放器还是旧版（没打 queue_next 补丁 / 没重启 DSH）→ 退成追加，
     * 别让整次点歌失败。日志说清楚，免得以后又当成"点歌不优先"来查。 */
    if (!cmdR.ok && c.type === 'queue_next') {
      cmdR = await boxJson('/bridge/command', {
        method: 'POST', body: { type: 'queue_add', tracks: [hit] }, timeout: 6000,
      })
      if (cmdR.ok) log('  ♫ 播放器还不支持插播（要重启 DSH 加载新代码），这首排到队尾了')
    }
    if (!cmdR.ok || cmdR.queued === false) return { ok: false, why: cmdR.why || '命令没递进去' }
  }

  await sleep(cur ? 2200 : 3200) // 浏览器 2 秒轮询一次，给足一拍
  const s2 = await boxState()
  if (!s2.alive) return { ok: false, why: '命令下发了，但播放器界面这时候关了' }

  if (!cur) {
    const nowId = String((s2.now && s2.now.trackId) || '')
    if (nowId && nowId === String(hit.id)) return { ok: true, title: hit.name, by, trial: trialOnly, how: 'play' }
    return { ok: false, why: '下发了但没响起来（可能是这首取不到流）' }
  }
  /* 排队尾这种没法用「在放什么」验证，就用「命令被取走了没」验证：
   * pending 归零 = 浏览器拿走了。拿走了就认，毕竟它自己会报错到界面上。
   *
   * 🔴 原来这里 `if (s2.pending > 0) return` 提前返回、**不写 boxQueue** ——
   * 排队成功（最常见的情况）时点歌台看不到刚点的那首，等于白点。
   * 现在不管 pending 有没有归零，都把歌记进队列，点歌台才有东西显示。 */
  boxQueuePush(hit.name, false, hit.id)
  /* 记下"这首是观众点的"—— 画面只显示点过的歌（热榜一律不显示）。
   * 必须在这里记，不能靠歌名比对：热榜里可能有同名翻唱。 */
  markRequested(hit.id)
  queue.list = boxQueueNames().slice(0, QUEUE_MAX)
  if (s2.pending > 0) log(`  ♫ 《${hit.name}》还堆在命令队列里（${s2.pending} 条），浏览器还没取走`)
  return { ok: true, title: hit.name, by, trial: trialOnly, how: 'queue' }
  } finally {
    songRequesting--
  }
}

/* ── 热榜垫歌：没人点歌的时候不能死寂（2026-10-27 主人要求）──────────
 *
 * 规矩：
 *   · **点歌永远优先** —— 队列里够 HOT_KEEP 首就不补，别把观众的曲子往后挤
 *   · 只在插件模式补（QQ 模式有自己的歌单，桥去插队会把它搅乱）
 *   · 放过的记在 cache/hot-played.json，按天重置，同一批歌一天之内不重放
 *   · 播放器空着 → `play` 第一首；已经在放 → 只 `queue_add`，绝不打断
 *
 * 榜单走插件 /chart（网易云热歌榜 3778678）。**不预检取流** ——
 * 热榜都是热门曲，偶尔有一首取不到，插件自己的 recovery 会跳下一首，
 * 而预检每首要多花一次 /url 请求，不值。
 */
const HOT_ON = String(process.env.ZY_HOT ?? '1') !== '0'
const HOT_CHART = String(process.env.ZY_HOT_CHART || '3778678')
const HOT_KEEP = Number(process.env.ZY_HOT_KEEP || 2) // 队列里少于几首就补
const HOT_GAP = Number(process.env.ZY_HOT_GAP || 8000) // 两次补歌之间至少隔多久
const HOT_LOG = path.join(DIR, 'cache', 'hot-played.json')

let hotPool = [] // 榜单候选（还没排进队列的）
const hotPlayed = new Set() // 今天已经放过 / 排过的
let hotFilling = false
let hotAt = 0
let hotWhy = ''
let hotLoaded = false // 惰性读盘：第一次真要补歌时才去读，省得启动流程到处插

function todayTag() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 读「今天放过哪些」。跨天自动清空 —— 不然热榜 50 首放完就再也没歌了。 */
function loadHotPlayed() {
  try {
    const raw = JSON.parse(fs.readFileSync(HOT_LOG, 'utf8'))
    if (raw && raw.date === todayTag() && Array.isArray(raw.ids)) {
      for (const x of raw.ids) hotPlayed.add(String(x))
    }
  } catch {
    /* 第一次没有这个文件，正常 */
  }
}

function saveHotPlayed() {
  try {
    fs.mkdirSync(path.dirname(HOT_LOG), { recursive: true })
    fs.writeFileSync(HOT_LOG, JSON.stringify({ date: todayTag(), ids: [...hotPlayed].slice(-600) }))
  } catch {
    /* 存不下就算了，顶多下次重放 */
  }
}

/** 插件要的 Track 形状。chart 返回的本来就够，这里只做兜底，别把脏数据塞进队列。 */
function trackOf(t) {
  const o = t || {}
  const id = String(o.id || '')
  const cut = id.indexOf(':')
  const provider = cut > 0 ? id.slice(0, cut) : String(o.provider || 'netease')
  const songId = cut > 0 ? id.slice(cut + 1) : String(o.songId || '')
  const name = String(o.name || '')
  if (!provider || !songId || !name) return null
  return {
    id,
    provider,
    songId,
    name,
    artists: Array.isArray(o.artists) ? o.artists.map(String) : [],
    album: String(o.album || ''),
    durationMs: Number(o.durationMs) || 0,
    cover: String(o.cover || ''),
    vip: o.vip === true,
    mediaMid: o.mediaMid == null ? '' : String(o.mediaMid),
  }
}

/** 这首能不能真放出来。`trial`（30 秒试听片段）不算能放。
 *
 *  热榜是个例外，必须预检：网易云榜单里大半是 VIP 曲，未登录时
 *  `/url` 要么不给、要么给一段 30 秒的试听流。不预检的话，垫上去的两首
 *  可能都是三十秒就断 —— 观众听到的是「热榜怎么全是片段」。
 */
/** 只有「完整音源」才算可播。
 *  2026-10-27 晚加返回值区分：'full' 完整 / 'trial' 只有试听 / '' 取不到。
 *  trial 不直接丢掉 —— 整榜都是试听时（音源没登录/没会员）如果全划掉，
 *  队列会一直是空的，观众听到的是**彻底静音**，比放 30 秒还糟。 */
async function hotPlayable(track) {
  const u = await boxJson(`/url?id=${encodeURIComponent(track.id)}`, { timeout: 10000 })
  const res = u.result
  if (!(u.ok && res && res.url)) return ''
  return res.trial ? 'trial' : 'full'
}

/** 榜单曲目换源：网易云热榜里大半是 VIP，网易云没登录就只回 30 秒试听。
 *  主人 2026-10-28 的话是「我 QQ 音乐已经登录了啊，有会员」——
 *  盯着网易云要会员是死路，拿着歌名+歌手去搜一遍，**挑一个能放整首的源**才对。
 *  返回换好的曲目（形状跟榜单条目一样），换不到返回 null。 */
async function hotSwapPlayable(track) {
  const first = (Array.isArray(track.artists) ? track.artists[0] : '') || ''
  const q = `${track.name} ${first}`.trim()
  const r = await boxJson(`/search?keyword=${encodeURIComponent(q)}&limit=8`, { timeout: 9000 })
  if (!r.ok) return null
  const list = Array.isArray(r.tracks) ? r.tracks : []
  if (!list.length) return null
  /* 打分时带上登录状态：没登录那家的 VIP 会被扣分，登录了的自然排前面 */
  const auth = await boxAuth()
  const picked = pickTrack(list, track.name, first, auth)
  if (!picked) return null
  for (const cand of [picked.best, ...picked.rest].slice(0, 5)) {
    if (!cand || !cand.id) continue
    if (String(cand.id) === String(track.id)) continue // 还是原曲，换了个寂寞
    const u = await boxJson(`/url?id=${encodeURIComponent(cand.id)}`, { timeout: 10000 })
    const res = u.result
    if (u.ok && res && res.url && !res.trial) {
      log(`  ♫ 换源：《${track.name}》只有试听 → 改放 ${cand.provider} 上的《${cand.name}》`)
      /* 搜索结果本身就是 trackOf 认的形状（id 带 provider 前缀，还有 songId / mediaMid） */
      return trackOf(cand)
    }
  }
  return null
}

/** 还缺几首。点歌的排在热榜前面，这里只算总量够不够。
 *  🔴 先对账再算：拿「几小时前点了但被跳过」的老账当额度，就是 2026-10-27 那场
 *  55 分钟不补歌的事故 —— boxQueue 停在 3 首，HOT_KEEP 是 2，这里永远返回 0。
 *
 *  2026-10-28 加「点歌严格优先」：热榜只会填**真·空缺**，永远排不到观众点歌前面。
 *  两种点歌都让热榜闭嘴：
 *    · 队里还有观众点的歌（非热榜项，`hot:false` 没放到）→ 不补；
 *    · 有一首点歌正在搜索/预检/排队（songRequesting > 0，慢那 0.3~1 秒，
 *      命令还没写进 boxQueue，也会被热榜抢在它前面入队）→ 不补。
 *  等点歌全放完、队列真空了，才正常垫热榜到 HOT_KEEP 首。 */
let songRequesting = 0
function hotNeed() {
  boxQueueSettle(music.title, music.trackId)
  if (songRequesting > 0) return 0
  if (boxQueue.some((x) => !x.hot)) return 0
  return Math.max(0, HOT_KEEP - boxQueue.length)
}

async function fillHot() {
  if (!musicOn || !HOT_ON || musicSrc !== 'box' || hotFilling || !box.alive) return
  if (hotNeed() <= 0) return
  if (!hotLoaded) {
    hotLoaded = true
    loadHotPlayed()
  }
  hotFilling = true
  try {
    if (hotPool.length < 2) {
      const r = await boxJson(`/chart?id=${HOT_CHART}&limit=50`, { timeout: 12000 })
      if (!r.ok) {
        hotWhy = r.why || '榜单拉不到'
        return
      }
      const list = Array.isArray(r.tracks) ? r.tracks : []
      hotPool = list.filter((t) => {
        const id = String((t && t.id) || '')
        return id && t.name && !hotPlayed.has(id)
      })
      /* 🔴 热榜池耗尽：网易云热歌榜固定 50 首，放完一轮就「可用 0 首」，
       * 背景垫歌从那一刻起永久停摆（2026-10-28 实测日志连刷「可用 0 首」）。
       * 这不是取流失败，是去重表把整榜都标了。放完一轮 → 清掉去重，重新能垫。 */
      if (!hotPool.length && list.length) {
        hotPlayed.clear()
        saveHotPlayed()
        hotPool = list.filter((t) => {
          const id = String((t && t.id) || '')
          return id && t.name
        })
        hotWhy = `热榜 50 首放完一轮，去重已重置（第 ${hotPlayed.size + 1} 轮）`
        log(`  ♫ 热榜 ${list.length} 首全部放完，重置去重，重新可垫 ${hotPool.length} 首`)
      } else {
        hotWhy = hotPool.length ? '' : '榜单里的今天都放过了'
      }
      if (list.length) log(`  ♫ 热榜 ${list.length} 首，可用 ${hotPool.length} 首`)
    }

    /* 播放器里到底有没有东西**在响**？
     * 🔴 光看 trackId 不够（2026-10-27 深夜）。插件默认是 mode=order（顺序播放），
     * 队列放到底时 jumpToNext 直接 `set({playing:false})` 就停了 ——
     * 而 queue_add 只往队尾加，index 已经到底不会自己往前挪，
     * 于是歌加进去了、界面也显示了，**就是不出声**，而且永远起不来。
     * 所以「有 trackId、没在放、而且正好停在那一刻的末尾」也当成空播放器：
     * 第一首用 play 直接起播。
     * 只认「停在末尾」这个特征，不认「只是暂停了」—— 操作员手动按暂停是想让人听清他说话，
     * 这时候拿 play 把歌跳走就是捣乱。同理闲时视频压出来的暂停也不碰（musicPausedByMedia）。 */
    const now0 = box.now
    const atEnd = Boolean(now0 && now0.durationSec > 0 && now0.positionSec >= now0.durationSec - 3)
    const stopped = !(now0 && now0.trackId)
      || (now0.playing === false && atEnd && !musicPausedByMedia)
    let started = !stopped
    let need = hotNeed()
    let tries = 0
    /* 试听片段的先攒在这儿：有完整音源就轮不到它们，
     * 整榜都只有试听时才拿出来兜底（见下面那段）。 */
    const trials = []
    while (need > 0 && hotPool.length && tries < 8) {
      tries++
      const track = trackOf(hotPool.shift())
      if (!track || hotPlayed.has(track.id)) continue
      /* 正在放的这首可能就在榜上，别把自己排到自己后面 */
      if (music.title && sameTitle(track.name, music.title)) {
        hotPlayed.add(track.id)
        continue
      }
      /* 放不出来的直接划掉，别下一条命令过去让它静默失败 */
      const kind = await hotPlayable(track)
      if (!kind) {
        hotPlayed.add(track.id)
        hotWhy = `《${track.name}》取不到音源`
        continue
      }
      /* 只有 30 秒试听 → 先在别的源上找整首（主人 QQ 有会员，别死磕网易云） */
      let use = track
      if (kind === 'trial') {
        const alt = await hotSwapPlayable(track)
        if (!alt) {
          trials.push(track)
          continue
        }
        use = alt
      }
      const cmd = started ? { type: 'queue_add', tracks: [use] } : { type: 'play', track: use }
      const r = await boxJson('/bridge/command', { method: 'POST', body: cmd, timeout: 6000 })
      if (!r.ok || r.queued === false) {
        hotWhy = r.why || '命令没递进去'
        log(`  ♫ 热榜垫歌没成：${hotWhy}`)
        break
      }
      hotPlayed.add(track.id)
      /* 队列里记**实际播的那个名字**：换过源之后播放器报的是新名字，
       * 记榜单原名的话 boxQueueSettle 永远对不上号，这笔账就又出不去了。 */
      boxQueuePush(use.name, true, use.id)
      started = true
      need--
      hotWhy = ''
      const by = use.artists && use.artists.length ? ' - ' + use.artists.join('/') : ''
      log(`  ♫ 热榜垫上《${use.name}》${by}`)
    }

    /* 兜底：整榜只剩试听片段（音源没登录 / 没会员）。
     * 放 30 秒总比一直静音强 —— 但只在这一轮没凑够时才用，完整音源永远优先。
     * 🔴 2026-10-27 晚：改之前这里是把 trial 全划掉的，于是「热榜里的今天都放过了」
     * → 队列永远补不上 → 观众听到的是「放着放着就没声了，再也不响」。 */
    if (need > 0 && trials.length) {
      for (const track of trials) {
        if (need <= 0) break
        const cmd = started ? { type: 'queue_add', tracks: [track] } : { type: 'play', track }
        const r = await boxJson('/bridge/command', { method: 'POST', body: cmd, timeout: 6000 })
        if (!r.ok || r.queued === false) {
          hotWhy = r.why || '命令没递进去'
          break
        }
        hotPlayed.add(track.id)
        boxQueuePush(track.name, true, track.id)
        started = true
        need--
        hotWhy = '只有试听片段（音源没登录/没会员）'
        const by = track.artists.length ? ' - ' + track.artists.join('/') : ''
        log(`  ♫ 只有试听片段，先垫上《${track.name}》${by} —— 想放全曲得登录音源`)
      }
    }
    if (boxQueue.length) queue.list = boxQueueNames().slice(0, QUEUE_MAX)
    saveHotPlayed()
  } finally {
    hotFilling = false
  }
}

/** 轮询里顺手叫一下，自己节流 —— 别每 1.5 秒去拉一次榜单。 */
function maybeHot() {
  if (!musicOn || !HOT_ON || musicSrc !== 'box') return
  if (hotNeed() <= 0) return
  if (Date.now() - hotAt < HOT_GAP) return
  hotAt = Date.now()
  fillHot().catch((e) => {
    hotWhy = String((e && e.message) || e)
  })
}

/* ── 播放列表快照 ──────────────────────────────────────────────────────
 * QQ 音乐**没有任何**可读的播放列表接口（qmlist64.db 加密 / 本地 HTTP 全 404 /
 * UIA 只有空 Pane / MSAA 找不到元素 / COM 只注册了文件关联）。
 * 唯一的路是「按 next 一首首翻，边翻边读歌名」，翻到绕回起点为止。
 *
 * 🔴 翻歌单的代价极大（2026-10-27 第二次修）：
 *   每首 0.55 秒，翻 12 首要 7 秒；而且翻完要「一首首 prev 退回来」，
 *   退回来只是**回到那首歌**，播放进度归零 —— 观众听到的就是「歌又从头开始了」。
 *
 *   原来只要「当前歌不在快照里」就翻一次，闸门 60 秒。结果：
 *   快照只存 12 首、歌单有几十上百首，播过 12 首就必然对不上 →
 *   每分钟翻一次 → 每分钟把歌切回去重播。用户原话
 *   「播放还没一分钟就频繁切歌，好频繁」，就是这个。
 *
 *   更狠的一条：第一份快照没抓到时 `refreshQueue(true)` 会**绕过**闸门，
 *   于是每 2.7 秒翻一次、每次切十几首 —— 歌单直接被刷成幻灯片。
 *
 * 现在的策略：
 *   · 换歌时**不翻歌单**，只把快照往前滚一格（noteSong）——
 *     正常顺序播放时滚动结果和真实歌单完全一致，零成本、零切歌
 *   · 快照快用完了（剩不到 4 首）才补一次
 *   · 任何情况下两次翻歌之间至少隔 QUEUE_FLOOR（20 秒），
 *     force 也绕不过去；连续失败 3 次就退到 QUEUE_GAP（5 分钟）
 *   · 她正在说话时不翻（翻歌要压音量，会把人声一起压掉）
 */
const QUEUE_MAX = Number(process.env.ZY_QUEUE_MAX || 20)
const QUEUE_GAP = Number(process.env.ZY_QUEUE_GAP || 300000) // 正常补列表的间隔
const QUEUE_FLOOR = Number(process.env.ZY_QUEUE_FLOOR || 20000) // 硬下限，force 也绕不过
const QUEUE_POS = Number(process.env.ZY_QUEUE_POS || 25) // 只在「这首刚开头」时翻
let queue = { at: 0, list: [], why: '', busy: false, looped: false, miss: 0, fails: 0, drift: 0 }

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/[\s\-_·.、,，!！?？'"“”‘’/\\]/g, '')
}
/** 和 media.py 的 same_song() 同一套规则，两边判定要一致 */
function sameTitle(a, b) {
  const x = normTitle(a)
  const y = normTitle(b)
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

/** 换歌时把快照往前滚一格。
 *
 *  [旧头, A, B, C] + 新歌 X  →  [X, A, B, C]
 *
 * 正常顺序播放时 X 就是 A，滚完正好对上真实歌单；
 * 观众手动跳走 / 点歌跳走时也只会偏一格，点歌台显示的「接下来」还大致对。
 * 关键是**一次 next 都不用发** —— 不再为了更新一张表去把歌切走。
 *
 * 歌单已经绕回过一圈（looped）就说明读全了，是个环：
 * 被换掉的那首要接到队尾，不然每换一首表就少一格，最后只剩一首、
 * 又去翻歌单 —— 短歌单（5 首那种）会变成「每十分钟重播一次」。
 */
function noteSong(prevTitle) {
  const cur = music.title
  if (!music.found || !cur || !queue.list.length) return
  const at = queue.list.findIndex((t) => sameTitle(t, cur))
  if (at >= 0) {
    queue.miss = 0
  } else {
    queue.miss++
    queue.drift++
    const rest = queue.list.filter((t) => !sameTitle(t, cur) && !sameTitle(t, prevTitle))
    const tail = queue.looped && prevTitle ? [prevTitle] : []
    queue.list = [cur, ...rest, ...tail].slice(0, QUEUE_MAX + 2)
  }
  /* 什么时候才值得去翻一次歌单：
   *   · 播到表尾了（后面只剩不到 3 首，点歌台要显示 3 首）—— 只在**没跑偏**的时候
   *   · 表快见底了（剩不到 4 首）
   *   · 滚过的歌比自己表长两倍还没对上（drift 兜底）
   * 绕回过一圈的歌单（looped）是个准确的环，永远不会「播到表尾」，不用再翻。
   *
   * 🔴 原来还有一条「连续 3 首对不上就翻」（miss>=3），已经删掉（2026-10-27 第二次）：
   *   主播手动切歌、观众点歌、点歌失败往回退，都会让「当前歌不在表里」，
   *   连着三首就触发一次翻歌单 —— 而翻歌单是真的按 next 过十几首再退回来，
   *   退回来还要从头播。实测 13:49 和 13:57 各翻了一次，用户听到的就是
   *   「还是一直会频繁切歌」。现在手动切歌只会让快照往前滚，不会去碰播放器。
   * 真去翻之前 refreshQueue 还会再等「这首歌刚开始」的时机（见那里）。 */
  const nearEnd = !queue.looped && queue.drift === 0 && at >= 0 && at >= queue.list.length - 3
  const stale = !queue.looped && queue.drift >= queue.list.length * 2
  if (nearEnd || queue.list.length <= 3 || stale) {
    setTimeout(() => refreshQueue(), 1500)
  }
}

/** 当前歌之后要放的 n 首（歌名数组）。没有快照就返回空。 */
/** 画面上的「接下来」——**只列观众点的歌**（2026-10-28 主人定的规矩）。
 *
 *  以前把热榜也列进去（nextUp 读 queue.list），但热榜是直接 append 到播放器队尾的，
 *  桥这本账和播放器真实队列迟早对不上 —— 于是「下一首」显示三首热榜，
 *  实际播出来的却是另一首。主人原话：「下一首播放的跟实际显示的还是不一样」。
 *
 *  现在只列点歌（boxQueue 里 hot=false 的），顺序就是点单顺序；
 *  播放器那边点歌也按**同一个顺序**插队（见 boxRequestSong 里的 offset），
 *  两边终于说的是同一件事。热榜彻底退出画面，只在后台放。 */
function nextUp(n = 3) {
  return boxQueue.filter((x) => !x.hot).slice(0, n).map((x) => x.name)
}

/** 点歌时猜「还要往后翻几首」：快照里有就按位置算，没有就翻 SONG_MAX 首。
 *  快照只存 12 首，歌排在 20 位的永远不会在快照里 —— 所以「没有」时不能只翻 12 首，
 *  否则大歌单里点歌永远是「这首我这儿没有」。18 首 ≈ 6 秒，退回来再 8 秒，40 秒超时够。 */
const SONG_MAX = Number(process.env.ZY_SONG_MAX || 18)
function skipHint(want) {
  const n = queue.list.length
  if (n < 2 || !want) return SONG_MAX
  const i = queue.list.findIndex((t) => sameTitle(t, music.title))
  const j = queue.list.findIndex((t) => sameTitle(t, want))
  if (i < 0 || j < 0) return SONG_MAX
  const d = (j - i + n) % n
  return Math.max(1, Math.min(n, d)) + 1
}

async function refreshQueue(force = false) {
  if (!musicOn || mediaDead || queue.busy) return
  /* 插件在放的时候「翻歌单」毫无意义：那个歌单是 QQ 音乐的，
   * 而且翻一次要按十几次 next，会把插件正在放的歌切走。 */
  if (musicSrc === 'box') return
  if (mediaLong > 0) return // 正在切歌，等它完了再说
  if (!music.found) return
  /* 有人在等回复的时候不翻歌单。
   * 翻歌单要独占 media.py 七秒（一条命令一行、严格串行），
   * 这七秒里进来的点歌只能排队 —— 实测「点歌」要等 27 秒才回话，
   * 观众早就走了。宁可晚点更新列表，也不能让人等着。
   * 唯一的例外是**第一次**：没有列表的话点歌台就是空的，
   * 而直播里永远都有下一条弹幕，一直等下去就永远抓不到。 */
  if (queue.at && (replying || chatLatest || songQueue.length || giftQueue.length)) return
  /* 闸门。force 只用来「第一次抓」，但也不能无限快 ——
   * 抓失败时 list 一直是空的，force 每次都成立，原来就是这里把歌单刷成幻灯片的。 */
  const gap = force && queue.fails < 3 ? QUEUE_FLOOR : QUEUE_GAP
  const since = Date.now() - queue.at
  if (since < gap) return
  /* 🔴 只在「这首刚开头」时翻（2026-10-27）。
   * 翻歌单最后要 `_rewind_to()` 退回来 —— 退回来只是回到这首歌，
   * **播放进度归零**。要是在一首歌播到 2 分钟的时候翻，观众听到的就是
   * 「歌突然从头开始」。刚开头的那几秒翻，退回来本来就该从头放，完全无感。
   * 翻不了就等下一首（noteSong 每次换歌都会再叫一次，闸门没被消耗）。 */
  if (!force && queue.list.length && music.pos > QUEUE_POS) return
  if (say && Date.now() < say.until) return // 说话期间别压音量翻歌
  queue = { ...queue, busy: true, at: Date.now() }
  try {
    // duck:true 让 media.py 自己压到 0.02 再抬回来 ——
    // 这里刻意不走 duckMusic()：那套是给 TTS 闪避用的（60%），
    // 翻歌的残响在 60% 下还是听得见，而且两边各压各的会把音量搞乱。
    const r = await mediaCmdSlow('queue', { max: QUEUE_MAX, duck: true }, QUEUE_MAX * 1500 + 12000)
    if (r?.ok && Array.isArray(r.items) && r.items.length) {
      // media.py 返回的 items 是「起点之后」的歌，**不含起点本身**。
      // 这里把起点补回第一位：nextUp() 靠它定位当前播到哪儿，
      // 顺便让 noteSong 那个「当前歌不在快照里」的判断不会永远成立（否则会无限翻歌）。
      const items = r.items.map((x) => String((x && x.title) || '').trim()).filter(Boolean)
      const head = String(r.title || music.title || '').trim()
      const list = head ? [head, ...items.filter((t) => !sameTitle(t, head))] : items
      queue = { at: Date.now(), list, why: '', busy: false, looped: !!r.looped, miss: 0, fails: 0, drift: 0 }
      log(`  ♫ 播放列表 ${list.length} 首${r.looped ? '（已绕回）' : ''}：${list.slice(1, 4).join(' / ')}`)
      if (r.restored === false) {
        log(`  ♫ ⚠ 翻完没退回到「${music.title}」，当前是「${head}」—— 这首歌会从头开始`)
      }
      broadcast('music', music)
    } else {
      queue = { ...queue, busy: false, at: Date.now(), why: (r && r.why) || '没读到', fails: queue.fails + 1 }
      log(`  ♫ 播放列表没读到（第 ${queue.fails} 次）：${queue.why}`)
    }
  } catch (e) {
    queue = { ...queue, busy: false, why: String((e && e.message) || e), fails: queue.fails + 1 }
  }
  await pollMusic()
}

/* TTS 闪避：她说话时把音乐压到 60%，说完抬回来。
 * 用「截止时间 + 一个定时器」而不是每次开一个新定时器 ——
 * 连续两条说话时，第一条的恢复定时器会插进第二条中间，音乐忽大忽小。 */
let duckUntil = 0
let duckTimer = null
function duckMusic(ms) {
  if (!music.found || !music.playing) return // 没在放音乐就别去动音量
  duckUntil = Math.max(duckUntil, Date.now() + ms)
  /* 压到多少由设置页决定（audio.duck，默认 60%），不再写死 0.6。 */
  const duckTo = Math.min(1, Math.max(0, Number(mediaCfg.audio.duck) / 100))
  if (musicSrc === 'box') {
    /* 插件放歌时，音量是**网页播放器自己的**，系统音量动它没用 ——
     * 只能通过 /bridge/command 的 volume 命令改。这里是绝对值，不是相对值。 */
    if (boxDuckSaved == null) boxDuckSaved = boxVol
    boxSetVolume(Math.min(boxVol, duckTo))
    log(`  ♫ 音乐压到 ${Math.round(Math.min(boxDuckSaved, duckTo) * 100)}%（说完恢复 ${Math.round(boxDuckSaved * 100)}%）`)
  } else {
    if (!musicOn || mediaDead) return
    mediaCmd('duck', { on: 1 }).then((r) => {
      if (r?.ok && r.ducked) log(`  ♫ 音乐压到 ${Math.round((r.vol ?? 0) * 100)}%（说完恢复 ${Math.round((r.saved ?? 1) * 100)}%）`)
    })
  }
  scheduleUnduck()
}
function scheduleUnduck() {
  clearTimeout(duckTimer)
  const wait = Math.max(200, duckUntil - Date.now())
  duckTimer = setTimeout(() => {
    if (Date.now() < duckUntil) return scheduleUnduck()
    duckTimer = null
    /* 🔴 恢复不能看 `musicSrc`（2026-10-28 修的）。
     * `musicSrc` 会因为心跳抖动在 box/qq 之间跳 —— 播放器是网页，标签到后台
     * 就被浏览器节流到一分钟一次，25 秒宽限一过就切 qq。恢复动作正好落在那一瞬，
     * 就会走进 mediaCmd('duck', off) 那个分支：QQ 根本没开 → 静默失败，
     * 音乐永远停在 60%，而日志里一条「恢复」都没有（实测就这样卡了一整天）。
     *
     * 判断依据改成「这次是谁压的」：boxDuckSaved 有值 = 是 box 压的，就还给 box。 */
    if (boxDuckSaved != null) {
      const back = boxDuckSaved
      boxDuckSaved = null
      boxSetVolume(back)
      log(`  ♫ 音乐恢复到 ${Math.round(back * 100)}%`)
      return
    }
    if (musicSrc === 'box') return // box 那边没有待恢复的音量，别乱发命令
    mediaCmd('duck', { on: 0 }).then((r) => {
      if (r?.ok && !r.ducked && r.vol != null) log(`  ♫ 音乐恢复到 ${Math.round(r.vol * 100)}%`)
    })
  }, wait + 80)
  duckTimer.unref?.()
}

/**
 * 合成 / 播放拆成两步（2026-10-27 改）。
 *
 * 原来是一个 speak()：先上字幕，再合成，再 spawn 播放 —— 观众看到的是
 * 「字幕出来了，声音一秒后才响」，明显对不上。
 * 现在先 await 合成（缓存命中只要 20ms），拿到时长再**同时**上字幕和出声。
 * 合成期间画面一直在放「思考」动画，不会显得卡住。
 */
let ttsBusy = false
let speakUntil = 0 // 排队的语音大概放到什么时候（只给「自言自语别抢话」用，不再用来挡合成）
/* ⚠️ 这个变量**声明得比用它的地方靠后**（mediaVolumeNow 在 mediaOut 旁边）。
 * 之所以没事：函数体是运行时才执行的，那时整个模块早就初始化完了。
 * 千万别在模块顶层直接调 mediaOut()，会踩 TDZ。 */

/** 只合成，不播。返回 {ok,file,dur,cached,ms}。 */
async function ttsSynth(text) {
  if (!TTS_ON || !text) return { ok: false }
  if (ttsBusy) return { ok: false }
  /* 兜底：把孤立代理字符去掉（见 reply.mjs 里 clip 的注释）。
   * 这里再挡一道，是因为字幕那条路也走同一个字符串 ——
   * 一个半个 emoji 就能让 tts 常驻进程崩掉，而崩一次就要等 30 秒重启。 */
  text = String(text)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1')
  if (!text.trim()) return { ok: false }
  ttsBusy = true
  try {
    TTS_SVC.start()
    const r = await TTS_SVC.cmd({ text, voice: TTS_VOICE, rate: TTS_RATE }, 25000)
    if (r && r.ok) return r
    // 常驻进程挂了就退回一次性调用 —— 不能因为一个 bug 让她哑掉
    const one = await pyOnce('tts.py', ['--text', text, '--voice', TTS_VOICE, `--rate=${TTS_RATE}`], 20000)
    if (one && one.ok) return one
    log(`  [tts] 合成失败，只出字幕：${r?.why || one?.error || '没返回'}`)
    return { ok: false }
  } catch (e) {
    log(`  [tts] 出错，只出字幕：${e?.message || e}`)
    return { ok: false }
  } finally {
    ttsBusy = false
  }
}

/** 放已经合成好的音频。不等它放完（player 自己会播完再收下一条）。 */
function playFile(syn) {
  const dur = Number(syn.dur) || 0
  if (dur <= 0) return 0
  /* 先让音乐让路，**再**让它出声。
   * 反过来的话实测会晚 1 秒才压下去 —— 声音已经出来了音乐还满音量，
   * 观众听到的是「人声和歌叠在一起」，再压就没意义了。 */
  duckMusic(dur * 1000 + 500)
  PLAY_SVC.start()
  /* 累加而不是覆盖：播放器串行，排在后面的那句要等前面的放完。
   * 覆盖的话 speakUntil 会比真实结束时间早，自言自语那条判断就会抢话。 */
  speakUntil = Math.max(Date.now(), speakUntil) + dur * 1000
  // 超时要盖住「上一条还在播」的等待：player 是串行的
  /* 说话音量走设置页的 audio.voice（0~100 → 播放器要 0~1000） */
  PLAY_SVC.cmd({ file: syn.file, volume: Math.round(mediaCfg.audio.voice * 10) }, Math.max(20000, (dur + 30) * 1000))
    .then((p) => {
      if (!p || !p.ok) log(`  [player] ${p?.why || p?.error || '没回包'}`)
    })
  log(`  🔊 ${syn.cached ? '缓存命中' : `合成 ${syn.ms}ms`} · ${dur.toFixed(1)}s`)
  return dur
}

function sse(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  } catch {}
}
function broadcast(type, payload) {
  for (const r of clients) sse(r, { type, payload })
}
function broadcastStats() {
  broadcast('stats', {
    online: stat.online,
    seen: stat.chat,
    picked: stat.gift,
    liked: stat.like,
    replied: stat.replied,
    total: stat.total,
  })
}

/* ------------------------------------------------------------ 自动回复 */
/**
 * 收到弹幕 → 生成一句回复 → 让画面「说话」（底部字幕 + 状态点转金）。
 *
 * 为什么不立刻回：真人会有一个思考的空档，0.9~1.5 秒后才冒出来才像活的。
 * 为什么排队而不是并行：同时回三条会互相打断，字幕最后只剩一条。
 *
 * 2026-10-27 改：**只回最新的一条**。
 *   原来是一个先进先出队列（最多 3 条），弹幕一密就开始回 10 秒前的话 ——
 *   观众看到的是「她在答非所问」，而且队列永远排不完，每条都要一次模型 + 一次 TTS。
 *   现在分成两条队列：
 *     · 礼物：先进先出，最多 2 条。礼物少、必须点名，丢了就是事故
 *     · 其他（聊天/欢迎/自言自语）：**只留最新一条**，新弹幕直接顶掉还没轮到的那条
 *   另外同一个人 60 秒内重复同一句话只回一次，刷屏刷不动。
 */
const giftQueue = [] // 礼物：FIFO，最多 2 条
/* 点歌：单独排队（2026-10-27 加）。
 * 原来点歌和闲聊共用 chatLatest，后面的闲聊会把它顶掉 ——
 * 观众明明点了歌、她一个字都没回、歌也没换，就是这个原因。
 * 点歌是要真去操作播放器的，不能像闲聊那样「算了不回了」。 */
const songQueue = [] // 上限见 SONG_QUEUE_MAX（6），满了会打日志

/* 点赞：也要有反馈（2026-10-27 加）。
 * 观众双击屏幕飘出来的就是爱心，主播看到的是「有人送爱心」——
 * 但那是 WebcastLikeMessage（点赞），不是 WebcastGiftMessage（礼物）。
 * 原来点赞是 show:false、直接不回，观众点半天她一点反应都没有。
 *
 * 但点赞能连点几十下（实测一个人 5 秒点 6 次），必须节流：
 *   · 累计涨了 LIKE_STEP 个赞才值得谢一次
 *   · 两次之间至少隔 LIKE_GAP
 *   · 只留一条，新的顶掉旧的（过期的感谢不如不谢） */
const LIKE_GAP = Number(process.env.ZY_LIKE_GAP || 45000)
const LIKE_STEP = Number(process.env.ZY_LIKE_STEP || 8)
const likeQueue = []
let likeThankedTotal = 0 // 上次谢的时候累计多少个赞了
let likeThanksAt = 0

let chatLatest = null // 聊天：只留最新一条
let replying = false // 回复线程在不在跑（单线程，同一时刻只回一条）
let lastChatAt = 0 // 上一条聊天回复的开始时间，两条之间至少隔 CHAT_GAP
/* 两条聊天之间的间隔。原来是 5 秒（「别像播报」），2026-10-27 主人定成 2.5 秒，
 * 并且要求在设置页里能改 —— 所以它是 let，运行时可热改（见 /reply/gap），
 * env 只当启动初值。太短会变成连珠炮，太长观众会觉得她不理人，所以夹在 0.5~15 秒。 */
let CHAT_GAP = Number(process.env.REPLY_CHAT_GAP || 2500)
const CHAT_GAP_MIN = 500
const CHAT_GAP_MAX = 15000
function setChatGap(ms) {
  const v = Math.round(Number(ms))
  if (!Number.isFinite(v)) return { ok: false, error: '间隔得是数字' }
  if (v < CHAT_GAP_MIN || v > CHAT_GAP_MAX) {
    return {
      ok: false,
      error: `间隔要在 ${CHAT_GAP_MIN / 1000}~${CHAT_GAP_MAX / 1000} 秒之间`,
    }
  }
  CHAT_GAP = v
  return { ok: true, ms: CHAT_GAP, sec: CHAT_GAP / 1000 }
}
const saidRecent = new Map() // "人|话" → 最后一次的时间，防复读

/* 点歌队列上限。
 * 🔴 2026-10-28 凌晨：原来是写死的 3，而且超了**一声不响** `shift()` 掉最老的。
 * 主人在画面里连点了 7 首（一半一半 / 特别的人 / 爱爱爱 / 唯一 / 用背脊唱情歌 /
 * 相信 / 开始懂了），点歌台只看到 4 首，直接问「是不是说话太快被过滤了」。
 * 一条点歌背后是 6~10 秒的搜索 + 逐个试流，replyWorker 又只串行跑一条，
 * 几秒内来三四条就必然溢出 —— 3 个槽位装不下一场直播的正常节奏。
 * 现在放到 6，并且**丢的时候一定要打日志**：静默丢是最难查的故障。 */
const SONG_QUEUE_MAX = 6

function queueReply(ctx) {
  if (!REPLY_ON) return
  if (livePaused) return // 已经下播了，别对着空房间自言自语烧 token

  if (ctx.kind !== 'gift') {
    const key = `${ctx.user || ''}|${String(ctx.text || '').slice(0, 40)}`
    const isSong = isSongRequest(ctx.text)
    const last = saidRecent.get(key) || 0
    if (Date.now() - last < 60000) {
      /* 同一句 60 秒内不重复回。点歌这种情况尤其容易让人误会 ——
       * 点了没反应，其实是被当成重复顶掉了。留一行日志，别让它无声无息。 */
      if (isSong) log(`  🎵 点歌去重：${ctx.user} 一分钟内已经点过「${ctx.text}」，这条不重复处理`)
      return
    }
    saidRecent.set(key, Date.now())
    if (saidRecent.size > 300) {
      const cut = Date.now() - 60000
      for (const [k, t] of saidRecent) if (t < cut) saidRecent.delete(k)
    }
    if (isSong) {
      // 点歌不顶别人，也不被别人顶
      while (songQueue.length >= SONG_QUEUE_MAX) {
        const gone = songQueue.shift()
        log(`  🎵 点歌排到 ${SONG_QUEUE_MAX} 条满了，丢掉最早那条：${gone.user || '?'}「${gone.text}」`)
      }
      songQueue.push(ctx)
      if (songQueue.length > 1) {
        log(`  🎵 点歌排队 ${songQueue.length} 条，还在等：${songQueue.map((x) => x.text).join(' / ')}`)
      }
    } else {
      // 顶掉还没轮到的那条：观众要的是「她现在在理我」，不是「她五秒前理了别人」
      chatLatest = ctx
    }
  } else {
    if (giftQueue.length >= 2) giftQueue.shift()
    giftQueue.push(ctx)
  }
  if (!replying) replyWorker()
}

/** 下一个该回什么。礼物 > 点歌 > 点赞 > 聊天。
 *  礼物优先是因为送钱的人不能等；点歌排在聊天前面是因为它要真去切歌，
 *  晚一步观众听到的就是「点了歌但放的是下一首别的」；
 *  点赞排在聊天前面，是因为它被节流过了，攒很久才轮到一次，不该被闲聊挤掉。 */
function nextCtx() {
  if (giftQueue.length) return giftQueue.shift()
  if (songQueue.length) return songQueue.shift()
  if (likeQueue.length) return likeQueue.shift()
  const c = chatLatest
  chatLatest = null
  return c
}

async function replyWorker() {
  replying = true
  while (true) {
    const ctx = nextCtx()
    if (!ctx) break
    // 两条聊天之间留个空档，不然连着说是「播报」不是「聊天」
    if (ctx.kind !== 'gift') {
      const wait = lastChatAt + CHAT_GAP - Date.now()
      if (wait > 0) await sleep(wait)
      lastChatAt = Date.now()
    }
    setMood('thinking') // 想事情那段（有冒泡），正好盖住"思考空档"

    /* 放视频：观众喊了就放（2026-10-27 主人要求）。
     * 位置在点歌之前 —— 「放个视频」不含点歌关键词，互不影响；
     * 先真放，再生成回复，回复里才能说「放了」而不是「我找找」。 */
    if (ctx.kind !== 'gift' && isVideoRequest(ctx.text)) {
      ctx.video = playClipNow(ctx.user)
      if (!ctx.video.ok) log(`  🖥 观众点播没成：${ctx.video.why}`)
    }

    /* 切歌（2026-10-28，主人要求「跟大肥鱼说切歌就可以切」）。
     * 放在点歌之前：两者不会抢 —— `isSkipRequest` 只认**整句**指令，
     * 「点歌，孤勇者」整句不是切歌，「切歌」也不含点歌关键词。
     * 先真按了再回话，跟点歌同一个原则：别嘴上说切了、歌没动。 */
    if (ctx.kind !== 'gift' && isSkipRequest(ctx.text)) {
      const r = musicSrc === 'box' ? await boxCmd('next') : await mediaCmd('next')
      ctx.skip = { ok: Boolean(r.ok), why: r.why || '' }
      /* 记一笔：自检看到「刚手动操作过」就不会乱拉（next 会触发自动续播）。 */
      lastUserCmdAt = Date.now()
      log(`  🎵 有人喊切歌 → ${r.ok ? '切到下一首' : '没切动：' + (r.why || '')}`)
      await pollMusicLoop()
    }

    /* 点歌：真去放（2026-10-27 加，2026-10-27 晚换成插件）。
     * 之前只回了句「好嘞，这就放」——观众看着歌名没变，等于被骗。
     * 现在先真的放/排队，再生成回复，回复里才能说「切到《xxx》」而不是空口白话。 */
    if (ctx.kind !== 'gift' && isSongRequest(ctx.text)) {
      /* 点歌写法（2026-10-27 主人定）：**点歌，歌名，歌手（可不填）**。
       * 歌手不是必填，但它能显著提高搜索命中率 —— 同名歌太多了，
       * 只拿「孤勇者」去搜，插件可能挑到翻唱；带上「陈奕迅」就准得多。 */
      const ask = songAsk(ctx.text)
      const want = ask.title
      const q = ask.artist ? `${want} ${ask.artist}` : want
      /* 有人在问「怎么点歌」—— 不搜歌，让 reply.mjs 直接教格式。
       * 不单独拦的话，「怎么点歌」会被当成点了一首叫「怎么」的歌。 */
      if (isSongHelp(ctx.text)) {
        ctx.song = { name: '', help: true }
        log('  🎵 有人在问点歌格式，直接教他')
      } else {
      /* 第一优先：单身汉播放器（真搜索 + 真队列，能指定放哪一首）。
       * 它不在（没装 / DSH 没开 / 音乐界面没开）才回落到 QQ 音乐那套翻歌。 */
      const boxR = want ? await boxRequestSong(want, ask.artist) : { ok: false, why: '没听出歌名' }
      if (boxR.ok) {
        ctx.song = {
          name: want, artist: ask.artist, found: true,
          title: boxR.title || want, how: boxR.how || 'play',
          /* 实际演唱者 + 是不是只有试听片段。观众点陈奕迅、放出来是熊昱琦，
           * 这两个字段让回复不至于睁眼说瞎话。 */
          by: boxR.by || '', trial: boxR.trial === true,
        }
        log(`  🎵 点歌「${q}」→ ${boxR.how === 'queue' ? '排进歌单' : '直接播'}《${ctx.song.title}》`)
        await pollMusicLoop() // 让画面立刻显示，别等下一次轮询
      } else if (!boxR.fallback) {
        /* 插件在，但这次没成（搜不到 / 播放器界面关了 / 取不到流）。
         * 直说原因 —— 不许再落到「排上了」那种话上。 */
        ctx.song = { name: want, artist: ask.artist, found: false, title: '', why: boxR.why || '没点成' }
        log(`  🎵 点歌「${q}」没成：${ctx.song.why}`)
      } else if (!musicOn || mediaDead) {
        /* 音乐根本没接管（关掉了 / 播放器挂了）。
         * 这里必须显式给 ctx.song 一个 why，否则 reply.mjs 会落到
         * 「《X》排上了，唱完这首就到」那句上 —— 什么都没发生却说排上了，
         * 观众等一晚上也等不到。宁可直说「音乐没开」。 */
        ctx.song = { name: want, artist: ask.artist, found: false, title: '', why: '没有播放器在跑' }
        log(`  🎵 点歌「${q}」：音乐没接管，放不了（${boxR.why || '插件不可用'}）`)
      } else if (want && queue.looped && queue.list.length && !queue.list.some((t) => sameTitle(t, want))) {
        /* 快照已经把整个歌单读全了（翻的时候绕回起点 = looped），
         * 那「快照里没有」就是**歌单里真的没有**，一次都不用翻。
         * 这条很关键：以前这种情况会按 next 硬翻 18 首再一首首退回来，
         * 观众看到的就是「我点了个歌单里没有的歌，她连续切了十几首」。
         * 现在直接告诉她没有。 */
        ctx.song = { name: want, artist: ask.artist, found: false, title: '', why: '歌单里没有这首' }
        log(`  🎵 点歌「${q}」不在歌单里（快照已读全，不翻歌）`)
      } else if (want) {
        /* 翻几首？快照里有这首歌就按位置算（可能在第 20 首，默认只翻 12 首就永远找不到），
         * 没有就退回 12。上限 40 —— 再多观众要听一分钟快进。 */
        const hint = Math.min(40, skipHint(want))
        log(`  🎵 点歌「${q}」，去歌单里找（最多翻 ${hint} 首）…`)
        // 40 秒：找不到的时候 python 要「翻 N 首 + 一首首退回来」，
        // 实测 12 首能到 20 秒。宁可让她多等一会儿，也别超时后说「没找到」而其实找到了。
        const r = await mediaCmdSlow('song', { name: want, duck: true, max: hint }, 40000)
        ctx.song = {
          name: want,
          artist: ask.artist,
          found: !!(r && r.ok && r.found),
          title: String((r && r.title) || ''),
          why: String((r && r.why) || ''),
        }
        if (ctx.song.found) log(`  🎵 切到《${ctx.song.title}》`)
        else log(`  🎵 没找到「${want}」：${ctx.song.why || '不在歌单里'}`)
        await pollMusic() // 让画面立刻显示新歌，别等下一次轮询
      }
      }
    }

    /* 原来固定 900~1500ms，纯粹是为了「像在思考」。可它是**纯排队**的时间：
     * 加上轮询 1.5s + 模型 1~3s + 合成 2s，观众从发出去到听见要 6 秒以上。
     * 模型调用本身就有 1 秒起步，「思考」动画根本不用靠这里撑。
     * 现在只留一点点，让两条回复不至于像连珠炮。 */
    await sleep(Number(process.env.REPLY_THINK_MS || 300) + Math.random() * 300)
    let text = ''
    try {
      /* 面板里填了感谢模板就直接用 —— 不走模型。
       * 好处：① 主人写什么就说什么，不会被模型改写；② 零延迟、零 token；
       * ③ 模板里的 {user} 一定替换对了，不会出现「谢谢undefined」。 */
      text = ctx.forceText ? String(ctx.forceText) : await makeReply(ctx)
    } catch (e) {
      log('  [reply] 出错：', e?.message || e)
      continue
    }
    if (!text) continue
    stat.replied++
    spendMoney() // 饭钱：每开一次口扣 0.05

    /* 闲时视频还在放就先收掉 —— 她开口的时候不该有别人的声音在旁边抢戏。
     * 放在 ttsSynth 之前：只在「真要出声」的这一条路上让位，纯字幕不走这儿。
     *
     * 🔴 例外：观众点播的那段（`keep === 'request'`）**宽限期内**不收 ——
     * 人家刚喊「放个视频」，你放了一秒就掐掉，比不放还气人。
     *
     * 🔴 2026-10-27 深夜补：宽限期原来等于「整段都不收」，于是点播视频这 120 秒里
     * 她说的每一句都是**哑的** —— 视频音轨和 TTS 一起出声，人声被盖住。
     * 主人的原话：「设置里面显示回复了，但是实际直播好像没有回复」。
     * 日志对得上：22:57:55 点播开播（120s 上限），
     * 22:58:11 / 22:58:51 / 22:59:00 三句 🗣 全落在视频播放期内，一条都没让位。
     * 现在只保护前 20 秒（够观众看到「真的放上了」），之后她开口照收。
     *
     * 🔴 2026-10-28 又改：主人选的是「放完为止 + 说话时压低视频音量」。
     * 所以默认 **不再收掉**（`rules.idleFull`，默认 true），改成让 mediaOut()
     * 把音量压到 20% —— 画面不断，她的声音也听得清。
     * 想回到「一开口就收」的老行为：设置页「电脑 → 播放队列与打断」关掉那个开关。 */
    const graceMs = Number(process.env.ZY_REQUEST_GRACE || 20) * 1000
    const protecting = Boolean(
      MEDIA.cur && MEDIA.cur.keep === 'request'
      && Date.now() - Number(MEDIA.cur.at || 0) < graceMs
    )
    if (MEDIA.cur && MEDIA.cur.tier === 0 && !protecting && !mediaCfg.rules.idleFull) {
      const wasRequest = MEDIA.cur.keep === 'request'
      mediaFinish(MEDIA.cur.seq, '她要说话了')
      log(`  🖥 要开口了，视频先收掉${wasRequest ? '（点播的宽限期已过）' : ''}`)
    } else if (MEDIA.cur && MEDIA.cur.tier === 0 && !MEDIA.cur.duckLogged) {
      /* 不收，只压低。下一拍 /state.json 就会带上压低后的音量。
       * 只记一次 —— 否则她每说一句都刷一行，日志会被淹掉。 */
      MEDIA.cur.duckLogged = true
      log('  🖥 要开口了，视频音量压到 20%（画面继续放）')
    }
    /* 先合成，再**同时**上字幕 + 出声（2026-10-27 改）。
     * 原来是「字幕立刻上屏、声音后补」，观众看到字幕出来了还要等一秒才听到，
     * 像卡了一下。现在合成好再一起出 —— 缓存命中时两者相差不到 50ms。
     * 合成那零点几秒里画面在放「思考」动画，不会显得没反应。 */
    /* 🔴 以前这里是 `Date.now() < speakUntil ? {ok:false} : await ttsSynth(...)`
     * —— 上一句还没放完就直接放弃合成，只上字幕不出声。本意是「别叠着念」，
     * 实际效果是**连着回两条时第二条永远是哑的**：日志里 🗣 明明有，
     * 观众却什么都没听见（2026-10-27 主人问「显示回复了但实际没回复」，实测
     * 550 句里有 65 句是这样）。
     * 播放器本身是串行的（见 playFile 注释：player 自己会播完再收下一条），
     * 所以根本不用在这里挡 —— 合成了丢给播放器，它会排队播。 */
    const syn = await ttsSynth(text)
    const dur = syn.ok ? Number(syn.dur) || 0 : 0

    let hold = Math.max(4200, text.length * 340)
    if (dur > 0) hold = Math.max(hold, dur * 1000 + 900)
    say = { text, until: Date.now() + hold }
    setMood('idle') // 说话期间回待机（还没有"张嘴说话"的素材），字幕会盖住状态
    broadcast('say', { text, dur, pending: false })
    log(`  🗣 ${text}`)
    broadcastStats()
    if (dur > 0) playFile(syn)

    await sleep(Math.max(1400, hold * 0.55))
  }
  replying = false
}

function showDanmaku(user, text, kind) {
  broadcast('danmaku', { user, text, kind: kind || '' })
  recent.push({ user, text, kind: kind || '' })
  while (recent.length > 12) recent.shift()
  log(`  ${kind === 'gift' ? '🎁' : '💬'} ${user}：${text}`)
}

/* ------------------------------------------------------------ 心情 → 动作
 * 画面那边（native/pet.py）有一张同样的表，把心情翻成「播哪一段」。
 * 这里只负责决定「现在是什么心情」和「从哪一刻开始的」——
 * 相位交给画面自己按绝对时间算，否则 0.4 秒轮询一次会让动作一顿一顿。
 *
 * 时长是照素材来的：success 10.12 秒一整段（起势→跳→回站姿），
 * 但直播里让她笑 10 秒太久，只取前面 4 秒就切回待机，看着更像"被逗了一下"。
 */
/* R2 素材一轮 pingpong 的时长：124 帧 × 2 − 2 = 246 拍 × 42ms ≈ 10.33 秒。
 * 临时情绪（送礼/被骂）按整轮播完，中途切走会看到动作戛然而止。 */
const LOOP_MS = 10330
const MOOD_MS = { happy: LOOP_MS, sad: LOOP_MS, waiting: 3400, thinking: 4200 }

// 平常待机的两段交替：thinking 占 1/3 的时间片，idle 占 2/3
const MOOD_ALT_MS = Number(process.env.ZY_MOOD_ALT_MS || 20000)
// 有人在线但多久没人说话算「没人说话」——超过就切委屈
const QUIET_FOR_SAD = Number(process.env.ZY_QUIET_SAD || 60000)

const RE_BAD = /笨|丑|滚|垃圾|傻|闭嘴|难听|恶心|人机|假的吧/
const RE_GOOD = /好听|好看|可爱|漂亮|厉害|牛|棒|爱了|喜欢|绝了|唱得好/

let mood = { name: 'idle', at: Date.now(), until: 0 }

/* 基线情绪 —— 没有临时情绪时该播什么（2026-10-28 主人定的策略）：
 *   · TTS 正在出声      → thinking（睁着眼，比闭眼待机更像在回应）
 *   · 房间没人          → sad
 *   · 有人但安静超时    → sad
 *   · 其余              → idle / thinking 按时间片交替
 *
 * 为什么要有「基线」这一层：原来的 currentMood() 只有「临时情绪 + 超时回 idle」，
 * 安静时永远是 idle，而 R2 素材的 idle 是闭眼的，看着像睡着了。
 */
function baselineMood() {
  const now = Date.now()
  if (now < speakUntil) return 'thinking'
  if (stat.online <= 0) return 'sad'
  if (now - quietSince > QUIET_FOR_SAD) return 'sad'
  return Math.floor(now / MOOD_ALT_MS) % 3 === 0 ? 'thinking' : 'idle'
}

function setMood(name, ms) {
  const m = MOOD_MS[name] || 0
  mood = { name, at: Date.now(), until: Date.now() + (ms || m) }
}

function currentMood() {
  const now = Date.now()
  if (mood.until && now > mood.until) {
    // 临时情绪到期 → 交回基线
    mood = { name: baselineMood(), at: now, until: 0 }
  } else if (!mood.until) {
    // 没有临时情绪时，基线变了就跟着变（交替 / 掉线 / 静音都会走到这里）
    const b = baselineMood()
    if (b !== mood.name) mood = { name: b, at: now, until: 0 }
  }
  return mood
}

/* ------------------------------------------------------------ 主动开口
 * 直播不能只在被点名时才说话 —— 安静下来观众 30 秒就划走了。
 * 但要克制，否则会变成自说自话的复读机。四道闸门：
 *   · 安静 40 秒才考虑
 *   · 两次主动开口至少隔 90 秒（说错话/卡壳时也不会连环开炮）
 *   · 正在说话（TTS 还没放完）时一律不动
 *   · 房间没人（online <= 0）不开腔 —— 2026-10-28 修：
 *     原来 chitchat 完全不看在线人数，空房间也照烧 token 自己跟自己聊。
 * 说不了话的时候就让画面动一下（打哈欠/伸懒腰），至少不像死机。
 */
const QUIET_FOR_TALK = Number(process.env.REPLY_QUIET_FOR_TALK || 40000)
const SELF_GAP = Number(process.env.REPLY_SELF_GAP || 90000)
let quietSince = Date.now()
let lastSelfTalk = 0
let lastWelcome = 0

setInterval(() => {
  if (Date.now() < speakUntil) return // 还在出声，别叠着说
  // 房间没人就别自言自语白烧 token（2026-10-28 修）。
  // stat.online 来自抖音 room_stats 心跳（display_value），空房间是 0；
  // demo 模式每轮把 online 顶到 >=3，调试时照常自言自语，不受影响。
  // 注意：若你的平台把主播自己算进在线（空房间显示 1），把 `<= 0` 改成 `<= 1`。
  if (stat.online <= 0) return
  const quiet = Date.now() - quietSince
  if (quiet < QUIET_FOR_TALK) return

  if (Date.now() - lastSelfTalk > SELF_GAP) {
    lastSelfTalk = Date.now()
    quietSince = Date.now() + 15000 // 刚说过，别马上又触发
    log(`  [self] 安静 ${Math.round(quiet / 1000)}s，自己找句话`)
    queueReply({ kind: 'chitchat', user: '', text: '' })
    return
  }

  // 安静太久时基线已经切到 sad（见 baselineMood），画面不会死着。
  // 原来这里会额外打个哈欠/伸懒腰 —— R2 素材没这两段，设了也是白设（会兜底回 idle）。
}, 5000).unref?.()

/** 一条弹幕进来 → 更新「安静了多久」和表情。真实事件和 demo 都走这里，别各写一套 */
function noteEvent(text, isGift) {
  quietSince = Date.now()
  if (isGift) setMood('happy')
  else if (RE_BAD.test(String(text || ''))) setMood('sad')
  else if (RE_GOOD.test(String(text || ''))) setMood('happy', 3000)
}

/* ------------------------------------------------------------ 回放去重 */
/* get_live_events 没有 id，而且返回的是「监听开始以来的全量累积数组」。
 * 只要重新 start_live_listen（换房间、MCP 重连、主人点一下「连上这个房间」），
 * 上游就会把最近这批历史再吐一遍 —— 同一句话被回两次。
 * 2026-10-27 21:26 就是这么翻车的：点了「连上这个房间」，21:26:34 一口气
 * 收到 7 条旧弹幕，38/47/53 秒各回了一句，主人当场看出来不对。
 *
 * cursorWarmUntil 那个冷却期挡的是「整批回放」（按数组长度判断）；
 * 这里再按内容兜一层，防的是「冷却期过了才姗姗来迟的重复」。
 * 只对 chat / gift 去重：进场、点赞本来就可能同一个人反复来，
 * 一起去了会把正常事件也吃掉。 */
const DEDUPE_TTL = Number(process.env.ZY_DEDUPE_TTL || 180000)
const seenKeys = new Map() // 指纹 -> 第一次见到的时刻
let lastUnknownAt = 0 // 「认不出来的事件」上次报的时刻（限流用）

function dedupeKey(n) {
  if (n.kind === 'chat') return `c|${n.uid || n.user || ''}|${n.text || ''}`
  if (n.kind === 'gift') return `g|${n.uid || n.user || ''}|${n.giftName || ''}|${n.giftCount || 1}`
  return ''
}

function isReplay(n) {
  const k = dedupeKey(n)
  if (!k) return false
  const now = Date.now()
  const at = seenKeys.get(k)
  if (at && now - at < DEDUPE_TTL) return true
  seenKeys.set(k, now)
  if (seenKeys.size > 500) {
    for (const [kk, tt] of seenKeys) if (now - tt > DEDUPE_TTL) seenKeys.delete(kk)
  }
  return false
}

function pushEvent(d) {
  const n = normalize(d)
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify({ t: Date.now(), d }) + '\n')
    } catch {}
  }
  if (n && isReplay(n)) {
    /* 回放：原始事件上面已经落盘留痕了，但这里不计数、不回复。 */
    stat.dup++
    if (stat.dup === 1 || stat.dup % 10 === 0) {
      log(`  ♻ 丢掉回放的旧事件 ${stat.dup} 条（不回复）`)
    }
    return
  }
  stat.total++
  if (!n) {
    /* 认不出来的事件以前是**静默丢弃**的。主人问「我发的弹幕怎么没显示」时，
     * 光看日志分不清是「上游没给」还是「给了但我们没认出来」——这两件事
     * 处理方式完全不同。留一行痕（30 秒最多一次，别刷屏）。 */
    if (Date.now() - lastUnknownAt > 30000) {
      lastUnknownAt = Date.now()
      let raw = ''
      try {
        raw = JSON.stringify(d).slice(0, 240)
      } catch {}
      log('  ❓ 认不出来的事件（已丢弃）：', raw)
    }
    return
  }
  if (n.online != null) stat.online = n.online
  /* 记一笔档案。room_stats 是「在线人数」，不是人，别往档案里塞。
   * 摘要放在 n.profile 上，后面组装 ctx 时带进去 —— 只在内存里传，
   * 不进 system（进了前缀缓存就废了）。 */
  if (n.uid && n.kind !== 'room_stats') {
    n.profile = touchUser(
      n.uid,
      n.user,
      n.kind,
      n.kind === 'gift' ? { name: n.giftName, n: n.giftCount } : null
    )
  }
  if (n.kind === 'chat') stat.chat++
  if (n.kind === 'gift') {
    stat.gift++
    /* 礼物通道自检：记「最后一次收到礼物」的时刻。
     * 不靠「收到礼物 0」这一条判断 —— 刚开播本来也可能是 0。
     * 判据是「弹幕/进场在流，礼物却一条都没有」（见 giftHealth()）。 */
    lastGiftAt = Date.now()
    giftEvents++
  }
  if (n.kind === 'member') {
    stat.member++
    // 有人进来 → 抬头看一眼（waiting 是"张望"那段），再欢迎一句。
    // 进出很频繁，所以 25 秒内只喊一次，别变成复读机。
    //
    // 🔴 进场**不再**刷新 quietSince（2026-10-27 22:00 改）。
    // 原来这里有一句 quietSince = Date.now()，后果是闲时视频永远等不到：
    // 直播间每几十秒就有人进进出出，100 秒安静窗口几乎凑不齐，
    // 主人问「视频为什么一次都没播」就是这么来的。
    // 判断「她无聊」应该只看有没有人真的跟她说话（弹幕/礼物），
    // 路人推门进来不算聊天 —— 现在由 noteEvent() 和礼物分支负责。
    setMood('waiting')
    if (REPLY_ON && Date.now() - lastWelcome > 25000) {
      lastWelcome = Date.now()
      queueReply({ kind: 'welcome', user: n.user, text: n.text, uid: n.uid, profile: n.profile })
    }
  }
  if (n.kind === 'like') {
    stat.like++
    if (n.totalLike) stat.like = n.totalLike
    /* 点赞也谢一句。观众双击屏幕看到的是爱心飘过，主播看到的就是「有人送爱心」，
     * 不回的话他会以为根本没识别到（2026-10-27 主人就是这么问的）。
     * 但不能每一下都谢 —— 一个人 5 秒能点 6 下。节流见 LIKE_GAP / LIKE_STEP。 */
    const now = Date.now()
    const grew = stat.like - likeThankedTotal
    if (REPLY_ON && !livePaused && grew >= LIKE_STEP && now - likeThanksAt >= LIKE_GAP) {
      likeThanksAt = now
      likeThankedTotal = stat.like
      likeQueue.length = 0 // 过期的感谢不如不谢
      likeQueue.push({ kind: 'like', user: n.user, text: n.text, uid: n.uid, profile: n.profile })
      if (!replying) replyWorker()
    }
  }
  if (n.show) {
    showDanmaku(n.user, n.text, n.gift ? 'gift' : '')
    // 表情跟着弹幕走：送礼/被夸 → 高兴，被骂 → 委屈。优先级 gift > 骂 > 夸。
    noteEvent(n.text, n.kind === 'gift' || !!n.gift)
  }
  // 弹幕和礼物都要回。点赞/进场不回，否则刷屏
  if (n.show && (n.kind === 'chat' || n.kind === 'gift')) {
    if (n.kind === 'gift') {
      enqueueGift(n, false)
      /* 媒体播放和感谢**互不阻塞**（2026-10-27 主人要求）：
       * 这里同步调用，但里面只做「排队 + 定个定时器」，不 await 任何东西，
       * 所以哪怕素材解码卡住，感谢话术照常发。 */
      try {
        const r = triggerGiftMedia(n)
        if (r && r.how === '跳过' && r.why) log(`  🖥 媒体没播：${r.why}`)
      } catch (e) {
        log('  🖥 媒体触发失败（不影响感谢）：', e?.message || e)
      }
    } else queueReply({ user: n.user, text: n.text, kind: 'chat', uid: n.uid, profile: n.profile })
  }
  // 没认出来的事件形状，每种只提示一次。以后要支持新事件（连麦/PK/关注…），
  // 看这几行就知道该按哪些字段判断，不用瞎猜。
  if (n.kind === 'unknown') {
    const sig = Object.keys(d || {}).sort().join(',')
    if (!seenUnknown.has(sig)) {
      seenUnknown.add(sig)
      log(`  [未知事件] 字段：${sig.slice(0, 160)}`)
    }
  }
  broadcastStats()
}

/* ------------------------------------------------------------ 启动 MCP */
let child = null
let mcpReuseLogged = false
async function ensureMcp() {
  if (await tcpAlive(MCP_PORT)) {
    /* 这行以前每 18 秒刷一次（好几条循环都会走到这里），一天几千行纯噪音。
     * 只在「这次是复用而不是新起」的第一回打一次。 */
    if (!mcpReuseLogged) {
      mcpReuseLogged = true
      log(`MCP 已在 127.0.0.1:${MCP_PORT} 上跑着，直接用`)
    }
    return
  }
  mcpReuseLogged = false
  if (!fs.existsSync(MCP_EXE)) {
    throw new Error(`找不到 MCP 可执行文件：${MCP_EXE}\n用 --mcp <路径> 指定`)
  }
  log('启动 douyin-mcp …')
  child = spawn(MCP_EXE, ['-port', ':' + MCP_PORT, '-token', TOKEN], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  /* MCP 每处理一次调用就打一行 GIN access log。轮询 400ms 一次 = 一天十几万行，
   * 把真正有用的行全埋了（日志已经 4.3MB，面板每 3 秒还要整份读一遍来解析）。
   * GIN 行没有信息量，直接不落盘。 */
  const logMcp = (b) => {
    for (const line of String(b).split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.includes('[GIN]')) continue
      log('[mcp]', t)
    }
  }
  child.stdout.on('data', logMcp)
  child.stderr.on('data', logMcp)
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (await tcpAlive(MCP_PORT)) {
      log('MCP 就绪')
      return
    }
  }
  throw new Error('MCP 启动超时')
}

/* ------------------------------------------------------------- 轮询增量 */
const mcp = new Mcp(MCP_PORT, TOKEN)
/* 🔴 null = 「还没建立基线」。不能用 0 起手：
 * get_live_events 返回的是「监听开始以来的全量累积数组」，而 ensureMcp()
 * 发现 MCP 已经在监听就直接复用旧进程 —— 只重启 bridge 时数组里还躺着
 * 整场历史弹幕，cursor 从 0 开始就会把它们当新弹幕逐条回复。
 * （2026-10-27 主人实测：重启画面和桥之后，刚才那批弹幕又被回了一遍。）
 *
 * 但光有 cursor=null 只挡住了「复用旧进程」。当天 21:11 和 21:26 又各回放了一批：
 * MCP 进程重启 → 数组先被读到 0 条（基线就定在 0）→ 一秒后抖音把最近十几条
 * 历史消息推过来 → 这十几条全被当成新弹幕回了。所以还得加「冷却期」：
 * 一旦发现基线可疑（第一轮 / 数组变短），接下来 WARMUP 毫秒内只跟着刷基线、
 * 一条都不推 —— 等回放批次落地了再开始算新弹幕。 */
const POLL_WARMUP_MS = Number(process.env.ZY_POLL_WARMUP || 10000)
let cursor = null
let cursorWarmUntil = 0 // 这之前只刷基线不推送（毫秒时间戳）
let cursorWarmSkipped = 0 // 冷却期里吞掉多少条，到期后汇总报一句
let polling = false
let lastErr = ''

async function pollOnce() {
  const arr = await mcp.call('get_live_events')
  if (!Array.isArray(arr)) return
  if (cursor === null || arr.length < cursor) {
    /* 第一轮，或者数组变短（MCP 重启过、重新开始累积）。
     * 这些事件都是「已经发生」的，一条都不该补回 —— 全部当历史吞掉，
     * 并且进入冷却期，等回放批次落地。丢几条新的，好过把整场重播一遍。 */
    const why = cursor === null ? '建基线' : `数组被重置（${cursor} → ${arr.length}）`
    cursor = arr.length
    cursorWarmUntil = Date.now() + POLL_WARMUP_MS
    cursorWarmSkipped = 0
    log(`  ${why}：${cursor} 条当历史，${(POLL_WARMUP_MS / 1000).toFixed(0)} 秒冷却期内不回复`)
    return
  }
  if (Date.now() < cursorWarmUntil) {
    /* 冷却期：基线跟着走，事件不推。抖音在这几秒里会补发一批历史消息。 */
    if (arr.length > cursor) {
      cursorWarmSkipped += arr.length - cursor
      cursor = arr.length
    }
    return
  }
  if (cursorWarmSkipped) {
    log(`  冷却结束，又吞掉回放的旧事件 ${cursorWarmSkipped} 条（没回）`)
    cursorWarmSkipped = 0
  }
  const fresh = arr.slice(cursor)
  cursor = arr.length
  for (const d of fresh) pushEvent(d)
}

/* 轮询间隔。原来 1500ms —— 弹幕从抖音到她开口，光这一层就要白等最多 1.5 秒。
 * get_live_events 是本机调用（实测 0.5~1.5ms），400ms 一次完全不心疼，
 * 体感上就是「刚发出去她就动了」。要更保守可以用 ZY_POLL_MS 调回去。 */
const POLL_MS = Number(process.env.ZY_POLL_MS || 400)
let pollTicks = 0
let lastPollLog = 0

async function startPolling() {
  polling = true
  while (polling) {
    try {
      await pollOnce()
      lastErr = ''
    } catch (e) {
      const m = String(e?.message || e)
      if (m !== lastErr) {
        lastErr = m
        log('轮询出错：', m)
      }
    }
    /* 每分钟报一次「轮询还活着、游标走到哪」。
     * 有了这行，再出「我发了但她没看见」就能一眼分清是「没轮询」还是「上游没给」。 */
    pollTicks++
    if (Date.now() - lastPollLog > 60000) {
      lastPollLog = Date.now()
      log(`  [poll] 心跳 ${pollTicks} 次 · cursor=${cursor} · 累计 ${stat.total} 条 · 丢弃回放 ${stat.dup} 条`)
    }
    await sleep(POLL_MS)
  }
}

/* ------------------------------------------------------- 礼物通道自检 */
/* 为什么要有这个东西：抖音的礼物消息和弹幕走的是不同的下发通道，
 * cookie 掉成游客态（没 sessionid）时，弹幕/进场/点赞全都照常，礼物一条不剩。
 * 2026-10-27 就是这样：17:11 cookie 被重写，此后再没收到过礼物，
 * 面板上唯一的异常只有「收到礼物 0」—— 而刚开播本来就可能是 0，看不出来。
 *
 * 判据不是「礼物等于 0」，而是「别的通道在动，礼物通道一动不动」：
 *   开播满 GIFT_SILENT_SEC 秒 + 至少来过 GIFT_MIN_OTHER 条别的事件 + 礼物 0 条
 * 三个条件同时成立才报「通道断了」，误报概率很低。 */
const GIFT_SILENT_SEC = Number(process.env.ZY_GIFT_SILENT || 900) // 15 分钟
const GIFT_MIN_OTHER = Number(process.env.ZY_GIFT_MIN_OTHER || 20)
function giftHealth() {
  const now = Date.now()
  const upSec = Math.floor((now - START) / 1000)
  const agoSec = lastGiftAt ? Math.floor((now - lastGiftAt) / 1000) : null
  const others = stat.chat + stat.member + stat.like // 别的通道活着的证据
  let state = 'ok' // ok | idle | silent
  let why = ''
  if (!lastGiftAt) {
    if (upSec >= GIFT_SILENT_SEC && others >= GIFT_MIN_OTHER) {
      state = 'silent'
      why = `开播 ${Math.floor(upSec / 60)} 分钟、收到 ${others} 条别的事件，礼物 0 条 —— 礼物通道大概断了（多半是抖音登录态掉了，去 DSH 设置页扫码重新登录）`
    } else {
      state = 'idle' // 时间还不够，说不准
    }
  } else if (others >= GIFT_MIN_OTHER && agoSec > GIFT_SILENT_SEC) {
    state = 'silent'
    why = `最后一次礼物在 ${Math.floor(agoSec / 60)} 分钟前，期间别的通道一直在动 —— 礼物通道大概断了`
  }
  /* 断流只喊一次，别每分钟刷屏。恢复了要能重新武装。 */
  if (state === 'silent' && !giftWarned) {
    giftWarned = true
    log(`  ⚠ 礼物通道疑似断开：${why}`)
  } else if (state === 'ok' && giftWarned) {
    giftWarned = false
    log('  ✓ 礼物通道恢复')
  }
  return { state, why: why || null, seen: giftEvents, lastAgoSec: agoSec, others }
}

/* -------------------------------------------------------- 直播开没开 */
/* 2026-10-27 主人问「能不能检测到直播开启或者结束」。试过三条路：
 *   ① 抖音直播伴侣的窗口标题 —— 开播前后都叫「直播伴侣」，没有信息量
 *   ② 进程上行速率 —— 实测没开播也有 490KB/s（它在传封面、预加载），分不出来
 *   ③ MCP 的 get_live_info —— room_status：0 未开播 / 2 直播中 / 4 已结束
 *      本地调用、权威、快。就用它。
 *
 * 为什么这件事值得做：下播以后她还在回弹幕、还在念 TTS，纯烧钱；
 * 而且画面一直写着「直播中」，你自己也看不出到底断没断。 */
const LIVE_POLL = Number(process.env.ZY_LIVE_POLL || 30000)
const LIVE_PAUSE = String(process.env.ZY_LIVE_PAUSE ?? '1') !== '0'
const LIVE_GRACE = Number(process.env.ZY_LIVE_GRACE || 60000) // 掉线多久才算「真下播」
const LIVE = {
  status: 'unknown', // unknown | live | ended | offline
  at: 0, // 当前状态从哪一刻开始
  startedAt: 0, // 开播时刻（本地第一次看到 live）
  checkedAt: 0,
  title: '',
  roomId: '', // 抖音内部 room_id（面板「直播房间识别」卡要展示）
  anchorId: '',
  why: '',
  fails: 0,
}
let livePaused = false

const LIVE_TEXT = { live: '直播中', ended: '已下播', offline: '未开播', unknown: '直播中' }

/** 下播超过宽限期就暂停自动回复。短暂断流不算 —— 网络抖一下很常见 */
function refreshLivePause() {
  if (!LIVE_PAUSE || !RID) {
    livePaused = false
    return
  }
  const off = LIVE.status === 'ended' || LIVE.status === 'offline'
  const next = off && Date.now() - LIVE.at > LIVE_GRACE
  if (next === livePaused) return
  livePaused = next
  log(next ? '  [live] 已下播，暂停自动回复和语音（重新开播会自动恢复）' : '  [live] 恢复自动回复')
}

async function pollLiveOnce() {
  if (!RID) return
  let info = null
  try {
    info = await mcp.call('get_live_info', { web_rid: RID })
  } catch (e) {
    LIVE.fails++
    LIVE.why = String(e?.message || e).slice(0, 80)
    return
  }
  LIVE.fails = 0
  LIVE.why = ''
  LIVE.checkedAt = Date.now()
  LIVE.title = String(info?.room_title || '')
  LIVE.roomId = String(info?.room_id || '')
  LIVE.anchorId = String(info?.anchor_id || '')
  const raw = String(info?.room_status ?? '')
  const status = raw === '2' ? 'live' : raw === '4' ? 'ended' : raw === '0' ? 'offline' : 'unknown'
  if (status === LIVE.status) {
    refreshLivePause()
    return
  }
  const prev = LIVE.status
  LIVE.status = status
  LIVE.at = Date.now()
  if (status === 'live') {
    LIVE.startedAt = Date.now()
    log(`  [live] 🔴 开播了${LIVE.title ? ' · ' + LIVE.title : ''}`)
    // 下播时上游的 WS 会断，重新开播必须重新起监听，不然一条弹幕都收不到。
    // 如果监听其实还活着，这里会报「已在运行」，catch 掉就行 —— 别去 stop，
    // 那会把正在用的监听顶掉。
    if (prev === 'ended' || prev === 'offline') {
      mcp.call('start_live_listen', { web_rid: RID }).catch(() => {})
    }
  } else if (prev === 'live') {
    const mins = LIVE.startedAt ? Math.round((Date.now() - LIVE.startedAt) / 60000) : 0
    log(`  [live] ⏹ 下播了（本场约 ${mins} 分钟）`)
  }
  refreshLivePause()
  broadcast('live', { status, at: LIVE.at, text: LIVE_TEXT[status] || '' })
}

function startLiveWatch() {
  if (!RID) {
    log('没给房间号，直播状态检测关掉（demo 模式下正常）')
    return
  }
  pollLiveOnce().catch(() => {})
  setInterval(() => pollLiveOnce().catch(() => {}), LIVE_POLL).unref?.()
  log(`直播状态：每 ${Math.round(LIVE_POLL / 1000)} 秒问一次抖音（0 未开播 / 2 直播中 / 4 已结束）`)
}

/* ------------------------------------------------------------ demo 模式 */
const DEMO_FEED = [
  ['阿伟', '这歌真的好听'],
  ['momo', '主播今天状态不错啊'],
  ['夜色', '送出一个「小心心」', true],
  ['小蒋', '这是 AI 吗 好像真人'],
  ['路人甲', '点歌：孤勇者'],
  ['枫', '这段我循环三遍了'],
  ['K', '送出一个「抖音一号」', true],
  ['никто', '刚才那个视频我也刷到过'],
  ['阿七', '关注了 明天还来'],
]
function demoLoop() {
  /* ZY_DEMO_QUIET=1 关掉自动喂料，只留 /demo 手动注入。
   * 排查单条链路时必须有这个 —— 自动喂料每 2~3 秒顶掉一次 chatLatest，
   * 手动塞进去的那条还没轮到就被冲掉了（2026-10-27 验「放视频」时踩到）。 */
  if (String(process.env.ZY_DEMO_QUIET ?? '') === '1') {
    log('demo 自动喂料关掉了（ZY_DEMO_QUIET=1），只用 /demo?chat=1 注入')
    return
  }
  let i = 0
  const tick = () => {
    const [user, text, gift] = DEMO_FEED[i++ % DEMO_FEED.length]
    showDanmaku(user, text, gift ? 'gift' : '')
    noteEvent(text, !!gift) // demo 也要有表情，不然验不出动作切换
    if (gift) stat.gift++
    else stat.chat++
    stat.online = Math.max(3, stat.online + (Math.random() > 0.5 ? 1 : -1))
    stat.total++
    broadcastStats()
    // demo 也走一遍回复：不然「她会不会说话」只能等真开播才知道（--no-reply 可关）
    if (gift) queueReply({ user, text, kind: 'gift' })
    else queueReply({ user, text, kind: 'chat' })
    setTimeout(tick, 1800 + Math.random() * 1600)
  }
  setTimeout(tick, 800)
}

/* -------------------------------------------------------------- HTTP 服务 */
function serveFile(res, file) {
  try {
    const body = fs.readFileSync(file)
    res.writeHead(200, {
      'content-type': file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.endsWith('.png') ? 'image/png' : 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(body)
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404 ' + file)
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 面板接口实现（2026-10-27）
 *
 * 为什么要经过桥：MCP 是桥拉起来的、端口在桥手里（18080）。面板（DSH 插件）
 * 自己再起一个 MCP 会抢端口，还会把桥正在用的监听顶掉。所以统一走这里转发。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 读请求体（JSON）。面板 POST 的都很小，64KB 封顶，读不到就当空对象。 */
function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on('data', (b) => {
      raw += b
      if (raw.length > 65536) finish({})
    })
    req.on('end', () => {
      if (!raw.trim()) return finish({})
      try {
        finish(JSON.parse(raw))
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
    setTimeout(() => finish({}), 3000).unref?.()
  })
}

let mcpInited = false
async function mcpReady() {
  await ensureMcp()
  if (!mcpInited) {
    await mcp.init()
    mcpInited = true
  }
}

/* 抖音账号状态。15 秒缓存 —— 面板 3 秒刷一次，不缓存就等于每 3 秒打一次抖音。 */
const dyAcct = { at: 0, loggedIn: false, profile: null, why: '' }
let dyQr = { token: '', img: '', expireAt: 0, at: 0 }

/** 头像字段在抖音那边叫法很多，挨个试。拿不到就返回空串（面板显示占位）。 */
function pickAvatar(u) {
  const c = [
    u?.avatar_thumb?.url_list?.[0],
    u?.avatar_medium?.url_list?.[0],
    u?.avatar_larger?.url_list?.[0],
    u?.avatar_168x168?.url_list?.[0],
    u?.avatar_300x300?.url_list?.[0],
  ]
  return c.find((x) => typeof x === 'string' && x) || ''
}

/**
 * 问抖音「现在登录的是谁」。
 *
 * 🔴 判据是 check_login_status 的 **uid**，不是那个 logged_in 布尔，也不是 get_my_profile。
 *
 *    实测（2026-10-27）：
 *      · 未登录 → check_login_status 回 `{"logged_in": true, "uid": 0}`
 *        —— 布尔是骗人的，uid=0 才是「没登录」。
 *      · 扫码登录成功后 → `{"logged_in": true, "uid": 3154971418698523}`。
 *      · get_my_profile 走的是**网页版**接口，要 sessionid cookie；
 *        而扫码登录只发 app 侧的 passport cookie ⇒ 已经登录了它照样回
 *        `status_code: 8, 用户未登录, user: null`。
 *
 *    之前拿 get_my_profile 当唯一判据，症状就是「手机上显示登录成功、
 *    设置页死活不跳成已登录」。get_my_profile 现在只用来顺手拿昵称/头像，
 *    拿不到不影响登录态（面板会退化成显示 uid）。
 */
async function dyProfile(force = false) {
  if (!force && dyAcct.at && Date.now() - dyAcct.at < 15000) return dyAcct
  await mcpReady()
  let st = null
  let why = ''
  try {
    st = await mcp.call('check_login_status')
  } catch (e) {
    why = String(e?.message || e).slice(0, 120)
  }
  const uid = String(st?.uid ?? '0')
  const ok = Boolean(st && st.logged_in) && uid !== '0' && uid !== ''

  /* 昵称 / 头像：有就带上，没有就给个只有 uid 的壳 */
  let prof = null
  if (ok) {
    try {
      const p = await mcp.call('get_my_profile')
      const u = p?.user || null
      if (u && (u.nickname || u.uid)) {
        prof = {
          nickname: String(u.nickname || ''),
          avatar: pickAvatar(u),
          uniqueId: String(u.unique_id || u.short_id || ''),
          uid: String(u.uid || uid),
          secUid: String(u.sec_uid || ''),
          fans: Number(u.follower_count || 0),
          following: Number(u.following_count || 0),
        }
      }
    } catch {
      /* 网页接口要 sessionid，扫码登录拿不到 —— 正常，不记日志免得刷屏 */
    }
    if (!prof) prof = { nickname: '', avatar: '', uniqueId: '', uid, secUid: '', fans: 0, following: 0 }
  }

  dyAcct.at = Date.now()
  dyAcct.loggedIn = ok
  dyAcct.why = ok ? '' : (st?.status_msg || why || '未登录')
  dyAcct.profile = prof
  return dyAcct
}

function roomOut() {
  /* 待机（没连上房间）要单独一个状态 —— LIVE.status 的初始值是 'unknown'，
   * 而 LIVE_TEXT.unknown 是「直播中」，面板会显示「直播中」其实一条弹幕都收不到。 */
  const idle = isIdle()
  return {
    ok: true,
    webRid: RID,
    owner: ROOM_OWNER,
    roomId: LIVE.roomId,
    anchorId: LIVE.anchorId,
    title: LIVE.title,
    status: idle ? 'idle' : LIVE.status,
    statusText: idle ? '待机中' : LIVE_TEXT[LIVE.status] || '未知',
    checkedAt: LIVE.checkedAt,
    startedAt: LIVE.startedAt,
    why: idle ? IDLE_WHY : LIVE.why,
    fails: LIVE.fails,
    demo: DEMO,
    idle,
    idleWhy: IDLE_WHY,
    target: ROOM_TARGET,
    retrySec: Math.round(IDLE_RETRY / 1000),
  }
}

/** 读原始请求体（二进制，给背景图上传用）。超过上限直接掐掉，返回 null。 */
function readRaw(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (b) => {
      size += b.length
      if (size > limit) { finish(null); req.destroy(); return }
      chunks.push(b)
    })
    req.on('end', () => finish(Buffer.concat(chunks)))
    req.on('error', () => finish(null))
  })
}

/* ── 画面版式（2026-10-28）─────────────────────────────────────────────
 * 只认这 7 个组件，键名跟 native/render.py 里的 layout.json 一一对应。
 * 校验的目的不是防坏人（本机 127.0.0.1），是防「编辑器传了个 NaN/字符串」
 * 把 render.py 里的 int() 弄炸 —— 那会直接黑屏。
 */
const LAYOUT_PATH = path.join(DIR, 'cache', 'layout.json')
/* 形象清单：render.py 启动 / 换形象时落的（有哪些素材、各自角色包围盒比例）。
 * 桥只读不写 —— 包围盒得解图才量得准，Python 那边才是权威。 */
const PET_GEOM_PATH = path.join(DIR, 'cache', 'pet-geom.json')
function readPetGeom() {
  try {
    return JSON.parse(fs.readFileSync(PET_GEOM_PATH, 'utf8'))
  } catch {
    return null
  }
}
const LAYOUT_KEYS = ['stats', 'songs', 'banner', 'character', 'monitor', 'danmaku', 'subtitle']

function sanitizeLayout(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: '要一个 JSON 对象' }
  const src = b.items
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { ok: false, error: '缺 items' }
  const num = (v, lo, hi, dflt) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return dflt
    return Math.max(lo, Math.min(hi, Math.round(n)))
  }
  const items = {}
  for (const k of LAYOUT_KEYS) {
    const v = src[k]
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const o = {
      x: num(v.x, -1000, 3000, 0),
      y: num(v.y, -1000, 3000, 0),
      w: num(v.w, 120, 1920, 400),
      visible: v.visible !== false,
    }
    if (k === 'banner') {
      o.size = num(v.size, 12, 200, 50)
      o.align = ['left', 'center', 'right'].includes(v.align) ? v.align : 'center'
    }
    /* 皮套用哪套素材（2026-10-28）。**必须原样留着** —— render.py 靠它判断
     * 这份版式是不是已经按新素材换算过了；编辑器保存时丢掉这个字段，
     * 画面就会以为还是旧版式，又按新基准换算一次，人越存越大。 */
    if (k === 'character' && typeof v.pet === 'string' && /^pet\d*$/.test(v.pet)) o.pet = v.pet
    items[k] = o
  }
  if (!Object.keys(items).length) return { ok: false, error: 'items 里没有一个认识的组件' }
  const bgIn = (b.bg && typeof b.bg === 'object' && !Array.isArray(b.bg)) ? b.bg : {}
  const bg = {
    type: bgIn.type === 'color' ? 'color' : 'image',
    // 去掉 .. 和前导斜杠：编辑器里手填一个 ../../etc/passwd 会读到别处去。
    // render.py 那边是 os.path.join(项目根, 这个值)，绝对路径会把前半截丢掉。
    image: typeof bgIn.image === 'string'
      ? bgIn.image.replace(/\.\./g, '').replace(/^[\\/]+/, '').slice(0, 200)
      : '',
    color: /^#[0-9a-fA-F]{3,8}$/.test(String(bgIn.color || '')) ? String(bgIn.color) : '#1E182A',
    dim: Math.max(0, Math.min(0.9, Number(bgIn.dim) || 0)),
  }
  return {
    ok: true,
    data: { version: 1, theme: b.theme === 'light' ? 'light' : 'dark', bg, items },
  }
}

async function dyRoute(p, u, req) {
  /* ══════════════════════════════════════════════════════════════════
   * 礼物档位媒体（2026-10-27 加）
   *   GET  /media/box      当前状态（正在播什么 / 队列 / 留痕 / 每档素材数）
   *   GET  /media/list     扫目录的结果（按档位分组 + 认不出档位的 + 不支持的）
   *   POST /media/config   {on?, idle?, tierDefault?, giftMap?, tiers?, rules?}
   *   POST /media/play     {tier} 或 {file}   手动试播（设置页「试播」按钮）
   *   POST /media/stop     停掉当前，清空队列
   *   GET  /media/done?seq=N  画面播完了回调（seq 不对说明已经换人，忽略）
   *
   * 🔴 为什么是 /media/box 而不是 /media（2026-10-27 修）：
   *    /media 是**音乐**接口（music.html 一直在用：GET /media 读曲目、
   *    GET /media?cmd=playpause 切歌）。这一块原来直接占了 /media，
   *    把音乐面板整个顶掉了 —— music.html 读到的是素材队列，一个字都不对。
   *    现在电脑展示区独占 /media/box，音乐那边回到 /media。
   *
   * 决策全在桥这边：画面只负责解码 + 播完回报，不自己判断该不该播。
   * ══════════════════════════════════════════════════════════════════ */
  if (p === '/media/box') {
    return { ok: true, ...mediaOut(), cfg: mediaCfg, rules: mediaCfg.rules }
  }

  /* ── 音源登录（2026-10-27 深夜加）────────────────────────────────────
   * 主人有 QQ 音乐会员：登录之后 VIP 曲才给完整音源，不登录只有 30 秒试听
   * （日志里的「⚠ 只有试听片段」就是这个）。实测三家全是 loggedIn:false。
   *
   * 为什么在面板里内嵌二维码、不跳网页：DSH 的网页端口要鉴权，
   * 裸 URL 直接打开是 401。二维码本来就是 base64 data URI，塞进 <img> 就行。
   */
  if (p === '/music/auth') {
    const r = await boxJson('/auth/status', { timeout: 6000 })
    if (!r.ok) return { ok: false, error: r.why || '问不到登录状态', providers: [] }
    return { ok: true, providers: Array.isArray(r.providers) ? r.providers : [] }
  }
  if (p === '/music/login/qq' && req.method === 'POST') {
    const r = await boxJson('/auth/qq/qr', { method: 'POST', body: {}, timeout: 15000 })
    if (!r.ok) return { ok: false, error: r.why || '二维码没拿到' }
    return { ok: true, qrsig: r.qrsig, ptLoginSig: r.ptLoginSig, img: r.img }
  }
  if (p === '/music/login/qq/check') {
    const qrsig = u.searchParams.get('qrsig') || ''
    const sig = u.searchParams.get('ptLoginSig') || ''
    if (!qrsig || !sig) return { ok: false, error: '没给 qrsig / ptLoginSig' }
    const r = await boxJson(
      `/auth/qq/qr/check?qrsig=${encodeURIComponent(qrsig)}&ptLoginSig=${encodeURIComponent(sig)}`,
      { timeout: 9000 },
    )
    return { ok: Boolean(r.ok), qr: r.qr || null, error: r.why || '' }
  }
  if (p === '/music/login/qq/cookie' && req.method === 'POST') {
    /* 扫码走不通时的兜底：直接从浏览器贴一段 QQ 音乐 cookie。
     * 2026-10-28 确认这是唯一能给 QQ 会员权益的办法 —— 扫码只回基础态
     * （uin + 空 p_skey），会员票据 qm_keyst 拿不到。 */
    const b = await readJson(req)
    const cookie = String(b.cookie || '').trim()
    if (!cookie) return { ok: false, error: '没给 cookie' }
    const r = await boxJson('/auth/qq', { method: 'POST', body: { cookie }, timeout: 10000 })
    return { ok: Boolean(r.ok && r.saved), saved: Boolean(r.saved), error: r.ok ? '' : (r.why || '没存上') }
  }

  /* ── 网易云扫码登录（2026-10-28 加，设置页「音源」那张卡用）──────────
   * QQ 扫码只回基础态，会员曲取不到音源；网易云走官方接口，非会员也能放
   * 标准音质整首（会员专享曲除外），是另一条能走通的路。
   * 一次调用把 key 和二维码都取回来 —— 分两步的话页面要多跑一个来回，
   * 而二维码只有两分钟寿命，能省就省。 */
  if (p === '/music/login/netease' && req.method === 'POST') {
    const a = await boxJson('/auth/netease/qr', { method: 'POST', body: {}, timeout: 15000 })
    if (!a.ok || !a.key) return { ok: false, error: a.why || '没拿到 key' }
    const key = String(a.key)
    const q = await boxJson(`/auth/netease/qr/create?key=${encodeURIComponent(key)}`, { timeout: 20000 })
    if (!q.ok) return { ok: false, key, error: q.why || '二维码没生成' }
    return { ok: true, key, img: q.img || '', url: q.url || '' }
  }
  if (p === '/music/login/netease/check') {
    const key = u.searchParams.get('key') || ''
    if (!key) return { ok: false, error: '没给 key' }
    const r = await boxJson(`/auth/netease/qr/check?key=${encodeURIComponent(key)}`, { timeout: 12000 })
    return { ok: Boolean(r.ok), qr: r.qr || null, error: r.why || '' }
  }

  /* ── 「会员曲到底能不能放」当场验一次（2026-10-28 加）─────────────────
   * 存完 cookie 之后最想知道的就是这个。别让人去点一首歌碰运气 ——
   * 直接拿搜索结果里的 VIP 曲逐个试 /url，把「哪家能取到音源」摆出来。 */
  if (p === '/music/test') {
    const song = String(u.searchParams.get('song') || '一半一半').trim()
    const sr = await boxJson(`/search?keyword=${encodeURIComponent(song)}&limit=8`, { timeout: 12000 })
    if (!sr.ok) return { ok: false, error: sr.why || '搜索失败' }
    const tracks = Array.isArray(sr.tracks) ? sr.tracks : []
    /* 只挑 VIP 曲来验 —— 免费曲本来就能放，验了也说明不了会员有没有生效 */
    const vips = tracks.filter((t) => t && t.vip === true).slice(0, 6)
    if (!vips.length) return { ok: true, song, tried: [], verdict: `搜「${song}」没搜到 VIP 曲，换个歌名再试` }
    const tried = []
    for (const t of vips) {
      const r = await boxJson(`/url?id=${encodeURIComponent(t.id)}`, { timeout: 12000 })
      const res = r.result || {}
      tried.push({
        provider: String(t.provider || ''),
        name: String(t.name || ''),
        artist: Array.isArray(t.artists) ? t.artists.join('/') : String(t.artists || ''),
        url: Boolean(res.url),
        trial: res.trial === true,
      })
    }
    const good = tried.filter((x) => x.url && !x.trial)
    const verdict = good.length
      ? `✓ ${good[0].provider} 的 VIP 曲能取到整首音源（${good[0].name}）`
      : '✗ 试过的 VIP 曲都取不到音源 —— 登录态里可能还缺会员票据'
    return { ok: true, song, tried, verdict }
  }

  if (p === '/media/list') {
    const s = scanMedia(true)
    return {
      ok: true,
      dir: s.dir,
      dirExists: s.exists,
      error: s.error || '',
      /* 0 = 闲时素材（场子冷了自动放的那种），1~4 = 礼物档 */
      byTier: { 0: s.idle || [], 1: s.byTier[1], 2: s.byTier[2], 3: s.byTier[3], 4: s.byTier[4] },
      idle: s.idle || [],
      others: s.others,
      bad: s.bad,
      total: s.total,
      hint: s.exists
        ? '文件名开头的数字就是档位：1-小心心.mp4 / 3-跑车.gif；0- 开头的是闲时素材（没人点歌/没人说话时自己放）'
        : '目录不存在。点「建目录」会自动建好，然后把素材丢进去。',
    }
  }

  if (p === '/media/config') {
    const b = await readJson(req)
    if (typeof b.on === 'boolean') mediaCfg.on = b.on
    if (typeof b.idle === 'string' && ['standby', 'black', 'wallpaper'].includes(b.idle)) mediaCfg.idle = b.idle
    if (Number.isFinite(Number(b.tierDefault))) mediaCfg.tierDefault = Math.max(0, Math.min(4, Number(b.tierDefault)))
    if (typeof b.dir === 'string') mediaCfg.dir = b.dir.slice(0, 400)
    /* 闲时自动放素材（2026-10-27 晚加的功能，但这里一直漏了 —— 只有手改
     * cache/media.json 再重启桥才能调，面板和 API 都改不了）。
     * 夹取范围和 loadMediaCfg() 里读盘时保持一致，别两处不一样。 */
    if (b.idlePlay && typeof b.idlePlay === 'object') {
      const ip = mediaCfg.idlePlay
      if (typeof b.idlePlay.on === 'boolean') ip.on = b.idlePlay.on
      if (Number.isFinite(Number(b.idlePlay.quietSec))) {
        ip.quietSec = Math.max(10, Math.min(3600, Number(b.idlePlay.quietSec)))
      }
      if (Number.isFinite(Number(b.idlePlay.gapSec))) {
        ip.gapSec = Math.max(30, Math.min(7200, Number(b.idlePlay.gapSec)))
      }
      if (Number.isFinite(Number(b.idlePlay.startSec))) {
        ip.startSec = Math.max(0, Math.min(3600, Number(b.idlePlay.startSec)))
      }
    }
    if (b.giftMap && typeof b.giftMap === 'object') {
      const m = {}
      for (const [k, v] of Object.entries(b.giftMap)) {
        /* 0 档也算合法目标（2026-10-28 主人：「发礼物也可以放 0 档」）——
         * 原来这里是 n >= 1，礼物映射到 0 档会被**静默吞掉**，
         * 界面上选了 0 档、保存也不报错，但实际一点变化都没有。 */
        const n = Number(v)
        if (String(k).trim() && n >= 0 && n <= 4) m[String(k).trim().slice(0, 20)] = n
      }
      mediaCfg.giftMap = m
    }
    if (b.tiers && typeof b.tiers === 'object') {
      /* 0 档也要能改（2026-10-28）：原来是 [1,2,3,4]，0 档的 mode 根本改不了，
       * 主人想「0 档点播也随机」只能手改 media.json 再重启桥。 */
      for (const t of [0, 1, 2, 3, 4]) {
        const s = b.tiers[t] || b.tiers[String(t)]
        if (!s) continue
        const d = mediaCfg.tiers[t]
        if (['random', 'sequence'].includes(s.mode)) d.mode = s.mode
        if (Number.isFinite(Number(s.volume))) d.volume = Math.max(0, Math.min(1, Number(s.volume)))
        if (Number.isFinite(Number(s.maxSec))) d.maxSec = Math.max(1, Math.min(600, Number(s.maxSec)))
        if (typeof s.loop === 'boolean') d.loop = s.loop
      }
    }
    if (b.rules && typeof b.rules === 'object') {
      const r = mediaCfg.rules
      if (typeof b.rules.interrupt === 'boolean') r.interrupt = b.rules.interrupt
      if (['queue', 'merge'].includes(b.rules.sameTier)) r.sameTier = b.rules.sameTier
      if (Number.isFinite(Number(b.rules.cooldown))) r.cooldown = Math.max(0, Math.min(600, Number(b.rules.cooldown)))
      if (typeof b.rules.duckMusic === 'boolean') r.duckMusic = b.rules.duckMusic
      if (Number.isFinite(Number(b.rules.maxQueue))) r.maxQueue = Math.max(1, Math.min(20, Number(b.rules.maxQueue)))
      /* 礼物不分档（2026-10-27 深夜）：打开后不看礼物名，1–4 档混着随机抽 */
      if (typeof b.rules.flatGift === 'boolean') r.flatGift = b.rules.flatGift
      /* 0 档放完为止（2026-10-28）：说话时不收只压低，礼物来了排队不顶掉 */
      if (typeof b.rules.idleFull === 'boolean') r.idleFull = b.rules.idleFull
    }
    /* 音量（2026-10-27）：改完立刻生效。
     * 音乐这一项要马上落到播放器上 —— 不然面板拖到 30%，观众那边还是 100%，
     * 得等下一首歌才「碰巧」对上。 */
    if (b.audio && typeof b.audio === 'object') {
      const before = { ...mediaCfg.audio }
      for (const k of ['voice', 'media', 'music', 'duck']) {
        if (Number.isFinite(Number(b.audio[k]))) {
          mediaCfg.audio[k] = Math.max(0, Math.min(100, Math.round(Number(b.audio[k]))))
        }
      }
      if (mediaCfg.audio.music !== before.music) applyMusicVolume()
      if (mediaCfg.audio.duck !== before.duck) log(`  ♫ 说话时音乐压到 ${mediaCfg.audio.duck}%`)
    }
    /* 背景音乐总开关（2026-10-28）：面板启动页那个开关走这里。
     * 交给 setMusicOn 而不是直接改 mediaCfg —— 关掉要顺带把播放器按停、清空快照，
     * 只改一个布尔值的话，声音还在响，面板却显示"关着"。 */
    let musicSwitch = null
    if (typeof b.musicOn === 'boolean') {
      musicSwitch = setMusicOn(b.musicOn, '面板')
      if (!musicSwitch.ok) return { ok: false, error: musicSwitch.error, musicOn }
    }
    saveMediaCfg()
    mediaScanAt = 0
    log(`  🖥 媒体设置已更新：${mediaCfg.on ? '开' : '关'} · 冷却 ${mediaCfg.rules.cooldown}s · ` +
      `${mediaCfg.rules.interrupt ? '高档打断' : '不打断'} · 同档${mediaCfg.rules.sameTier === 'merge' ? '合并' : '排队'} · ` +
      `音量 说话${mediaCfg.audio.voice}% 素材${mediaCfg.audio.media}% 音乐${mediaCfg.audio.music}%` +
      /* 这两项不写出来，主人改完只能在日志里干等「到底生效没有」——
       * 礼物不分档尤其需要一句话确认，不然他分不清是没开还是没抽中。 */
      (mediaCfg.rules.flatGift ? ' · 礼物不分档（1–4 混着抽）' : '') +
      (mediaCfg.rules.idleFull ? ' · 0 档放完为止（说话只压低）' : '') +
      ` · 背景音乐${musicOn ? '开' : '关'}`)
    if (b.idlePlay && typeof b.idlePlay === 'object') {
      const ip = mediaCfg.idlePlay
      log(`  🕐 闲时自动放：${ip.on ? '开' : '关'} · 安静 ${ip.quietSec}s 算闲 · 两条隔 ${ip.gapSec}s · 开播 ${ip.startSec}s 后才开始`)
    }
    return { ok: true, musicOn, cfg: mediaCfg, ...mediaOut() }
  }

  if (p === '/media/play') {
    const b = await readJson(req)
    let item = null
    if (b.file) {
      const s = scanMedia()
      const all = [...(s.idle || []), ...s.byTier[1], ...s.byTier[2], ...s.byTier[3], ...s.byTier[4], ...s.others]
      item = all.find((x) => x.file === b.file || x.name === b.file) || null
      if (!item) return { ok: false, error: '找不到这个文件（目录里没有，或者刚被删了）' }
    } else {
      /* 🔴 别写 `Number(b.tier) || 1`：0 档（闲时）会被 || 改成礼物 1 档。 */
      const raw = Number(b.tier)
      const wantTier = Number.isFinite(raw) && raw >= 0 ? raw : 1
      item = pickFile(wantTier)
      if (!item) return { ok: false, error: wantTier === 0 ? 'media/ 里还没有 0- 开头的闲时素材' : `档位${wantTier} 目录里还没有素材` }
    }
    const fromName = Number((item.name.match(/^\s*([0-4])/) || [])[1])
    const rawTier = Number(b.tier)
    const tier = Number.isFinite(rawTier) && rawTier >= 0
      ? rawTier
      : (Number.isFinite(fromName) ? fromName : mediaCfg.tierDefault || 1)
    /* 上一份是闲时视频、这一份是礼物档：先把音乐放回来，
     * 否则它一直停在暂停上，新媒体的 duck 也没东西可压。 */
    const wasIdle = !!(MEDIA.cur && MEDIA.cur.tier === 0)
    clearEndTimer()
    MEDIA.cur = null
    MEDIA.queue.length = 0
    if (wasIdle && tier !== 0) resumeMusicAfterMedia()
    mediaBegin(item, { tier, user: '试播', gift: '' })
    return { ok: true, ...mediaOut() }
  }

  if (p === '/media/stop') {
    const wasIdle = !!(MEDIA.cur && MEDIA.cur.tier === 0)
    clearEndTimer()
    MEDIA.cur = null
    MEDIA.queue.length = 0
    MEDIA.seq++
    /* 手动停掉闲时视频也要把音乐放回来 —— 不然点了「停止」，歌就一直是暂停的。 */
    if (wasIdle) resumeMusicAfterMedia()
    mediaLog('■ 手动停止', 'end')
    return { ok: true, ...mediaOut() }
  }

  /* ── 素材文件操作（2026-10-27 加）────────────────────────────────────
   *   {op:'open'}            在资源管理器里打开素材目录（往里丢文件用）
   *   {op:'trash', file}     把一个素材挪进 media/.trash
   *
   * 🔴 删除一律是「移到 .trash」，不真删：
   *    设置页上「删除」按钮就在「试播」旁边，手滑一次就少一份素材太狠了。
   *    真要清空，自己去 .trash 里删，那是主人的事。
   * 🔴 只允许动素材目录里的文件 —— 传 ../../ 这种路径要挡住。
   */
  if (p === '/media/file') {
    const b = await readJson(req)
    const op = String(b.op || '')
    const dir = mediaDir()
    if (op === 'open') {
      try {
        fs.mkdirSync(dir, { recursive: true })
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } catch (e) {
        return { ok: false, error: '打不开目录：' + String(e?.message || e) }
      }
      return { ok: true, dir, message: '已打开素材目录' }
    }
    if (op === 'trash') {
      const f = String(b.file || '')
      if (!f) return { ok: false, error: '没给文件' }
      const full = path.resolve(f)
      if (path.dirname(full).toLowerCase() !== path.resolve(dir).toLowerCase()) {
        return { ok: false, error: '只能处理素材目录里的文件' }
      }
      if (!fs.existsSync(full)) return { ok: false, error: '文件已经不在了' }
      const trash = path.join(dir, '.trash')
      fs.mkdirSync(trash, { recursive: true })
      const base = path.basename(full)
      const ext = path.extname(base)
      let target = path.join(trash, base)
      for (let i = 1; fs.existsSync(target); i++) {
        target = path.join(trash, `${path.basename(base, ext)}-${i}${ext}`)
      }
      try {
        fs.renameSync(full, target)
      } catch (e) {
        return { ok: false, error: '挪不动：' + String(e?.message || e) }
      }
      mediaScanAt = 0
      mediaLog(`🗑 移出素材 ${base}（在 .trash 里）`, 'warn')
      return { ok: true, moved: target, ...mediaOut() }
    }
    return { ok: false, error: '不认识的操作：' + op }
  }

  if (p === '/media/done') {
    const seq = Number(u.searchParams.get('seq'))
    const why = String(u.searchParams.get('why') || '播完')
    mediaFinish(Number.isFinite(seq) ? seq : null, why)
    return { ok: true, ...mediaOut() }
  }

  /* ══════════════════════════════════════════════════════════════════
   * 性格（2026-10-27 加）
   *   GET  /persona                              当前性格 + 三套定义
   *   POST /persona        {active}              切换（下一条立刻生效）
   *   POST /persona/over   {key,catch,ban,samples}  改口头禅 / 禁用词 / 示例库
   *   POST /persona/test   {text,user?,kind?}    试说一句
   *
   * 切换不重写任何数据 —— 记忆和成长值跟性格无关，只换说话方式。
   * ══════════════════════════════════════════════════════════════════ */
  if (p === '/persona') {
    if (req.method === 'POST') {
      const b = await readJson(req)
      const keys = personaInfo().list.map((x) => x.key)
      const want = String(b.active || '')
      if (keys.includes(want)) {
        const j = readPersonaCfgFile()
        j.active = want
        writePersonaCfgFile(j)
        log(`  [persona] 性格切成「${want}」，下一条生效（不用重起桥）`)
      }
    }
    return { ok: true, ...personaInfo() }
  }

  if (p === '/persona/over' && req.method === 'POST') {
    const b = await readJson(req)
    const j = readPersonaCfgFile()
    const key = String(b.key || j.active || 'meme')
    if (!j.over[key]) j.over[key] = {}
    const one = j.over[key]
    const arr = (x, max) =>
      Array.isArray(x)
        ? x.map((s) => String(s).trim().slice(0, 24)).filter(Boolean).slice(0, max)
        : null
    const c = arr(b.catch, 5)
    const ban = arr(b.ban, 5)
    const sm = arr(b.samples, 5)
    if (c) one.catch = c
    if (ban) one.ban = ban
    if (sm) one.samples = sm
    writePersonaCfgFile(j)
    log(`  [persona] 更新了「${key}」的覆盖项`)
    return { ok: true, ...personaInfo() }
  }

  if (p === '/persona/test' && req.method === 'POST') {
    const b = await readJson(req)
    const text = String(b.text || '').slice(0, 60)
    if (!text) return { ok: false, error: '要说点什么' }
    const out = await makeReply({
      user: String(b.user || '测试观众').slice(0, 20),
      text,
      kind: b.kind === 'gift' ? 'gift' : 'chat',
      uid: 'panel-test',
      noRemember: true, // 试说的话别进「刚说过，换一句」的队列
    })
    return { ok: true, out, active: personaInfo().active }
  }

  /* ══════════════════════════════════════════════════════════════════
   * 知识库（2026-10-27 加）
   *   GET  /kb                                  所有文件 / 块 / 开关
   *   POST /kb            {enabled}             总开关
   *   POST /kb            {file,on,maxBlocks,maxChars}   单份文件
   *   POST /kb            {block:"myschool/就业",on}  单块隔离
   *   POST /kb/test       {text}                这条弹幕会捞到哪几块
   *
   * 知识不是塞进 system 的 —— 那样她会照着念，像招生咨询。
   * 这里只负责读写 cache/kb.json，取用逻辑在 reply.mjs 的 kbPick()。
   * ══════════════════════════════════════════════════════════════════ */
  if (p === '/kb') {
    if (req.method === 'POST') {
      const b = await readJson(req)
      const patch = {}
      if ('enabled' in b) patch.enabled = !!b.enabled
      if (b.file) {
        patch.file = String(b.file).replace(/[^\w.-]/g, '').slice(0, 40)
        if ('on' in b) patch.on = !!b.on
        if ('maxBlocks' in b) patch.maxBlocks = b.maxBlocks
        if ('maxChars' in b) patch.maxChars = b.maxChars
      }
      if (b.block) {
        patch.block = String(b.block).slice(0, 80)
        patch.on = !!b.on
      }
      const info = kbSet(patch)
      log(`  [kb] 设置已改（${JSON.stringify(patch)}）`)
      return { ok: true, ...info }
    }
    return { ok: true, ...kbInfo() }
  }

  if (p === '/kb/test' && req.method === 'POST') {
    const b = await readJson(req)
    const text = String(b.text || '').slice(0, 60)
    if (!text) return { ok: false, error: '要说点什么' }
    const got = kbPick(text)
    const hit = [...got.matchAll(/【(.+?)】/g)].map((m) => m[1])
    return { ok: true, hit, len: got.length, injected: got }
  }

  /* ══════════════════════════════════════════════════════════════════
   * 用户记忆（2026-10-27 加）
   *   GET  /user/list?q=&limit=   列档案（按最近活跃排序）
   *   GET  /user/get?uid=         单个档案（含最近送礼记录）
   *   POST /user/set              改标签 / 备注 / 成长值 / 阶段
   *   POST /user/del              删一个
   *   GET  /user/export           导出全部（备份用）
   *   POST /user/import           导入（同一个 uid 覆盖）
   *   POST /user/clear            清空，**必须带 confirm:"yes"**
   *
   * 只有本机面板会调，所以跟 /gift/cfg 一样不鉴权（HTTP 只监听 127.0.0.1）。
   * 写操作一律 saveUsersSoon(true) —— 立刻落盘，不等 1.5 秒防抖。
   * ══════════════════════════════════════════════════════════════════ */
  if (p === '/user/list') {
    return {
      ok: true,
      ...listUsers({ q: u.searchParams.get('q') || '', limit: u.searchParams.get('limit') || 50 }),
    }
  }

  if (p === '/user/get') {
    const uid = String(u.searchParams.get('uid') || '')
    const one = users.get(uid)
    if (!one) return { ok: false, error: '没有这个用户' }
    return { ok: true, user: one }
  }

  if (p === '/user/set' && req.method === 'POST') {
    const b = await readJson(req)
    const one = users.get(String(b.uid || ''))
    if (!one) return { ok: false, error: '没有这个用户' }
    if (Array.isArray(b.tags)) {
      one.tags = b.tags.map((x) => String(x).trim().slice(0, 8)).filter(Boolean).slice(0, 5)
    }
    if (typeof b.note === 'string') one.note = b.note.trim().slice(0, 40)
    if (b.growth != null) one.growth = Math.max(0, Math.round(Number(b.growth) || 0))
    if (b.stage != null) one.stage = Math.max(0, Math.round(Number(b.stage) || 0))
    saveUsersSoon(true)
    log(`  [users] 面板改了 ${one.nick || one.uid}：标签「${(one.tags || []).join('、')}」备注「${one.note || ''}」`)
    return { ok: true, user: one }
  }

  if (p === '/user/del' && req.method === 'POST') {
    const b = await readJson(req)
    const uid = String(b.uid || '')
    if (!uid) return { ok: false, error: 'uid 不能空' }
    const okDel = users.delete(uid)
    if (okDel) saveUsersSoon(true)
    return { ok: okDel, left: users.size }
  }

  if (p === '/user/export') {
    return { ok: true, version: 1, at: Date.now(), users: [...users.values()] }
  }

  if (p === '/user/import' && req.method === 'POST') {
    const b = await readJson(req)
    const arr = Array.isArray(b.users) ? b.users : []
    if (!arr.length) return { ok: false, error: '没给 users 数组' }
    let n = 0
    for (const it of arr) {
      if (!it || !it.uid) continue
      const uid = String(it.uid)
      // 只收认识的字段，别让导入把乱七八糟的东西塞进档案（面板要渲染它）
      users.set(uid, {
        uid,
        nick: String(it.nick || '').slice(0, 40),
        firstAt: Number(it.firstAt) || Date.now(),
        lastAt: Number(it.lastAt) || Date.now(),
        chat: Math.max(0, Number(it.chat) || 0),
        gift: Math.max(0, Number(it.gift) || 0),
        like: Math.max(0, Number(it.like) || 0),
        member: Math.max(0, Number(it.member) || 0),
        song: Math.max(0, Number(it.song) || 0),
        growth: Math.max(0, Number(it.growth) || 0),
        stage: Math.max(0, Number(it.stage) || 0),
        tags: Array.isArray(it.tags) ? it.tags.map((x) => String(x).slice(0, 8)).slice(0, 5) : [],
        note: String(it.note || '').slice(0, 40),
        gifts: Array.isArray(it.gifts) ? it.gifts.slice(-GIFTS_KEEP) : [],
      })
      n++
    }
    trimUsers()
    saveUsersSoon(true)
    log(`  [users] 导入了 ${n} 个档案，现在一共 ${users.size} 个`)
    return { ok: true, imported: n, total: users.size }
  }

  if (p === '/user/clear' && req.method === 'POST') {
    const b = await readJson(req)
    // 二次确认写在后端，不靠前端 —— 前端写错一次就全没了
    if (b.confirm !== 'yes') return { ok: false, error: '要清空请带 confirm:"yes"' }
    const had = users.size
    users.clear()
    saveUsersSoon(true)
    log(`  [users] 清空了 ${had} 个档案`)
    return { ok: true, cleared: had }
  }

  /* ---- 账号：现在登录的是谁 ---- */
  if (p === '/dy/status') {
    const a = await dyProfile(u.searchParams.get('fresh') === '1')
    return { ok: true, loggedIn: a.loggedIn, profile: a.profile, why: a.why, at: a.at }
  }

  /* ---- 账号：取二维码 ---- */
  if (p === '/dy/qr') {
    await mcpReady()
    const r = await mcp.call('get_login_qrcode')
    const d = r?.data || r || {}
    if (!d.qrcode || !d.token) {
      return { ok: false, error: String(d.description || d.copywriting || '抖音没给二维码，稍后重试').slice(0, 160) }
    }
    const exp = Number(d.expire_time) || 0
    dyQr = {
      token: String(d.token),
      img: `data:image/png;base64,${d.qrcode}`,
      // 抖音给的是秒级时间戳（1793092343），有的接口给毫秒，两种都认
      expireAt: exp > 1e12 ? exp : exp * 1000,
      at: Date.now(),
      /* 取码这一刻是否已经登录。poll 里有个「uid 不为 0 就当扫码成功」的兜底，
       * 已经登录的人点「重新登录」时不能一进 poll 就判成功，所以记下来。 */
      wasLoggedIn: dyAcct.loggedIn,
    }
    log('  [dy] 已取到登录二维码（等扫码）')
    return { ok: true, ...dyQr }
  }

  /* ---- 账号：轮询扫码状态 ---- */
  if (p === '/dy/qr/poll') {
    const token = u.searchParams.get('token') || dyQr.token
    if (!token) return { ok: false, error: '没有 token —— 先点「扫码登录」取一张二维码' }
    await mcpReady()
    const r = await mcp.call('check_login_qrcode', { token })
    const d = r?.data || r || {}
    const raw = String(d.status ?? '')
    /* 实测未扫码是 "new"。其余取值（scanning / scanned / confirmed / expired）
     * 没在真机上逐个验过，所以先按关键字认，认不出来一律当「等待扫码」——
     * 宁可多轮询几次，也别把「已确认」错判成「过期」把人踢回第一步。 */
    let state = 'waiting'
    if (/confirm|success|done|accept/i.test(raw)) state = 'confirmed'
    else if (/scan/i.test(raw)) state = 'scanned'
    else if (/expire|invalid|fail|timeout|cancel/i.test(raw)) state = 'expired'
    else if (raw === '4' || raw === '2') state = 'confirmed'
    else if (raw === '3' || raw === '-1') state = 'expired'
    else if (raw === '1') state = 'scanned'

    /* 状态字符串认不出来时的硬兜底：直接问登录态。
     * 「uid 已经不是 0 了」是硬事实，比猜字符串可靠 —— 扫码后哪怕抖音那边
     * 回了个没见过的 status，面板也能自己跳成已登录。 */
    if (state === 'waiting' && !dyQr.wasLoggedIn) {
      const st = await mcp.call('check_login_status').catch(() => null)
      const uid = String(st?.uid ?? '0')
      if (st && st.logged_in && uid !== '0' && uid !== '') state = 'confirmed'
    }

    if (state === 'confirmed') {
      /* 扫码成功后 cookie 是异步落盘的，第一次问可能还是 uid=0 —— 最多等 3 秒 */
      for (let i = 0; i < 6; i++) {
        await dyProfile(true)
        if (dyAcct.loggedIn) break
        await sleep(500)
      }
      log(dyAcct.loggedIn
        ? `  [dy] 扫码登录成功（uid=${dyAcct.profile?.uid || '?'}）`
        : '  [dy] 抖音说扫码确认了，但登录态还没读到 —— 再等等')
    }

    return {
      ok: true,
      state,
      raw,
      message: String(d.description || ''),
      loggedIn: dyAcct.loggedIn,
      profile: dyAcct.profile,
    }
  }

  /* ---- 账号：退出登录 ---- */
  if (p === '/dy/logout') {
    await mcpReady()
    await mcp.call('delete_cookies').catch((e) => {
      log('  [dy] delete_cookies 报错（继续清本地状态）：', e?.message || e)
    })
    dyAcct.at = 0
    dyAcct.loggedIn = false
    dyAcct.profile = null
    dyAcct.why = '已退出登录'
    dyQr = { token: '', img: '', expireAt: 0, at: 0 }
    log('  [dy] 已退出抖音账号（本地 cookie 已清）')
    return { ok: true, message: '已退出登录' }
  }

  /* ---- 回复档热切换（2026-10-27）----
   * 面板改「回复模型」不用再全停重启桥：MODE 是 reply.mjs 里的模块级变量，
   * 改完下一条弹幕就走新档。持久化由宿主写配置（zhiboReplyMode）负责。 */
  if (p === '/reply/mode' && req.method === 'POST') {
    const b = await readJson(req)
    const r = setReplyMode(b.mode)
    if (r.ok) log(`  [reply] 回复档切成 ${r.mode}（${r.text}）`)
    return r
  }
  if (p === '/reply/mode') return { ok: true, text: replyModeText() }

  /* ---- 两条聊天之间的间隔（2026-10-27）----
   * 面板「回复」页里那个「两条之间隔几秒」。改了立刻生效，下一条就走新节奏。
   * 传 {sec:2.5} 或 {ms:2500} 都行，面板用秒（人对秒有直觉）。 */
  if (p === '/reply/gap' && req.method === 'POST') {
    const b = await readJson(req)
    const ms = Number.isFinite(Number(b.sec)) && b.sec !== null && b.sec !== undefined
      ? Number(b.sec) * 1000
      : Number(b.ms)
    const r = setChatGap(ms)
    if (r.ok) log(`  [reply] 两条之间改成 ${r.sec}s`)
    return r
  }
  if (p === '/reply/gap') return { ok: true, ms: CHAT_GAP, sec: CHAT_GAP / 1000 }

  /* ---- 房间识别 ---- */
  if (p === '/room') return roomOut()
  if (p === '/room/refresh') {
    /* 待机时「重新识别」= 拿上次那坨东西再认一次（开播前查不到、开播后就能查到）。
     * ?force=1 = 硬重连：监听灯还绿着但一条弹幕都没有时用（上游偶尔会静默掉线）。
     * 注意重连必然会让上游把历史吐一遍，所以去重那层是必须的，别删。 */
    const force = u.searchParams.get('force') === '1'
    if (!RID || force) {
      if (!ROOM_TARGET) return { ...roomOut(), ok: false, error: '还没给房间号 —— 先粘一条分享链接' }
      const r = await attachRoom(ROOM_TARGET, { force })
      return r.ok
        ? { ...roomOut(), ok: true, message: `已连上房间 ${r.webRid}` }
        : { ...roomOut(), ok: false, error: r.error }
    }
    await pollLiveOnce()
    return roomOut()
  }

  /* 换房间 / 补房间号：**运行时生效，不用重启桥**（2026-10-27）。
   * 主人原来改完房间号必须「全停 → 再起桥 → 再开画面」，太折腾。 */
  if (p === '/room/set' && req.method === 'POST') {
    const b = await readJson(req)
    const raw = String(b.room || '').trim()
    if (!raw) return { ...roomOut(), ok: false, error: '房间号是空的' }
    const r = await attachRoom(raw)
    return r.ok
      ? {
        ...roomOut(),
        ok: true,
        picked: r.webRid,
        reused: r.reused === true,
        message: r.reused
          ? `已经连着房间 ${r.webRid}，没重连（省得上游把历史弹幕再吐一遍）`
          : `已连上房间 ${r.webRid}` +
            (r.live === true ? '（正在直播）' : r.live === false ? '（现在没在播，开播后自动接上）' : ''),
      }
      : {
        ...roomOut(),
        ok: false,
        idle: true,
        error: `${r.error} —— 已存下来，每 ${Math.round(IDLE_RETRY / 1000)} 秒自动重试`,
      }
  }

  /* ---- 礼物感谢设置 ---- */
  if (p === '/gift/cfg') {
    if (req.method === 'POST') {
      const b = await readJson(req)
      if (typeof b.on === 'boolean') giftCfg.on = b.on
      if (typeof b.template === 'string') giftCfg.template = b.template.slice(0, 200)
      if (b.cooldown != null) giftCfg.cooldown = Math.max(0, Math.min(3600, Number(b.cooldown) || 0))
      if (b.dedupe != null) giftCfg.dedupe = Math.max(0, Math.min(3600, Number(b.dedupe) || 0))
      if (typeof b.useLlm === 'boolean') giftCfg.useLlm = b.useLlm
      saveGiftCfg()
      log(
        `  [gift] 设置已更新：${giftCfg.on ? '开' : '关'} · 模板「${giftCfg.template || '（默认话术）'}」` +
        ` · 冷却 ${giftCfg.cooldown}s · 去重 ${giftCfg.dedupe}s`
      )
    }
    return {
      ok: true,
      cfg: giftCfg,
      defaults: GIFT_DEFAULTS,
      stat: { gift: stat.gift, thanked: giftThanked },
      giftNameKnown: false,
    }
  }

  if (p === '/gift/test') {
    const b = req.method === 'POST' ? await readJson(req) : {}
    const user = String(b.user || '测试观众').slice(0, 20)
    const gift = String(b.gift || '小心心').slice(0, 20)
    if (!giftCfg.on) {
      return { ok: false, error: '自动感谢开关是关的 —— 先打开再测，否则测了也不会谢' }
    }
    const n = { kind: 'gift', user, text: `送出「${gift}」`, gift: true, show: true, giftName: gift, giftCount: 1 }
    /* 测试**绕过冷却和去重**：连点两下按钮是正常操作，
     * 要是第二下被自己的去重挡住，人只会以为功能坏了。 */
    const sent = enqueueGift(n, true)
    /* 媒体也要跟着走一遍（2026-10-27 补）：以前这里只发感谢，
     * 主人点「测试一下」看不到电脑里播东西，会以为媒体档位配错了。 */
    let med = null
    try { med = triggerGiftMedia(n) } catch (e) { med = { how: '跳过', why: String(e?.message || e) } }
    return {
      ok: true,
      message: `已按当前设置生成一条感谢（${sent.how}），画面底部和语音里应该能看到`,
      text: sent.text,
      how: sent.how,
      media: med,
    }
  }

  /* ---- 画面版式（2026-10-28 加）--------------------------------------
   * editor.html 拖完要落盘，浏览器写不了磁盘，所以走桥：
   *   GET  /layout        读 cache/layout.json（编辑器打开时先拉这份，跟画面一致）
   *   POST /layout        整份覆盖写（校验 + 原子写）
   *
   * 🔴 为什么必须原子写：native/render.py 每 0.5 秒 stat 一次这个文件，
   *    写一半被读到就会解析失败。它虽然会退回上一份版式（不会黑屏），
   *    但下一次 mtime 变了才会重试 —— 中间那段时间画面停在旧版式上，
   *    表现是「拖了但没反应」。所以先写 .tmp 再 rename。
   */
  if (p === '/layout' && req.method === 'POST') {
    const b = await readJson(req)
    const clean = sanitizeLayout(b)
    if (!clean.ok) return clean
    try {
      fs.mkdirSync(path.dirname(LAYOUT_PATH), { recursive: true })
      const tmp = LAYOUT_PATH + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(clean.data, null, 2), 'utf8')
      fs.renameSync(tmp, LAYOUT_PATH)
      log(`  [layout] 版式已保存（${Object.keys(clean.data.items).length} 个组件，主题 ${clean.data.theme}）`)
      return { ok: true, at: new Date().toISOString(), theme: clean.data.theme,
               bg: clean.data.bg.type, items: Object.keys(clean.data.items).length }
    } catch (e) {
      return { ok: false, error: '写不进去：' + String((e && e.message) || e).slice(0, 200) }
    }
  }
  /* 背景图：列目录 + 上传
   *   GET  /layout/bg               assets/ 里能当背景的图（编辑器下拉用）
   *   POST /layout/bg?name=x.png    请求体就是图片二进制（拖一张图进编辑器）
   * 为什么要上传：主人原话「背景可以替换选择，允许人更改」——
   *   让他为了换张图去手动拷文件、再手打路径，那就不叫"可以替换"了。 */
  if (p === '/layout/bg' && req.method === 'GET') {
    try {
      const dir = path.join(DIR, 'assets')
      const files = fs.readdirSync(dir)
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .map((f) => {
          let kb = 0
          try { kb = Math.round(fs.statSync(path.join(dir, f)).size / 1024) } catch { /* 忽略 */ }
          return { name: f, path: 'assets/' + f, kb }
        })
        .sort((a, b) => b.kb - a.kb)
      return { ok: true, files }
    } catch (e) {
      return { ok: false, error: '读不了 assets/：' + String((e && e.message) || e).slice(0, 160) }
    }
  }
  if (p === '/layout/bg' && req.method === 'POST') {
    const raw = await readRaw(req, 12 * 1024 * 1024)
    if (!raw || !raw.length) return { ok: false, error: '没收到图片数据（或者超过 12MB）' }
    // 扩展名只认这三种，其余一律当 png —— 反正下面 Pillow 打开时还会再判一次
    let name = String(u.searchParams.get('name') || 'bg.png')
    name = name.replace(/[^\w.\-]/g, '_').replace(/^\.+/, '').slice(-60)
    if (!/\.(png|jpe?g|webp)$/i.test(name)) name = name.replace(/\.[^.]*$/, '') + '.png'
    try {
      const dir = path.join(DIR, 'assets')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), raw)
      log(`  [layout] 背景图已存 assets/${name}（${Math.round(raw.length / 1024)}KB）`)
      return { ok: true, path: 'assets/' + name, kb: Math.round(raw.length / 1024) }
    } catch (e) {
      return { ok: false, error: '写不进去：' + String((e && e.message) || e).slice(0, 200) }
    }
  }

  if (p === '/layout') {
    try {
      const raw = fs.readFileSync(LAYOUT_PATH, 'utf8')
      return { ok: true, layout: JSON.parse(raw), path: LAYOUT_PATH }
    } catch (e) {
      return { ok: false, error: '还没有版式文件（画面正在用内置默认版式）', path: LAYOUT_PATH }
    }
  }

  /* ── 皮套形象（2026-10-28）─────────────────────────────────────────
   *   GET  /pet          assets/ 下有哪些形象、各自比例、现在用哪套
   *   POST /pet {name}   换形象
   *
   * 🔴 换形象**只改 layout 的 character.pet 一个字段，坐标一个字不动**。
   *    因为换算要用「角色包围盒」，那玩意儿只有画面进程量得出来（它解图）。
   *    桥自己按像素猜一份，迟早跟 Python 算的对不上 —— 那种偏差在直播里
   *    表现成「人忽大忽小」，还特别难查。画面进程读到 pet 变了会自己换算并写回。
   *
   *    pet-geom.json 是 render.py 启动/切换时落的，桥只读不写。
   */
  if (p === '/pet' && req.method === 'GET') {
    const g = readPetGeom()
    /* skin 一起带上（2026-10-28）：面板换皮套时要顺手告诉人「人设也跟着换了」，
     * 不然主人不知道提示词已经切过，下次还会以为她记错自己颜色。 */
    const skin = skinInfo()
    if (g && Array.isArray(g.list) && g.list.length) {
      return { ok: true, cur: g.cur || '', list: g.list, at: g.at || 0, skin }
    }
    /* 没有 geom 文件（画面进程没起过）也要能列出来，否则设置页一片空 */
    try {
      const dir = path.join(DIR, 'assets')
      const list = fs.readdirSync(dir)
        .filter((f) => /^pet\d*$/.test(f) && fs.statSync(path.join(dir, f)).isDirectory())
        .map((f) => ({ name: f, label: f, ratio: null, clips: [], frames: 0, still: '' }))
      return { ok: true, cur: '', list, at: 0, stale: true, skin }
    } catch (e) {
      return { ok: false, error: '读不到素材目录：' + String((e && e.message) || e).slice(0, 160) }
    }
  }

  if (p === '/pet' && req.method === 'POST') {
    const b = await readJson(req)
    const name = String((b && b.name) || '').trim()
    if (!/^pet\d*$/.test(name)) return { ok: false, error: '形象名不对：' + name.slice(0, 40) }
    if (!fs.existsSync(path.join(DIR, 'assets', name, 'idle'))) {
      return { ok: false, error: `assets/${name}/idle 不存在，这套素材没接进来` }
    }
    let L
    try {
      L = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'))
    } catch (e) {
      /* 没有版式文件 = 画面在用内置默认版式，那就只写 pet 这一项，
       * 其余交给 render.py 跟默认值合并。 */
      L = { version: 1, items: {} }
    }
    if (!L.items || typeof L.items !== 'object') L.items = {}
    if (!L.items.character || typeof L.items.character !== 'object') L.items.character = {}
    L.items.character.pet = name
    try {
      fs.mkdirSync(path.dirname(LAYOUT_PATH), { recursive: true })
      const tmp = LAYOUT_PATH + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(L, null, 2), 'utf8')
      fs.renameSync(tmp, LAYOUT_PATH)
      log(`  🎭 形象切到 ${name}（坐标由画面进程换算）`)
      return { ok: true, cur: name, note: '画面进程会在 1 秒内换算坐标并换人' }
    } catch (e) {
      return { ok: false, error: '写不进去：' + String((e && e.message) || e).slice(0, 200) }
    }
  }

  return { ok: false, error: '不认识的接口：' + p }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const p = u.pathname

  if (p === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    clients.add(res)
    const t0 = Date.now()
    log(`叠加层接入（当前 ${clients.size} 个）`)
    sse(res, { type: 'hello', payload: { rid: RID, demo: DEMO } })
    broadcastStats()
    req.on('close', () => {
      clients.delete(res)
      log(`叠加层断开（剩 ${clients.size} 个）`)
      // 撑过 5 秒就断，基本只有两种可能：手滑关了窗口，或者渲染进程崩了
      if (Date.now() - t0 > 5000 && clients.size === 0) {
        log('⚠ 叠加层断开了 —— 如果是 Chrome 崩了，在那个窗口按 Ctrl+R 重新加载；')
        log('  窗口已经变成白底「喔唷，崩溃啦」的话就关掉它，重开 open-overlay.cmd。')
      }
    })
    return
  }

  if (p === '/hb') {
    // 页面每 5 秒报一次堆大小。崩了以后 hb.log 里留着最后几个点，
    // 能区分「内存一路涨」还是「一直很稳但突然死」。
    lastHb = {
      at: new Date().toISOString(),
      heapMB: u.searchParams.get('m'),
      nodes: u.searchParams.get('n'),
      sec: u.searchParams.get('s'),
    }
    if (HB_FILE) {
      try {
        const el = `${lastHb.at} heap=${lastHb.heapMB}MB nodes=${lastHb.nodes} sec=${lastHb.sec}\n`
        fs.appendFileSync(HB_FILE, el)
      } catch {}
    }
    res.writeHead(204, { 'access-control-allow-origin': '*' })
    res.end()
    return
  }

  if (p === '/money') {
    /* 饭钱。加钱只能走这里 —— 重启不会让数字变回去。
     *   curl "127.0.0.1:18081/money"            看还剩多少
     *   curl "127.0.0.1:18081/money?add=50"     加 50
     *   curl "127.0.0.1:18081/money?set=17.54"  直接设成 17.54
     */
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    const add = u.searchParams.get('add')
    const set = u.searchParams.get('set')
    if (add != null) addMoney(Number(add))
    else if (set != null) {
      const v = Number(set)
      if (Number.isFinite(v)) {
        money.left = Math.max(0, r2(v))
        money.at = Date.now()
        saveMoney()
      }
    }
    res.end(JSON.stringify({ ok: true, ...money, cost: MONEY_COST }))
    return
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 面板用的接口（2026-10-27 加）
   *   /dy/*     抖音账号：扫码登录、登录状态、退出
   *   /room/*   直播房间识别
   *   /gift/*   礼物感谢设置
   *
   * 为什么要经过桥：MCP 是桥拉起来的，端口在桥手里。面板（DSH 插件）
   * 自己再起一个 MCP 会抢 18080，还会跟桥的监听互相顶掉。
   * 所以统一走这里转发 —— 面板只管显示，不碰 MCP。
   * ══════════════════════════════════════════════════════════════════════ */
  /* ⚠️ `/media` 本身**不放进来** —— 那是音乐接口（music.html 在用）。
   *    电脑展示区走 /media/box、/media/list、/media/config、/media/play… */
  /* 🔴 `/music/` 这个前缀 2026-10-28 才补进来。5873cd7 那几个音源登录端点
   *    （/music/auth、/music/login/qq…）当时写进了 dyRoute，但**前缀没挂到
   *    这里**，于是它们一直是 404 —— 面板那张卡点「扫码登录」当然没反应。
   *    实测：curl /music/auth → `404 D:\Workplace\zhibo\music\auth`。 */
  if (p.startsWith('/dy/') || p.startsWith('/gift/') || p.startsWith('/user/') || p.startsWith('/persona') || p === '/kb' || p.startsWith('/kb/') || p.startsWith('/music/') || (p.startsWith('/media') && p !== '/media') || p === '/room' || p.startsWith('/room/') || p.startsWith('/reply/') || p.startsWith('/layout') || p === '/pet') {
    res.setHeader('access-control-allow-origin', '*')
    /* CORS 预检（2026-10-28 加）。
     * editor.html 如果是从别的源打开的（双击本地文件 = Origin: null），
     * 带 JSON 头的 POST 会先发一个 OPTIONS。以前这里没人答，
     * 浏览器直接判成 "Failed to fetch" —— 面板上看着就是「连不上桥」，
     * 但 GET 明明是通的（GET 不预检），所以特别难查。
     * 现在编辑器那边改成了 text/plain（简单请求，根本不预检），这里是兜底。 */
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('access-control-max-age', '600')
      res.writeHead(204)
      res.end()
      return
    }
    res.setHeader('content-type', 'application/json; charset=utf-8')
    let out
    try {
      out = await dyRoute(p, u, req)
    } catch (e) {
      out = { ok: false, error: String((e && e.message) || e).slice(0, 300) }
    }
    res.end(JSON.stringify(out))
    return
  }

  if (p === '/state.json') {
    // 原生渲染器（native/overlay.py）每 0.4 秒拉一次。给的是「当前画面该怎么画」。
    // 它带 x-dafeiyu-overlay 头 —— 用它判断「画面到底有没有在拉数据」，
    // 比查进程靠谱（手工双击 open-overlay.cmd 起的也算数）。
    if (req.headers['x-dafeiyu-overlay']) lastOverlayAt = Date.now()
    const speaking = say && Date.now() < say.until
    const m = currentMood()
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(JSON.stringify({
      name: 'zuige大肥鱼',
      state: speaking ? 'busy' : 'idle',
      stateText: speaking ? '说话中' : LIVE_TEXT[LIVE.status] || '直播中',
      // 直播状态：画面靠它决定写「直播中」还是「已下播」，也靠它算本场时长
      live: {
        status: LIVE.status,
        text: LIVE_TEXT[LIVE.status] || '直播中',
        since: LIVE.at,
        startedAt: LIVE.startedAt,
        title: LIVE.title,
        paused: livePaused,
      },
      // 动作：心情名 + 这个心情从哪一刻开始（epoch 毫秒）。
      // 画面按 (now - moodAt) 算相位，所以轮询多慢都不影响动作的顺滑度。
      mood: m.name,
      moodAt: m.at,
      online: stat.online,
      sec: Math.floor((Date.now() - START) / 1000),
      chat: stat.chat,
      gift: stat.gift,
      /* 礼物通道多久没出过事件了。画面/面板拿它区分「没人送礼物」和「收不到礼物」——
       * 2026-10-27 那天礼物断了两个小时，唯一线索就是这个数字（当时没有）。 */
      giftAgoSec: giftHealth().lastAgoSec,
      like: stat.like,
      replied: stat.replied,
      // 饭钱：右下角那个数。每开口一次 -0.05，存盘，重启接着上次的。
      money: money.left,
      moneySpent: money.spent,
      // 老字段留着：music.html / 面板还有地方读 token，别让它们读不到
      token: money.left,
      // 点歌台：**只放观众点的歌**（2026-10-28 改）。热榜只在后台放，不进画面。
      // 以前这里读整个队列快照，热榜和点歌混在一起，显示的顺序跟播放器实际顺序
      // 对不上（主人：「下一首播放的跟实际显示的还是不一样」）。
      songs: nextUp(3),
      // total 也改成只数点歌 —— 卡片右上角那个「歌单 N 首」写 4 首，
      // 结果画面里只列得出 1 首，观众会以为显示坏了。
      /* list 是**全量**（2026-10-28 加）：设置页「音源」页要看完整歌单队列，
       * 画面那边仍然只用上面那 3 首（songs），别让两块共用一个字段。
       * hot=true 的是热榜垫的，设置页会灰着标出来，方便分辨「谁点的」。 */
      queue: {
        total: boxQueue.filter((x) => !x.hot).length,
        why: queue.why || '',
        hot: hotWhy || '',
        list: boxQueue.map((x) => ({
          name: x.name,
          hot: Boolean(x.hot),
          sec: Math.max(0, Math.round((Date.now() - x.at) / 1000)),
        })),
      },
      danmaku: recent,
      subtitle: speaking ? say.text : null,
      // 正在播的歌。`hot=true` 表示这是热榜垫的 —— 点歌台**不显示歌名**（只后台放），
      // 但电脑屏上的封面照放（2026-10-28 主人定：热榜的歌也显示）。
      music: music.found
        ? {
            title: music.title,
            artist: music.artist,
            playing: music.playing,
            hot: Boolean(music.hot),
            /* 封面本地绝对路径（同机读盘）。空串 = 还没抓到 / 抓不到
             * → 画面画一个唱片占位块，不会开天窗。
             * 为什么不给 URL：画面每帧要出图，在里面发网络请求必然掉帧。 */
            coverFile: coverPathOf(music.trackId),
          }
        : null,
      // 礼物档位媒体：画面右侧那台「电脑」放什么全靠这一段。
      // seq 变了 = 换了一份素材，画面要重新打开文件。
      media: mediaOut(),
      /* 点歌的规范写法。画面底下那行提示直接读它 ——
       * 改格式只改 reply.mjs 里的 SONG_TIP 一处，屏幕上跟着变。 */
      songTip: SONG_TIP,
      demo: DEMO,
      rid: RID,
    }))
    return
  }

  if (p === '/say') {
    // 让大肥鱼「说一句」：字幕显示 N 秒。之后接 TTS / LLM 的回复就走这里。
    //   curl "http://127.0.0.1:18081/say?t=你好呀&sec=6"
    //   curl "http://127.0.0.1:18081/say?t=你好呀&speak=1"   ← 连声音一起出（验 TTS 用）
    const text = u.searchParams.get('t') || ''
    const sec = Number(u.searchParams.get('sec') || 6)
    if (text && u.searchParams.get('speak') === '1') {
      // 合成期间别把 HTTP 卡住：先出字幕，声音合成好了再补
      ttsSynth(text).then((syn) => {
        if (syn.ok && Number(syn.dur) > 0) {
          say = { text, until: Date.now() + Math.max(sec, Number(syn.dur) + 1) * 1000 }
          playFile(syn)
        }
      })
    }
    say = text ? { text, until: Date.now() + Math.max(1, sec) * 1000 } : null
    broadcast('say', { text: say ? say.text : '' })
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(say ? 'ok' : 'cleared')
    return
  }

  if (p === '/media') {
    /* 音乐控制面板（music.html）和画面都读这里。
     *   curl 127.0.0.1:18081/media                  → 当前在放什么
     *   curl "127.0.0.1:18081/media?cmd=playpause"  → 播放/暂停
     *   curl "127.0.0.1:18081/media?cmd=next"       → 下一首
     * 只读请求走内存快照（1.5 秒轮询一次），带 cmd 的才真去问播放器。 */
    const cmd = u.searchParams.get('cmd') || ''
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (!cmd) {
      if (u.searchParams.get('fresh') === '1') await pollMusic()
      res.end(JSON.stringify({ ...music, on: musicOn, forcedOff: MUSIC_FORCED_OFF, src: musicSrc, box: { ok: box.ok, alive: box.alive, why: box.why, pending: box.pending }, watch: { ok: musicWatch.ok, why: musicWatch.why, fixes: musicWatch.fixes, lastFixAt: musicWatch.lastFixAt || null }, sys: { ok: sysAudio.ok, dev: sysAudio.dev, vol: sysAudio.vol, mute: sysAudio.mute }, age: music.at ? Date.now() - music.at : null }))
      return
    }
    const ok = ['playpause', 'play', 'pause', 'next', 'prev', 'stop', 'vol'].includes(cmd)
    if (!ok) {
      res.writeHead(400)
      res.end(JSON.stringify({ ok: false, why: `不支持的 cmd：${cmd}` }))
      return
    }
    const extra = cmd === 'vol' ? { v: Number(u.searchParams.get('v') ?? 1) } : {}
    /* 记一笔「主人手动按过」—— 自检看到最近 3 分钟内有手动命令，
     * 就不去拉起暂停（否则面板点暂停 15 秒后自己又响了）。 */
    if (['playpause', 'play', 'pause', 'stop'].includes(cmd)) lastUserCmdAt = Date.now()
    /* 按「现在到底是谁在放」分流 —— 别再一律打给 QQ 音乐（见 boxCmd 上面的注释）。 */
    const r = musicSrc === 'box'
      ? await boxCmd(cmd, extra)
      : await mediaCmd(cmd, extra)
    await pollMusic()
    res.end(JSON.stringify({ ...r, music }))
    return
  }

  if (p === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(
      JSON.stringify({
        ok: true,
        rid: RID,
        owner: ROOM_OWNER,
        demo: DEMO,
        /* 待机 = 进程活着但还没连上房间（没给房间号 / 还没开播 / 解析失败）。
         * 面板靠它区分「桥在跑」和「桥在跑且连上了房间」—— 这两件事以前都显示绿。 */
        idle: isIdle(),
        idleWhy: IDLE_WHY,
        roomTarget: ROOM_TARGET,
        clients: clients.size,
        cursor: cursor ?? -1, // -1 = 还没建立基线（第一轮轮询之前）
        stat,
        /* 礼物通道自检。state=ok（正常）/ idle（说不准，刚开播）/ silent（断了）。
         * 「收到礼物 0」这个数字本身分不清「没人送」和「收不到」，这里能分清。 */
        giftChannel: giftHealth(),
        lastHb,
        // 面板（DSH 设置页）要的三样：回复走哪个模型、画面多久没来拉数据、开播多久
        replyMode: replyModeText(),
        // 两条聊天之间隔多久（秒）。面板要显示「当前生效值」，所以运行值也报出去。
        chatGapSec: CHAT_GAP / 1000,
        // 模型健康：cooling=是否在退避、coolLeftMs=还要等多久、lastError=上次为什么失败。
        // 「已回复 0」那种查不出来的问题，看这个字段就知道是模型挂了还是在退避。
        llm: llmHealth(),
        // 缓存账本：rate=累计命中率，last=最近一条，prefix=人设字数。
        // 看这个比看平台按天聚合的数字准 —— 平台那个混着冷启和别的工具。
        cache: cacheStats(),
        // 直播状态：status=live/ended/offline/unknown，paused=是否已暂停自动回复
        live: {
          status: LIVE.status,
          text: LIVE_TEXT[LIVE.status] || '',
          paused: livePaused,
          title: LIVE.title || null,
          startedAt: LIVE.startedAt || null,
          checkedAt: LIVE.checkedAt || null,
          fails: LIVE.fails,
          why: LIVE.why || null,
        },
        tts: TTS_ON ? `${TTS_VOICE} ${TTS_RATE}` : '关着',
        /* 音乐这一段 2026-10-28 改了语义：
         *   on        = 背景音乐总开关（面板启动页那个开关），关掉也照样报字段
         *   forcedOff = 起桥时被 --no-music / ZY_MUSIC=0 强制关的（面板打不开）
         *   proc      = 本机 QQ 音乐那条 python 链在不在
         * 原来只有一个 on = !!mediaProc，面板分不清「主人关的」和「播放器挂了」，
         * 两种情况显示同一句话，排查时全靠猜。 */
        music: {
          on: musicOn,
          forcedOff: MUSIC_FORCED_OFF,
          src: musicSrc,
          proc: !!mediaProc,
          title: music.title || null,
          artist: music.artist || null,
          playing: musicOn && music.playing,
          volume: music.volume,
          why: music.ok ? null : music.why || null,
          /* 自检结果。面板据此显示「正在重连」或「已拉起 N 次」——
           * 没有这个字段的话，「断连又自己好了」这件事在界面上完全看不见。 */
          watch: {
            ok: musicWatch.ok,
            why: musicWatch.why || null,
            fixes: musicWatch.fixes,
            lastFixAt: musicWatch.lastFixAt || null,
          },
          /* 系统输出这一层（设备名/音量/静音）。面板直接写出来 ——
           * 「没声音」十次有八次是这里，而它以前完全不可见。 */
          sys: {
            ok: sysAudio.ok,
            dev: sysAudio.dev || '',
            vol: sysAudio.vol,
            mute: sysAudio.mute,
            why: sysAudio.why || null,
          },
        },
        overlayAgeMs: lastOverlayAt ? Date.now() - lastOverlayAt : null,
        upSec: Math.floor((Date.now() - START) / 1000),
      })
    )
    return
  }

  if (p === '/demo') {
    /* 手动塞一条事件，排查用：
     *   curl "127.0.0.1:18081/demo?u=测试&t=你好"          普通弹幕
     *   curl "127.0.0.1:18081/demo?u=测试&t=送出「小心心」&gift=1"  礼物
     *   curl "127.0.0.1:18081/demo?u=测试&like=20"         点赞（total 直接给 20）
     * 点赞这条走的是真的 pushEvent，所以能验「节流 + 感谢」整条链路。 */
    const likeN = u.searchParams.get('like')
    if (likeN != null) {
      pushEvent({
        count: String(likeN),
        total: String(likeN),
        user: { nickname: u.searchParams.get('u') || '测试' },
      })
    } else if (u.searchParams.get('bare') === '1') {
      /* 复现「只有 user 一个字段」的事件。**它现在是进场，不是礼物** ——
       * 2026-10-27 22:15 订正：这种形状被当成礼物，导致四个只是进来的人被谢了一通。
       * 想验礼物请用下面 chat=1 加真礼物字段，或者直接在直播间送一个。 */
      pushEvent({ user: { nickname: u.searchParams.get('u') || '测试' } })
    } else if (u.searchParams.get('gift') === '1') {
      /* 真礼物的形状（登录态正常时实测）：gift 对象 + comboCount 都在。 */
      pushEvent({
        gift: { name: u.searchParams.get('name') || '小心心' },
        comboCount: String(u.searchParams.get('n') || '1'),
        user: { nickname: u.searchParams.get('u') || '测试' },
      })
    } else if (u.searchParams.get('chat') === '1') {
      /* 真弹幕（走 pushEvent，会真的排进回复队列）—— 用来端到端验点歌 */
      pushEvent({ content: u.searchParams.get('t') || '你好', user: { nickname: u.searchParams.get('u') || '测试' } })
    } else {
      broadcast('danmaku', {
        user: u.searchParams.get('u') || '测试',
        text: u.searchParams.get('t') || '手动测试弹幕',
        kind: u.searchParams.get('gift') === '1' ? 'gift' : '',
      })
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('ok')
    return
  }

  // `/` 不再指向已删除的浏览器叠加层 index.html —— 生产画面走原生 Win32 窗口。
  // 2026-10-28：根页面改成磁盘上的 home.html（M3E 控制台）。
  // 放磁盘而不是内联字符串，改样式不用重启桥 —— 跟 settings.html 一个待遇。
  if (p === '/') {
    const home = path.join(DIR, 'home.html')
    if (fs.existsSync(home)) return serveFile(res, home)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>大肥鱼弹幕桥</title>' +
      '<body style="font:14px/1.7 system-ui,sans-serif;background:#0e1116;color:#e6edf3;padding:24px">' +
      '<h2>大肥鱼弹幕桥运行中</h2>' +
      '<p>画面走原生 Win32 窗口（非浏览器）。可用接口与页面：</p>' +
      '<ul>' +
      '<li><a style="color:#4dd0e1" href="/state.json">/state.json</a> — 状态快照（JSON）</li>' +
      '<li><a style="color:#4dd0e1" href="/events">/events</a> — 弹幕事件 SSE 流</li>' +
      '<li><a style="color:#4dd0e1" href="/settings.html">/settings.html</a> — 设置面板</li>' +
      '<li><a style="color:#4dd0e1" href="/music.html">/music.html</a> — 音乐台</li>' +
      '</ul></body>'
    )
    return
  }
  return serveFile(res, path.join(DIR, p.replace(/^\/+/, '')))
})

/* --------------------------------------------------------- 分类器自检 */
// node bridge.mjs --selftest   两种键名格式各喂一遍，看有没有被判成 unknown 的
function runSelftest() {
  const cases = [
    ['真实房间原样', { displayLong: '1在线观众', displayMiddle: '1', displayShort: '1', displayValue: '1', displayType: '1', total: '1' }],
    ['snake 版统计', { display_long: '1234在线观众', display_short: '1234', display_value: '1234', total: '5678' }],
    ['camel 弹幕', { content: '这歌真好听', user: { nickname: '阿伟', id: '123' } }],
    ['snake 弹幕', { content: 'snake 版弹幕', user: { nickname: '小明', display_id: 'xm' } }],
    ['camel 礼物', { giftId: '1', gift: { name: '小心心' }, repeatCount: '10', user: { nickname: '夜色' } }],
    ['snake 礼物', { gift_id: '2', gift: { name: '抖音一号' }, repeat_count: '1', user: { nickname: 'K' } }],
    ['点赞', { count: '5', total: '200', user: { nickname: '枫' } }],
    ['进场', { memberCount: '3', actionDescription: '来了', user: { nickname: '路人' } }],
    ['关注', { followCount: '1', user: { nickname: '小蒋' } }],
  ]
  let bad = 0
  for (const [label, d] of cases) {
    const kind = classify(d)
    const n = normalize(d)
    if (kind === 'unknown') bad++
    console.log(
      `${kind === 'unknown' ? '✗' : '·'} ${label.padEnd(14)} → ${kind.padEnd(11)}` +
        (n && n.show ? `  「${n.user}：${n.text}」` : n && n.online != null ? `  online=${n.online}` : '') +
        // uid 是记忆系统的主键，顺手打出来 —— 没有 id 的会显示 n: 开头（退化成昵称）
        (n && n.uid ? `  uid=${n.uid}` : '')
    )
  }
  console.log(bad ? `\n有 ${bad} 条被判成 unknown` : '\n全部识别正常')

  /* ---- 用户档案自检（2026-10-27 加）----
   * 用假 uid，测完删干净，绝不碰真档案。
   * 只验四件事：isNew 判断、计数、送礼记录、搜索。 */
  console.log('\n用户档案：')
  const tid = 'selftest:' + Date.now()
  const p1 = touchUser(tid, '自检阿伟', 'chat')
  const p2 = touchUser(tid, '自检阿伟', 'gift', { name: '小心心', n: 3 })
  const p3 = touchUser(tid, '自检阿伟', 'chat')
  const okNew = p1.isNew === true && p3.isNew === false
  // 送礼那一次的 visits 还不含后面的聊天，所以 3 次要看 p3
  const okGift = p2.gift === 1 && p2.visits === 2 && p3.visits === 3
  const one = users.get(tid) || {}
  const okRec = Array.isArray(one.gifts) && one.gifts.length === 1 && one.gifts[0].name === '小心心'
  const found = listUsers({ q: '自检阿伟' }).users.some((x) => x.uid === tid)
  console.log(`  ${okNew ? '✓' : '✗'} isNew：第一次 ${p1.isNew}，第二次 ${p3.isNew}（应为 true / false）`)
  console.log(
    `  ${okGift ? '✓' : '✗'} 计数：送礼 ${p2.gift} 次，送礼时互动 ${p2.visits}，之后 ${p3.visits}（应为 1 / 2 / 3）`
  )
  console.log(`  ${okRec ? '✓' : '✗'} 送礼记录：${JSON.stringify(one.gifts || [])}`)
  console.log(`  ${found ? '✓' : '✗'} 按昵称搜索：${found ? '找得到' : '找不到'}`)
  users.delete(tid)
  saveUsersSoon(true)
  if (!okNew || !okGift || !okRec || !found) bad++

  process.exit(bad ? 1 : 0)
}

/* ------------------------------------------------ 认房间 / 待机重试（2026-10-27） */
/* 一次「认领房间」= 解析出 web_rid → 起 MCP → 停旧监听 → 起新监听 → 起轮询。
 * 抽成函数是因为它现在有四个调用方：启动、/room/set、/room/refresh、待机重试。 */
const IDLE_RETRY = Number(process.env.ZY_ROOM_RETRY || 30000)
let LISTEN_OK = false // 监听是不是真的起着（false ⇒ 待机，重试会接着来）
let pollStarted = false
let liveWatchStarted = false
let idleTimer = null
let idleMediaStarted = false
let idleMediaTimer = null
let attachBusy = false

function ensureLoops() {
  if (!pollStarted) {
    pollStarted = true
    startPolling()
  }
  if (!liveWatchStarted) {
    liveWatchStarted = true
    startLiveWatch()
  }
  /* 闲时播放：5 秒看一次「场子是不是冷了」。判据全在 maybeIdleMedia 里，
   * 这里只是个便宜的闹钟 —— 不满足条件会立刻 return，不碰盘不碰网。 */
  if (!idleMediaStarted) {
    idleMediaStarted = true
    idleMediaTimer = setInterval(() => {
      try {
        maybeIdleMedia()
      } catch (e) {
        log('  🖥 闲时播放出错：', (e && e.message) || e)
      }
    }, 5000)
    idleMediaTimer.unref?.()
  }
}

/** 错误信息压成一行 —— 面板上是一小块提示框，带换行会撑成三行（MCP 的报错就带换行）。 */
const whyText = (e) => String((e && e.message) || e || '').replace(/\s+/g, ' ').trim().slice(0, 160)

async function attachRoom(input, { quiet = false, force = false } = {}) {
  const target = extractTarget(input) || String(input || '').trim()
  if (!target) {
    IDLE_WHY = '没给房间号'
    return { ok: false, error: IDLE_WHY }
  }
  /* 先记住用户给的这坨东西 —— 解析失败也要记住，待机重试靠它。
   * （分享链接在开播前常常查不到房间，等开播后才查得到。） */
  ROOM_TARGET = target
  let room
  try {
    room = await resolveRoom(target)
  } catch (e) {
    IDLE_WHY = whyText(e)
    /* 🔴 必须把 RID 清掉。留着 19 位 room_id 去 start_live_listen，
     *    上游会回「已启动」然后一条事件都不给 —— 比直接失败更难查。 */
    RID = ''
    LISTEN_OK = false
    if (!quiet) log('房间解析失败：', IDLE_WHY)
    return { ok: false, error: IDLE_WHY }
  }

  const changed = room.webRid !== RID
  RID = room.webRid
  ROOM_OWNER = room.nickname || ROOM_OWNER || ''
  IDLE_WHY = ''
  const tag = room.live === true ? '正在直播' : room.live === false ? '这场已经结束' : '状态未知'
  log(`房间解析：${room.nickname || '(没拿到昵称)'}  web_rid=${room.webRid}  ${tag}`)
  if (room.roomId) log(`  room_id ${room.roomId}`)
  if (room.live === false) log('  ⚠ 现在没在播。监听先挂着，开播后自动恢复。')

  try {
    await mcpReady()
  } catch (e) {
    IDLE_WHY = 'MCP 起不来：' + whyText(e)
    LISTEN_OK = false
    log('⚠ ' + IDLE_WHY)
    return { ok: false, error: IDLE_WHY, webRid: RID }
  }
  /* 🔴 同一个房间 + 监听还活着 ⇒ 什么都不做。
   * 原来这里不管三七二十一都 stop_live_listen + start_live_listen，而上游的
   * 事件数组会跟着重置、再把最近十几条历史吐一遍 —— 主人点一下「连上这个
   * 房间」（房间根本没换）就触发一次回放，AI 把旧弹幕又回了一遍。
   * 要强制重来走 /room/refresh（它传 force:true）。 */
  if (!changed && LISTEN_OK && !force) {
    log('房间没变、监听还在 —— 不重听（重听会让上游把历史弹幕再吐一遍）')
    ensureLoops()
    return {
      ok: true,
      webRid: RID,
      nickname: ROOM_OWNER,
      live: room.live,
      roomId: room.roomId,
      reused: true,
    }
  }
  if (changed) {
    // 换房间：旧监听必须先停，否则 start_live_listen 会回「已在运行」并继续收旧房间
    await mcp.call('stop_live_listen').catch(() => {})
    await sleep(400)
    cursor = null // 换房间 = 重新建基线，别把新房间已有的弹幕当新的回
    LIVE.status = 'unknown'
    LIVE.checkedAt = 0
  }
  try {
    await mcp.call('start_live_listen', { web_rid: RID })
    log('监听已启动')
    LISTEN_OK = true
  } catch (e) {
    const m = String(e?.message || e)
    if (m.includes('已在运行')) {
      log('之前有残留监听，先停掉再起')
      await mcp.call('stop_live_listen').catch(() => {})
      await sleep(600)
      try {
        await mcp.call('start_live_listen', { web_rid: RID })
        log('监听已启动')
        LISTEN_OK = true
      } catch (e2) {
        IDLE_WHY = '监听没起来：' + whyText(e2)
        LISTEN_OK = false
        log('⚠ ' + IDLE_WHY)
      }
    } else {
      IDLE_WHY = '监听没起来：' + whyText(m)
      LISTEN_OK = false
      log('⚠ ' + IDLE_WHY)
    }
  }
  ensureLoops()
  return {
    ok: LISTEN_OK,
    webRid: RID,
    nickname: ROOM_OWNER,
    live: room.live,
    roomId: room.roomId,
    error: LISTEN_OK ? '' : IDLE_WHY,
  }
}

/** 待机重试：没房间 / 监听没起来时，每 30 秒拿上次那坨东西再认一次。
 *  开播前后 reflow 的返回不一样（没开播常常查不到房间），所以重试是必须的。 */
function startIdleWatch() {
  if (idleTimer) return
  idleTimer = setInterval(async () => {
    if (attachBusy) return
    if (!ROOM_TARGET) return
    if (RID && LISTEN_OK) return
    attachBusy = true
    try {
      const r = await attachRoom(ROOM_TARGET, { quiet: true })
      if (r.ok) log(`  [room] 接上了：web_rid=${r.webRid}${r.live === true ? '（正在直播）' : ''}`)
    } catch (e) {
      IDLE_WHY = whyText(e)
    } finally {
      attachBusy = false
    }
  }, IDLE_RETRY)
  idleTimer.unref?.()
}

/* ---------------------------------------------------------------- 主流程 */
// 端口被占是最常见的「双击了两次」——别抛一堆栈把人吓到
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`端口 ${HTTP_PORT} 已经被占用，多半是已经有一个弹幕桥在跑了。`)
    log(`直接用浏览器开 http://127.0.0.1:${HTTP_PORT}/ 就行。`)
    log('要重开的话，先把那个还开着的黑窗口关掉。')
    process.exit(0)
  }
  throw e
})

async function main() {
  // 回复引擎先自报家门：配了 key 不等于能用，探一次比事后猜「她怎么说话变呆了」强
  log(`回复模式：${REPLY_ON ? replyMode : '关掉了（--no-reply）'}`)
  log(`语音：${TTS_ON ? `${TTS_VOICE} ${TTS_RATE}（edge-tts，缓存命中即 0 延迟）` : '关掉了（--no-tts）'}`)
  log(`音乐：${musicOn
    ? '接管本机 QQ 音乐 / 单身汉播放器（画面显示曲目 + 说话自动闪避）'
    : MUSIC_FORCED_OFF
      ? '关着（起桥参数 --no-music / ZY_MUSIC=0 强制关）'
      : '关着（cache/media.json 里 musicOn=false，DSH 启动页可打开）'}`)

  server.listen(HTTP_PORT, '127.0.0.1', () => {
    log(`叠加层地址 http://127.0.0.1:${HTTP_PORT}/`)
    log(`SSE        http://127.0.0.1:${HTTP_PORT}/events`)
    log(`音乐面板   http://127.0.0.1:${HTTP_PORT}/music.html`)
  })

  // 语音的合成 / 播放都常驻（一条命令 20ms，冷启 python 要 300ms）
  if (TTS_ON) {
    TTS_SVC.start()
    PLAY_SVC.start()
  } else if (DEMO) {
    log('demo 模式默认不出声（想在 demo 里听声音加 --speak）')
  }

  if (musicOn) {
    startMusic()
    // 上一次可能是被强杀的，音乐还压着（甚至 _saved 都丢了、就卡在 3%）——
    // 开局无条件做一次体检，把音量拉回该有的位置。
    setTimeout(() => {
      mediaCmd('reset', {}, 9000).then((r) => {
        if (!r?.ok) return
        if (r.fixed != null) log(`  ♫ 上次音量卡在 ${Math.round((r.wasLow ?? 0) * 100)}%，已拉回 ${Math.round(r.fixed * 100)}%`)
        else if (r.restored != null && r.restored < 0.9) log(`  ♫ 上次没收尾，音乐音量已还原到 ${Math.round(r.restored * 100)}%`)
      })
    }, 1200)
    /* 先问插件、再问 QQ 音乐（见 pollMusicLoop）。1.5 秒一次，
     * 画面每 1.5 秒取一次快照，对得上。 */
    const timer = setInterval(pollMusicLoop, Math.min(MUSIC_POLL, BOX_POLL))
    timer.unref?.()
    if (BOX_ON) {
      boxState().then(async (s) => {
        if (s.ok && s.alive) log(`  音乐：单身汉播放器已连上（${await boxBase()}），点歌走真搜索 + 真队列`)
        else log(`  音乐：插件没就绪（${s.why}）—— 点歌会回落到本机 QQ 音乐`)
      })
    }
  } else {
    log(`音乐：关着（${MUSIC_FORCED_OFF ? '--no-music / ZY_MUSIC=0 强制关，面板打不开' : '面板上关掉的，启动页可以打开'}）`)
  }
  /* 自检无条件挂上：musicOn 关着时它第一行就 return，
   * 这样「关掉再打开」不用重新挂定时器（少一个状态就少一个 bug）。 */
  const musicWd = setInterval(musicWatchdog, WATCH_EVERY)
  musicWd.unref?.()

  if (REPLY_ON && llmConfigured) {
    const p = await probeLLM()
    if (p.ok) log(`  模型自检通过，样例：「${p.sample}」`)
    else log(`  ⚠ 模型探不通，这一轮用本地话术：${p.why}`)
  }

  // 心跳，避免代理/浏览器掐掉空闲连接
  setInterval(() => {
    for (const r of clients) {
      try { r.write(': ping\n\n') } catch {}
    }
  }, 15000)

  if (DEMO) {
    log('demo 模式：不连抖音，造弹幕验证链路')
    demoLoop()
    return
  }

  /* 认房间：认不出来 / 没给，都只是「待机」，不是失败。
   * 以前这里解析失败就 return —— 进程活着但 RID 是空的，开播后还得人来重启。 */
  if (TARGET && TARGET !== String(RID_RAW || SHARE || POSITIONAL).trim()) {
    log(`从粘贴内容里认出：${TARGET}`)
  }
  if (TARGET) {
    const r = await attachRoom(TARGET, { quiet: true })
    if (!r.ok) {
      log(`⚠ 房间没认出来（${r.error}）`)
      log(`  先进待机，每 ${Math.round(IDLE_RETRY / 1000)} 秒再试一次 —— 开播后自己就接上了。`)
    }
  } else {
    log('没给房间号 —— 进待机（登录、礼物、媒体照常可用，粘个房间号就开连）')
  }
  startIdleWatch()

  if (!RID || !LISTEN_OK) {
    log('  桥的 HTTP 服务已经起着了（画面能连上），只是还没连上房间 ——')
    log('  面板「抖音直播 → 启动」里粘一次分享链接就行；认出来之后会记住 web_rid，')
    log('  以后不用再粘，开播自动接上。')
    return
  }

  // 上游的坑：start_live_listen 是先返回 success 再在后台建连的，
  // 房间号写错也照样报「已启动」，之后一条事件都没有。这里兜个底。
  // 注意别把阈值设太短：冷清的房间只有「N 在线观众」这条心跳，实测 66 秒一次。
  setTimeout(() => {
    if (stat.total === 0) {
      log('⚠ 75 秒内一条事件都没收到，这个不正常。依次核对：')
      log('   1) https://live.douyin.com/' + RID + ' 能打开吗、是不是正在播')
      log('   2) 房间是不是冷到连在线人数心跳都没有')
      log('   3) node probe-listen.mjs —— 看 MCP 里 get_live_events 是不是空的')
    }
  }, 75000)
}

let exiting = false
async function shutdown() {
  if (exiting) return
  exiting = true
  polling = false
  log('收尾…')
  try {
    await mcp.call('stop_live_listen')
  } catch {}
  if (child) {
    try { child.kill() } catch {}
  }
  // 音乐进程收掉之前先把音量还原，不然下次开播音乐是闷的
  if (mediaProc) {
    try { await mediaCmd('duck', { on: 0 }, 1500) } catch {}
    try { mediaProc.kill() } catch {}
    mediaProc = null
  }
  // 常驻的语音进程也要收掉，不然它们会挂在那儿变成孤儿
  for (const svc of [TTS_SVC, PLAY_SVC]) {
    try { svc.stop() } catch {}
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

/**
 * 只查一次直播状态就退出，**不启动监听**。
 *
 *   node bridge.mjs --probe-live --rid 208717515082
 *
 * 为什么单独做这个：正式桥在跑的时候不能再调 start_live_listen（会把别人的
 * 监听顶掉）。排查「到底认没认出我开播了」用它最安全。
 */
async function probeLive() {
  if (!RID) throw new Error('要给房间号：node bridge.mjs --probe-live --rid 208717515082')
  await ensureMcp()
  await mcp.init()
  const info = await mcp.call('get_live_info', { web_rid: RID })
  const raw = String(info?.room_status ?? '')
  const map = { '0': 'offline · 未开播', '2': 'live · 直播中', '4': 'ended · 已结束' }
  log(`房间  ${info?.room_title || '(无标题)'}`)
  log(`room_id      ${info?.room_id || '-'}`)
  log(`room_status  ${raw}  →  ${map[raw] || 'unknown（不认识这个值，当成未知）'}`)
  log(`主播  ${info?.anchor_id || '-'}`)
  process.exit(0)
}

if (has('probe-live')) {
  probeLive().catch((e) => {
    log('查询失败：', e?.message || e)
    process.exit(1)
  })
} else if (has('selftest')) {
  runSelftest()
} else {
  main().catch((e) => {
    log('启动失败：', e?.message || e)
    process.exit(1)
  })
}
