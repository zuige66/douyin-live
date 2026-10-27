#!/usr/bin/env node
/**
 * tools/fetch-pet.mjs —— 把 dsh-dafeiyu 的动作帧拉到本地
 *
 * 为什么要这个脚本：
 *   动作素材在 GitHub 上（QCYTSN/dsh-dafeiyu，MIT），一共 16 段 3444 帧。
 *   但 raw.githubusercontent.com 在这台机器上时好时坏（SSL handshake 经常直接失败），
 *   codeload 整包 96MB 只有 30KB/s（要一个多小时）。
 *   实测 ghfast.top 这个镜像能稳定拿到，所以走镜像 + 并发 + 重试。
 *
 * 用法：
 *   node tools/fetch-pet.mjs idle success error     # 拉指定几段
 *   node tools/fetch-pet.mjs --all                  # 全拉（3444 帧，约 100MB）
 *   node tools/fetch-pet.mjs idle --force           # 已有也重下
 *
 * 已经存在的帧默认跳过，所以断了直接再跑一次就接着下。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PET = path.join(ROOT, 'assets', 'pet')
const MANIFEST = path.join(PET, 'manifest.json')

const MIRRORS = [
  (p) => `https://ghfast.top/https://raw.githubusercontent.com/QCYTSN/dsh-dafeiyu/main/assets/pet/${p}`,
  (p) => `https://gh-proxy.com/https://raw.githubusercontent.com/QCYTSN/dsh-dafeiyu/main/assets/pet/${p}`,
  (p) => `https://raw.githubusercontent.com/QCYTSN/dsh-dafeiyu/main/assets/pet/${p}`,
]

const CONC = 12
const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')
const ALL = argv.includes('--all')
const want = argv.filter((a) => !a.startsWith('--'))

if (!fs.existsSync(MANIFEST)) {
  console.error(`缺少 ${MANIFEST}，先从仓库拉 manifest.json 放到 assets/pet/`)
  process.exit(1)
}
const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const clips = ALL ? Object.keys(man.clips) : want
if (!clips.length) {
  console.error('要哪几段？例如：node tools/fetch-pet.mjs idle success error')
  console.error('可用：', Object.keys(man.clips).join(' '))
  process.exit(1)
}
for (const c of clips) {
  if (!man.clips[c]) {
    console.error(`清单里没有 ${c}；可用：${Object.keys(man.clips).join(' ')}`)
    process.exit(1)
  }
}

const jobs = []
for (const c of clips) for (const f of man.clips[c].frames) jobs.push(f)

let done = 0
let skip = 0
let fail = 0
const failed = []

async function one(rel) {
  const out = path.join(PET, rel)
  if (!FORCE && fs.existsSync(out) && fs.statSync(out).size > 512) {
    skip++
    done++
    return
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  for (let m = 0; m < MIRRORS.length; m++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), 20000)
        const res = await fetch(MIRRORS[m](rel), { signal: ctl.signal })
        clearTimeout(t)
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length < 512) throw new Error('太小 ' + buf.length)
        // 先写临时文件再改名，断了不会留下半截 webp
        fs.writeFileSync(out + '.part', buf)
        fs.renameSync(out + '.part', out)
        done++
        if (done % 40 === 0) {
          process.stdout.write(`  ${done}/${jobs.length}（跳过 ${skip}）\n`)
        }
        return
      } catch (e) {
        if (attempt === 1 && m === MIRRORS.length - 1) {
          fail++
          failed.push(`${rel}  ${e.message}`)
        }
      }
    }
  }
}

const t0 = Date.now()
let i = 0
async function worker() {
  while (i < jobs.length) {
    const rel = jobs[i++]
    await one(rel)
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker))

const sec = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n完成 ${done - skip} 帧，跳过 ${skip}，失败 ${fail}，用时 ${sec}s`)
if (failed.length) {
  console.log('失败的（再跑一次会接着下）：')
  for (const f of failed.slice(0, 10)) console.log('  ', f)
}
process.exit(fail ? 1 : 0)
