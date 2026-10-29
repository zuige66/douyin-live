#!/usr/bin/env node
/**
 * mate-mcp —— 直播伴侣 MCP 助手（开播 / 关播 / 看状态）。
 *
 * 架构：
 *   本进程(Medium IL, stdio) --HTTP--> mate_agent.py(High IL) --UIA--> 直播伴侣
 *
 * 为什么不直接点：
 *   直播伴侣 manifest 是 requireAdministrator + uiAccess，跑在 High IL，
 *   中完整性进程的 SendInput/SetCursorPos 被 UIPI 静默丢弃；而且它自带 edrAgent
 *   把软件级输入注入 hook 掉了。UIA 的 InvokePattern 由目标进程内部派发点击，
 *   不过输入队列，是唯一不碰硬件的可行路子。
 *
 * 前置：先双击仓库根目录的 start-mate-agent.cmd（弹一次 UAC），代理常驻 127.0.0.1:18085。
 * 详见 docs/2026-10-29-直播伴侣MCP助手.md
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const TOKEN_FILE = path.join(ROOT, '.run', 'mate-token')
const CONF_FILE = path.join(ROOT, 'cache', 'mate.json')

const TIMEOUT = 90000 // 导一次 UIA 树 + 关播二次确认，最慢能到 20~30 秒

function conf() {
  try {
    return JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function token() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

function base() {
  const port = Number(conf().port) || 18085
  return `http://127.0.0.1:${port}`
}

const HINT = '控制代理没起来。请双击仓库根目录的 start-mate-agent.cmd（会弹 UAC），保持那个黑窗口开着，再试一次。'

async function call(pathname, method = 'GET', bodyObj = null) {
  const t = token()
  if (!t) throw new Error(HINT + '（还没生成 .run/mate-token）')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT)
  const headers = { 'X-Mate-Token': t, Accept: 'application/json' }
  let payload
  if (bodyObj) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(bodyObj)
  }
  let res
  try {
    res = await fetch(base() + pathname, {
      method,
      headers,
      body: payload,
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') throw new Error(`代理 ${TIMEOUT / 1000}s 没响应：${pathname}`)
    throw new Error(HINT + `（${base()} 连不上）`)
  }
  clearTimeout(timer)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.reason || `HTTP ${res.status}`)
  return body
}

function txt(s) {
  return { content: [{ type: 'text', text: s }] }
}

const LIVE_CN = { true: '直播中', false: '未开播', null: '判断不了' }

async function status() {
  const h = await call('/health')
  const s = await call('/state')
  const lines = []
  lines.push(`代理：运行中（pid ${h.pid}，${h.admin ? '已提权 ✓' : '⚠️ 未提权，点不动'}）`)
  if (!h.admin) lines.push('   ⚠️ 代理不是管理员，直播伴侣是 High IL，必须用 start-mate-agent.cmd 启动。')
  lines.push(`直播伴侣：${s.running ? '运行中' : '没在跑'}`)
  if (s.running) {
    lines.push(`直播状态：${LIVE_CN[String(s.live)]}`)
    lines.push(`窗口标题：${s.title || '(空)'}`)
    lines.push(`按钮：开播 ${s.hasStartButton ? '有' : '无'} / 关播 ${s.hasStopButton ? '有' : '无'}`)
    if (s.hints?.length) lines.push(`在播旁证：${s.hints.join(', ')}`)
  }
  return lines.join('\n')
}

const TOOLS = [
  {
    name: 'mate_status',
    description: '查直播伴侣状态：是否在运行、是否正在直播。开播/关播前后先查一下。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'live_start',
    description: '让直播伴侣开始直播（等同点界面上的「开始直播」）。走 UIA 默认动作，不需要鼠标。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'live_stop',
    description: '让直播伴侣结束直播（等同点界面上的「结束直播」）。走 UIA 默认动作，不需要鼠标。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mate_launch',
    description: '启动直播伴侣（代理已提权，所以不会弹 UAC）。已经开着就什么都不做。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mate_probe',
    description:
      '导出直播伴侣的 UIA 树，用来排查「找不到开播/关播按钮」。返回候选按钮名和支持的 UIA 模式。',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', description: '最大深度，默认 8' },
        nodes: { type: 'integer', description: '最多节点数，默认 1200' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mate_click',
    description:
      '按控件名字点一下界面上的任意控件（调试/兜底用）。默认精确匹配，exact=false 则包含即可。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '控件名，例如「直播设置」' },
        exact: { type: 'boolean', description: '是否精确匹配，默认 true' },
        dry: { type: 'boolean', description: '只报会点哪个，不真点' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
]

async function callTool(name, args = {}) {
  if (name === 'mate_status') return txt(await status())

  if (name === 'live_start' || name === 'live_stop') {
    const kind = name === 'live_start' ? '开播' : '关播'
    const before = await call('/state').catch(() => null)
    const r = await call(name === 'live_start' ? '/live/start' : '/live/stop', 'POST')
    if (!r.ok) {
      const tried = (r.tried || []).map((t) => `  · ${JSON.stringify(t.name)} -> ${t.how || '点不动'}`).join('\n')
      return {
        content: [
          {
            type: 'text',
            text: `${kind}失败：${r.reason || '未知原因'}\n${
              r.picked ? `最像的控件：${JSON.stringify(r.picked.name)} ${JSON.stringify(r.picked.rect)}` : ''
            }${tried ? '\n试过的：\n' + tried : ''}\n可以让我跑 mate_probe 看看真实按钮名。`,
          },
        ],
        isError: true,
      }
    }
    await new Promise((s) => setTimeout(s, 1500))
    const after = await call('/state').catch(() => null)
    const bits = [`${kind}指令已执行（UIA ${r.how}，控件「${r.picked?.name || '?'}」）。`]
    if (kind === '关播') {
      bits.push(
        r.confirm && r.confirm !== '没弹确认框（可能已经直接停了）'
          ? `二次确认已点掉（${r.confirm}）。`
          : '没有弹二次确认框。'
      )
    }
    if (before && after) {
      bits.push(`状态：${LIVE_CN[String(before.live)]} → ${LIVE_CN[String(after.live)]}`)
      if (before.live === after.live) bits.push('（状态没变，可能界面还在转圈，建议再查一次状态）')
    }
    return txt(bits.join('\n'))
  }

  if (name === 'mate_launch') {
    const r = await call('/launch', 'POST')
    if (!r.ok) return { content: [{ type: 'text', text: `启动失败：${r.reason}` }], isError: true }
    return txt(r.already ? '直播伴侣本来就开着。' : '直播伴侣已启动。')
  }

  if (name === 'mate_probe') {
    const q = new URLSearchParams()
    if (args.depth) q.set('depth', String(args.depth))
    if (args.nodes) q.set('nodes', String(args.nodes))
    const r = await call('/probe?' + q.toString())
    if (!r.ok) return { content: [{ type: 'text', text: `探测失败：${r.reason}` }], isError: true }
    const cand = r.candidates || {}
    const brief = (arr) =>
      (arr || []).map((x) => `  · [${x.type}] ${JSON.stringify(x.name)} 模式=${(x.patterns || []).join('/') || '无'}`).join('\n') ||
      '  （无）'
    const body = [
      `窗口：${r.window?.title}  pid=${r.window?.pid}`,
      `节点 ${r.nodeCount}${r.truncated ? '（已截断）' : ''}`,
      '开播候选：',
      brief(cand.start),
      '关播候选：',
      brief(cand.stop),
    ].join('\n')
    return txt(body)
  }

  if (name === 'mate_click') {
    if (!args.name) throw new Error('mate_click 需要 name')
    const r = await call('/click', 'POST', {
      name: args.name,
      exact: args.exact !== false,
      dry: !!args.dry,
    })
    if (!r.ok) return { content: [{ type: 'text', text: `没点成：${r.reason}` }], isError: true }
    const p = r.picked || {}
    return txt(
      r.dry
        ? `会点：${JSON.stringify(p.name)} ${JSON.stringify(p.rect)}（共 ${r.count} 个同名控件）`
        : `已点：${JSON.stringify(p.name)} ${JSON.stringify(p.rect)}，方式 ${r.how}`
    )
  }

  throw new Error('未知工具: ' + name)
}

// ---------------------------------------------------------------- MCP over stdio
function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
const ok = (id, result) => write({ jsonrpc: '2.0', id, result })
const fail = (id, message) => write({ jsonrpc: '2.0', id, error: { code: -32603, message } })

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mate', version: '2.0.0' },
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') {
    ok(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    try {
      ok(id, await callTool(params.name, params.arguments || {}))
    } catch (e) {
      ok(id, { content: [{ type: 'text', text: '失败: ' + e.message }], isError: true })
    }
    return
  }
  if (method === 'ping') {
    ok(id, {})
    return
  }
  if (id !== undefined) fail(id, '不支持的方法: ' + method)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch (e) {
      process.stderr.write('[mate-mcp] 解析失败 ' + e.message + '\n')
    }
  }
})
