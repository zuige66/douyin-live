#!/usr/bin/env node
/**
 * server.mjs —— 直播控制台（单项目版）
 * ============================================================================
 * 这个文件解决的问题：**网页以前打不开，是因为网页是桥发的。**
 *
 *   旧架构：DSH 宿主 spawn 桥 → 桥 :18081 发 settings.html → 浏览器才能打开
 *           ⇒ 桥没跑 = 网页打不开 = 想启动桥又必须先打开网页 = 死循环
 *           ⇒ 「启动 / 停止 / 重启」只能长在 DSH 面板上
 *
 *   新架构：server.mjs :18082 常驻，它自己发静态页，自己管桥的启停，
 *           其余请求原样代理给桥 :18081
 *           ⇒ 桥死了网页照样能开，页面上点「开播」就能把桥拉起来
 *           ⇒ 不再需要 DSH，一个仓库跑一个进程就是完整控制台
 *
 * 三个进程的分工（跟以前一样，只是"谁拉起谁"变了）：
 *   server.mjs           node 起，127.0.0.1:18082，发网页 + 管启停 + 反向代理
 *   bridge.mjs           node 起，127.0.0.1:18081，连 douyin-mcp 收弹幕、回话
 *   native/overlay.py    python 起，1920×1080 原生窗口，直播伴侣「窗口捕捉」抓它
 *   douyin-mcp.exe       由 bridge 自己拉起（端口 18080），这里不用管
 *
 * 🔴 判断「桥在不在」永远靠 /healthz，不许靠查进程 ——
 *    进程在但连不上房间（待机）和进程根本不在，是两种完全不同的故障。
 * 🔴 判断「画面在不在」也靠桥的 overlayAgeMs（画面每 0.4 秒拉一次 /state.json），
 *    进程活着但拉不到数据 = 画面是死的，屏幕上一片空白。
 * ============================================================================
 */
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const RUN = path.join(DIR, '.run')
const CFG_FILE = path.join(RUN, 'panel.json')
const PID_FILE = path.join(RUN, 'pids.json')
const BRIDGE_PORT = 18081
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`
const PORT = Number(process.env.ZY_CTL_PORT || 18082)
/* 音乐播放器服务（player/musicd.mjs）。桥通过 DSH_MUSIC_API 指过来，
 * 所以桥那边一行都不用改 —— 它本来就把播放器当成一个 HTTP 服务。 */
const MUSIC_PORT = Number(process.env.ZY_MUSIC_PORT || 18083)
const MUSIC = `http://127.0.0.1:${MUSIC_PORT}`

/* ══════════════════════════════════════════════════════════════════════
 * 配置与 pid
 * ══════════════════════════════════════════════════════════════════════ */

const DEFAULTS = {
  /* 房间。存 web_rid（12 位主播号）而不是分享链接 ——
   * 分享链接那串 room_id 下播就失效，重起桥时解析不出来。 */
  room: '',
  mode: 'flash',
  /* python 命令。有人机器上是 py / python3 / 绝对路径。 */
  python: 'python',
  /* 两条聊天之间隔几秒（桥收毫秒） */
  chatGap: 2.5,
}

const readJson = (file, fallback) => {
  try {
    return { ...fallback, ...(JSON.parse(fs.readFileSync(file, 'utf8')) || {}) }
  } catch {
    return { ...fallback }
  }
}

/** 原子写：先写 .tmp 再 rename。半截文件读起来会变成「配置全丢」，比写失败更难查。 */
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

const cfg = () => readJson(CFG_FILE, DEFAULTS)
const saveCfg = (patch) => {
  const next = { ...cfg(), ...patch }
  writeJson(CFG_FILE, next)
  return next
}
const readPids = () => readJson(PID_FILE, { bridgePid: 0, overlayPid: 0 })
const writePids = (o) => writeJson(PID_FILE, { ...readPids(), ...o })

const gapSec = () => {
  const v = Number(cfg().chatGap)
  if (!Number.isFinite(v)) return 2.5
  return Math.min(15, Math.max(0.5, v))
}

/* ══════════════════════════════════════════════════════════════════════
 * 进程小工具
 * ══════════════════════════════════════════════════════════════════════ */

const log = (...a) => {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${a.join(' ')}`
  console.log(line)
}

const alive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const killTree = (pid) => {
  if (!pid) return false
  try {
    // /T 连子进程一起（bridge 会自己拉起 douyin-mcp.exe）
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** 从端口反查 pid —— 手工 start.cmd 起的桥不在 pids.json 里，全靠这个兜底 */
const pidOnPort = (port) => {
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || ''
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue
      const cols = line.trim().split(/\s+/)
      const pid = Number(cols[cols.length - 1])
      if (pid > 0 && pid !== process.pid) return pid
    }
  } catch {}
  return 0
}

const spawnDetached = (cmd, args, { tag, env } = {}) => {
  fs.mkdirSync(RUN, { recursive: true })
  const logFile = path.join(RUN, `${tag}.log`)
  const fd = fs.openSync(logFile, 'a')
  const child = spawn(cmd, args, {
    cwd: DIR,
    env: { ...process.env, ...env },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  /* 父进程这份 fd 必须自己关掉，不然每起一次就漏一个句柄 */
  fs.closeSync(fd)
  return { pid: child.pid, logFile }
}

/* ══════════════════════════════════════════════════════════════════════
 * python 解释器探测
 *
 * 🔴 为什么非要有这一步：画面 native/render.py 第 24 行就 `from PIL import ...`，
 *    解释器没有 Pillow 就秒退，页面上只剩一句 ModuleNotFoundError。
 *    而 Windows 上 `python` 到底指哪个，取决于「启动控制台的那个 cmd」的 PATH ——
 *    实测同一台机器：从 Git Bash 里 `python` 是 3.13（有 Pillow 13.0.0），
 *    从 start.cmd 的 cmd 里却是 D:\download\python3.12.10（没有 Pillow）。
 *    ⇒ 不能信命令名，必须真的 `import PIL` 跑一次。
 * ══════════════════════════════════════════════════════════════════════ */

const PY_CACHE = { stamp: null, pick: null }

const pyHasPillow = (cmd, args = []) => {
  try {
    const r = spawnSync(cmd, [...args, '-c', 'import PIL'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    })
    return r.status === 0
  } catch {
    return false
  }
}

/** 候选：配置里那个 → PATH 里的 python / python3 → py -3 → 常见安装位置（扫目录，不写死版本） */
const pythonCandidates = () => {
  const out = []
  const add = (cmd, args = []) => {
    const c = String(cmd || '').trim()
    if (!c) return
    if (out.some((x) => x.cmd === c && x.args.join(' ') === args.join(' '))) return
    out.push({ cmd: c, args })
  }
  add(cfg().python)
  add('python')
  add('python3')
  add('py', ['-3'])
  const roots = [
    path.join(process.env.USERPROFILE || '', '.workbuddy-ai', 'binaries', 'python', 'versions'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'),
    'C:\\Python313',
    'C:\\Python312',
    'C:\\Python311',
  ]
  for (const root of roots) {
    try {
      for (const d of fs.readdirSync(root)) {
        const exe = path.join(root, d, 'python.exe')
        if (fs.existsSync(exe)) add(exe)
      }
    } catch {}
  }
  return out
}

/** 挑一个能 import PIL 的 python。按 panel.json 的 mtime 缓存，改配置立刻生效。 */
const pickPython = () => {
  let stamp = 'none'
  try {
    stamp = String(fs.statSync(CFG_FILE).mtimeMs)
  } catch {}
  if (PY_CACHE.pick && PY_CACHE.stamp === stamp) return PY_CACHE.pick

  const tried = []
  for (const c of pythonCandidates()) {
    const label = c.cmd + (c.args.length ? ' ' + c.args.join(' ') : '')
    const ok = pyHasPillow(c.cmd, c.args)
    tried.push(`${label} ${ok ? '✓' : '✗ 没有 Pillow'}`)
    if (ok) {
      PY_CACHE.stamp = stamp
      PY_CACHE.pick = { ok: true, cmd: c.cmd, args: c.args, tried }
      return PY_CACHE.pick
    }
  }
  PY_CACHE.stamp = stamp
  PY_CACHE.pick = {
    ok: false,
    cmd: '',
    args: [],
    tried,
    error:
      '找不到装了 Pillow 的 python，画面起不来（native/render.py 需要 PIL）。试过：\n' +
      tried.map((t) => '  ' + t).join('\n') +
      '\n在能用的那个 python 上装一次：<python> -m pip install Pillow',
  }
  return PY_CACHE.pick
}

/* ══════════════════════════════════════════════════════════════════════
 * 音乐播放器服务
 *
 * 为什么要有：原来播放器是 DSH 的插件（dsh-music-huazai），DSH 不开就没音乐。
 * 现在换成 player/musicd.mjs —— 同样是「HTTP 服务 + 浏览器页面出声」的模型，
 * 但页面由我们自己发，所以不再依赖 DSH。
 * ══════════════════════════════════════════════════════════════════════ */

async function musicAlive() {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 1200)
  try {
    const res = await fetch(`${MUSIC}/health`, { signal: ctl.signal })
    if (!res.ok) return false
    const j = await res.json()
    return Boolean(j && j.ok)
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/** 起播放器服务。已经在跑就不动（它是无状态的，重启会丢当前队列）。 */
async function musicEnsure() {
  if (await musicAlive()) return { ok: true, already: true, message: '播放器服务已经在跑' }
  const entry = path.join(DIR, 'player', 'musicd.mjs')
  if (!fs.existsSync(entry)) return { ok: false, error: `找不到 ${entry}` }
  let spawned
  try {
    spawned = spawnDetached(process.execPath, [entry], { tag: 'musicd' })
  } catch (e) {
    return { ok: false, error: `起不来：${e?.message ?? e}` }
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200))
    if (await musicAlive()) {
      writePids({ musicPid: spawned.pid })
      return { ok: true, pid: spawned.pid, message: '播放器服务起来了' }
    }
    if (!alive(spawned.pid)) break
  }
  const tail = tailOf(spawned.logFile)
  return {
    ok: false,
    error: '播放器服务没起来' + (tail ? '：' + tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' / ') : ''),
    log: spawned.logFile,
  }
}

/** 播放器服务的状态快照（桥的 /media 里有音乐，这里给页面用的精简版） */
async function musicState() {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 1500)
  try {
    const res = await fetch(`${MUSIC}/health`, { signal: ctl.signal })
    if (!res.ok) return { up: false }
    const j = await res.json()
    return {
      up: true,
      clientAlive: Boolean(j.clientAlive),
      /* 页面开着 ≠ 浏览器肯出声（自动播放策略）。分开报，
       * 不然「一切正常但没声音」只能靠人猜。 */
      clientUnlocked: Boolean(j.clientUnlocked),
      now: j.nowPlaying || null,
      pending: Number(j.pending) || 0,
      queue: Array.isArray(j.queue) ? j.queue.slice(0, 5) : [],
      lastError: String(j.lastError || ''),
      auth: j.auth || null,
      url: `http://127.0.0.1:${MUSIC_PORT}/player.html`,
    }
  } catch {
    return { up: false }
  } finally {
    clearTimeout(t)
  }
}

/** 读日志最后几行 —— 进程秒退时把真原因捞出来，别只回一句"起不来" */
const tailOf = (file, bytes = 8192) => {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.max(0, size - bytes)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 桥
 * ══════════════════════════════════════════════════════════════════════ */

/** 桥在不在、活得怎么样（1.5 秒超时，桥没起就快速失败） */
async function probe() {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 1500)
  try {
    const res = await fetch(`${BRIDGE}/healthz`, { signal: ctl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * 起桥。
 *
 * 🔴 起完不能立刻说 ok。实测两种秒退：端口被占、douyin-mcp 拉不起来。
 *    旧版直接回 ok:true ⇒ 页面绿灯、屏幕上什么都没有，最难查。
 *    这里轮询 /healthz 最多 8 秒，等不到就把日志尾巴当错误回上去。
 *
 * @param {{room?:string, mode?:string, demo?:boolean, withOverlay?:boolean}} o
 */
async function start(o = {}) {
  const already = await probe()
  if (already && already.ok) {
    const ov = o.withOverlay === false ? null : await overlayStart()
    return {
      ok: true,
      already: true,
      idle: Boolean(already.idle),
      rid: already.rid || '',
      overlay: ov,
      message:
        '桥已经在跑了' +
        (already.idle ? '（待机：还没连上房间）' : '') +
        (ov && ov.message ? `；${ov.message}` : ''),
    }
  }

  const raw = String(o.room != null ? o.room : cfg().room || '').trim()
  const room = pickRoom(raw) || raw
  const mode = String(o.mode || cfg().mode || 'flash').toLowerCase()
  const args = [path.join(DIR, 'bridge.mjs')]
  /* 有房间就 --rid；没有就待机（不带 --demo）。
   * 待机是有用的状态：登录、礼物、媒体都能先配好，粘个房间号就开连。 */
  if (room) args.push('--rid', room)
  else if (o.demo === true) args.push('--demo')

  let spawned
  try {
    /* 播放器活着就把桥直接指过去 —— 桥见到 DSH_MUSIC_API 就跳过「扫 DSH 端口」
     * 那一整套，点歌/热榜/闪避全走 player/musicd.mjs。
     * 没起来就什么都不设，桥自己回落到本机 QQ 音乐（跟以前一样，不会更差）。 */
    const musicUp = await musicAlive()
    spawned = spawnDetached(process.execPath, args, {
      tag: 'bridge',
      env: {
        REPLY_MODE: mode,
        REPLY_CHAT_GAP: String(Math.round(gapSec() * 1000)),
        ...(musicUp ? { DSH_MUSIC_API: MUSIC } : {}),
      },
    })
  } catch (e) {
    return { ok: false, error: `起不来：${e?.message ?? e}` }
  }

  writePids({ bridgePid: spawned.pid, startedAt: Date.now() })

  /* 等它真的 listen —— 8 秒，200ms 一次 */
  let h = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200))
    h = await probe()
    if (h && h.ok) break
    if (!alive(spawned.pid)) break
  }

  if (!h || !h.ok) {
    const dead = !alive(spawned.pid)
    writePids({ bridgePid: 0 })
    const tail = tailOf(spawned.logFile)
    const why = tail ? tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' / ') : ''
    log(`起桥失败 dead=${dead} ${why}`)
    return {
      ok: false,
      error: dead
        ? `桥起来就退了${why ? '：' + why : '，日志里没写原因'}`
        : `桥进程在，但 8 秒内没响应 /healthz${why ? '：' + why : ''}`,
      log: spawned.logFile,
    }
  }

  const rid = String(h.rid || '')
  /* web_rid 是主播号，跨场次不变 —— 记住它，下次开播不用再粘分享链接 */
  if (rid && rid !== cfg().room) {
    saveCfg({ room: rid })
    log(`记住 web_rid=${rid}`)
  }

  const ov = o.withOverlay === false ? null : await overlayStart()
  log(`桥已起 pid=${spawned.pid} room=${rid || room || '待机'} mode=${mode}`)

  return {
    ok: true,
    pid: spawned.pid,
    rid,
    idle: Boolean(h.idle),
    overlay: ov,
    log: spawned.logFile,
    message:
      (rid
        ? `桥起来了，已连上房间 ${rid}`
        : room
          ? `桥起来了，「${String(raw).slice(0, 24)}」还没认出来 —— 先进待机，开播后自动接上`
          : o.demo === true
            ? '桥起来了（demo 模式：假弹幕，不连抖音）'
            : '桥起来了（待机：还没连房间，先把账号登上、礼物配好）') +
      (ov ? `；${ov.ok ? '画面' + (ov.already ? '本来就在' : '也开了') : '画面没起来：' + ov.error}` : ''),
  }
}

/**
 * 停桥之前先把音乐按停（2026-10-29）。
 *
 * 主人原话：「全停之后还有音乐」。桥本身不出声 —— 出声的是 DSH 里的网页播放器
 * （`src=box`）或者本机 QQ 音乐，桥只负责「说话时压低、说完抬回来、点歌切歌」。
 * 桥一死，那段声音就没人管了：一直响、没法闪避、点歌也没人接。所以这一刀必须
 * **赶在 killTree 之前**打，桥死了就再也命令不到播放器。
 *
 * 走 `GET /media?cmd=pause`：桥自己按「现在到底谁在放」分流到 boxCmd / mediaCmd。
 * 关键是它**不写** `cache/media.json` 的 `musicOn` —— 只按一下暂停，
 * 下次开播自检（bridge.mjs 的 musicWatchdog ③）看到「停在暂停上」会自己按继续，
 * 不会变成「下播顺手把音乐总开关关了」。
 *
 * 🔴 只等 1.2 秒：这是「顺手」的一步，不能让它拖慢全停 ——
 *    播放器连不上的时候（DSH 关了、QQ 音乐没开）本来就会超时。
 */
async function pauseMusic() {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 1200)
  try {
    const res = await fetch(`${BRIDGE}/media?cmd=pause`, { signal: ctl.signal })
    if (!res.ok) return false
    const j = await res.json().catch(() => null)
    return Boolean(j && j.ok !== false)
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/**
 * 全停：桥（含它拉起的 douyin-mcp）+ 画面 + 音乐。
 *
 * @param {{keepMusic?: boolean}} o
 *   keepMusic —— 重启时用。重启只是换代码，音乐不该被按停：桥起来后自检虽然会
 *   把暂停按回来，但那要等 15 秒，中间静音一段没必要。
 */
async function stop(o = {}) {
  const pids = readPids()
  const killed = []

  /* 音乐先停 —— 顺序不能换，桥死了就没人能命令播放器了 */
  const musicPaused = o.keepMusic ? false : await pauseMusic()

  let bpid = pids.bridgePid
  /* pids.json 里没有但端口在听 —— 是手工 start.cmd 起的，也得停掉，
   * 不然「点停止没反应」这种事又会发生一次。 */
  if (!alive(bpid)) {
    const onPort = pidOnPort(BRIDGE_PORT)
    if (onPort) bpid = onPort
  }
  if (alive(bpid)) killed.push(`桥 pid=${bpid}`)
  killTree(bpid)

  if (alive(pids.overlayPid)) killed.push(`画面 pid=${pids.overlayPid}`)
  killTree(pids.overlayPid)

  /* 手工双击 open-overlay.cmd 起的窗口不在 pids 里，上面那刀砍不到。
   * 按窗口标题补一刀。
   * ⚠️ taskkill 的 WINDOWTITLE 不支持通配符，只能两个全名各来一次。
   * ⚠️ 也别改成按 IMAGENAME 杀 python.exe —— 会把机器上所有 python 一起带走。 */
  for (const t of ['zuige大肥鱼直播画面', '大肥鱼直播画面']) {
    try {
      spawnSync('taskkill', ['/F', '/FI', `WINDOWTITLE eq ${t}`], { windowsHide: true })
    } catch {}
  }

  writePids({ bridgePid: 0, overlayPid: 0 })

  /* 等端口真的放开再回，不然「停止」之后立刻「启动」会撞端口 */
  for (let i = 0; i < 15; i++) {
    if (!pidOnPort(BRIDGE_PORT)) break
    await new Promise((r) => setTimeout(r, 200))
  }

  log(`已停 ${killed.length ? killed.join(' / ') : '（本来就没在跑）'}${musicPaused ? ' · 音乐已暂停' : ''}`)
  return {
    ok: true,
    musicPaused,
    message:
      (killed.length ? `已停：${killed.join(' / ')}` : '已停（本来就没在跑）') +
      (musicPaused ? ' · 音乐已暂停' : ''),
  }
}

/** 起原生画面窗口（1920×1080，直播伴侣抓它） */
async function overlayStart() {
  const py = path.join(DIR, 'native', 'overlay.py')
  if (!fs.existsSync(py)) return { ok: false, error: `找不到 ${py}` }

  /* 🔴 先问桥「画面有没有在拉数据」，而不是先查 pid。
   *    画面每 0.4 秒拉一次 /state.json，3 秒没拉就是死的。
   *    为什么不查 pid：手工双击 open-overlay.cmd 起的窗口、或者以前 DSH 起的窗口，
   *    pid 都不在 .run/pids.json 里 —— 只查 pid 会以为"没开"，
   *    于是又 spawn 一个，python 那边单实例互斥量秒退，页面上就报一堆假错误。 */
  const h = await probe()
  if (h && h.ok && typeof h.overlayAgeMs === 'number' && h.overlayAgeMs < 3000) {
    return { ok: true, already: true, message: '画面已经在拉数据了' }
  }

  const pids = readPids()
  if (alive(pids.overlayPid)) return { ok: true, already: true, message: '画面窗口已经开着了' }

  /* 🔴 必须是能 import PIL 的那个 —— 见 pickPython() 上面那段注释 */
  const pyPick = pickPython()
  if (!pyPick.ok) return { ok: false, error: pyPick.error }

  let spawned
  try {
    spawned = spawnDetached(pyPick.cmd, [...pyPick.args, py], { tag: 'overlay' })
  } catch (e) {
    return { ok: false, error: `起不来：${e?.message ?? e}` }
  }

  /* 实测：python 那边有单实例互斥量，已经有一个画面在跑时会秒退并打印原因 */
  await new Promise((r) => setTimeout(r, 1200))
  if (!alive(spawned.pid)) {
    writePids({ overlayPid: 0 })
    const tail = tailOf(spawned.logFile)
    const why = tail ? tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' / ') : ''
    return { ok: false, error: `画面起来就退了${why ? '：' + why : '，日志里没写原因'}`, log: spawned.logFile }
  }

  writePids({ overlayPid: spawned.pid })
  log(`画面已起 pid=${spawned.pid}`)
  return {
    ok: true,
    pid: spawned.pid,
    python: pyPick.cmd,
    message: '画面窗口开了（1920×1080，去直播伴侣里抓「zuige大肥鱼直播画面」）',
  }
}

/** 只停画面，不动桥 —— 「重启画面」用，直播中也能安全点。 */
function overlayStop() {
  const pids = readPids()
  const killed = []
  if (alive(pids.overlayPid)) {
    killed.push(`pid=${pids.overlayPid}`)
    killTree(pids.overlayPid)
  }
  /* 不在 pids 里的（手工开的、别处起的）按窗口标题补一刀。
   * ⚠️ taskkill 的 WINDOWTITLE 不支持通配符，只能两个全名各来一次。
   * ⚠️ 别改成按 IMAGENAME 杀 python.exe —— 会把机器上所有 python 一起带走。 */
  for (const t of ['zuige大肥鱼直播画面', '大肥鱼直播画面']) {
    try {
      spawnSync('taskkill', ['/F', '/FI', `WINDOWTITLE eq ${t}`], { windowsHide: true })
    } catch {}
  }
  writePids({ overlayPid: 0 })
  return killed
}

/**
 * 重启画面 = 停 + 起。
 * 🔴 中间必须等桥那边的 overlayAgeMs 变旧，否则 overlayStart 会走
 *    「画面已经在拉数据了」的短路分支直接返回，看着成功其实没重启。
 */
async function overlayRestart() {
  const killed = overlayStop()
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200))
    const h = await probe()
    if (!h || typeof h.overlayAgeMs !== 'number' || h.overlayAgeMs > 3000) break
  }
  const r = await overlayStart()
  return { ...r, stopped: killed.length ? killed.join('、') : '（本来就没开）' }
}

/** 重启播放器服务。队列会丢，但队列本来就是桥在下发，桥会重新垫热榜。 */
async function musicRestart() {
  const pids = readPids()
  const killed = []
  if (alive(pids.musicPid)) {
    killed.push(`pid=${pids.musicPid}`)
    killTree(pids.musicPid)
  }
  const onPort = pidOnPort(MUSIC_PORT)
  if (onPort && onPort !== pids.musicPid) {
    killed.push(`pid=${onPort}`)
    killTree(onPort)
  }
  writePids({ musicPid: 0 })
  await new Promise((r) => setTimeout(r, 600))
  const r = await musicEnsure()
  return { ...r, stopped: killed.length ? killed.join('、') : '（本来就没跑）' }
}

/** 一键全开：音乐 → 桥（桥起来时会自己带上播放器地址）→ 画面 */
async function startAll(o = {}) {
  const m = await musicEnsure()
  const b = await start({ ...o, withOverlay: o.withOverlay !== false })
  return {
    ok: b.ok,
    music: m,
    bridge: b,
    message: b.ok
      ? `全开了：${m.ok ? '播放器在跑' : '播放器没起来'}；${b.message}`
      : `桥没起来：${b.error}`,
  }
}

/** 重启 = 停 + 起。桥在跑时换新代码只能走这条路。
 *  重启不按停音乐（keepMusic），换代码不该顺手静音一段。 */
async function restart(o = {}) {
  const s = await stop({ keepMusic: true })
  const r = await start({ ...o, withOverlay: o.withOverlay !== false })
  return {
    ok: r.ok,
    stopped: s.message,
    ...r,
    message: r.ok ? `重启好了：${r.message}` : `重启失败：${r.error}`,
  }
}

/** 从「用户手上那坨东西」里抠出房间标识。
 *  抖音「分享 → 复制链接」复制的是一整段话，直接传进去桥认不出来。 */
function pickRoom(text) {
  const t = String(text || '').trim()
  if (!t) return ''
  const link = t.match(/https?:\/\/(?:v|live)\.douyin\.com\/[A-Za-z0-9_-]+/i)
  if (link) return link[0]
  const live = t.match(/live\.douyin\.com\/(\d{8,14})/i)
  if (live) return live[1]
  const num = t.match(/\d{8,20}/)
  return num ? num[0] : ''
}

/** 从桥日志里解析「收弹幕 / 说话 / 礼物」三种行，喂给控制台显示。
 *  日志长得像：  23:19:12   💬 zuige大肥鱼：点解点解
 *  这是「她在不在说话」的唯一窗口 —— 后台起的桥没有黑窗口。 */
function parseBridgeLog(text, n = 14) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
    const m = line.match(/^(\d{2}:\d{2}:\d{2})\s+(?:\[[^\]]*\]\s*)*(💬|🗣|🎁)\s*(.*)$/u)
    if (!m) continue
    const kind = m[2] === '🗣' ? 'say' : m[2] === '🎁' ? 'gift' : 'in'
    out.push({ at: m[1], kind, text: m[3].trim() })
  }
  return out.slice(-Math.max(1, n))
}

async function status() {
  const pids = readPids()
  const h = await probe()
  const running = Boolean(h && h.ok)
  const overlayAge = running && typeof h.overlayAgeMs === 'number' ? h.overlayAgeMs : null

  return {
    ok: true,
    dir: DIR,
    ctl: { port: PORT, upSec: Math.round(process.uptime()) },
    bridge: {
      running,
      /* 待机 = 桥在跑但还没连上房间。这两件事以前都显示成绿灯，
       * 看着"在跑"其实一条弹幕都收不到。 */
      idle: running ? Boolean(h.idle) : false,
      idleWhy: running ? String(h.idleWhy || '') : '',
      roomTarget: running ? String(h.roomTarget || '') : '',
      pid: running ? pids.bridgePid || pidOnPort(BRIDGE_PORT) || null : null,
      rid: running ? h.rid || '' : '',
      demo: running ? Boolean(h.demo) : false,
      upSec: running ? h.upSec || 0 : 0,
      chat: running ? (h.stat && h.stat.chat) || 0 : 0,
      gift: running ? (h.stat && h.stat.gift) || 0 : 0,
      replied: running ? (h.stat && h.stat.replied) || 0 : 0,
      online: running ? (h.stat && h.stat.online) || 0 : 0,
      replyMode: running ? h.replyMode || '' : '',
      chatGapSec: running && typeof h.chatGapSec === 'number' ? h.chatGapSec : gapSec(),
      live: running && h.live
        ? {
          status: String(h.live.status || ''),
          text: String(h.live.text || ''),
          paused: Boolean(h.live.paused),
          title: h.live.title || '',
        }
        : null,
      music: running && h.music && typeof h.music === 'object'
        ? { on: Boolean(h.music.on), playing: Boolean(h.music.playing), title: h.music.title || '' }
        : null,
    },
    overlay: {
      /* 只看「有没有在拉数据」：进程在但拉不到数据 = 画面是死的 */
      live: overlayAge !== null && overlayAge < 3000,
      ageMs: overlayAge,
      pid: alive(pids.overlayPid) ? pids.overlayPid : null,
    },
    /* 房间号优先用桥当前真正连着的那个 —— 桥可能是别处起的，
     * 配置里存的和屏幕上跑的不是一回事，页面上要显示"正在用的"。 */
    cfg: {
      room: String((running && h.rid) || cfg().room || ''),
      mode: String(cfg().mode || 'flash'),
      python: String(cfg().python || 'python'),
      /* 探测结果只读缓存，不在这里现跑 —— 这是 2 秒轮询的接口，
       * 现跑 spawnSync 会把页面拖死。没探测过就是 null（还没点过开画面）。 */
      pythonOk: PY_CACHE.pick ? PY_CACHE.pick.ok : null,
      pythonUsed: PY_CACHE.pick && PY_CACHE.pick.ok ? PY_CACHE.pick.cmd : '',
      chatGap: gapSec(),
    },
    /* 音乐播放器（player/musicd.mjs）—— 页面上的「音乐」卡片读这个 */
    music: await musicState(),
    recent: parseBridgeLog(tailOf(path.join(RUN, 'bridge.log'), 128 * 1024), 14),
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * HTTP：静态页 + 控制 API + 反向代理
 * ══════════════════════════════════════════════════════════════════════ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
}

/** 允许直接发的文件类型。
 *  🔴 故意**不含 .json / .txt / .py / .mjs** —— 这个目录里躺着 llm.json（API key）、
 *     cookies.txt（抖音登录态）、bridge.mjs（业务代码）。服务虽然只听 127.0.0.1，
 *     但浏览器里随手敲一下路径就能看到，等于把 key 摆在桌面上。 */
const ALLOW_EXT = new Set([
  '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico',
  '.mp4', '.mp3', '.wav', '.woff2',
])
const DENY_NAME = new Set(['llm.json', 'cookies.txt', 'server.mjs', 'bridge.mjs'])

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 2e6) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/panel.html'
  /* 没有后缀就补 .html —— /settings 也能开 */
  if (!path.extname(rel)) rel += '.html'

  const fp = path.normalize(path.join(DIR, rel))
  /* 防目录穿越：必须还在项目目录里 */
  if (fp !== DIR && !fp.startsWith(DIR + path.sep)) {
    res.writeHead(403).end('403')
    return true
  }

  /* 只发「页面和页面要用的资源」。点开头的目录（.run / .git / .workbuddy-ai）
   * 一律挡掉 —— 里面是日志、pid、登录态。 */
  const segs = rel.split(/[\\/]/).filter(Boolean)
  const ext = path.extname(fp).toLowerCase()
  const base = path.basename(fp).toLowerCase()
  if (segs.some((s) => s.startsWith('.')) || !ALLOW_EXT.has(ext) || DENY_NAME.has(base)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('403 这个文件不给')
    return true
  }

  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return false

  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
  fs.createReadStream(fp).pipe(res)
  return true
}

/** 其余请求原样转给桥。桥没跑就回一个能看懂的 502，别让页面卡在 loading。 */
function proxy(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1')
  const p = http.request(
    {
      host: '127.0.0.1',
      port: BRIDGE_PORT,
      path: u.pathname + u.search,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${BRIDGE_PORT}` },
    },
    (pr) => {
      res.writeHead(pr.statusCode || 502, pr.headers)
      pr.pipe(res)
    },
  )
  p.on('error', () => {
    if (!res.headersSent) {
      json(res, 502, {
        ok: false,
        offline: true,
        error: '桥没在跑 —— 在这个页面点「开播」把它拉起来',
      })
    } else {
      res.end()
    }
  })
  req.pipe(p)
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const p = u.pathname

  /* ── 控制 API ───────────────────────────────────────────────── */
  if (p === '/ctl/status') {
    json(res, 200, await status())
    return
  }
  if (p === '/ctl/start' && req.method === 'POST') {
    json(res, 200, await start(await readBody(req)))
    return
  }
  if (p === '/ctl/stop' && req.method === 'POST') {
    json(res, 200, await stop())
    return
  }
  if (p === '/ctl/restart' && req.method === 'POST') {
    json(res, 200, await restart(await readBody(req)))
    return
  }
  if (p === '/ctl/overlay' && req.method === 'POST') {
    const b = await readBody(req)
    json(res, 200, b.action === 'restart' ? await overlayRestart() : await overlayStart())
    return
  }
  if (p === '/ctl/music' && req.method === 'POST') {
    const b = await readBody(req)
    json(res, 200, b.action === 'restart' ? await musicRestart() : await musicEnsure())
    return
  }
  if (p === '/ctl/all' && req.method === 'POST') {
    json(res, 200, await startAll(await readBody(req)))
    return
  }
  if (p === '/ctl/cfg' && req.method === 'POST') {
    const b = await readBody(req)
    const patch = {}
    if (typeof b.room === 'string') patch.room = pickRoom(b.room) || b.room.trim()
    if (typeof b.mode === 'string' && b.mode) patch.mode = b.mode
    if (typeof b.python === 'string' && b.python) patch.python = b.python
    if (b.chatGap != null && Number.isFinite(Number(b.chatGap))) {
      patch.chatGap = Math.min(15, Math.max(0.5, Number(b.chatGap)))
    }
    json(res, 200, { ok: true, cfg: saveCfg(patch) })
    return
  }
  if (p === '/ctl/log') {
    const n = Math.min(500, Math.max(20, Number(u.searchParams.get('n') || 200)))
    const text = tailOf(path.join(RUN, 'bridge.log'), 256 * 1024)
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-n)
    json(res, 200, { ok: true, lines, recent: parseBridgeLog(text, 14) })
    return
  }

  /* ── 静态页 ─────────────────────────────────────────────────── */
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (serveStatic(res, p)) return
  }

  /* ── 其余全部转给桥 ─────────────────────────────────────────── */
  proxy(req, res)
})

server.listen(PORT, '127.0.0.1', () => {
  log(`控制台 http://127.0.0.1:${PORT}/  （项目目录 ${DIR}）`)
  log(`桥的接口原样代理到 :${BRIDGE_PORT}，桥没跑时页面照样能打开`)
  /* 播放器服务跟着控制台一起起 —— 它挂了不影响弹幕，只影响音乐，
   * 所以失败只记一行日志，绝不拦住控制台本身。 */
  musicEnsure().then((r) => log(r.ok ? `音乐：${r.message}` : `音乐：${r.error}`))
  /* start.cmd 双击时要顺手把浏览器打开 —— 但必须等 listen 之后，
   * 否则浏览器比服务先到，看到的是"无法连接"，主人以为没起来。 */
  if (process.argv.includes('--open')) {
    try {
      spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}/`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
    } catch {}
  }
})

/* 端口被占的时候 node 只会打一行 EADDRINUSE，很容易看漏 —— 说明白点 */
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    /* 双击两次 start.cmd 是最常见的情况，别用报错吓人：
     * 直接把浏览器指到已经跑着的那个控制台，然后安静退出。 */
    console.error(`\n端口 ${PORT} 上已经有一个控制台在跑了。`)
    if (process.argv.includes('--open')) {
      try {
        spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}/`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref()
      } catch {}
      console.error('已经帮你打开那一个了，这个窗口可以关掉。\n')
      process.exit(0)
    }
    console.error(`换端口：set ZY_CTL_PORT=18083 && node server.mjs\n`)
    process.exit(1)
  }
  console.error('控制台起不来：', e)
  process.exit(1)
})
