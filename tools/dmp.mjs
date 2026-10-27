#!/usr/bin/env node
// 极简 minidump 解析：只取异常码、崩溃线程和模块列表。
// 不依赖 windbg，纯按 MS 的 MINIDUMP 结构硬读。
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] || '.'
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.dmp')).sort()

const EXC = {
  0x80000003: 'BREAKPOINT (Chrome 主动崩：通常是 OOM / CHECK 失败)',
  0xc0000005: 'ACCESS_VIOLATION',
  0xc0000017: 'NO_MEMORY',
  0xc00000fd: 'STACK_OVERFLOW',
  0xc0000409: 'STACK_BUFFER_OVERRUN (fail-fast，多半是 CHECK)',
  0xe0000008: 'abort()',
}

function u32(b, o) { return b.readUInt32LE(o) }
function u64(b, o) { return Number(b.readBigUInt64LE(o)) }

function readUtf16(b, rva) {
  const len = u32(b, rva)
  return b.toString('utf16le', rva + 4, rva + 4 + len)
}

for (const f of files) {
  const b = fs.readFileSync(path.join(dir, f))
  if (b.toString('ascii', 0, 4) !== 'MDMP') { console.log(f, '不是 minidump'); continue }
  const nStreams = u32(b, 8)
  const dirRva = u32(b, 12)
  const ts = u32(b, 20)

  let exc = null
  let mods = []
  let misc = null
  let threads = 0
  for (let i = 0; i < nStreams; i++) {
    const o = dirRva + i * 12
    const type = u32(b, o)
    const rva = u32(b, o + 8)
    if (type === 6) { // ExceptionStream
      const rec = rva + 8
      const code = u32(b, rec)
      const addr = u64(b, rec + 16)
      exc = { code, addr, tid: u32(b, rva) }
    } else if (type === 4) { // ModuleListStream
      const n = u32(b, rva)
      for (let m = 0; m < n; m++) {
        const mo = rva + 4 + m * 108
        const nameRva = u32(b, mo + 20)
        try { mods.push(readUtf16(b, nameRva)) } catch {}
      }
    } else if (type === 3) { // ThreadListStream
      threads = u32(b, rva)
    } else if (type === 15) { // MiscInfoStream
      const flags = u32(b, rva + 4)
      if (flags & 1) {
        misc = {
          pid: u32(b, rva + 8),
          createTime: u32(b, rva + 12),
          userTime: u32(b, rva + 16),
          kernelTime: u32(b, rva + 20),
        }
      }
    }
  }

  const base = mods.map((p) => p.split('\\').pop())
  const interesting = base.filter((n) =>
    /^(chrome|chrome_elf|msedge|libEGL|libGLESv2|d3d11|dxgi|dcomp|skia|win32k|ntdll|igd|nvoglv|opengl32|vk_swiftshader|swiftshader)/i.test(n)
  )

  console.log('=== ' + f)
  console.log('  时间戳 : ' + new Date(ts * 1000).toLocaleString('zh-CN'))
  console.log('  异常码 : ' + (exc ? '0x' + exc.code.toString(16).toUpperCase() + '  ' + (EXC[exc.code] || '未知') : '无'))
  if (misc) {
    const life = ts - misc.createTime
    console.log('  进程   : pid=' + misc.pid + '  创建于 ' + new Date(misc.createTime * 1000).toLocaleString('zh-CN') + '  存活 ' + life + ' 秒')
    console.log('  CPU    : user ' + misc.userTime + 's / kernel ' + misc.kernelTime + 's')
  }
  console.log('  线程数 : ' + threads)
  console.log('  模块数 : ' + mods.length)
  console.log('  关键模块: ' + interesting.join(', '))
  console.log('  全部模块: ' + base.join(', '))
}
