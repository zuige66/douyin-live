#!/usr/bin/env node
/**
 * live.mjs —— 开播 / 下播 一键编排（人是 .cmd 双击，agent 也能 `node tools/live.mjs start`）
 *
 * 架构（见 docs/2026-10-29-直播伴侣MCP助手.md）：
 *   Mate 提权代理 :18085（X-Mate-Token）──UIA──> 直播伴侣（开播/关播）
 *   zhibo 主控 :18082（server.mjs）──> 桥 :18081 + 音乐 :18083 + 画面 overlay
 *
 * 命令：
 *   node tools/live.mjs start    # 开播：确保主控在 → Mate 开播 → /ctl/all 起桥+画面+音乐
 *   node tools/live.mjs stop     # 下播：Mate 关播 → /ctl/stop 停桥+画面 → 彻底杀 musicd
 *   node tools/live.mjs status   # 只查状态，不动
 *
 * 设计要点：
 *   - 用 node 原生 fetch（undici 默认不走系统代理），比 curl 稳，避免 HTTP_PROXY 干扰本地端口。
 *   - 开播顺序严格「先开播 → 再起桥」（bridge.mjs 若在房间没活时先起会假活、0 弹幕）。
 *   - 下播彻底关：/ctl/stop 只暂停音乐服务，这里再按端口把 musicd 进程杀掉。
 *   - 全程失败给中文明确提示，不瞎点、不吞错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const TOKEN_FILE = path.join(ROOT, '.run', 'mate-token')
const MATE_CONF = path.join(ROOT, 'cache', 'mate.json')
const PIDS_FILE = path.join(ROOT, '.run', 'pids.json')

const CTL_PORT = Number(process.env.ZY_CTL_PORT || 18082)
const MUSIC_PORT = Number(process.env.ZY_MUSIC_PORT || 18083)
const CTL = `http://127.0.0.1:${CTL_PORT}`

const log = (s = '') => console.log(s)
const warn = (s) => console.log('⚠ ' + s)
const fail = (s) => console.error('✗ ' + s)
const ok = (s) => console.log('✓ ' + s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const readToken = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch { return '' } }

function mateBase() {
  const c = readJson(MATE_CONF) || {}
  return `http://${c.host || '127.0.0.1'}:${Number(c.port) || 18085}`
}

async function http(method, url, { headers = {}, body = null, timeout = 20000 } = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { httpOk: res.ok, status: res.status, text, json }
  } finally {
    clearTimeout(t)
  }
}

/** 调 Mate 提权代理（和 mate-mcp.mjs 完全一致的鉴权/路径） */
async function mateCall(pathname, method = 'GET', bodyObj = null) {
  const tk = readToken()
  if (!tk) throw new Error('没有令牌 .run/mate-token —— Mate 代理没起来？先双击 start-mate-agent.cmd')
  const headers = { 'X-Mate-Token': tk, Accept: 'application/json' }
  let body
  if (bodyObj) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(bodyObj) }
  const r = await http(method, mateBase() + pathname, { headers, body })
  if (!r.httpOk) throw new Error(r.json?.reason || `Mate 代理 HTTP ${r.status}`)
  if (!r.json) throw new Error(`Mate 代理返回非 JSON（${pathname}）`)
  return r.json
}

/** 调 zhibo 主控 server.mjs */
async function ctlCall(pathname, method = 'GET', bodyObj = null, timeout = 25000) {
  const headers = { Accept: 'application/json' }
  let body
  if (bodyObj) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(bodyObj) }
  const r = await http(method, CTL + pathname, { headers, body, timeout })
  if (!r.httpOk && !r.json) throw new Error(`主控 HTTP ${r.status}`)
  if (!r.json) throw new Error(`主控返回非 JSON（${pathname}）`)
  return r.json
}

async function ctlAlive() {
  try { await http('GET', CTL + '/ctl/status', { timeout: 2500 }); return true } catch { return false }
}

async function ensureMate() {
  const h = await mateCall('/health').catch((e) => {
    throw new Error('Mate 提权代理连不上（' + e.message + '）。先双击 start-mate-agent.cmd，保持黑窗口。')
  })
  if (!h.admin) warn('Mate 代理没提权，可能点不动直播伴侣（请用 start-mate-agent.cmd 重启代理）')
  return h
}

/** 主控没起就拉起来（隐藏后台，独立进程，父进程退出也不影响） */
async function ensureCtl() {
  if (await ctlAlive()) return { started: false }
  log(`主控 :${CTL_PORT} 没在跑，正在拉起 server.mjs …`)
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  })
  child.unref()
  for (let i = 0; i < 50; i++) {
    await sleep(300)
    if (await ctlAlive()) return { started: true, pid: child.pid }
  }
  throw new Error('server.mjs 约 15 秒没起来 —— 手动双击 start.cmd 看报错再排查')
}

async function printStatus() {
  log('')
  log('—— 当前状态 ——')
  try {
    const s = await ctlCall('/ctl/status')
    const b = s.bridge || {}, o = s.overlay || {}, m = s.music || {}
    log(`  桥　：${b.running ? '运行' : '停'}${b.idle ? '（待机·还没连上房间）' : ''}  live=${b.live?.status || '?'}`)
    log(`  画面：${o.live ? '在' : '无'}${o.pid ? ` (pid ${o.pid})` : ''}`)
    const mu = m.now || {}
    log(`  音乐：${m.up ? '服务在' : '服务停'}  clientAlive=${m.clientAlive}` +
      (mu.playing ? `  正在放《${mu.name}》` : (mu.name ? `  暂停于《${mu.name}》` : '')))
  } catch (e) {
    warn('查状态失败：' + e.message)
  }
  try {
    const st = await mateCall('/state')
    log(`  直播伴侣：${st.running ? (st.live === true ? '直播中' : st.live === false ? '未开播' : '判断不了') : '没在跑'}`)
  } catch {
    log('  直播伴侣：读不到（Mate 提权代理没在跑 —— 双击 start-mate-agent.cmd 启动它）')
  }
}

/* ------------------------------------------------------------------ start */
async function start() {
  log('=== 开播 ===')
  await ensureMate()

  const c = await ensureCtl()
  if (c.started) ok(`主控已拉起 (pid ${c.pid})`)
  else log('主控已在运行')

  // Mate 开播（直播伴侣没开就先拉起）
  let before = await mateCall('/state').catch(() => null)
  if (before && before.running === false) {
    log('直播伴侣没开，先拉起…')
    await mateCall('/launch', 'POST').catch(() => {})
    await sleep(2500)
    before = await mateCall('/state').catch(() => null)
  }
  if (before && before.live === true) {
    log('直播伴侣已经是在播状态，跳过开播')
  } else {
    const r = await mateCall('/live/start', 'POST')
    if (!r || r.ok !== true) {
      throw new Error('开播失败：' + (r?.reason || '未知') +
        (r?.picked ? `（最像的控件：${JSON.stringify(r.picked.name)}）` : ''))
    }
    ok(`开播指令已执行（UIA ${r.how || ''}，控件「${r.picked?.name || '?'}」）`)
  }
  await sleep(1500)
  const af = await mateCall('/state').catch(() => null)
  if (af) log(`直播伴侣：${af.live === true ? '直播中' : af.live === false ? '未开播' : '判断不了'}`)

  // 关键：先开播，等房间在抖音侧变活跃，再起桥
  log('等房间变活跃（6s）后起桥…')
  await sleep(6000)

  const all = await ctlCall('/ctl/all', 'POST', {})
  if (!all || all.ok === false) throw new Error('起桥失败：' + (all?.message || all?.error || '未知'))
  ok(all.message || '桥+画面+音乐已全开')

  // 等桥从「待机」连上房间（最多 15s），连上就停
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    try { const s = await ctlCall('/ctl/status'); if (s.bridge && s.bridge.idle === false) break } catch {}
  }
  await printStatus()
  ok('开播完成')
}

/* ------------------------------------------------------------------- stop */
function findPidOnPort(port) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  if (!r.stdout) return 0
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    const local = parts[1] || ''
    if (!local.endsWith(':' + port)) continue
    const last = parts[parts.length - 1]
    if (/^\d+$/.test(last)) return Number(last)
  }
  return 0
}

function procName(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  const m = (r.stdout || '').match(/"([^"]+\.exe)"/i)
  return m ? m[1].toLowerCase() : ''
}

/** 彻底关掉 musicd：/ctl/stop 只暂停，不杀；这里按端口找进程，确认是 node 才 taskkill */
async function killMusic() {
  let pid = findPidOnPort(MUSIC_PORT)
  if (!pid) {
    const p = readJson(PIDS_FILE) || {}
    if (p.musicPid) pid = Number(p.musicPid)
  }
  if (!pid) { log('音乐服务本来就没在跑'); return }
  const name = procName(pid)
  if (!name) { log('音乐服务本来就没在跑（进程已退出）'); return }
  if (name !== 'node.exe') {
    warn(`:${MUSIC_PORT} 的占用者 pid=${pid} 是 ${name}，不是 node，为安全不杀`)
    return
  }
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
  if (r.status === 0) ok(`音乐服务已彻底关闭 (pid ${pid})`)
  else warn('关音乐服务失败：' + ((r.stdout || '') + (r.stderr || '')).trim())
  // 兜底验证
  await sleep(1000)
  if (findPidOnPort(MUSIC_PORT)) warn(`:${MUSIC_PORT} 仍在监听，可能还有残留`)
}

/**
 * 关播兜底：直播伴侣 UI 改版后，关播按钮时有时叫「下播」、真按钮是「MM:SS 关播」，
 * /live/stop 的严格守卫可能据不到。这里直接按名字点：先模糊点「关播」（带时长前缀的
 * 真按钮），退而点「下播」；再精确点「确认」弹窗；最后读 /state 复核。
 * 仅当用户确实要求下播、且正规 /live/stop 已失败时才会走到这里。
 */
async function fallbackStop() {
  const st = await mateCall('/state').catch(() => null)
  if (st && st.live === false) { log('直播伴侣已不在播'); return true }
  // 1) 点关播真按钮（模糊匹配「关播」以吃掉「MM:SS 」前缀；个别瞬间只有「下播」）
  let clicked = false
  for (const [nm, ex] of [['关播', false], ['关播', false], ['下播', true]]) {
    const c = await mateCall('/click', 'POST', { name: nm, exact: ex }).catch(() => null)
    if (c && c.ok === true) { clicked = true; ok(`已点「${c.picked?.name || nm}」`); break }
    await sleep(700)
  }
  if (!clicked) { warn('兜底：没点到「关播/下播」按钮'); return false }
  await sleep(1000)
  // 2) 点「确认」弹窗（可能有两个同名：活的一份 + 失效副本，多试几次）
  for (let i = 0; i < 4; i++) {
    const c = await mateCall('/click', 'POST', { name: '确认', exact: true }).catch(() => null)
    if (c && c.ok === true) { ok('已点「确认」'); break }
    await sleep(700)
  }
  await sleep(1200)
  const af = await mateCall('/state').catch(() => null)
  return af ? af.live === false : false
}

async function stop() {
  log('=== 下播 ===')
  // 1) Mate 关播（代理可能没起，但桥/音乐仍要停，所以失败也继续）
  let mateOk = true
  try { await ensureMate() } catch (e) { mateOk = false; warn(e.message) }
  if (mateOk) {
    const before = await mateCall('/state').catch(() => null)
    if (before && before.live === false) {
      log('直播伴侣本来就没在播，跳过下播')
    } else {
      // 在播（或判断不了）：先走正规 /live/stop，失败再兜底点击
      let stopped = false
      const r = await mateCall('/live/stop', 'POST').catch((e) => ({ ok: false, reason: e.message }))
      if (r && r.ok === true) {
        ok('下播指令已执行' + (r.confirm ? `（二次确认：${r.confirm}）` : ''))
        stopped = true
      } else {
        warn('正规关播失败：' + (r?.reason || '未知') + '，改用兜底点击…')
        stopped = await fallbackStop()
      }
      if (stopped) ok('已关播')
      else warn('⚠ 关播没成功，请手动点一下「关播/下播」再点「确认」')
    }
    await sleep(1000)
  }

  // 2) 停桥 + 画面 + 按停音乐
  if (await ctlAlive()) {
    try {
      const s = await ctlCall('/ctl/stop', 'POST', {})
      ok(s?.message || '已停桥+画面')
    } catch (e) { warn('停桥失败：' + e.message) }
  } else {
    log('主控没在跑，桥/画面应该已经没了')
  }

  // 3) 彻底杀 musicd（"全停了还有音乐" 的根治）
  await killMusic()

  await sleep(800)
  await printStatus()
  ok('下播完成（全部关闭）')
}

/* ------------------------------------------------------------------- main */
const cmd = (process.argv[2] || '').toLowerCase()
;(async () => {
  try {
    if (cmd === 'start') await start()
    else if (cmd === 'stop') await stop()
    else if (cmd === 'status') await printStatus()
    else {
      console.log('用法：node tools/live.mjs <start|stop|status>')
      process.exitCode = 2
    }
  } catch (e) {
    fail(e?.message || String(e))
    process.exitCode = 1
  }
})()
