#!/usr/bin/env node
// 探针：导出 get_live_events / start_live_listen 的完整 inputSchema，并试调一次
const URL = process.env.DOUYIN_MCP_URL || 'http://127.0.0.1:18080/mcp'
const TOKEN = process.env.DOUYIN_MCP_TOKEN || 'dsh-live-local'
let sessionId = null

async function rpc(method, params, id) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${TOKEN}`,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const body = { jsonrpc: '2.0', method, params }
  if (id !== undefined) body.id = id
  const res = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  if (!text.trim() || text.trim() === 'null') return null
  let payload = text
  const m = text.match(/^data:\s*(.*)$/m)
  if (m) payload = m[1]
  const msg = JSON.parse(payload)
  if (msg?.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`)
  return msg?.result
}

await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'probe', version: '0' },
}, 1)
await rpc('notifications/initialized', {})

const { tools } = await rpc('tools/list', {}, 2)
const want = ['start_live_listen', 'stop_live_listen', 'get_live_events', 'get_live_info']
for (const t of tools) {
  if (!want.includes(t.name)) continue
  console.log('### ' + t.name)
  console.log(JSON.stringify(t.inputSchema, null, 2))
}

const arg = process.argv[2]
if (arg) {
  const r = await rpc('tools/call', { name: arg, arguments: JSON.parse(process.argv[3] || '{}') }, 3)
  const txt = (r?.content ?? []).map((c) => c?.text ?? '').join('\n')
  console.log('--- call ' + arg + ' ---')
  console.log(txt.slice(0, 3000))
}
