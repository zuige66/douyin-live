#!/usr/bin/env node
/**
 * 直接问 douyin-mcp：监听到底连上了没。
 *   node probe-listen.mjs            → 列出所有跟 live/listen 有关的工具
 *   node probe-listen.mjs <工具名>    → 调它
 *
 * 为什么需要：桥只看得见 get_live_events 返回的数组，数组是空的就分不清
 * 「连上了但没人说话」和「压根没连上」。
 */
const PORT = Number(process.env.MCP_PORT || 18080)
const TOKEN = process.env.MCP_TOKEN || 'dsh-live-local'
const URL = `http://127.0.0.1:${PORT}/mcp`

let sid = null
let id = 0

async function rpc(method, params) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${TOKEN}`,
  }
  if (sid) headers['mcp-session-id'] = sid
  const body = { jsonrpc: '2.0', method, params }
  if (method !== 'notifications/initialized') body.id = ++id
  const res = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const s = res.headers.get('mcp-session-id')
  if (s) sid = s
  const text = await res.text()
  if (!text.trim() || text.trim() === 'null') return null
  const m = text.match(/^data:\s*(.*)$/m)
  const msg = JSON.parse(m ? m[1] : text)
  if (msg?.error) throw new Error(msg.error.message || 'mcp error')
  return msg?.result ?? null
}

const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args })
  const text = (r?.content ?? []).map((c) => c?.text ?? '').join('\n').trim()
  return { isError: !!r?.isError, text }
}

const main = async () => {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe-listen', version: '0.1.0' },
  })
  await rpc('notifications/initialized', {})

  const arg = process.argv[2]
  if (arg) {
    const r = await call(arg, JSON.parse(process.argv[3] || '{}'))
    console.log(r.isError ? '【错误】' : '【结果】')
    console.log(r.text || '(空)')
    return
  }

  const list = await rpc('tools/list', {})
  const tools = list?.tools ?? []
  console.log(`共 ${tools.length} 个工具\n`)
  const hit = tools.filter((t) => /live|listen|room|danmaku|event/i.test(t.name))
  for (const t of hit) {
    console.log(`· ${t.name}`)
    const d = (t.description || '').replace(/\s+/g, ' ').slice(0, 100)
    if (d) console.log(`    ${d}`)
  }

  // 猜几个可能存在的状态工具，有就调
  for (const name of ['get_live_status', 'get_listen_status', 'live_status', 'get_live_events']) {
    if (!tools.some((t) => t.name === name)) continue
    const r = await call(name)
    console.log(`\n== ${name} ==\n${(r.text || '').slice(0, 1200)}`)
  }
}

main().catch((e) => {
  console.error('探针失败：', e?.message || e)
  process.exit(1)
})
