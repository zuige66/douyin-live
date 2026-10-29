/**
 * 独立音乐播放器服务 —— 替代 DSH 的 dsh-music-huazai。
 *
 * 为什么能替：桥只通过 HTTP 调那个插件（/state /search /bridge/command /auth/status），
 * 桥里有 `DSH_MUSIC_API` 环境变量可以直接指过来，所以**桥一行都不用改**。
 *
 * 分工：
 *   这个服务  —— 队列、取直链、状态账本、命令中转（node，无界面）
 *   player.html —— 真正出声的地方（浏览器 <audio>，跟原插件同一个原理）
 *
 * 🔴 为什么播放必须在浏览器里：桥是 node，没有音频输出。原插件也是靠网页放音，
 *    `clientAlive` 就是那个页面每 2 秒的心跳。所以「DSH 不开就没音乐」的根因不是
 *    播放器写得差，是播放器长在 DSH 里。这里把它搬到自己发的页面上。
 *
 * 状态以**页面回报为准**：页面每 2 秒 POST /client/report 上报真实进度，
 * /state 的 nowPlaying 直接用这份数据 —— 服务端自己编一个进度只会让画面和声音对不上。
 */
import http from 'node:http'
import fs from 'node:fs'
import { search, songUrl, userAccount, cookieSource, lyric, chart } from './netease.mjs'

const PORT = Number(process.env.ZY_MUSIC_PORT || 18083)
const HOST = '127.0.0.1'
/** 页面超过这个时间没上报就认为播放器界面没开（原插件是 8 秒） */
const ALIVE_MS = 8000
/** 命令最多堆这么多，防止页面长期不开时无限增长 */
const MAX_CMD = 200

const S = {
  current: null, // 当前曲目 track
  queue: [], // 待播
  playing: false,
  positionSec: 0,
  durationSec: 0,
  volume: 0.7,
  clientAt: 0,
  /* 浏览器允不允许真出声（自动播放策略）。
   * 跟 clientAt 分开记：页面开着 ≠ 能出声，
   * 混在一起会变成「一切正常但没声音」。 */
  clientUnlocked: false,
  commands: [],
  lastError: '',
  endedAt: 0,
}

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a)
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0))
const alive = () => Date.now() - S.clientAt < ALIVE_MS

function nowPlaying() {
  if (!S.current) return null
  const c = S.current
  return {
    trackId: c.id,
    name: c.name,
    artists: Array.isArray(c.artists) ? c.artists : [String(c.artists || '')],
    album: c.album || '',
    cover: c.cover || '',
    positionSec: Number(S.positionSec) || 0,
    durationSec: Number(S.durationSec) || 0,
    playing: Boolean(S.playing),
    /* 真实待播队列（2026-10-29 加）。桥的 boxState() 读的是 nowPlaying.queue，
     * 以前这里没给 → 桥永远看到空队列 → 点歌台显示的和实际放的对不上。
     * 注意语义：**不含当前这首**，跟桥的 boxQueue 一致。 */
    queue: S.queue.slice(0, 30).map((t) => ({
      id: t.id, name: t.name, artists: t.artists, durationMs: t.durationMs,
    })),
  }
}

function snapshot() {
  return {
    clientAlive: alive(),
    clientUnlocked: Boolean(S.clientUnlocked),
    nowPlaying: nowPlaying(),
    pending: S.commands.length,
    volume: S.volume,
    playing: S.playing,
    queue: S.queue.slice(0, 30).map((t) => ({ id: t.id, name: t.name, artists: t.artists })),
    lastError: S.lastError,
    at: Date.now(),
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 队列与命令
 * ══════════════════════════════════════════════════════════════════════ */

function push(cmd) {
  if (S.commands.length > MAX_CMD) S.commands.splice(0, S.commands.length - MAX_CMD)
  S.commands.push({ ...cmd, _at: Date.now() })
}

/** 切到下一首。队列空了就停 —— 不自己编歌，编出来的观众会以为是串台。 */
function advance(reason) {
  if (!S.queue.length) {
    S.current = null
    S.playing = false
    S.positionSec = 0
    S.durationSec = 0
    push({ type: 'stop' })
    return null
  }
  S.current = S.queue.shift()
  S.playing = true
  S.positionSec = 0
  S.durationSec = Number(S.current.durationMs || 0) / 1000
  push({ type: 'play', track: S.current })
  log(`  ▶ 下一首：${S.current.name}（${reason}）`)
  return S.current
}

/**
 * 桥下发的命令。跟 dsh-music-huazai 的 /bridge/command 语义一致。
 * 注意：这里只改「账本」，真正出声由页面执行 —— 所以每条都要 push 给页面。
 */
function applyCommand(cmd) {
  const type = String(cmd?.type || '')
  switch (type) {
    case 'play': {
      const t = cmd.track
      if (!t || !t.id) return { ok: false, why: 'play 缺少 track' }
      S.current = t
      S.playing = true
      S.positionSec = 0
      S.durationSec = Number(t.durationMs || 0) / 1000
      S.lastError = ''
      push({ type: 'play', track: t })
      log(`  ▶ 播放：${t.name} - ${(t.artists || []).join('/')}`)
      return { ok: true }
    }
    case 'queue_add': {
      const list = Array.isArray(cmd.tracks) ? cmd.tracks : cmd.track ? [cmd.track] : []
      S.queue.push(...list)
      push({ type: 'queue', queue: S.queue.slice(0, 30) })
      return { ok: true, queued: list.length, total: S.queue.length }
    }
    case 'queue_next': {
      /* 插到 offset 处（点歌插队）。offset 越界就追加，别丢歌。 */
      const list = Array.isArray(cmd.tracks) ? cmd.tracks : cmd.track ? [cmd.track] : []
      const at = Math.max(0, Math.min(Number(cmd.offset) || 0, S.queue.length))
      S.queue.splice(at, 0, ...list)
      push({ type: 'queue', queue: S.queue.slice(0, 30) })
      return { ok: true, queued: list.length, at, total: S.queue.length }
    }
    case 'next': {
      advance('桥发的 next')
      return { ok: true }
    }
    case 'prev': {
      /* 没有播放历史栈，prev 退化成「把当前塞回队首再从头来」——比什么都不做强 */
      if (S.current) {
        S.queue.unshift(S.current)
        advance('桥发的 prev')
      }
      return { ok: true }
    }
    case 'pause': {
      S.playing = false
      push({ type: 'pause' })
      return { ok: true }
    }
    case 'resume': {
      S.playing = true
      push({ type: 'resume' })
      return { ok: true }
    }
    case 'volume': {
      S.volume = clamp01(cmd.value)
      push({ type: 'volume', value: S.volume })
      return { ok: true, volume: S.volume }
    }
    /* 清空当前 + 队列，真停下来（2026-10-29 加）。
     * 以前只有 advance() 在队列放空时自己 push 一条 stop，
     * 外部想让音乐停（切歌源、紧急静音）没有办法，只能关整个播放器服务。 */
    case 'stop': {
      S.current = null
      S.queue = []
      S.playing = false
      S.positionSec = 0
      S.durationSec = 0
      push({ type: 'stop' })
      log('  ■ 停止播放（清空队列）')
      return { ok: true }
    }
    default:
      return { ok: false, why: `不认识的命令 ${type}` }
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * HTTP
 * ══════════════════════════════════════════════════════════════════════ */

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        return resolve({})
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const p = url.pathname.replace(/\/+$/, '') || '/'

  try {
    /* 🔴 CORS 预检：控制台（:18082）里的 <audio> 逻辑要跨源调这里的 POST，
     * 带 content-type: application/json 就会先发 OPTIONS。
     * 不处理的话命令和进度上报全部发不出去，症状是「点了没反应、也不报错」。 */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      })
      return res.end()
    }

    /* 播放页由这里直接发 —— 单独起 musicd 也能测，不用等控制台接进来 */
    if (req.method === 'GET' && (p === '/player' || p === '/player.html')) {
      try {
        const html = fs.readFileSync(new URL('./player.html', import.meta.url), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(html)
      } catch (e) {
        return json(res, 500, { ok: false, why: '读不到 player.html：' + (e?.message || e) })
      }
    }

    if (p === '/' || p === '/health') {
      return json(res, 200, { ok: true, ...snapshot(), auth: cookieSource() })
    }

    /* ── 桥用的接口（跟 dsh-music-huazai 完全一致）──────────────── */
    if (p === '/state') return json(res, 200, snapshot())

    if (p === '/search') {
      const kw = url.searchParams.get('keyword') || url.searchParams.get('keywords') || ''
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 10))
      const tracks = await search(kw, limit)
      return json(res, 200, { tracks, keyword: kw })
    }

    /* 榜单 —— 桥的「热榜垫歌」用这个接口补歌（空闲时自己放）。
     * 缺了它，没人的时候就永远静着。 */
    if (p === '/chart') {
      const id = url.searchParams.get('id') || '3778678'
      const limit = Number(url.searchParams.get('limit')) || 50
      try {
        const tracks = await chart(id, limit)
        if (!tracks.length) {
          return json(res, 200, { ok: false, why: '榜单拉不到（登录态过期？试试重新登录网易云）', tracks: [] })
        }
        return json(res, 200, { ok: true, id, tracks })
      } catch (e) {
        return json(res, 200, { ok: false, why: '榜单请求出错：' + String((e && e.message) || e).slice(0, 120), tracks: [] })
      }
    }

    if (p === '/url') {
      const id = url.searchParams.get('id') || ''
      const quality = url.searchParams.get('quality') || 'exhigh'
      const r = await songUrl(id, quality)
      if (!r.url) S.lastError = r.why || '取不到直链'
      /* 🔴 必须同时给两种形状（2026-10-29 修）：
       * 桥读的是 dsh-music-huazai 的 `{ok, result:{url, trial}}`，
       * 我们原来只回扁平的 `{url, trial}` → 桥那边 `u.result` 恒 undefined
       * → 一律判「取不到音源」。表现就是：
       *   · 观众点歌「晴天」「颜色」全回「找到是找到了，但这首放不出来」
       *   · 热榜垫歌一首也垫不上（预检永远失败）
       * 而直接 curl /url 看是有 url 的，所以特别容易误判成「网络问题」。
       * 扁平那层留着，别的地方已经在用了。 */
      return json(res, 200, {
        ok: Boolean(r.url),
        ...r,
        result: { url: r.url || '', level: r.level || '', trial: Boolean(r.trial), code: r.code },
      })
    }

    if (p === '/lyric') {
      const id = url.searchParams.get('id') || ''
      return json(res, 200, await lyric(id))
    }

    if (p === '/auth/status') {
      const src = cookieSource()
      if (!src.ok) return json(res, 200, { providers: [{ provider: 'netease', loggedIn: false }], why: src.why })
      const a = await userAccount()
      return json(res, 200, {
        providers: [
          {
            provider: 'netease',
            loggedIn: a.loggedIn,
            nickname: a.nickname,
            avatar: a.avatar,
            vipLabel: a.vipType >= 11 ? 'SVIP' : a.vipType > 0 ? 'VIP' : '无VIP',
          },
        ],
        file: src.file,
      })
    }

    if (p === '/bridge/command' && req.method === 'POST') {
      const cmd = await readBody(req)
      const r = applyCommand(cmd)
      return json(res, 200, { ok: r.ok !== false, queued: true, pending: S.commands.length, ...r })
    }

    /* ── 播放页用的接口 ─────────────────────────────────────────── */
    if (p === '/client/poll') {
      /* 页面来取命令：取走并清空。同时把 volume / 当前曲目一起带回去，
       * 页面刷新后不用额外请求就能接上。
       *
       * 🔴 这里必须打 clientAt 心跳（2026-10-29 修）。
       *    原来只有 /client/report 打心跳，而面板「没在放歌就不报进度」——
       *    于是**空闲时 clientAt 永远是 0**，桥判定「播放器界面没开」，
       *    观众点歌直接回「播放器关着呢」。页面明明开着也没用。
       *    poll 是每 1 秒无条件发的，用它当心跳才对得上「界面在不在」。 */
      S.clientAt = Date.now()
      const q = url.searchParams
      if (q.has('unlocked')) S.clientUnlocked = q.get('unlocked') === '1'
      const cmds = S.commands.splice(0, S.commands.length)
      return json(res, 200, { commands: cmds, volume: S.volume, nowPlaying: nowPlaying() })
    }

    if (p === '/client/report' && req.method === 'POST') {
      const b = await readBody(req)
      S.clientAt = Date.now()
      if (b.playing) S.clientUnlocked = true
      if (b.trackId && S.current && String(b.trackId) === String(S.current.id)) {
        S.positionSec = Number(b.positionSec) || 0
        S.durationSec = Number(b.durationSec) || S.durationSec
        S.playing = Boolean(b.playing)
      } else if (b.trackId && (!S.current || String(b.trackId) !== String(S.current.id))) {
        /* 页面在放别的（刷新后接上旧歌）—— 以页面为准，别把账本和声音拆开 */
        S.positionSec = Number(b.positionSec) || 0
        S.durationSec = Number(b.durationSec) || 0
        S.playing = Boolean(b.playing)
      }
      return json(res, 200, { ok: true, pending: S.commands.length })
    }

    if (p === '/client/ended' && req.method === 'POST') {
      const b = await readBody(req)
      S.clientAt = Date.now()
      S.endedAt = Date.now()
      const next = advance(`页面报告播完${b?.trackId ? ' ' + b.trackId : ''}`)
      return json(res, 200, { ok: true, next, commands: S.commands.splice(0, S.commands.length) })
    }

    if (p === '/client/error' && req.method === 'POST') {
      const b = await readBody(req)
      S.lastError = String(b.why || '播放出错').slice(0, 200)
      S.playing = false
      log(`  ⚠ 页面报错：${S.lastError}`)
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { ok: false, why: `没有这个接口：${p}` })
  } catch (e) {
    S.lastError = String(e?.message || e).slice(0, 200)
    log('  ✗ 处理失败：', S.lastError)
    return json(res, 500, { ok: false, why: S.lastError })
  }
})

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用 —— 可能已经有一个播放器服务在跑。`)
    process.exit(1)
  }
  console.error('播放器服务起不来：', e)
  process.exit(1)
})

server.listen(PORT, HOST, async () => {
  const src = cookieSource()
  log(`播放器服务 http://${HOST}:${PORT}/   （player.html 是出声的地方）`)
  if (!src.ok) log(`  ⚠ ${src.why}`)
  else log(`  网易云登录态：${src.file}`)
  try {
    const a = await userAccount()
    log(`  账号：${a.nickname || '(未登录)'}  vipType=${a.vipType}`)
  } catch (e) {
    log(`  账号查询失败：${e?.message || e}`)
  }
})
