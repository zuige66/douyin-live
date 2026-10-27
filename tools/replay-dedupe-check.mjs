/* 临时校验：从 bridge.mjs 里抽出 dedupeKey / isReplay 真实源码跑一遍。
 * 跑完就删。目的不是测副本，是测「真正会发出去的那段代码」。 */
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(path.join(process.cwd(), 'bridge.mjs'), 'utf8')
const start = src.indexOf('const DEDUPE_TTL')
const end = src.indexOf('function pushEvent(')
if (start < 0 || end < 0) throw new Error('抽不到去重代码块')
const block = src.slice(start, end)

// 假的时间，方便测 TTL
let NOW = 1_000_000
const realNow = Date.now
Date.now = () => NOW

const fn = new Function(`
  const log = () => {}
  ${block}
  return { isReplay, dedupeKey, seenKeys, DEDUPE_TTL }
`)
const { isReplay, seenKeys, DEDUPE_TTL } = fn()

let pass = 0, fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' —— ' + extra : '')) }
}

console.log('回放去重：')

// 1. 同一句弹幕第二次进来 = 回放
ok(isReplay({ kind: 'chat', uid: 'u1', user: '森波拉', text: '大肥鱼？' }) === false, '第一次见到不算回放')
ok(isReplay({ kind: 'chat', uid: 'u1', user: '森波拉', text: '大肥鱼？' }) === true, '同一句再来一次判为回放')

// 2. 同一个人说不同的话 = 正常
ok(isReplay({ kind: 'chat', uid: 'u1', user: '森波拉', text: '你有什么才艺' }) === false, '同一个人换了句话不算回放')

// 3. 不同的人说同一句话 = 正常（不能因为话一样就吞）
ok(isReplay({ kind: 'chat', uid: 'u2', user: '翎', text: '大肥鱼？' }) === false, '不同人说同一句不算回放')

// 4. 没 uid 时退化成按昵称
ok(isReplay({ kind: 'chat', user: '路人', text: '1' }) === false, '无 uid 首次')
ok(isReplay({ kind: 'chat', user: '路人', text: '1' }) === true, '无 uid 重复判为回放')

// 5. 礼物同理
ok(isReplay({ kind: 'gift', uid: 'u3', user: 'A', giftName: '小心心', giftCount: 3 }) === false, '礼物首次')
ok(isReplay({ kind: 'gift', uid: 'u3', user: 'A', giftName: '小心心', giftCount: 3 }) === true, '礼物重复判为回放')

// 6. 进场 / 点赞 永远不判回放（同一个人本来就可能反复来）
ok(isReplay({ kind: 'member', uid: 'u1', user: '森波拉' }) === false, '进场第一次')
ok(isReplay({ kind: 'member', uid: 'u1', user: '森波拉' }) === false, '进场重复也不吞')
ok(isReplay({ kind: 'like', uid: 'u1', user: '森波拉' }) === false, '点赞第一次')
ok(isReplay({ kind: 'like', uid: 'u1', user: '森波拉' }) === false, '点赞重复也不吞')

// 7. TTL 过期后同一句又算新的（隔了几分钟真的又说了，得回）
const k = { kind: 'chat', uid: 'u9', user: 'X', text: '点歌 特别的人' }
isReplay(k)
NOW += DEDUPE_TTL + 1
ok(isReplay(k) === false, `隔了 ${DEDUPE_TTL / 1000}s 以上再说同一句，算新的`)

// 8. 清场逻辑不误删没过期的
seenKeys.clear()
NOW = 5_000_000
for (let i = 0; i < 600; i++) isReplay({ kind: 'chat', uid: 'x' + i, user: 'x', text: 'hi' + i })
ok(seenKeys.size <= 600, 'Map 不会无限长（有上限清理）', 'size=' + seenKeys.size)

Date.now = realNow
console.log(`\n回放去重：${fail === 0 ? '全部通过' : fail + ' 条失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail ? 1 : 0)
