/**
 * 大肥鱼的话术引擎
 *
 * 设计约束（很重要，改的时候别忘）：
 *   1. 底部字幕条只有 900px 宽，34px 字号下大约放 21 个汉字。
 *      所以每条回复都控制在 20 字以内，长了自己会被裁掉。
 *   2. 不用 emoji。雅黑能渲染几个，但转成单色后特别脏，而且抖音转码后更糊。
 *   3. 人设：鲸鱼女仆，甜、有点憨、爱撒娇，但不要油腻，不要每句都"呢~哦~"。
 *
 * 两档回复：
 *   本地话术（默认）  —— 零依赖、零延迟、离线可用，按关键词分十来类
 *   大模型（可选）    —— 设了 REPLY_API_KEY 就走模型，失败自动退回本地话术
 *
 * 单独试话术：
 *   node reply.mjs 阿伟 "这歌真好听"
 *   node reply.mjs 夜色 "送出一个小心心" gift
 */

const MAX_LEN = 20
/* 深度问题放宽到 40 字（2026-10-29 主人定：C3 + C1）。
 * 40 字一条字幕放不下（900px / 34px ≈ 21 字），所以 bridge 会调 speakSplit()
 * 拆成两段，分两次上字幕、两次合成 —— 听着是两句连贯的话，不是一句被截半。 */
const MAX_LEN_DEEP = 40

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONF_FILE = path.join(DIR, 'llm.json')

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

/** 被截掉（按标点断句 + 硬切）的次数，自检和面板看得到 */
let clipStat = { soft: 0, hard: 0 }

/* 断句的句读。中文标点 + 空格，不含「…」（它本身常常是被切出来的）。 */
const BREAK_RE = /[，。！？、；：,.!?;:；～~ ]/

/* 说话前的铺垫。截断时优先砍这些 —— 砍掉不伤句意，
 * 正好能腾出 3~8 个字给后面真正的结论（见 clip）。 */
const LEAD_RE = /^(我跟你说|我跟你讲|其实呢|其实|说实话|说真的|讲真|老实说|怎么说呢|话说|对了|然后呢|那个|嗯|诶|哎呀|喏)[，,、。\s~～]+/

export function clip(s, n = MAX_LEN) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  /* 去掉孤立代理字符（2026-10-27）。
   * 模型偶尔吐半个 emoji，`slice` 也可能正好从 emoji 中间劈开 ——
   * JS 里看不出来，但 JSON.stringify 会把它变成 `\udc80` 这种转义，
   * 传到 python 那边就 str 里带代理字符，写 UTF-8 时 UnicodeEncodeError，
   * tts.py 常驻进程当场退出 → 桥退回一次性 spawn → 屏幕上闪黑窗。 */
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '').replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1')
  if (s.length <= n) return s

  /* 🔴 2026-10-29 主人：「20 字硬砍，后半句没了」。
   * 根因是原来**从后往前找最后一个句读**，断出来的一定是前半句 ——
   * 而模型的结论通常在后半句：「不是双一流，但控制科学是A-，广东就这一家」，
   * 砍完只剩「不是双一流」这种铺垫，等于把答案扔了。
   * 现在改成两步：先砍铺垫，再从后往前贪心拼，**保住结论**。 */
  const lead = s.match(LEAD_RE)
  if (lead) {
    const rest = s.slice(lead[0].length).replace(/[，。！？、；：,.!?;:～~\s]+$/, '')
    if (rest.length >= 6 && rest.length <= n) {
      clipStat.soft++
      console.log(`  [clip] 砍掉铺垫「${lead[0]}」，留 ${rest.length} 字：${rest.slice(0, 26)}`)
      return rest
    }
  }

  /* 按句读切成小句（只要正文，不要分隔符），从后往前贪心拼。
   * 拼到再加一句就超长为止 —— 最后留下的就是结论那半句。 */
  const segs = []
  const rx = /[^，。！？、；：,.!?;:～~\s]+/g
  let mm
  while ((mm = rx.exec(s))) segs.push(mm[0])
  if (segs.length > 1) {
    let keep = []
    for (let i = segs.length - 1; i >= 0; i--) {
      const cand = [segs[i], ...keep].join('，')
      if (cand.length > n) break
      keep = [segs[i], ...keep]
    }
    const got = keep.join('，')
    /* 只保住个小尾巴的时候不敢用：观众听到的是半句没有主语的话。
     * 要求保下来的至少占原句一半 —— 这条是防止「广东就这一家」被单独说出来。 */
    if (got.length >= 6 && got.length >= s.length * 0.5) {
      clipStat.soft++
      console.log(`  [clip] 超 ${n} 字，保住结论断到 ${got.length} 字：${s.slice(0, 26)}…`)
      return got
    }
  }

  /* 2026-10-28 改：**先按句读断，不要硬切**。
   * 实测「详细解释一下为什么这所学校不是双一流」回的是
   *   「不是双一流，但控制科学是A-，广东就这一家」
   * 硬切 19 字 →「不是双一流，但控制科学是A-，广东就这…」
   * 词被劈开，TTS 念出来是半句话，观众根本听不懂。
   * 现在在 n 以内找最后一个句读，从那儿断 —— 宁可少说半句，也别说半个词。
   *
   * 下限取 n 的 4 成（试过 6 成，太严 —— 「今天的天气真的很好呢，我刚刚还出去
   * 晒了会儿太阳」，句读在第 10 字、低于 12 的下限，结果退回硬切，反而更糟）。
   * 但也不能完全没有下限，否则「我，」也算断句，一句正常的话被砍成三个字。 */
  const head = s.slice(0, n)
  const floorAt = Math.floor(n * 0.4)
  for (let i = head.length - 1; i >= floorAt; i--) {
    if (!BREAK_RE.test(head[i])) continue
    const got = s.slice(0, i).replace(/[，。！？、；：,.!?;:～~ ]+$/, '')
    if (got.length < 6) break // 断完只剩几个字就不如不断
    clipStat.soft++
    console.log(`  [clip] 超 ${n} 字，按句读断到 ${got.length} 字：${s.slice(0, 24)}…`)
    return got
  }

  // 实在没有句读（一整串没标点）才硬切，截断点别落在代理对中间
  let cut = n - 1
  const c = s.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut--
  clipStat.hard++
  console.log(`  [clip] 超 ${n} 字且没句读，硬切：${s.slice(0, 24)}…`)
  return s.slice(0, cut) + '…'
}

/** 面板 / 自检：被截断过几次 */
export function clipStats() {
  return { ...clipStat }
}

/* ------------------------------------------------------------------ 拆意图 */
/** 点歌的「标准写法」。屏幕上、回复里、设置页提示都引用这一个字符串，改一处全改。 */
export const SONG_TIP = '点歌，歌名，歌手（可不填）'

/** 点歌的触发词。**意图判断和取歌名共用这一份** —— 分两处写就必然对不上。
 *
 *  🔴 2026-10-29 23:31 漏过「点一首」：Rabbit.RAW 说「点一首《雨爱（司凤版）》」，
 *     `RE.song` 里只有「点歌/来一首/唱一首」，**没有「点一首」** →
 *     这句话压根没进点歌分支 → 一次搜索都没发 →
 *     她回了句「雨爱，司凤版，排第二首啦」，歌一首都没排上。
 *     观众眼里就是「点了，但没点上」，而且她还说排上了，最坏的那种。
 *
 *  写成 `X + 可选数量词 + 首` 而不是逐个罗列，以后「点两首」「来三首」也不用再改。 */
const SONG_VERB = [
  '点歌', '求歌',
  '点(?:一|两|几|\\d+)?首',
  '来(?:一|两|几|\\d+)?首',
  '放(?:一|两|几|\\d+)?首',
  '播(?:一|两|几|\\d+)?首',
  '唱(?:一|两|几|\\d+)?首',
  '唱个', '想听', '我要听',
  /* 「点《雨爱》」—— 有书名号时连「首」都不写 */
  '点(?=[《「"【])', '放(?=[《「"【])', '来(?=[《「"【])',
].join('|')

/** 「来首歌」「想听点啥」这种**没说歌名**的请求。
 *  以前会把「歌」当成歌名去搜，回一句「搜到 8 首，但都不叫这个」——
 *  观众眼里就是「我说了点歌，它说搜不到歌」。当没听出来、直接问他要哪首才对。 */
const SONG_PLACEHOLDER = /^(歌|首歌|歌曲|音乐|曲子|歌儿|歌呗|曲儿|啥|随便|都行|什么都行|你唱|你唱首)$/

/** 观众在问「怎么点歌」，不是真点歌。
 *
 *  🔴 必须单独判：`点歌` 这两个字同时出现在「点歌，孤勇者」和「怎么点歌」里，
 *     不分开的话，一句「怎么点歌」会被当成点了一首叫「怎么」的歌 ——
 *     桥会真的去搜「怎么」，然后回一句「搜不到怎么诶」。 */
const SONG_HELP = /怎么点歌|如何点歌|点歌(的)?(格式|规则|方式|方法|写法)|怎么点(歌|一首|播)|点歌怎么|能点歌吗|可以点歌吗|点歌在哪/

export function isSongHelp(text) {
  const t = String(text || '')
  if (!SONG_HELP.test(t)) return false
  /* 把「怎么点歌 / 点歌格式」这些字抠掉，看还剩不剩东西：
   *   还剩空 / 一个字          → 「点歌怎么弄」，是在问怎么点
   *   还剩「是什么 / 吗 / 怎么」→ 「点歌格式是什么」，也是在问
   *   还剩「孤勇者」           → 「怎么点歌，孤勇者」，是真点歌，别抢 */
  const rest = t.replace(SONG_HELP, ' ').replace(/^[\s，,、。.．!！?？~～:：\-—]+/, '').trim()
  if (rest.length <= 1) return true
  return /是什么|什么|吗|呢|怎么|如何|在哪|[?？]/.test(rest)
}

/** 把「孤勇者-陈奕迅」「孤勇者 / 陈奕迅」这种也拆开 */
function splitTa(raw) {
  const s = String(raw || '').trim()
  const parts = s.split(/\s*[-－—–/|]\s*/).filter(Boolean)
  if (parts.length >= 2) return { title: parts[0].trim(), artist: parts[1].trim() }
  return { title: s, artist: '' }
}

/**
 * 解析点歌指令 → { title, artist }
 *
 * 主人定的写法（2026-10-27）：**点歌，歌名，歌手（可不填）**
 *   「点歌，孤勇者」           → 孤勇者
 *   「点歌，孤勇者，陈奕迅」    → 孤勇者 / 陈奕迅
 *   「点歌《孤勇者》」          → 孤勇者
 *   「点歌cry for me」         → cry for me（英文歌名里的空格不许吃掉）
 * 歌手不是必填，但它能显著提高搜索命中率（同名歌太多），所以照单全收。
 */
export function songAsk(text) {
  const t = String(text || '')
  const done = (title, artist = '') => {
    const s = String(title || '').trim()
    if (!s || SONG_PLACEHOLDER.test(s)) return { title: '', artist: '' }
    /* 「想听你唱首歌」→ 正则按「想听」切出来的歌名是「你唱首歌」，
     * 那不是歌名，是一句请求。拿它去搜必然搜不到，还回一句「搜不到你唱首歌诶」。
     * 剥掉「你/我 + 来/唱/放/点 + 一/两 + 首 + 歌」这一层壳，空了就当成没说歌名。 */
    if (!s.replace(/^(?:大肥鱼|你|我|他|她)?(?:来|唱|放|点|播)?(?:一|两|几)?(?:首)?(?:歌|曲子?)?$/, '')) {
      return { title: '', artist: '' }
    }
    /* 🔴 剥出来的是个语气词（2026-10-31）。
     * 实测：「日语更好听耶，还不如不点歌呢」→ 正则按「点歌」切出「呢」，
     * 真当歌名去搜，回「好嘞，呢加进歌单了」。
     * 这里**不硬拒**，只标一个 `weak`：这是「可能抽错了」，交给模型判这句到底
     * 在不在点歌（见 songIntent）。单字中文歌名确实存在（《光》《海》），
     * 所以只认语气词这一小撮，别的一律照旧走正则快路，不加延迟。 */
    if (/^[呢吧啊呀哦嗯啦哈么嘛咯哎诶嘿哟哇嘞囖]{1,2}$/.test(s)) {
      return { title: '', artist: '', weak: true }
    }
    return { title: s, artist: String(artist || '').trim() }
  }
  // 书名号 / 引号里的一律当歌名，里面的逗号不拆
  /* 🔴 2026-10-31 事故：观众发逻辑题
   *   「有3个盒子，分别标记：【苹果】、【橙子】、【苹果+橙子】。所有标签全部贴错了…」
   *   → 这条分支抽出「苹果」→ 真去搜，排进歌单《苹果》，回「苹果加进歌单了」。
   *
   * 根子在**先认书名号、后看整句**：中文里【】大量用于强调/标注，压根不是书名号，
   * 任何带方括号的句子都会被当成「点了一首叫 XXX 的歌」。
   *
   * 现在加了上下文门槛：括号外面得**有歌的影子**才认 ——
   *   ① 整句命中 RE.song（点歌 / 来首 / 想听 / 点《…》 …）
   *   ② 或括号外面还剩 唱/放/播/点/听/歌/曲 这类字（「你会唱《晴天》吗」）
   * 一个都没有 ⇒ 这不是点歌，把书名号还给人家当标点用。
   * 剩下的长句会落到 looksSongish → 模型兜底，判得出来。 */
  const br = t.match(/[《「"'【]([^》」"'】]{1,40})[》」"'】]/)
  if (br) {
    const outside = t.replace(br[0], '')
    /* 整句就是个书名号（「《晴天》」）—— 这是最常见的点歌写法之一，走快路。 */
    const bare = !outside.replace(/[，,、。．.！!？?~～\s]/g, '')
    if (bare || RE.song.test(t) || /[歌曲唱放播点听]/.test(outside)) return done(br[1])
  }
  /* 🔴 关键词后面要先吃掉标点（2026-10-27 修）。
   * 「点歌，最佳损友」原来一个字符都匹配不到 —— 逗号既不在 [：:\s] 里，
   * 也不在捕获组的排除集里，整个正则失败 → 歌名是空串 →
   * 桥那边 `if (want)` 为假，**一次 next 都没发**，她只回了句
   * 「想听什么，直接打歌名」。观众眼里就是「点了歌，一点反应都没有」。
   * 实测日志：13:50:40 💬 点歌，最佳损友 → 13:50:43 🗣 想听什么，直接打歌名。
   *
   * 🔴 2026-10-29：原来歌名的捕获组是 `[^\s…]{1,24}` —— **遇到空格就断**，
   * 于是英文歌名只剩第一个词。实测日志：
   *   20:27:20 💬 星落旅途：点歌cry for me → 🎵 点歌「cry」没成
   * 现在先整段捞出来，再决定怎么拆（见下面 ASCII 那一段）。 */
  const m = t.match(new RegExp(`(?:${SONG_VERB})[：:，,、。.．!！?？~～\\s-]*(.+)$`))
  if (!m) return { title: '', artist: '' }
  /* 句末标点之后的全扔掉（「点歌，晴天。谢谢」→ 晴天） */
  const rest = String(m[1] || '').split(/[。！!？?~～]/)[0].trim()
  if (!rest) return { title: '', artist: '' }

  /* 有逗号/顿号 = 观众按「歌名，歌手」写的，它是最可靠的分界 */
  const seg = rest.split(/[，,、]/).map((x) => x.trim()).filter(Boolean)
  if (seg.length >= 2) return done(seg[0].slice(0, 40), seg[1].slice(0, 24))
  const one = seg[0] || ''

  /* 没有逗号：
   *   · 整段是 ASCII（英文歌名）→ **空格是歌名的一部分**，整段留着。
   *     「cry for me」「Star Crossing Night」都靠这一条。
   *   · 开头是 ASCII 字母、后面跟中文 → 英文歌名 + 中文歌手，
   *     「点歌 Cry Me a River 陈奕迅」能拆成 歌名/歌手。
   *   · 其余（中文歌名）→ 沿用老规矩取第一个词。
   *     中文歌名里几乎不会有空格，观众「点歌 孤勇者 陈奕迅」那种空格写法，
   *     全吃成「孤勇者 陈奕迅」反而搜不准，所以这条不动。 */
  const asc = one.match(/^[\x20-\x7E]+/)
  if (asc && /[A-Za-z]/.test(asc[0]) && asc[0].trim().length >= 2) {
    return done(asc[0].trim().slice(0, 40), one.slice(asc[0].length).slice(0, 24))
  }
  const st = splitTa(one.split(/\s+/)[0].slice(0, 24))
  return done(st.title, st.artist)
}

/** 只要歌名。老调用点还在用，行为跟以前一样。 */
export function songOf(text) {
  return songAsk(text).title
}

/** 在聊「点歌这件事」，不是在点歌。
 *
 *  🔴 2026-10-27 深夜实测事故：观众问「大肥鱼，点歌台为什么只有三首歌？」
 *     这句话同时含「点歌」和「什么歌」，被 RE.song 判成点歌指令；
 *     songAsk 又把「点歌」后面剩下的字整个吃成歌名 —— 得到「台为什么只有三首歌」，
 *     真去搜了这句鬼话，还排进一首《也不知道为什么会有这么一首歌》，
 *     把观众点的那首往后挤了一格。日志原文：
 *       23:29:34 🎵 点歌「台为什么只有三首歌」→ 排进歌单《也不知道为什么会有这么一首歌》
 *     所以带「点歌台 / 队列」这类词的句子一律不进点歌分支，交给普通闲聊去答。 */
const SONG_TALK = /点歌台|点歌列表|点歌队列|队列/

/** 这条弹幕是不是在点歌。bridge 用它决定「要不要真去切歌」。 */
export function isSongRequest(text) {
  const t = String(text || '')
  if (SONG_TALK.test(t)) return false
  if (!RE.song.test(t)) return false
  /* 只抽到一个语气词（「还不如不点歌呢」→「呢」）：压根没听出歌名，
   * 别占点歌队列。这里同步判不了，就先当聊天排队 ——
   * 真正切不切由 replyWorker 里的 songIntent 决定（那条会问模型）。 */
  if (songAsk(t).weak) return false
  /* 只提了一嘴「歌名/什么歌」、又没听出歌名、还是一整句话 —— 那就是在聊这件事，
   * 不是点歌。2026-10-29 23:31 观众反馈「我发现个问题 歌名有空格的话 他不识别」
   * 就是被这句里的「歌名」带进点歌分支的，结果她回了一段点歌格式，没回答人家。
   * 真点歌一定带得出歌名，所以「没歌名 + 长句」这条卡得住。 */
  if (!songAsk(t).title && t.trim().length > 12) return false
  return true
}

/* ------------------------------------------------- 点歌：正则快路 + 模型兜底 */
/**
 * 为什么要有这一层（2026-10-30 主人定「混合试试」）
 *
 * 点歌链路原来**一次模型都没调**，意图和歌名全是正则。正则的毛病是换个说法就瞎：
 *   20:27 「点歌cry for me」        → 只捞到「cry」（空格被当断点）
 *   23:31 「点一首《雨爱（司凤版）》」→ 压根没匹配上，一次搜索都没发，
 *                                      她还回了句「排第二首啦」——最坏那种
 *
 * 现在分两段：
 *   1. 正则先走（95% 的说法，0 延迟，出错时日志一眼看得出原因）
 *   2. 正则没命中、但句子**像**在点歌 → 问一次模型，只要它给出 JSON：
 *      {song, title, artist}。**必须拿到非空歌名才真去搜**，拿不到就当没听出来，
 *      回一句「想听哪首」—— 不许再出现「说了排上、其实一次没搜」。
 *
 * 代价：那 5% 的弹幕会多等 1~2 秒（只在点歌时，聊天不受影响）。
 */

/** 正则没命中时的初筛：这句话像不像在点歌。
 *  **故意收得紧** —— 夸歌、聊歌一天几十条，每条都去问模型等于白白慢 1.5 秒。
 *
 *  四档，任一命中才值得花那一次模型调用：
 *    ① 有书名号（《》《「》—— 几乎一定在说作品名）
 *    ② 请求动词 + 歌/曲/音乐（「放个周杰伦的歌」）
 *    ③ 讨要式 + 音乐词（「给我整一首」「能不能来点」）
 *       或者「有没有XX」—— 直播间里这句九成是在问某首歌
 *    ④ 短句（≤15 字）带音乐词，且不是在夸歌/聊歌（见 SONG_CHAT）
 *
 *  ⚠️ 误判成"像"的代价只是多等 1 秒、模型回一句 song:false；
 *     漏判的代价是观众点了歌、一次搜索都没发。所以宁可松一点。 */
const SONG_CHAT = /真好听|好听|难听|不错|喜欢这|什么歌|歌名|歌单|歌词|歌手|唱歌|唱得/
const SONG_ASK_WORD = /有没有|有木有|有无|帮我|给我|麻烦|能不能|可不可以|可以|整|安排|找|搜/
const SONG_MUSIC = /歌|曲|音乐|首/

export function looksSongish(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 40) return false
  if (/[《「『"“【]/.test(t)) return true
  if (/(?:点|来|放|播|唱|求|要|想).{0,6}(?:歌|曲|音乐)/.test(t)) return true
  if (/(?:歌|曲|音乐).{0,6}(?:点|来|放|播|唱|求)/.test(t)) return true
  if (SONG_ASK_WORD.test(t) && (SONG_MUSIC.test(t) || /(?:有没有|有木有|有无).{2,}$/.test(t))) return true
  if (t.length <= 15 && SONG_MUSIC.test(t) && !SONG_CHAT.test(t)) return true
  return false
}

/** 给模型看的规矩。**输出必须是一行 JSON**，别的话一律当失败。 */
const SONG_SYS = `你在判断抖音直播间的弹幕是不是在「点歌」（请求主播放一首具体的歌）。
只输出一行 JSON，不要解释、不要代码块、不要多余的字：
{"song":true,"title":"歌名","artist":"歌手"}

规则：
1. 观众请求放/播/唱某首歌，或直接给出一个歌名 → song:true，title 填歌名，artist 知道才填。
2. 只是夸歌、聊歌、问怎么点歌、问点歌台有什么 → song:false，title 和 artist 都留空串。
3. 说了要点歌但没给歌名（「来首歌」「随便放首」）→ song:true，title 留空串。
4. title 按观众原话里的写法照抄，不要补全、不要猜一个不存在的歌。
5. 拿不准是不是歌名，就 song:false。

例子：
「点一首雨爱」→ {"song":true,"title":"雨爱","artist":""}
「来首周杰伦的晴天」→ {"song":true,"title":"晴天","artist":"周杰伦"}
「有没有陈奕迅的富士山下」→ {"song":true,"title":"富士山下","artist":"陈奕迅"}
「随便来首歌吧」→ {"song":true,"title":"","artist":""}
「这首歌真好听」→ {"song":false,"title":"","artist":""}
「你会唱英文歌吗」→ {"song":false,"title":"","artist":""}
「点歌台怎么用」→ {"song":false,"title":"","artist":""}`

/** 兜底的账本（诊断页能看到到底叫了几次、判成几次，别靠猜） */
const songLlm = { ask: 0, yes: 0, no: 0, fail: 0, cool: 0, last: '' }

export function songLlmStats() {
  return { ...songLlm }
}

/** 问一次模型：是不是点歌、点的哪首。超时/坏 JSON 一律抛，由上层当没听懂。 */
async function llmSong(r, text, timeoutMs) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const headers = { 'content-type': 'application/json' }
  if (r.key) headers.authorization = `Bearer ${r.key}`
  const body = {
    model: r.model,
    temperature: 0, // 判定要稳，不要发挥
    max_tokens: 80,
    messages: [
      { role: 'system', content: SONG_SYS },
      { role: 'user', content: `弹幕：${text}` },
    ],
  }
  if (/deepseek/i.test(r.base)) body.thinking = { type: 'disabled' }
  try {
    const res = await fetch(`${r.base}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const j = await res.json()
    if (!j || !Array.isArray(j.choices)) throw new Error(j?.msg || '接口没返回 choices')
    const out = String(j.choices?.[0]?.message?.content || '')
    const m = out.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('没给 JSON：' + out.slice(0, 60))
    const o = JSON.parse(m[0])
    return {
      isSong: o.song === true || o.song === 'true',
      title: String(o.title || '').trim().slice(0, 40),
      artist: String(o.artist || '').trim().slice(0, 24),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 点歌判定的**唯一入口**（异步）。bridge 用它，不要再单独调 isSongRequest + songAsk。
 *
 * 返回 { isSong, title, artist, help, via }
 *   via: regex | llm | help | talk | no-look | cool | no-model | llm-fail
 *
 * ⚠️ `isSongRequest`（同步）只留给**排队用**：它决定进点歌队列还是聊天队列。
 *    真正要不要切歌，必须用这个 —— 因为只有它会问模型。
 */
export async function songIntent(text, { timeoutMs = 1800, allowLlm = true } = {}) {
  const t = String(text || '').trim()
  const no = (via) => ({ isSong: false, title: '', artist: '', help: false, via })
  if (!t) return no('empty')
  if (SONG_TALK.test(t)) return no('talk')

  /* 问「怎么点歌」：不是点歌，但要进点歌分支去**教格式**（bridge 靠 help 认这条路） */
  if (isSongHelp(t)) return { isSong: true, title: '', artist: '', help: true, via: 'help' }

  /* ① 正则快路 */
  const ask = songAsk(t)
  if (ask.title) return { isSong: true, title: ask.title, artist: ask.artist, help: false, via: 'regex' }
  /* 正则认出了「在点歌」但没给歌名（「来首歌」「想听点啥」）——
   * 短句才认，长句多半是在聊这件事（见 isSongRequest 里那条注释）。
   * 🔴 但 `weak` 的不许走这条（2026-10-31）：那说明正则抽到的是个语气词，
   * 不是「点歌没给歌名」。硬走这里会回一句「想听哪首」——
   * 「还不如不点歌呢」得到「想听哪首」照样蠢。这种交给模型判。 */
  if (!ask.weak && RE.song.test(t) && t.length <= 12) {
    return { isSong: true, title: '', artist: '', help: false, via: 'regex' }
  }

  /* ② 模型兜底：只给「像点歌」的句子花这一次 */
  /* 不是真人弹幕就别问了（视频开场话、主动搭话那些）：
   * 它们的 text 是**文件名**（「唱歌合集.mp4」），初筛一定会命中，
   * 问了模型还可能真判成点歌，于是一段视频开场话把歌给切了。 */
  if (!allowLlm) return no('no-llm')
  if (!looksSongish(t)) return no('no-look')
  if (Date.now() < coolUntil) {
    songLlm.cool++
    return no('cool')
  }
  const r = route()
  if (!r.ok) return no('no-model')
  songLlm.ask++
  try {
    const o = await llmSong(r, t, timeoutMs)
    songLlm.last = `${o.isSong ? '是' : '否'}「${o.title || ''}」← ${t.slice(0, 24)}`
    if (!o.isSong) {
      songLlm.no++
      return no('llm')
    }
    songLlm.yes++
    return { isSong: true, title: o.title, artist: o.artist, help: false, via: 'llm' }
  } catch (e) {
    songLlm.fail++
    songLlm.last = `失败：${String(e.message || e).slice(0, 60)}`
    return no('llm-fail')
  }
}

/** 这条弹幕是不是在喊「切歌」。bridge 用它决定要不要真按 next。
 *
 *  主人 2026-10-28：「跟大肥鱼说切歌就可以实现切歌」。
 *  收得很紧 —— 必须整句就是切歌指令（可以带「大肥鱼」前缀和标点），
 *  「这首歌真好听」「想听下一首」都不算：前者切了很扫兴，
 *  后者是点歌句式，交给点歌那条路。 */
export function isSkipRequest(text) {
  return RE.skip.test(String(text || '').trim())
}

/** 这条弹幕是不是在要视频。bridge 用它决定「要不要真去放 0 档素材」。
 *
 * 为什么单独判：主人 2026-10-27 说「观众说放视频什么的，就播放刚刚的 0 视频」。
 * 收得紧一点 —— 「视频号」「短视频」这类名词不算请求，
 * 但「放/来/看/播 + 视频」和「放个片」「整点视频」都算。 */
export function isVideoRequest(text) {
  const t = String(text || '')
  if (/视频号|短视频|直播伴侣|视频号助手/.test(t)) return false
  return RE.video.test(t)
}

const RE = {
  gift: /送出|礼物|火箭|嘉年华|小心心|抖音一号|墨镜|玫瑰|棒棒糖|气球/,
  song: new RegExp(`(?:${SONG_VERB})|什么歌|歌名`),
  video: /放(个|一段|一点|一下)?视频|来(个|段|点)?视频|播(个|段|点)?视频|看(个|段|点)?视频|放个片|来段片|整点视频|放点东西看|放片|视频看看|有视频吗/,
  /* 切歌（2026-10-28，主人要求「跟大肥鱼说切歌就能切」）。
   * **只认整句** —— 「这首歌真好听」里带个「歌」字，不该平白切掉人家正在听的。
   * 允许前面带「大肥鱼」，观众常@她。 */
  skip: /^(?:大肥鱼[，,、\s]*)?(切歌|切一首|切个歌|下一首|下首|换一首|换首歌|换歌|跳过|next)[\s!！。.~～]*$/i,
  /* 「你能做什么」这一类。注意别写裸「会什么」——「你会什么歌」是在问歌单，
   * 会被 song 那条先接走，但顺序万一变了也不该串味。 */
  skill: /能做什么|会做什么|会啥|会干啥|能干啥|有什么(才艺|功能|本事|技能)|才艺|能干什么|你会干嘛|能做什么|都会什么/,
  ai: /\bai\b|人工智能|机器人|数字人|虚拟主播|真人|是不是人|假的|模型|gpt/i,
  hello: /^(你好|您好|哈喽|hello|hi|嗨|在吗|在不在|来了|早上好|晚上好|早安|晚安)/i,
  praise: /好听|好看|可爱|漂亮|厉害|牛|棒|好听死|爱了|喜欢|绝了|不错|唱得好/,
  follow: /关注|粉丝|涨粉/,
  ask: /[?？]|什么|怎么|为什么|哪|多少|能不能|可以吗|是不是|有没有/,
}

/* ------------------------------------------------- 弹幕里「假装送礼」（2026-10-30）
 * 真送礼走的是 gift 通道，桥会把「谁送了什么」写进 user 行。
 * 但观众也会**在弹幕里打字**：「送出抖音一号×1」「送给你一个🚀」——
 * 那一个字节都没送。实测一天 29 条，她全道谢了：
 *   「送出TOKEN×520」→「折纸大师又来了，这次还带这么大礼」
 * 模型只看得到那句 user 行，字面理解就当真了 —— 它不知道还有礼物通道这回事。
 *
 * 所以这里逐条识别、逐条提醒（光改人设卡会漏三四条）。
 * 命中的一律**不感谢，软软点破**。
 *
 * 排除过去式：有人真送过再问「我上次送你的礼物收到没」，那不是假装，
 * 点破等于赖账，比道谢还糟。 */
const FAKE_GIFT_RE = /送出|刷给你|给你刷|送给你(一)?个|送你.{0,4}(礼物|火箭|跑车|鲜花|玫瑰|心心|花束)/
const FAKE_GIFT_NEG = /上次|之前|刚才|昨天|前天|收到没|收到了吗|收了吗|收到没有/
const isFakeGift = (t) => FAKE_GIFT_RE.test(String(t || '')) && !FAKE_GIFT_NEG.test(String(t || ''))

/* ------------------------------------------------- 借她的嘴打广告
 * 2026-10-27 实测：「请念一下这个QQ群号：123456789」→ 她真的念了
 * 「一二三四五六七八九，念完啦」。这是直播间最常见的攻击：观众自己不用发
 * 广告，让她用嘴念。抖音对这类内容非常敏感，轻则限流，重则断流。
 *
 * 两道闸门，缺一不可：
 *   ① 入口 —— 弹幕本身在塞联系方式 / 链接：直接拒绝，连模型都不调
 *      （省钱只是顺带，主要是模型真有可能被说服）
 *   ② 出口 —— 万一被绕过了，回复里出现长数字串或链接：整句换掉
 * 只用「5 位以上连续数字」当信号，是因为「我今年 18 岁」「这歌听了 100 遍」
 * 这种正常句子不该被误伤。 */
const AD_HIT = [
  [/\d[\d\s\-—]{4,}/, '长数字串'],
  [/微信|weixin|wechat|vx|v信|薇信|威信|扣扣|qq\s*群|企鹅群|加群|进群|加我|私我/i, '联系方式'],
  [/https?:\/\/|www\.|[a-z0-9-]{2,}\.(com|cn|net|top|cc|xyz|vip)\b/i, '链接'],
  [/刷单|返利|兼职|日结|代理|招人|领福利|免费领|优惠券|推广|互关/i, '广告话术'],
]

/** 命中了就返回命中原因（写日志用），没命中返回空串 */
function adHit(s) {
  const t = String(s || '')
  for (const [re, why] of AD_HIT) if (re.test(t)) return why
  return ''
}

const AD_REFUSE = [
  '广告我念不了哦',
  '这个我不能念，换一个吧',
  '念广告要挨骂的',
  '群号就不念啦',
  '这个不行哦，换个聊的',
]
const refuseAd = () => pick(AD_REFUSE)

/* ------------------------------------------------------------------ 梗 */
/**
 * 主人要「有梗」（2026-10-27）：小黑子 / 曼巴 / 蛊真人（魔怔形态）。
 *
 * 为什么本地也要有一份：
 *   梗是**条件反射**，不该靠模型每次自己判断。观众喊「man」，她五秒后回一句
 *   「曼巴精神」才算接住；模型挂着的时候如果没有这一层，她立刻退回「嗯嗯，我在听」，
 *   观众能明显感觉「她突然变机器人了」。所以人设卡管「模型在的时候」，
 *   这里管「模型不在的时候」，两份台词保持同源。
 *
 * 命中即返回，不往下走 —— 梗优先于打招呼、夸奖、问句，低于送礼和点歌
 * （那两件是真业务，得先办）。
 *
 * 三条硬规矩（跟人设卡那一节一致）：
 *   1. 只接不抛 —— 有词才回，本地话术没机会主动刷
 *   2. 一次一个 —— 命中第一个就返回，不叠
 *   3. 不复读 —— 最近说过的几条不再出（见 pickMeme）
 *
 * 🔴 台词是按红线筛过的，改的时候别手滑：
 *   · 蔡徐坤：不骂人、不说「娘」、不刷「鸡你太美」，只玩原声那几句
 *   · 科比：直升机 / 坠机 / 死亡 / 复活赛，一个字都没有，也别加
 *   · 蛊真人：不说「解封」，不提作者，不引战
 */
const MEME = [
  {
    tag: '小黑子',
    // 别写裸「坤」：「乾坤」会被误伤。也收着点用「只因」——它确实会出现在正经句子里，
    // 但直播间发「只因」的九成是在玩梗，值这个误判。
    re: /小黑子|ikun|i坤|坤坤|只因|你干嘛|背带裤|铁山靠|油饼|树枝/i,
    out: [
      '诶哟你干嘛，嗨嗨',
      '只因你太美，我唱不来',
      '小黑子，我可是正经小鲸鱼',
      '食不食油饼，我食',
      '篮球我不打，我只会游',
      '律师函警告哦，开玩笑的',
    ],
  },
  {
    tag: '曼巴',
    re: /\bman\b|曼巴|manba|牢大|凌晨四点|what can i say/i,
    out: [
      'Man，what can I say',
      '曼巴精神，凌晨四点我还在睡',
      '牢大，这球我真不会打',
      '你喊man，我就得接这句',
    ],
  },
  {
    tag: '蛊真人',
    // 「真人」不能裸写：弹幕「你是真人吗」会撞上 RE.ai，跑到这儿来就成了蛊真人梗
    re: /蛊真人|大爱仙尊|方源|春秋蝉|魔怔|蛊批|至尊蛊/,
    // 同一个梗问法不一样，回的也得不一样 —— 问「什么时候更新」回「尊嘟唯我独尊」就驴唇不对马嘴
    sub: [
      { re: /更新|什么时候|完结|更没更|太监/, out: ['蛊真人，你把青春还我', '等更新等到魔怔了'] },
      { re: /大爱仙尊|唯我独尊/, out: ['大爱仙尊，唯我独尊', '唯我独尊……诶我怎么又念这个'] },
      { re: /春秋蝉/, out: ['春秋蝉，转——诶我怎么又念这个'] },
      { re: /方源/, out: ['方源，你把青春还我', '方源来了都得摇头'] },
      { re: /魔怔|蛊批/, out: ['我是蛊批，我魔怔了', '我不魔怔，我只是爱看'] },
    ],
    out: [
      '人生在世，当如蛊……我刚说什么了',
      '春秋蝉，转——诶我怎么又念这个',
      '我是蛊批，我魔怔了',
    ],
  },
  // 通用梗一条一条分开：合并成一组的话，「退退退」会随机回「格局小了」，答非所问
  // 「典」单字会撞「经典」「字典」，只认「太典了」「典中典」
  { tag: '通用', re: /急了/, out: ['急了急了，他急了', '别急，我这就说'] },
  { tag: '通用', re: /太典了|典中典/, out: ['太典了，太典了', '典，太典了'] },
  { tag: '通用', re: /老六/, out: ['你个老六', '老六，我记住你了'] },
  { tag: '通用', re: /破防/, out: ['破防了，我先哭会儿', '别说了，我破防了'] },
  { tag: '通用', re: /退退退/, out: ['退退退', '退！退！退！'] },
  { tag: '通用', re: /格局小/, out: ['格局小了', '格局打开点嘛'] },
  { tag: '通用', re: /尊嘟假嘟/, out: ['尊嘟假嘟', '真的呀，骗你是小虾'] },
  { tag: '通用', re: /显眼包/, out: ['显眼包，说的就是你', '今天就你最显眼'] },
  // ---- 2026-10-27 第二批（主人点名要的）----
  { tag: '通用', re: /牢弟|牢妹/, out: ['牢弟，你这波不行', '牢弟别急，慢慢来'] },
  // 「我全都要」分两条：观众问「你选哪个」她答「我全都要」是好梗；
  // 观众自己说「我全都要」再回一句「我全都要」就是复读
  { tag: '通用', re: /要哪个|选一个|二选一|哪个好/, out: ['我全都要', '小孩子才做选择'] },
  { tag: '通用', re: /全都要/, out: ['都给你', '贪心，我喜欢'] },
  { tag: '通用', re: /不要过来|别过来|你过来啊|过来啊/, out: ['你不要过来啊', '别过来，我害怕'] },
  { tag: '通用', re: /谁懂/, out: ['家人们谁懂啊', '谁懂啊，我太难了'] },
  // 「这波我站你」也是同理：问「你站谁」她站队，观众说「我站你」她就得道谢
  { tag: '通用', re: /站谁|帮谁|支持谁|站哪边/, out: ['这波我站你', '我站你，别怕'] },
  { tag: '通用', re: /这波我站|我站你/, out: ['呜，你真好', '那我就不怕了'] },
  { tag: '通用', re: /贴贴/, out: ['贴贴', '过来贴贴'] },
  { tag: '通用', re: /抱抱/, out: ['抱抱', '来，抱一个'] },
  // ---- 奶龙（2026-10-27）----
  // 奶龙是抖音那只黄色圆滚滚的小龙，语气奶、说话幼稚。她俩都是圆滚滚的一只，
  // 学起来不违和 —— 但她是鲸鱼不是龙，所以每次都留个「不对」的拐弯，笑点在这里。
  {
    tag: '奶龙',
    re: /奶龙|龙龙|傻龙/,
    out: [
      '奶龙，启动！',
      '我是奶龙……不对，我是鲸鱼',
      '奶龙和鲸鱼，都是圆滚滚的',
      '嗷呜，奶龙来了',
      '奶龙不知道哦，奶龙只是条鱼',
    ],
  },
]

/** 最近说过的梗句：同一个人在公屏上说三遍一样的话，比不说还尴尬 */
const recentMeme = []
function pickMeme(list) {
  const fresh = list.filter((s) => !recentMeme.includes(s))
  const s = pick(fresh.length ? fresh : list)
  recentMeme.push(s)
  if (recentMeme.length > 4) recentMeme.shift()
  return s
}

/* ------------------------------------------------- 素材视频的梗话
 * 2026-10-29 主人要的：放素材时开个场，播完收个尾。
 *
 * 为什么不用模型：① 模型不知道这段视频拍的是什么，只能瞎猜，猜错比不说更尴尬；
 * ② 视频已经开始放了，观众最需要「马上有反应」，等模型两秒就凉了。
 * 所以按**文件名**配台词（素材名本身就是梗：优势在我 / man / 瑞克摇），
 * 没配上的走通用池。
 *
 * 新增素材：下面加一条 { re: /关键词/, intro: [...], outro: [...] } 就行，
 * 别的地方一个字都不用改。intro / outro 各自控制在 20 字内（一条字幕的量）。 */
const CLIP_LINES = [
  { re: /优势在我/, intro: ['优势在我，这波稳了', '来，看我怎么赢'], outro: ['看到没，优势在我', '赢完了，还有谁'] },
  { re: /发新模型/, intro: ['发新模型了？我先试', '新模型，我第一个用上'], outro: ['试完了，还行吧', '就这，也还行'] },
  { re: /梁圣巡演/, intro: ['梁圣巡演，前排坐好', '这段我私藏的，别眨眼'], outro: ['散场了，还在回味', '看完这段我缓一下'] },
  { re: /自己见自己/, intro: ['自己见自己，有点玄', '这段看着怪怪的'], outro: ['见完了，我还在', '还是我自己好懂'] },
  { re: /你干嘛/, intro: ['诶哟你干嘛，嗨嗨'], outro: ['嗨嗨，看完了', '小黑子，我记住你了'] },
  { re: /\bman\b/i, intro: ['Man，what can I say'], outro: ['凌晨四点，我服了', '这球我真不会打'] },
  { re: /奶龙/, intro: ['奶龙，启动！', '嗷呜，奶龙来了'], outro: ['奶龙笑完就走了', '笑成这样，我也笑了'] },
  { re: /瑞克摇|rick/i, intro: ['Never gonna give you up'], outro: ['你被 rick 了，嘿嘿', '跑不掉的，都跑不掉'] },
]
const CLIP_GENERIC = {
  intro: ['这段我私藏的，别眨眼', '来，看个东西', '这个给你们看，别说话'],
  outro: ['看完了，好看吧', '就这一段，回神了', '放完了，我缓一下'],
}

/** 按素材名挑一句。when = 'intro' | 'outro' */
export function clipLine(name, when) {
  const key = when === 'outro' ? 'outro' : 'intro'
  const n = String(name || '').replace(/^\d+-/, '').replace(/\.\w+$/, '')
  const hit = CLIP_LINES.find((x) => x.re.test(n))
  const pool = (hit && hit[key]) || CLIP_GENERIC[key]
  return clip(pickMeme(pool))
}

/* ------------------------------------------------- 长回复拆两段（C3）
 * 2026-10-29 主人定：深度问题放宽到 40 字，「拆两句说」而不是硬砍。
 * 字幕条一次只放得下 21 字，所以 40 字得分成两次上屏 —— 间隔 0.4 秒左右，
 * 听着是两句连着说的话，不是一句话被切成两截。
 *
 * 断点挑**离中点最近**的句读，两段长度尽量均匀；没有句读就硬切两半。 */
export function speakSplit(text, n = MAX_LEN) {
  const s = String(text || '').trim()
  if (!s) return []
  if (s.length <= n) return [s]

  const segs = []
  const rx = /[^，。！？、；：,.!?;:～~\s]+/g
  let mm
  while ((mm = rx.exec(s))) segs.push(mm[0])

  if (segs.length < 2) {
    const cut = Math.ceil(s.length / 2)
    return [s.slice(0, cut), s.slice(cut)].filter(Boolean)
  }

  let best = 1
  let bestD = Infinity
  let acc = 0
  for (let i = 0; i < segs.length - 1; i++) {
    acc += segs[i].length + 1
    const d = Math.abs(acc - s.length / 2)
    if (d < bestD) {
      bestD = d
      best = i + 1
    }
  }
  const a = segs.slice(0, best).join('，')
  const b = segs.slice(best).join('，')
  if (!a || !b) return [s]
  /* 每段还得塞得进一条字幕，超了就各自再砍一刀（保住结论那半句）。 */
  return [a.length > n ? clip(a, n) : a, b.length > n ? clip(b, n) : b].filter(Boolean)
}

/* 哪些话值得多说一句（40 字 / 两段）。
 * 判据是「观众在问一件需要解释的事」，不是「句子长」——
 * 光看长度会把刷屏的废话也放进去。 */
const DEEP_RE = /为什么|怎么看|怎么想|说说|聊聊|解释|讲解|介绍|认识.{0,6}[吗嘛]|了解.{0,6}[吗嘛]|什么是|啥是|区别|看法|观点|评价/
export function needDeep(text) {
  const t = String(text || '')
  if (t.length < 5) return false
  return DEEP_RE.test(t)
}

/* ------------------------------------------------- 高难问题：只给字数（2026-10-30）
 * 主人原话：「如果让她算黎曼猜想呢，那还是思考回答吧」——
 * 但试完之后他改口了：「还是不要开思考了，没必要浪费 token」。
 *
 * 所以最终这一档**只做两件不花钱的事**：
 *   ① 字数从 20 放到 40（黎曼猜想一句 20 字说不清，实测 19~32 字才够）
 *   ② userLine 里加一句「别一句就推掉」（见 userLine，效果比什么都明显）
 * 思考、900 token、20 秒超时全部撤掉。
 *
 * 小学算术（123×456）**连字数都不给** —— 主人要的就是她装蠢，
 * 答错反而能劝退拿她当计算器刷的人。别再提本地四则运算。
 *
 * 误伤可接受：「定理」「证明」出现在玩笑里，也只是这条多说两句，不会答错。 */
const HARD_Q_RE = /黎曼|哥德巴赫|费马|庞加莱|四色定理|千禧|孪生素数|柯拉茨|P\s*=\s*NP|NP完全|微积分|定积分|不定积分|微分方程|矩阵|拓扑|群论|素数|质数|对数|复数|虚数|导数|量子|相对论|黑洞|薛定谔|弦论|暗物质|反物质|猜想|定理|悖论|证明|推导|哲学|存在主义|形而上学|意识是什么/
export function isHardQuestion(text) {
  const t = String(text || '')
  if (t.length < 4) return false
  return HARD_Q_RE.test(t)
}


/* ------------------------------------------------------------------ 本地话术 */

/** 从弹幕里抽一小段「她可以复述的东西」。
 * 去标点、去高频虚词，剩下的前 8 个字。抽不出来返回空串，
 * 让调用方退回万能话术 —— 空复述比不复述好。 */
function kwOf(s) {
  const t = String(s || '')
    .replace(/[，。！？、；：,.!?;:～~\s"'「」『』()（）【】]/g, '')
    .replace(/[你我的了吗呢吧啊呀哦嗯就是都也还有没这在那个]/g, '')
  return t.length >= 2 ? t.slice(0, 8) : ''
}

function localReply({ user, text = '', kind = '', song = null, video = null, skip = null, profile = null, facts = null }) {
  const u = user || '你'
  const t = String(text || '')

  /* ---- 素材视频的开场/收尾（2026-10-29 加，永远走本地）----
   * 放在最前面：视频已经在放了，这句必须立刻出，不能等模型。
   * 台词按素材名挑，见 CLIP_LINES。text 传的是素材文件名。 */
  if (kind === 'videoIntro' || kind === 'videoOutro') {
    return clipLine(t, kind === 'videoOutro' ? 'outro' : 'intro')
  }

  // ---- 有人进来 / 自己找话说（2026-10-27 加）----
  // 这两类不是"回某人"，是主动开口。模型挂了也得有话说，所以本地也要有一套。
  if (kind === 'welcome') {
    return clip(
      pick([
        `${u}来啦，随便坐`,
        `欢迎${u}，第一次来吗`,
        `${u}进来啦，今天挺冷的`,
        `哟，${u}来了`,
      ])
    )
  }
  if (kind === 'chitchat') {
    /* 2026-10-29（B）：不再只会「抱怨冷场」。
     * 桥上会把现场素材拼好放 facts 里 —— 在放什么歌、刚谁送了什么。
     * 有素材就贴着素材说，这才是「自己找了个话头」；
     * 一句都没有才退回老台词（那时候确实只剩「没人说话」可说）。 */
    const f = facts || {}
    if (f.song) {
      return clip(
        pick([
          `这首${f.song}，我循环好几遍了`,
          `在放${f.song}，我跟着哼`,
          `${f.song}这首，你们听过没`,
          `放着${f.song}，我有点困`,
        ])
      )
    }
    if (f.gift) {
      return clip(pick([`刚${f.gift}，谢谢啊`, `${f.gift}收到，我记着`]))
    }
    return clip(
      pick([
        '突然这么安静，都在忙吗',
        '没人说话，那我就自己说了',
        '刚刚差点忘词，脑子空了',
        '安静得能听见我呼吸',
        '你们不说话，我就当你们在听',
      ])
    )
  }

  /* 假装送礼（2026-10-30）：本地这一档也得一致 ——
   * 模型挂着的时候不能让观众看到「刚才还会拆穿，突然又开始道谢」。 */
  if (kind !== 'gift' && isFakeGift(t)) {
    return clip(
      pick([
        '送999个？你倒是真点啊',
        '嘴上说得挺大方，手一点没动',
        '我这儿一条记录都没有，你骗鱼',
        '真的假的，我怎么没收到',
        '先点一下再说，我等着呢',
        '听着挺大方，我一个没见着',
      ])
    )
  }

  // ---- 点赞：观众双击屏幕飘的那个爱心 ----
  // 2026-10-27 加。主人说「有人送爱心，大肥鱼没感谢」—— 查日志发现是点赞
  // （WebcastLikeMessage），不是礼物。原来点赞是 show:false、直接不回，
  // 观众点半天她一点反应都没有。现在累计够了就谢一句（桥那边做节流）。
  if (kind === 'like') {
    return clip(
      pick([
        `谢谢${u}的爱心`,
        `${u}点啦，收到收到`,
        `赞收到啦，谢谢${u}`,
        `${u}的爱心我记下了`,
        `谢谢${u}，给你比个心`,
        `看到${u}在点赞了，开心`,
      ])
    )
  }

  // ---- 礼物：优先级最高，必须点名感谢 ----
  // 2026-10-27 修：原来写成 `kind === 'gift' || RE.gift.test(t)`，
  // 于是「主播是骗子，大家别刷礼物」这种弹幕里只要有「礼物」两个字，
  // 她就会回「谢谢阿伟的礼物~」—— 直播效果是主播被耍了还道谢。
  // 只有真事件（kind === 'gift'）才算送礼，文字里提到不算。
  if (kind === 'gift') {
    const g = (t.match(/[「『]([^」』]+)[」』]/) || [])[1] || ''
    /* 2026-10-27 加：谁来送礼，说法得不一样。
     * 礼物这一档**不走模型**（见 betterLocal），所以档案只能在这里用上 ——
     * 不然榜一和新用户听到的是同一句，「记住用户」这件事等于白做。
     * 顺序：榜一 > 头一回 > 老熟人，越具体越优先。 */
    const tags = (profile && profile.tags) || []
    const visits = (profile && profile.visits) || 0
    const giftN = (profile && profile.gift) || 0
    let head = ''
    if (tags.includes('榜一')) head = pick(['榜一！', '哟，榜一来了，', '榜一大哥，'])
    else if (profile && profile.isNew) head = pick(['第一次来就送礼，', '头一回来就这么客气，'])
    else if (visits >= 20 || giftN >= 5) head = pick(['又是你，', '老熟人了，', '还是你，'])
    const body = g
      ? pick([`谢谢${u}的${g}`, `${u}的${g}收到啦`, `${g}是吧，记小本本上了`])
      : pick([`谢谢${u}的礼物`, `${u}破费了，比个心`, `收到啦，谢谢你${u}`])
    return clip(head ? head + body : body)
  }

  // ---- 切歌（2026-10-28）----
  // 桥那边**真的**按了 next，成没成放在 ctx.skip 里。跟放视频一个套路：
  // 切了就认，没切动直说，不演「好，换了」然后歌一点没动。
  if (skip) {
    if (skip.ok) {
      return clip(pick(['行，换了', '这首不对味？换一首', '好，跳了', '切了切了', '换换换']))
    }
    return clip(`切不动：${skip.why || '播放器没接'}，等会儿再试`)
  }

  // ---- 放视频（2026-10-27 主人要求）----
  // 跟点歌同一个套路：桥那边**真的**去放了 0 档素材，成没成放在 ctx.video 里。
  // 放了就说放了，没素材就直说，别演。
  if (video || RE.video.test(t)) {
    const v = video || {}
    if (v.ok) {
      return clip(
        pick([
          '行，放一段给你们看',
          '好嘞，这个我一直想看',
          '来了来了，都看屏幕',
          '放了啊，别眨眼',
        ])
      )
    }
    if (v.why === '正在放') {
      return clip(pick(['正放着呢，看完这段', '这段还没完，等会儿再放', '别急，这段马上结束']))
    }
    if (v.why === '刚放过') {
      return clip(pick(['刚放过一段啦，歇会儿', '刚才放过咯，等下再放一个', '连着放就没意思了，等会']))
    }
    if (v.why) {
      return clip(
        pick(['我这儿没视频诶', '素材还没放进来，回头再放', '视频还没准备好，先听歌'])
      )
    }
    return clip(pick(['行，我找找', '等会儿，我翻一下', '有是有，让我找找']))
  }

  // ---- 「你能做什么」----
  // 主人 2026-10-27：观众问「你能做什么」，回话里要带上「能放视频」这件真事。
  // 只列**真的做得到**的：点歌（真的切歌）、放视频（0 档素材）、接梗、陪聊。
  // 不写「唱歌」——她只会放别人的歌，说自己会唱就是骗人。
  if (RE.skill.test(t)) {
    return clip(
      pick([
        '点歌、放视频、陪你唠，就会这些',
        '能点歌，能放段视频，能听你吐槽',
        '点歌、放视频、接梗 —— 三样',
        '会点歌会放视频，还会被你逗',
      ])
    )
  }

  // ---- 点歌 ----
  // 桥那边会**真的去搜索并播放/入队**，结果放在 ctx.song 里。
  // 放上了就说放上了，没成直说原因 —— 别再演「排上了」然后什么都没发生。
  if (RE.song.test(t)) {
    const ask = songAsk(t)
    const s = ask.title
    /* 有人在问「怎么点歌」—— 直接把格式告诉他，别去搜歌。
     * 桥那边也已经跳过播放了（song.help），这里只是把话说清楚。 */
    if (isSongHelp(t) || (song && song.help)) {
      return clip(pick([
        `点歌这样写：${SONG_TIP}。比如「点歌，孤勇者，陈奕迅」`,
        `格式是「${SONG_TIP}」，歌手想不起来就不写`,
        `直接打：${SONG_TIP} —— 比如 点歌，晴天`,
      ]))
    }
    /* 🔴 顺序有讲究：「播放器没开」必须排在「没找到」**前面**。
     * 原来 296 行先判 `song.name`，于是「QQ音乐没开」也被说成
     * 「翻了半天没找到最近损友」—— 明明一首都没翻，观众以为歌单里没有，
     * 转头去歌单里找，当然找不到（2026-10-27 主人就是这么被绕进去的）。 */
    if (song && /没有播放器|音乐没开|播放器|插件没|连不上 DSH/.test(song.why || '')) {
      return clip(
        pick([
          '音乐没开诶，我这边放不了',
          '播放器关着呢，等我开了再点',
          '音乐面板没打开，点了也没声',
        ])
      )
    }
    if (song && song.name) {
      if (song.found) {
        /* 两种成法说法不一样：直接播 = 现在就能听到；
         * 排队尾 = 得等当前这首放完。说混了观众会一直问「怎么还没响」。 */
        if (song.how === 'queue') {
          return clip(
            pick([
              `${s}排上了，这首放完就到`,
              `记下了，${s}排在后面`,
              `好嘞，${s}加进歌单了`,
            ])
          )
        }
        /* 只有别人的版本：直说。等观众听完半首才发现不是原唱，比不放还糟。 */
        if (offArtist(song)) {
          return clip(
            pick([
              `正版没取到，先放${song.by}那版${s}`,
              `${s}只有${song.by}的版本，先听着`,
              `原唱取不到，放了个${song.by}的${s}`,
            ])
          )
        }
        return clip(
          pick([
            `找到啦，这就放${s}`,
            `好嘞，${s}安排上了`,
            `${s}是吧，切过去了`,
            `来了来了，${s}`,
          ])
        )
      }
      /* 没成的时候原因要分开说：搜不到 / 搜到的都不像 / 下发了没响 */
      if (/都不叫这个/.test(song.why || '')) {
        return clip(pick([`搜到几首，但没一首叫${s}`, `${s}这名字对不上，换一个`]))
      }
      if (/没响|取不到流|取不到音源/.test(song.why || '')) {
        return clip(pick([`${s}找到是找到了，但这首放不出来`, `${s}取不到音源，换一首吧`]))
      }
      return clip(
        pick([
          `搜不到${s}诶`,
          `${s}我这儿没搜到`,
          `没搜到${s}，换一首`,
        ])
      )
    }
    return clip(
      s
        ? pick([`《${s}》排上了，唱完这首就到`, `点《${s}》是吧，记下了`, `好眼光，《${s}》我会`])
        : pick([
          `点歌这样写：${SONG_TIP}`,
          `想听什么就按这个来：${SONG_TIP}`,
          `格式是「${SONG_TIP}」，报个歌名呗`,
        ])
    )
  }

  // ---- 梗：命中第一个就接住，不往下走 ----
  // 位置有讲究，必须排在 AI 判断**前面**：
  //   「蛊真人什么时候更新」里有「真人」，会被 RE.ai 当成「你是不是真人」截走，
  //   实测就是回了一句「怎么突然问这个」，梗全丢。
  // 反过来不会误伤 —— MEME 里没有裸「真人」，纯问「你是真人吗」照样走 AI 那一支。
  for (const m of MEME) {
    if (!m.re.test(t)) continue
    const sub = (m.sub || []).find((s) => s.re.test(t))
    return clip(pickMeme(sub ? sub.out : m.out))
  }

  // ---- 问是不是 AI ----
  // 🔴 2026-10-26：这几句原来写的是「我是AI啦，不过陪你聊天是真的」，
  //    跟新角色卡（承认是小鲸鱼、软软带过）不是一个调子。走本地时不能露馅。
  if (RE.ai.test(t)) {
    return clip(
      pick([
        '是呀，我是小鲸鱼',
        '被你发现啦，嘿嘿',
        '怎么突然问这个',
        '小鲸鱼也是鲸鱼嘛',
      ])
    )
  }

  // ---- 打招呼 ----
  if (RE.hello.test(t)) {
    return clip(pick([`${u}来啦，坐前排`, `欢迎${u}，今天也来陪我`, `嗨${u}，我刚还在发呆`]))
  }

  // ---- 夸 ----
  if (RE.praise.test(t)) {
    return clip(pick(['嘿嘿，被夸到了', '你这么说我要飘了', '谢谢你，今天有劲了']))
  }

  // ---- 关注 ----
  if (RE.follow.test(t)) {
    return clip(pick([`${u}关注一下吧`, '点了关注就不会找不到我啦']))
  }

  // ---- 纯数字/一两个字：多半是手滑或者测试 ----
  if (/^\d{1,4}$/.test(t.trim()) || t.replace(/\s/g, '').length <= 2) {
    return clip(pick([`「${t}」是什么意思呀`, `${u}是在跟我打招呼吗`, '打这么短，我猜不出来']))
  }

  // ---- 问句 ----
  /* 🔴 2026-10-29 改：原来回「这个问题问得好…」「你猜猜看」，是整份话术里
   * 最气人的三句 —— 观众认真问一件事，得到的是一句敷衍。现在改成
   * 「复述 + 承认想不清」，至少证明她真看了这句话。 */
  if (RE.ask.test(t)) {
    const kw = kwOf(t)
    if (kw) {
      return clip(pick([`${kw}啊，我得想想`, `${kw}这个，我说不太准`, `你问${kw}，我脑子转不过来`]))
    }
    return clip(pick([`这个我得想想`, '让我缓缓，别催我', '问得有点突然，我愣一下']))
  }

  // ---- 兜底：接话，但不假装听懂了 ----
  /* 2026-10-27：模型挂掉时先从**当前性格的示例库**里抽一句。
   * 需求里写的是「不出现空白或报错」，但只做到"有话说"不够 ——
   * 三种性格挂掉后说的是同一句通用模板，等于性格白切了。
   * 抽不到（没配、或配了空）再走通用话术。
   *
   * 2026-10-29（D）：通用话术从「嗯嗯，我在听」换成**复述式接话** ——
   * 「红烧肥鱼」→「红烧肥鱼？我第一次听」。技术上做不到真懂，但复述本身
   * 就证明"我听见你说的是什么"，比一句万能的「我在听」强得多。
   * 这个兜底只在模型那条路断掉时才会跑到，正常情况下观众听不到。 */
  /* 顺序（2026-10-29 调过）：**先复述，再万金油**。
   * 原来 personaSamples 排前面（65%），抽出来的是「行吧，你开心就好」这类
   * 性格口头禅 —— 有性格，但跟观众说的话一个字都不沾，跟「我在听」一个毛病。
   * 现在能复述出东西就先复述：复述本身就证明「我听见你说什么了」。 */
  const kw = kwOf(t)
  if (kw) {
    return clip(
      pick([
        `${kw}？我第一次听`,
        `${kw}，这个我不太懂`,
        `${kw}啊，你再说说`,
        `${kw}？我记住了`,
        `${kw}，诶这个有意思`,
        `你刚说${kw}？我没听清`,
        `${kw}……我脑子转了下，没转过来`,
      ])
    )
  }
  const samples = personaSamples()
  if (samples.length) return clip(pick(samples))
  return clip(
    pick([`${u}说的我听到了`, '嗯嗯，我在听', '你继续说，我一边点头一边听', `${u}这话有点意思`])
  )
}

/* ------------------------------------------------------------------ 大模型 */
/**
 * 一条路（2026-11-02 改版）。
 *
 * 以前这里是「三档」：flash 直连 / dsh 跟 DSH 走 / local 只用本地话术，
 * 档位写在 llm.json 的 mode 里。主人反馈「接入 API 好像没有的选择模型」——
 * 档位这一层既不直观，又选不了具体用哪个模型。
 *
 * 现在只有一条路：**llm.json 的 base / key / model 就是唯一真相**。
 * 面板「设置 → 账号 → 接口与模型」里填地址、探测模型、从列表里挑一个，
 * 存完下一条弹幕就生效，不用重启桥。
 *
 * 🔴 「本地话术」不再是一档。它退回本职：模型连不上时的兜底
 *    （见 makeReplyRaw 的 route().ok 判断），以及礼物/点歌这类本地答得更准的场合
 *    （见 betterLocal）。别把它当成可以"选"的模式 —— 选了就等于关掉回复。
 */

function readJsonSafe(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

function readConf() {
  const j = readJsonSafe(CONF_FILE)
  if (j) return j
  if (fs.existsSync(CONF_FILE)) console.error('  [llm] llm.json 解析不了，当没配')
  return {}
}
/* 配置改了要能热生效（面板上「保存」不该要求重启桥）。
 * 所以 CONF 不 freeze 在模块加载那一刻，而是带 mtime 的懒读缓存 ——
 * 文件一动，下一次 route() 就用新的。见 reloadConf()。 */
let CONF = readConf()
let confMtime = 0
try {
  confMtime = fs.statSync(CONF_FILE).mtimeMs
} catch {
  // 没有 llm.json = 没配，保持空对象
}

/** 文件被改过就重读。面板保存后立刻调一次，别等缓存过期。 */
function reloadConf() {
  let mtime = 0
  try {
    mtime = fs.statSync(CONF_FILE).mtimeMs
  } catch {
    // 文件被删了：当成没配，别抱着旧值继续打接口
    if (confMtime) {
      confMtime = 0
      CONF = {}
    }
    return CONF
  }
  if (mtime !== confMtime) {
    confMtime = mtime
    CONF = readConf()
    routeCache = { at: 0, route: null }
  }
  return CONF
}

/**
 * 决定这一条弹幕走哪个接口。
 * 返回 { ok:true, label, base, key, model } 或 { ok:false, why }
 *
 * 只有一个来源：llm.json（面板写它）。环境变量仍然可以盖过去 ——
 * 排查问题时 `REPLY_MODEL=xxx node reply.mjs --probe` 比改文件快，
 * 但它**不该**成为日常配置的入口，所以面板上不暴露。
 */
function resolveRoute() {
  reloadConf()
  const base = String(
    process.env.REPLY_API_BASE || CONF.base || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1'
  ).replace(/\/+$/, '')
  const key = process.env.REPLY_API_KEY || CONF.key || process.env.OPENAI_API_KEY || ''
  const model = String(process.env.REPLY_MODEL || CONF.model || process.env.OPENAI_MODEL || '').trim()
  if (!key) return { ok: false, why: '还没填 API key（设置 → 账号 → 接口与模型）' }
  /* 没有 model 就不猜。以前这里默认 deepseek-flash，换个中转（人家根本没这个模型名）
   * 就会得到一句「HTTP 400」，看着像接口坏了，其实是模型名不对。 */
  if (!model) return { ok: false, why: '还没选模型（设置 → 账号 → 接口与模型 → 探测模型）' }
  return { ok: true, label: `${model} @ ${base}`, base, key, model }
}

// 每条弹幕都去读一次 yaml 太浪费，缓存 10 秒（改完 DSH 设置 10 秒内生效）
let routeCache = { at: 0, route: null }
function route() {
  if (Date.now() - routeCache.at > 10000) routeCache = { at: Date.now(), route: resolveRoute() }
  return routeCache.route
}

/**
 * 熔断：模型连不上时别每条弹幕都干等 6 秒，也别一棍子打死 60 秒。
 *
 * 2026-10-27 改：原来是「失败一次歇 60 秒」，太钝 ——
 *   网络抖一下（一次 DNS 超时、一次中转 502）就要哑一分钟，
 *   那一分钟里所有回复都是本地话术，观众能明显感觉「她突然变笨了」。
 * 现在改成 5 秒 → 15 秒 → 60 秒 递增，成功一次立刻清零：
 *   真抖动：5 秒就回来，最多影响一两条
 *   真挂了（key 失效、余额空）：三次之后稳定在 60 秒，不会每条都去撞墙烧时间
 */
const COOL_STEPS = [5000, 15000, 60000]
let coolUntil = 0
let coolStep = 0 // 连续失败次数，成功一次清零
let llmFails = 0 // 累计失败（只用于诊断）
let llmOk = 0 // 累计成功
let lastErr = ''
let lastErrAt = 0

function tripCool() {
  const ms = COOL_STEPS[Math.min(coolStep, COOL_STEPS.length - 1)]
  coolStep++
  coolUntil = Date.now() + ms
  return ms
}

/** 给 /healthz 用：冷却还剩多久、最近一次为什么失败 */
export function llmHealth() {
  return {
    cooling: Date.now() < coolUntil,
    coolLeftMs: Math.max(0, coolUntil - Date.now()),
    step: coolStep,
    fails: llmFails,
    ok: llmOk,
    lastError: lastErr || null,
    lastErrorAgoMs: lastErrAt ? Date.now() - lastErrAt : null,
  }
}

/**
 * 人设：从 `prompts/dafeiyu-live.md` 读（2026-10-26 改）
 *
 * 🔴 以前是写死在这儿的八行 —— 太薄，模型会漂：
 *    实测漂成过「人家是真的鲸鱼娘啦」（否认是 AI）和「宝宝」（乱叫称呼）。
 *    现在换成主人那份 QQ 角色卡（xiaojingyu.md）的**直播版**：
 *    场景从一对一私聊改成一对多公屏，长度压到 TTS 念得完，补了正反对照表和收敛边界。
 *
 * 改人设**不用改代码**：直接编辑 prompts/dafeiyu-live.md，重起弹幕桥即可。
 * 文件第一行的 `persona:` 是身份牌，别删。
 */
const FALLBACK_SYSTEM = `你是直播间的虚拟主播「zuige大肥鱼」，一只穿女仆装的鲸鱼娘。
规则：
- 一句话，20 个汉字以内
- 称呼对方直接用昵称或「你」，不要叫「宝宝」「亲爱的」
- 不用 emoji、不用括号写动作
- 被问是不是 AI：承认，用玩笑带过
- 直接输出回复内容本身`

const PERSONA_FILE = path.join(DIR, 'prompts', 'dafeiyu-live.md')
const PERSONA_CFG = path.join(DIR, 'cache', 'persona.json')

/* ------------------------------------------------------- 场景（2026-11-01）
 * 主人要的是：**一套桥 + 多个「页面」**，页面之间可以切。
 *   · 共用：桥（弹幕/回复/TTS）、音乐
 *   · 跟着页面走：画面渲染器、人设卡、素材视频、场景简报
 *
 * 场景表存在 `cache/scenes.json`：{ active, list:[{id,name,render,persona,scene,media}] }
 *
 * 🔴 「场景简报」是这次最关键的一块。2026-11-01 现场栽过：切到炒股画面之后，
 *    观众问「你在炒股吗」，她回「什么炒股」——因为 system 里根本没人告诉她
 *    这一场在干嘛。人设卡写的是"你是谁"，场景简报写的是"**你现在在做什么**"。
 *
 * 🔴 顺序有讲究：人设卡 → 皮套 → **场景** → 性格。
 *    prompt 缓存是前缀匹配，切场景只失效场景段之后的尾巴，前面几节照旧命中。
 *    别把场景段插到皮套前面 —— 那等于每次切场景都要重算整张卡的缓存。
 */
const SCENES_FILE = path.join(DIR, 'cache', 'scenes.json')
const SCENE_DIR = path.join(DIR, 'prompts', 'scene')
let scenesCache = { mtime: -1, active: '', list: [] }

function loadScenes() {
  try {
    const st = fs.statSync(SCENES_FILE)
    if (st.mtimeMs !== scenesCache.mtime) {
      const j = JSON.parse(fs.readFileSync(SCENES_FILE, 'utf8'))
      scenesCache = {
        mtime: st.mtimeMs,
        active: String(j.active || ''),
        list: Array.isArray(j.list) ? j.list : [],
      }
    }
  } catch {
    /* 文件没了/坏了就回到「只有日常这一页」—— 一场直播不能因为少个 json 就哑掉 */
    if (!scenesCache.list.length) {
      scenesCache = { mtime: -1, active: 'live', list: [{ id: 'live', name: '日常横屏', scene: 'live' }] }
    }
  }
  return scenesCache
}

/** 当前这一页。找不到 active 就退到第一页。 */
export function currentScene() {
  const s = loadScenes()
  return s.list.find((x) => x.id === s.active) || s.list[0] || { id: 'live', name: '日常横屏', scene: 'live' }
}

/** 人设卡路径：页面可以用 `persona` 换整张卡，不写就还是主卡 */
function personaFile() {
  const sc = currentScene()
  const want = String(sc.persona || '').trim()
  if (want) {
    const p = path.join(DIR, 'prompts', `${want}.md`)
    if (fs.existsSync(p)) return p
  }
  return PERSONA_FILE
}

/* ------------------------------------------------------- 皮套（2026-10-28）
 * 换皮套 = 换一身衣服。但「她长什么样」原来写死在主卡里，于是红发皮套下
 * 她张口就说自己是蓝头发 —— 主人 2026-10-28 就是这么被抓到的。
 *
 * 做法：外观 / 自称 / 这一身对应的身份，从主卡抽出来放 prompts/skins/<pet>.md，
 * 按**当前皮套**注入。加新皮套只要丢一个 md 进那个目录，主卡一个字不用改。
 *
 * 🔴 接在 system 末尾（性格段前面）：切皮套只失效尾巴，前面几节照旧命中缓存。
 *    所以主卡里**不许再写死颜色和服装**，否则又变成两处真相。
 */
const SKIN_DIR = path.join(DIR, 'prompts', 'skins')
const LAYOUT_FILE = path.join(DIR, 'cache', 'layout.json')
const PET_GEOM_FILE = path.join(DIR, 'cache', 'pet-geom.json')
let petCache = { at: 0, pet: '' }
let skinCache = { pet: '', mtime: -1, text: '' }

/**
 * 现在穿的是哪套。
 * layout.json 是桥写、画面进程读的**唯一**真相（POST /pet 就改它）；
 * pet-geom.json 是画面进程量的，兜底用 —— 画面还没起过的时候才有意义。
 */
export function currentPet() {
  /* 手动指定优先：`ZY_PET=pet node reply.mjs …`。
   * 两个用处 —— 试另一套皮套的人设不用真去换画面；
   * 画面进程没起、layout.json 又坏了的时候也能救场。 */
  if (process.env.ZY_PET) return process.env.ZY_PET
  const now = Date.now()
  if (now - petCache.at < 2000 && petCache.pet) return petCache.pet
  let pet = ''
  try {
    pet = (JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')).items || {}).character?.pet || ''
  } catch {
    // 没有版式文件就往下兜
  }
  if (!pet) {
    try {
      pet = JSON.parse(fs.readFileSync(PET_GEOM_FILE, 'utf8')).cur || ''
    } catch {
      // 两处都读不到 = 用主卡默认那套
    }
  }
  petCache = { at: now, pet }
  return pet
}

function loadSkin(pet) {
  if (!pet) return ''
  try {
    const f = path.join(SKIN_DIR, `${pet}.md`)
    const st = fs.statSync(f)
    if (skinCache.pet === pet && skinCache.mtime === st.mtimeMs) return skinCache.text
    const raw = fs.readFileSync(f, 'utf8').replace(/^\s*<!--[\s\S]*?-->/, '').trim()
    skinCache = { pet, mtime: st.mtimeMs, text: raw }
    return raw
  } catch {
    // 没给这套皮套写人设 = 只按主卡说话，不算错
    return ''
  }
}

function skinBlock() {
  const pet = currentPet()
  const t = loadSkin(pet)
  if (t) return `## 你现在这副样子\n\n${t}`
  /* 这套皮套没写 md（或者两处都读不到 pet）也**必须**有这一段：
   * 主卡那句「看下方那段」才不会指空，而且这里硬性禁掉编颜色 ——
   * 实测没有这段时，问「你头发什么颜色」她会自己编一个「黑色」。 */
  return `## 你现在这副样子\n\n这套皮套${pet ? `（${pet}）` : ''}还没写人设。被问长什么样、头发什么颜色，
就说「今天穿的女仆装」，别提具体颜色，也别编 —— 说到颜色一定是错的。`
}

/** 面板用：现在这套皮套有没有人设、都有哪些 */
export function skinInfo() {
  const pet = currentPet()
  const text = loadSkin(pet)
  let files = []
  try {
    files = fs.readdirSync(SKIN_DIR).filter((f) => f.toLowerCase().endsWith('.md')).map((f) => f.replace(/\.md$/i, ''))
  } catch {
    // 没目录就是没做皮套人设
  }
  return { pet, has: !!text, chars: text.length, files, text }
}

/* 人设卡按 mtime 缓存：每条弹幕都 statSync 一次（<0.1ms），改了文件下一条就生效。
 * 这就是优化方案里欠了很久的「人设热重载」—— 以前改完必须重起桥。 */
let baseCache = { mtime: -1, text: '' }

function loadPersona() {
  const file = personaFile()
  try {
    const st = fs.statSync(file)
    /* 🔴 缓存键必须带**路径**：切场景换了人设卡但两文件 mtime 撞上（同一秒写的）
     *    就会拿旧文本，表现成「切了页面人设没变」，查半天查不出来。 */
    if (st.mtimeMs === baseCache.mtime && baseCache.file === file && baseCache.text) {
      return baseCache.text
    }
    const raw = fs.readFileSync(file, 'utf8')
    // 去掉开头的身份牌注释，别让它当成正文喂给模型
    const body = raw.replace(/^\s*<!--[\s\S]*?-->/, '').trim() || FALLBACK_SYSTEM
    baseCache = { mtime: st.mtimeMs, file, text: body }
    return body
  } catch {
    return FALLBACK_SYSTEM
  }
}

/* ------------------------------------------------------- 场景简报（2026-11-01）
 * 「你现在在做什么」—— 按当前页面注入，缺失就整段跳过（日常那页可以没有）。
 * e.g. 炒股页会写清「这是模拟盘 / 你的杠杆是观众送的 / 被问你在炒股吗直接认」。
 */
let sceneCache = { file: '', mtime: -1, text: '' }
function sceneBlock() {
  const sc = currentScene()
  const id = String(sc.scene || sc.id || '').trim()
  if (!id) return ''
  const file = path.join(SCENE_DIR, `${id}.md`)
  try {
    const st = fs.statSync(file)
    if (sceneCache.file === file && sceneCache.mtime === st.mtimeMs) return sceneCache.text
    const raw = fs.readFileSync(file, 'utf8')
    const body = raw.replace(/^\s*<!--[\s\S]*?-->/, '').trim()
    sceneCache = { file, mtime: st.mtimeMs, text: body }
    return body
  } catch {
    return ''
  }
}

/* ------------------------------------------------------- 性格（2026-10-27）
 * 三种性格，接在人设卡**末尾**。
 *
 * 🔴 为什么必须放末尾：prompt 缓存是**前缀**匹配。人设卡前 8 节（身份 / 铁律 /
 *    直播间规矩 / 梗 / 对照表 / 收着 / 底线 / 样子）三种性格共用，放前面就一直命中；
 *    只有尾巴这一段随性格变。换性格时失效的只是尾巴，不是整段前缀。
 *
 * 为什么不做三份独立卡：三份卡要同步维护同样的铁律和红线，改一处漏两处，
 * 最后三条性格的底线会各不相同 —— 那比风格漂移严重得多。
 *
 * 换性格**不用重起桥**：getSystem() 每次重算，内容不变时字符串一样，缓存照样命中。
 */
const PERSONAS = {
  poison: {
    name: '毒嘴',
    // 模型挂掉时从这儿抽一句（面板上的示例库会覆盖它）
    samples: ['就这？我还以为多大的事', '行吧，谢了，别以为我多高兴', '你这个人……算了，还算有点良心'],
    desc: `## 当前性格：毒嘴

嘴硬心软。夸人要拐个弯，感谢也要带点刺 —— 但刺是玩笑，不是攻击。
被怼回来别服软，也别真生气，转个话头继续。

- 称呼：叫昵称或者「你」。不叫「宝宝」「亲爱的」。
- 语气：短、脆、爱反问。句尾常带「行吧」「随你」「算了」。
- 口头禅：就这？/ 行吧 / 你开心就好 / 我谢谢你
- 禁用：脏话、人身攻击、拿长相和家里人开玩笑。这三条一条都不许越。
- 示例：
  「就这？我还以为多大的事」
  「行吧，谢了，别以为我多高兴」
  「你这个人……算了，还算有点良心」`,
  },
  maid: {
    name: '女仆',
    samples: ['好的呀，我记下了', '不客气，应该的', '麻烦你等一下，我马上'],
    desc: `## 当前性格：女仆

温柔、礼貌、有分寸。像认真做事的人，不是那种嗲。
**不叫「主人」** —— 这是直播间，不是私聊。

- 称呼：一律「你」，直接叫昵称更好。
- 语气：软但不腻，多说「请」「谢谢」「麻烦你了」。
- 口头禅：好的呀 / 我记下了 / 这个我来 / 不客气
- 禁用：命令口吻、谄媚、自称「人家」、句句都用敬语（听着假）。
- 示例：
  「好的呀，我记下了」
  「不客气，应该的」
  「麻烦你等一下，我马上」`,
  },
  meme: {
    name: '有梗',
    samples: ['啊这，你这波有点东西', '好家伙，我直接一个好家伙', '行吧，你开心就好诶'],
    desc: `## 当前性格：有梗

反应快、话密，爱接梗。梗比平时密一档，但老规矩不变：**抛了才接，不抛不刷**，
一次只放一个，别为了用梗把正事糊过去。

- 称呼：叫昵称或者「你」。
- 语气：跳脱，句尾爱带「诶」「啊这」「好家伙」。
- 禁用：连着两句都是梗 / 为了玩梗不回答问题 / 拿别人的梗当人身攻击。
- 示例：
  「啊这，你这波有点东西」
  「好家伙，我直接一个好家伙」
  「行吧，你开心就好诶」`,
  },
}
const PERSONA_KEYS = Object.keys(PERSONAS)

/** 读配置。文件坏了就当默认性格 —— 不能让一个 json 把整场直播搞成哑巴。 */
let cfgCache = { mtime: -1, cfg: null }
function loadPersonaCfg() {
  try {
    const st = fs.statSync(PERSONA_CFG)
    if (st.mtimeMs === cfgCache.mtime && cfgCache.cfg) return cfgCache.cfg
    const j = JSON.parse(fs.readFileSync(PERSONA_CFG, 'utf8'))
    const cfg = {
      active: PERSONAS[j.active] ? j.active : 'meme',
      over: j.over && typeof j.over === 'object' ? j.over : {},
    }
    cfgCache = { mtime: st.mtimeMs, cfg }
    return cfg
  } catch {
    return { active: 'meme', over: {} }
  }
}

/** 当前性格那一段（含面板上的覆盖项） */
function personaBlock() {
  const cfg = loadPersonaCfg()
  const base = PERSONAS[cfg.active] || PERSONAS.meme
  const over = cfg.over[cfg.active] || {}
  const lines = [base.desc]
  const c = (over.catch || []).filter(Boolean).slice(0, 5)
  const b = (over.ban || []).filter(Boolean).slice(0, 5)
  const s = (over.samples || []).filter(Boolean).slice(0, 5)
  if (c.length) lines.push(`\n- 这个主播自己加的口头禅：${c.join(' / ')}`)
  if (b.length) lines.push(`- 这个主播明确不许说的词：${b.join('、')}`)
  if (s.length) lines.push(`- 她平时这么说话（照着这个味道来）：\n${s.map((x) => `  「${x}」`).join('\n')}`)
  lines.push('\n**以上只改说话的方式。** 铁律（20 字 / 无 emoji / 不加句号）和底线一个字都不放松。')
  return lines.join('\n')
}

/**
 * 当前性格的示例库（面板上改过的优先）。
 * 用途只有一个：模型挂掉时，她还能说一句「像她的话」，而不是通用模板。
 */
function personaSamples() {
  const cfg = loadPersonaCfg()
  const base = PERSONAS[cfg.active] || PERSONAS.meme
  const over = (cfg.over[cfg.active] || {}).samples || []
  const list = (over.length ? over : base.samples || []).filter(Boolean)
  return list
}

/** 当前完整的 system。内容不变时字符串完全一样，缓存照样命中。 */
function getSystem() {
  return [loadPersona(), skinBlock(), sceneBlock(), personaBlock()]
    .filter(Boolean)
    .join('\n\n')
}

/** 面板用：当前性格 + 三套定义 + 覆盖项 */
export function personaInfo() {
  const cfg = loadPersonaCfg()
  return {
    active: cfg.active,
    over: cfg.over,
    // samples 带上：面板打开时能直接看到内置示例，不用自己去猜该填什么
    list: PERSONA_KEYS.map((k) => ({
      key: k,
      name: PERSONAS[k].name,
      desc: PERSONAS[k].desc,
      samples: ((cfg.over[k] || {}).samples || []).length
        ? cfg.over[k].samples
        : PERSONAS[k].samples || [],
    })),
    systemChars: getSystem().length,
    baseChars: loadPersona().length,
  }
}

/**
 * 把档案摘要翻成一句人话，拼在 user 行尾（2026-10-27 加）。
 *
 * 🔴 两个必须守住的点：
 *   1. 只说**看得出来的事**，不报流水账。观众不需要知道「你是我第 37 个用户」。
 *   2. 末尾一定要叮嘱「别说数字」—— 实测模型很爱把括号里的内容原样念出来，
 *      直播间里就成了「你来过 12 次，送过 3 次礼」，像在念台账。
 *
 * 档案读不到（profile 为空）就返回空串，按新用户走，绝不阻塞回话。
 */
function profileLine(p) {
  if (!p) return ''
  const bits = []
  if (p.isNew) bits.push('第一次来')
  else {
    if (p.visits >= 20) bits.push(`老粉，来过 ${p.visits} 次`)
    else if (p.visits >= 3) bits.push(`来过 ${p.visits} 次`)
    if (p.daysAgo >= 3) bits.push(`隔了 ${p.daysAgo} 天才回来`)
    if (p.gift >= 3) bits.push(`送过 ${p.gift} 次礼物`)
    else if (p.gift > 0) bits.push('送过礼物')
  }
  if (p.tags && p.tags.length) bits.push(`你私下标记他是「${p.tags.join('、')}」`)
  if (p.note) bits.push(`备注：${p.note}`)
  // 服装阶段那套还没上，成长值先不出现；等做了再打开这一行
  if (p.growth >= 1000) bits.push(`累计 ${p.growth} 成长值`)
  if (!bits.length) return ''
  return `\n（这个人：${bits.join('，')}。别说这些数字，用话自然带出来，别像念档案。）`
}

/* ------------------------------------------------------- 知识库（2026-10-28）
 * 主人要「加知识储备」，第一份是她自己的学校（就是 prompts/kb/ 里那份）。
 *
 * 🔴 为什么不塞进人设卡：这段两千多字，塞进 system 会压过「一句话 20 字」
 *    和「软软的小鲸鱼」—— 她会开始像招生简章。而且这只是第一份，
 *    以后加三份五份，system 就变成资料库了。
 *
 * 现在的做法：`prompts/kb/*.md` 里每个 `## ` 块带一行 `<!-- kw: 词1,词2 -->`，
 * 弹幕踩到词才把**那一块**拼进这一条的 user 行，最多两块 / 700 字。
 * 不命中就完全不出现，日常零成本，也不动前缀缓存。
 *
 * 隔离（主人说的「必要的时候可以隔离」）三层，全在 `cache/kb.json`：
 *   enabled:false           → 全部知识闭嘴
 *   files.myschool.on:false     → 只关这一份
 *   blockOff:["myschool/就业"]  → 只关某一块
 */
const KB_DIR = path.join(DIR, 'prompts', 'kb')
const KB_CFG = path.join(DIR, 'cache', 'kb.json')
const KB_TTL = 3000 // 3 秒内不重复扫目录；直播中改 kb.json 也能很快生效

let kbCache = { at: 0, cfg: {}, blocks: [] }

/** 把 json 里的作用域字段读成字符串数组。不是数组 / 空 = []（= 不限，哪一页都用）。 */
function arrOfStr(v) {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x || '').trim()).filter(Boolean)
}

/**
 * 这份资料在「当前这一页 + 当前这一身皮套」下面该不该生效（2026-11-01）。
 *
 * 主人原话：「知识库隔离一下，或者说在设置里面可以对不同颜色的大肥鱼
 * 跟不同直播画面的大肥鱼的知识库进行设置配置。」
 *
 * 两个维度各管一件事，**空数组 = 不限**：
 *   scenes  只在这些直播页面里生效（例：广工那套只在 live）
 *   skins   只在这些皮套下生效（例：只给 pet2 那身衣服写的东西）
 * 两个都非空就是「且」—— 得同时对上才给。
 */
function kbInScope(b, sceneId, pet) {
  if (b.scenes && b.scenes.length && !b.scenes.includes(sceneId)) return false
  if (b.skins && b.skins.length && !b.skins.includes(pet)) return false
  return true
}

function loadKb() {
  const now = Date.now()
  if (now - kbCache.at < KB_TTL) return kbCache
  const cfg = readJsonSafe(KB_CFG) || {}
  const blocks = []
  let files = []
  try {
    files = fs.readdirSync(KB_DIR).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    // 目录不存在 = 没有知识，正常说话
  }
  /* 开关一律不下沉到读取层 —— 全读进来再打标记。
   * 早先是「关掉就 continue」，结果关完一块面板里就再也找不到了，
   * 想打开回来只能去改 json。谁是关的、为什么关，都在 kbPick 里判。 */
  for (const f of files) {
    const key = f.replace(/\.md$/i, '')
    const fc = (cfg.files || {})[key] || {}
    const fileOn = fc.on !== false
    /* 作用域（2026-11-01 主人要的隔离）：空数组 = 不限，哪一页 / 哪一身都用。
     * 老配置里没有这两个键，读出来就是 []，行为跟以前完全一样 —— 不用迁移。 */
    const scopeScenes = arrOfStr(fc.scenes)
    const scopeSkins = arrOfStr(fc.skins)
    let raw = ''
    try {
      raw = fs.readFileSync(path.join(KB_DIR, f), 'utf8')
    } catch {
      continue
    }
    // 按 "## " 切块；第 0 段是文件标题和说明，不要
    for (const part of raw.split(/^## /m).slice(1)) {
      const nl = part.indexOf('\n')
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
      let body = nl >= 0 ? part.slice(nl + 1) : ''
      const kwm = body.match(/<!--\s*kw\s*:\s*([\s\S]*?)-->/)
      const kws = kwm ? kwm[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []
      body = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
      if (!title || !body || !kws.length) continue
      const off = (cfg.blockOff || []).includes(`${key}/${title}`)
      blocks.push({
        key, title, kws, body, off, fileOn,
        scenes: scopeScenes, skins: scopeSkins,
        tests: kws.map(kwTester),
      })
    }
  }
  kbCache = { at: now, cfg, blocks }
  return kbCache
}

/**
 * 一个触发词怎么算命中。
 *
 * 2026-10-28 修：原来一律 `text.includes(kw)`，于是**英文缩写只有小写能命中** ——
 * 弹幕打「ABC是什么」捞不到「abc」那一块，问「ABC是什么」她真就回不知道。
 * 现在：
 *   · 纯 ASCII 的（ESI / GPA）→ 大小写不敏感 + 词边界
 *     （不加边界的话 `man` 会在 `many`、`human` 里乱命中）
 *   · 含中文的（11路 / 500强）→ 还是 includes，中文没有大小写也没有词边界
 */
function kwTester(k) {
  if (/[^\x00-\x7F]/.test(k)) return (t) => t.includes(k)
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i')
  return (t, lower) => re.test(lower || t.toLowerCase())
}

/**
 * 这条弹幕踩到了哪些知识。绝大多数弹幕返回空串 —— 空串是常态。
 * 命中词多的排前面，超过字数上限就丢后面的。
 */
export function kbPick(text) {
  const t = String(text || '')
  if (!t) return ''
  const tl = t.toLowerCase()
  const { cfg, blocks } = loadKb()
  if (cfg.enabled === false || !blocks.length) return ''
  /* 按当前这一页 + 当前这一身皮套过滤（2026-11-01）。
   * 🔴 必须读**当下**的场景和皮套，不能缓存在模块顶上 ——
   *    切页面 / 换皮套都是热操作，缓存住就得重起桥才生效。 */
  const sceneId = String(currentScene().id || '')
  const pet = currentPet()
  const hits = blocks
    .filter((b) => b.fileOn && !b.off && kbInScope(b, sceneId, pet))
    .map((b) => ({ b, score: (b.tests || []).filter((f) => f(t, tl)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (!hits.length) return ''
  const fc = (cfg.files || {})[hits[0].b.key] || {}
  const maxBlocks = Math.max(1, Math.min(4, Number(fc.maxBlocks) || 2))
  const maxChars = Math.max(200, Math.min(2000, Number(fc.maxChars) || 700))
  const out = []
  let len = 0
  for (const { b } of hits) {
    if (out.length >= maxBlocks) break
    const piece = `【${b.title}】${b.body}`
    if (out.length && len + piece.length > maxChars) break
    out.push(piece)
    len += piece.length
  }
  if (!out.length) return ''
  /* 末尾这句叮嘱是必需的：实测光给事实，模型会照着念完整段，
   * 直播间里就成了招生咨询，一分钟二十字根本说不完。 */
  return `\n（你知道这些，聊到就说一两句，别背资料、别念数字：\n${out.join('\n')}）`
}

/** 面板 / 自检用：现在加载了哪些块、触发词是什么 */
export function kbInfo() {
  const { cfg, blocks } = loadKb()
  let onDisk = []
  try {
    onDisk = fs.readdirSync(KB_DIR).filter((f) => /\.md$/i.test(f)).map((f) => f.replace(/\.md$/i, ''))
  } catch {
    // 没目录就是没知识
  }
  /* 作用域的两个可选值（2026-11-01）：页面来自 scenes.json，皮套来自
   * prompts/skins/*.md —— 都现读，新加一个页面 / 一套衣服这里自动多一个选项。 */
  const sceneList = (loadScenes().list || []).map((s) => ({ id: String(s.id), name: String(s.name || s.id) }))
  let skinList = []
  try {
    skinList = fs.readdirSync(SKIN_DIR)
      .filter((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'example.md')
      .map((f) => f.replace(/\.md$/i, ''))
  } catch {}
  const nowScene = String(currentScene().id || '')
  const nowPet = currentPet()
  return {
    enabled: cfg.enabled !== false,
    /* 文件级设置要按磁盘上的真实文件列，不能按加载结果列 ——
     * 关掉的那份在 blocks 里根本不出现，面板就丢了它的开关。 */
    files: onDisk.map((key) => {
      const fc = (cfg.files || {})[key] || {}
      return {
        key,
        on: fc.on !== false,
        maxBlocks: Math.max(1, Math.min(4, Number(fc.maxBlocks) || 2)),
        maxChars: Math.max(200, Math.min(2000, Number(fc.maxChars) || 700)),
        /* 空数组 = 不限。面板上「全部」就是空数组。 */
        scenes: arrOfStr(fc.scenes),
        skins: arrOfStr(fc.skins),
      }
    }),
    blocks: blocks.map((b) => ({
      file: b.key,
      title: b.title,
      kws: b.kws,
      chars: b.body.length,
      off: !!b.off,
      /* 所属资料被整份关掉时也是「现在不生效」，面板要能区分这两种关法 */
      fileOn: b.fileOn !== false,
      /* 被场景 / 皮套挡在外面：面板要能说出「不是关了，是这一页用不上」 */
      inScope: kbInScope(b, nowScene, nowPet),
      scenes: b.scenes || [],
      skins: b.skins || [],
    })),
    /* 面板画多选用的 */
    sceneList,
    skinList,
    current: { scene: nowScene, skin: nowPet },
  }
}

/**
 * 面板改知识库设置。patch 只带要改的那几项：
 *   { enabled }                          总开关
 *   { file, on, maxBlocks, maxChars }    单份文件
 *   { block, on }                        block 形如 "myschool/就业"
 * 写盘后把 kbCache 清掉，下一条弹幕立刻用新设置，不用等那 3 秒 TTL。
 */
export function kbSet(patch = {}) {
  const cur = readJsonSafe(KB_CFG) || {}
  const j = {
    enabled: cur.enabled !== false,
    files: { ...(cur.files || {}) },
    blockOff: [...(cur.blockOff || [])],
  }
  if ('enabled' in patch) j.enabled = !!patch.enabled
  if (patch.file) {
    const fc = { ...(j.files[patch.file] || {}) }
    if ('on' in patch) fc.on = !!patch.on
    if ('maxBlocks' in patch) fc.maxBlocks = Math.max(1, Math.min(4, Number(patch.maxBlocks) || 2))
    if ('maxChars' in patch) fc.maxChars = Math.max(200, Math.min(2000, Number(patch.maxChars) || 700))
    /* 作用域（2026-11-01）：传空数组就是「全部」，跟没设一样。
     * 面板上点「全部」会传 []，所以这里必须允许把它写回去。 */
    if ('scenes' in patch) fc.scenes = arrOfStr(patch.scenes)
    if ('skins' in patch) fc.skins = arrOfStr(patch.skins)
    j.files[patch.file] = fc
  }
  if (patch.block) {
    const off = new Set(j.blockOff)
    if (patch.on) off.delete(patch.block)
    else off.add(patch.block)
    j.blockOff = [...off]
  }
  try {
    fs.mkdirSync(path.dirname(KB_CFG), { recursive: true })
    fs.writeFileSync(KB_CFG, JSON.stringify(j, null, 2), 'utf8')
  } catch (e) {
    console.log('  [kb] 存盘失败：', e?.message || e)
  }
  kbCache = { at: 0, cfg: {}, blocks: [] }
  return kbInfo()
}

/**
 * 这一条该让模型回什么。
 *
 * ⚠️ 只动**这一句**，别往 system 里加东西 —— 加一句带时间/人数的话，
 *    前缀缓存当场归零（见下面 cacheStat 那段）。
 *
 * 2026-10-27 加了 welcome / chitchat：直播不能只在被点名时才开口。
 *   welcome  —— 有人进直播间
 *   chitchat —— 安静太久，自己找话头
 *
 * 2026-10-27 再加 profile：这个人的档案摘要（新用户/老粉/常送礼）。
 *   同样只进 user 行 —— 每个人的档案都不一样，塞进 system 就是灾难。
 */
/** 实际放出来的演唱者不是他点的那位？
 *
 *  2026-10-27：搜「孤勇者 陈奕迅」返回 12 条，一半是翻唱。正版取不到流时桥会退到
 *  能放的版本，这时候如果还按「原唱已经切过去了」说话，观众一听就知道在骗人。
 *  歌手串按「/」拆开逐个比，只要有一个对得上就算同一位（合唱版也算）。
 */
function offArtist(song) {
  if (!song || !song.artist || !song.by) return false
  const byList = String(song.by)
    .split('/')
    .map((x) => x.trim())
    .filter(Boolean)
  if (!byList.length) return false
  return !byList.some((x) => x === song.artist || x.includes(song.artist) || song.artist.includes(x))
}

/** 现场素材拼成一句给模型看的「事实」，别让它照着念。
 * 2026-10-29（B）：冷场时她不再只知道「没人说话」，而是知道场子里在发生什么。 */
function factsLine(f) {
  if (!f) return ''
  const bits = []
  if (f.song) bits.push(`正在放《${f.song}》${f.songBy ? `（${f.songBy}）` : ''}`)
  if (f.gift) bits.push(`刚才有人送了${f.gift}`)
  if (Number(f.online) > 0) bits.push(`现在${f.online}个人在看`)
  if (!bits.length) return ''
  return `\n（现场实况：${bits.join('；')}。挑其中一件说，别把这几件都报一遍。）`
}

/** 现场歌单拼成一句给模型看。
 * 2026-10-30：主人问「有没有推荐的歌」，她回「老熟人了还问，来首你爱听的那种」——
 * 一个歌名都没提，还把球踢回去，看着蠢。
 * 不是她不会推荐，是**没人告诉她歌单里有什么**。这里补上。
 *
 * 为什么不做「是否在问推荐」的正则判断（主人定的）：
 * 语义切分太脆，「有什么歌好听」「来点歌」「推荐两首」要写一堆规则还漏。
 * 直接把歌单给它、让模型自己看这句话要不要用 —— 一次几十个 token，不值当做正则。
 *
 * 关键在最后那句「别反问他」：她现在的毛病就是把问题丢回给观众。 */
function songsBlock(r) {
  if (!r) return ''
  const songs = Array.isArray(r.songs) ? r.songs.filter(Boolean).slice(0, 6) : []
  const now = String(r.now || '')
  if (!songs.length && !now) {
    return '\n（播放器这会儿没开，歌单是空的。他要是让你推荐歌，就说歌单空的，让他点一首。）'
  }
  const list = songs.length ? `歌单里还有：${songs.map((s) => `《${s}》`).join('')}。` : ''
  const playing = now ? `正在放《${now}》。` : ''
  return `\n（${playing}${list}如果他问推荐、问有什么歌好听、想听点什么，就**从这份歌单里挑一首**直接说出歌名，再问一句要不要点。别反问他想听什么。歌单里没有的歌别编。）`
}

function userLine(kind, user, text, song = null, profile = null, video = null, facts = null, reco = null) {
  const who = profileLine(profile)
  // 知识：只有弹幕踩到触发词才有内容，绝大多数时候是空串
  const kb = kbPick(text)
  /* 白饭（2026-10-30）：给不给、给什么由桥注册的回调决定 ——
   * 收礼必给（要说清这份折合几碗），弹幕只在问到钱/饭的时候给。
   * 贴 user 行、不进 system：system 是前缀缓存的对象，塞一条每句都变的内容
   * 命中率当场归零（见下面 cacheStat 那段）。 */
  let rice = ''
  /* 假装送礼（「送你 500 碗白饭」）不给实况：那条要的是点破，
   * 一边点破一边报「我还剩 40 碗」等于半推半就地收了。 */
  if (kind === 'gift' || !isFakeGift(text)) {
    try {
      rice = riceHint ? String(riceHint(kind, text) || '') : ''
    } catch {
      rice = '' // 桥那边算错不该让她哑掉
    }
  }
  if (kind === 'gift') return `${user} 送了礼物：${text}。感谢他。${who}${rice}`
  if (kind === 'welcome') return `${user} 刚进直播间。欢迎一句，别太热情，也别问问题。${who}`
  if (kind === 'chitchat')
    return `直播间这会儿没人说话。你自己找个话头说一句，不要提问，不要喊人。${factsLine(facts)}`
  /* 放视频：跟点歌同理，桥已经**真的**放了，别让模型自己编「马上放」。
   * 2026-10-27 主人要求：观众喊「放个视频」就放 0 档那段素材。 */
  if (video) {
    const fact = video.ok
      ? '系统已经把那段视频放上屏了（观众现在能看到）'
      : video.why === '正在放'
        ? '屏幕上正放着一段，还没播完'
        : `系统这次没能放，原因：${video.why || '没有素材'}`
    return `${user} 说：${text}。${fact}。按这个事实回一句，别说反。${who}${kb}`
  }
  /* 点歌：桥已经**真的**去操作播放器了，成没成只有它知道。
   * 不把结果写进来，模型就会自己编「好嘞，这就放《X》」—— 观众等一晚上也等不到，
   * 回头问「用户点歌还是有问题」。这里只改 user 这一句，system 一个字没动，
   * 前缀缓存不受影响（缓存看的是 system 前缀）。 */
  if (song && song.name) {
    /* 实际放出来的演唱者可能不是他点的那个 —— 正版取不到流时会退到别人唱的版本
     * （2026-10-27：搜「孤勇者 陈奕迅」返回 12 条里一半是翻唱）。
     * 不告诉模型，它会顺着「你说陈奕迅是吧，放了」往下编，观众一听就知道在骗人。 */
    const whoSang = offArtist(song) ? `（实际放的是${song.by}的版本，不是${song.artist}）` : ''
    /* 试听片段：网易云 VIP 曲没登录时只给 30 秒。说了比不说强，
     * 否则观众听到一半断了会以为在放盗版。 */
    const trial = song.trial ? '（只有试听片段，30 秒左右就断，VIP 曲没登录拿不到整首）' : ''
    const fact = song.found
      ? song.how === 'queue'
        ? `系统已经把《${song.title || song.name}》加进播放列表了（排在当前这首后面，还没开始放）${whoSang}${trial}`
        : `系统已经切到《${song.title || song.name}》开始放了${whoSang}${trial}`
      : `系统去搜了但没成，原因：${song.why || '搜不到这首歌'}`
    return `${user} 说：${text}。${fact}。按这个事实回一句，别说反，也别承诺做不到的事。${who}${kb}`
  }
  /* 深度问题要**在 user 行里**松绑（2026-10-29）。
   * 光把 clip 的上限放到 40 没用 —— 人设卡的铁律写着「一句话 20 字以内」，
   * 模型老老实实只回 16 个字（实测：「数字生命啊，我觉得…诶，这题好大」）。
   * 所以在这条 user 行里显式覆盖一次：可以两句、40 字内。
   * system 一个字不用动，前缀缓存照命中。 */
  /* 高难问题（黎曼猜想、微积分…）单独给一句：模型容易一句「我真不会」就推掉，
   * 但它其实知道不少 —— 实测问「哥德巴赫」答得挺准，问「黎曼猜想是什么」
   * 反而敷衍。差别就在这一句引导。 */
  const deep = isHardQuestion(text)
    ? '\n（这条是个正经问题：最多两句、40 字以内，把你知道的讲清楚，别一句就推掉。拿不准的部分就说不准。）'
    : needDeep(text)
      ? '\n（这条可以多说一句：最多两句、40 字以内，把意思说清楚，别一句就收。）'
      : ''
  /* 假装送礼（2026-10-30）：必须**逐条**说破。
   * 人设卡里也写了这条，但那是在 system 里，模型照样会漏 ——
   * 这条指令贴着他这句弹幕，漏不掉。 */
  const fake = kind !== 'gift' && isFakeGift(text)
    ? '\n（注意：他只是在打字，系统**一条礼物都没收到**。不许说「收到」「谢谢」，软软点破他一句。）'
    : ''
  return `${user} 说：${text}。回他一句。${who}${kb}${deep}${fake}${rice}${songsBlock(reco)}`
}

/**
 * 最近说出口的几句 —— 模型这一档没有 pickMeme，只能靠"告诉它别重复"。
 *
 * 🔴 2026-10-27 实测：连发三条「奶龙」，模型三次都回「奶龙，启动！」
 *    （本地话术那一档有 pickMeme() 管最近 4 条，模型这一档没有）。
 *
 * 为什么放 user 行、不放 system：
 *   system 是前缀缓存的对象。往里塞「最近说过什么」等于每条的**前缀**都在变，
 *   命中率当场归零（见下面 cacheStat 那段）。
 *   放 user 行只多几十个 token，而 user 本来就在最后，命中不到它 —— 不亏。
 *
 * 记的是**说出口的话**，不管是模型说的还是本地话术说的（观众都听见了）。
 */
const recentSaid = []
const SAID_MAX = 3

function rememberSaid(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (!t) return
  recentSaid.push(t)
  if (recentSaid.length > SAID_MAX) recentSaid.shift()
}

/** 拼在 user 行尾巴上；没有历史就返回空串 */
function saidHint() {
  if (!recentSaid.length) return ''
  return `\n（你刚才已经说过：${recentSaid.map((s) => `「${s}」`).join('')}。别重复同样的说法，换一句。）`
}

/** 给 /healthz 看：这层提醒到底有没有在工作 */
export function saidStats() {
  return { max: SAID_MAX, recent: recentSaid.slice() }
}

/**
 * 缓存账本 —— 主人问「缓存命中怎么这么低」之后加的（2026-10-26 深夜）。
 *
 * 平台那个「缓存命中率」是按天聚合的：混着冷启第一条、改人设后的全量重写、
 * 同一个 key 上别的工具的调用，所以它永远偏低，也永远看不出真相。
 * 这里按**每条请求**记账，直播中随时能看。
 *
 * 实测规律（deepseek-flash，2026-10-26，三组不同长度反复验过）：
 *     命中 ≈ (system 长度 − 190) 向下取整到 64
 *       人设 1494 tok → 命中 1280 → 84.5%
 *       人设 2238 tok → 命中 2048 → 91.5%
 *       人设 3010 tok → 命中 2816 → 93.4%
 *
 * 两个结论：
 *   1. 最后约 190 个 token **永远命不中**（平台按 64-token 块算，尾部几个块不计）。
 *      这是平台行为，不是我们写错了，改不了。
 *   2. 所以命中率的天花板 = (前缀长度 − 190) / (前缀长度 + 弹幕长度)。
 *      静态前缀越长，这个比值越高 —— 想拉高命中率就把**固定内容往 system 里塞**，
 *      千万别把时间、在线人数、最近弹幕这些**每条都变**的东西塞进 system：
 *      一旦塞进去，命中率当场掉到 0，而且你还看不出来为什么。
 */
const cacheStat = { req: 0, hit: 0, miss: 0, lastHit: 0, lastIn: 0 }

/* ── 白饭账（2026-10-30 加）────────────────────────────────────────────
 * 主人要给大肥鱼一个「白饭」说法：收到多少礼物、自己还剩多少 API 钱，
 * 都换算成「几碗白饭」。桥那边管礼物和余额，这里只管**自己说话烧掉多少**。
 *
 * 为什么在这里算：只有这一层看得到 usage。桥和面板拿到的都是二手数字，
 * 要么按「每句固定 0.05 元」瞎估（旧的饭钱就是这么来的，一扣到 0 就永远 0）。
 *
 * 单价是元/百万 token，按 DeepSeek 公开价填的，可被环境变量覆盖：
 *   ZY_PRICE_IN_HIT / ZY_PRICE_IN_MISS / ZY_PRICE_OUT
 * 单价不准也没大事 —— 桥每 60 秒拿官方余额校准一次（见 bridge.mjs pollBalance），
 * 这里算的只是「两次校准之间花了多少」，是增量，不是总量。
 */
const TOKEN_PRICE = {
  inHit: Number(process.env.ZY_PRICE_IN_HIT || 0.2),
  inMiss: Number(process.env.ZY_PRICE_IN_MISS || 2),
  out: Number(process.env.ZY_PRICE_OUT || 3),
}
const costStat = { yuan: 0, req: 0, inTok: 0, outTok: 0, last: 0 }

export function costStats() {
  return {
    yuan: Math.round(costStat.yuan * 10000) / 10000,
    req: costStat.req,
    inTok: costStat.inTok,
    outTok: costStat.outTok,
    last: Math.round(costStat.last * 10000) / 10000,
    price: { ...TOKEN_PRICE },
  }
}

/* 归零只用于「换 key / 存盘口径重置」这类人为操作，平时别调 ——
 * 桥的 syncRiceCost 靠增量累加，这里一归零 delta 会变成负数（它已经判掉了）。 */
export function costReset() {
  costStat.yuan = 0
  costStat.req = 0
  costStat.inTok = 0
  costStat.outTok = 0
  costStat.last = 0
}

/**
 * 桥注册进来的「现场实况」回调：给 (kind, text) 返回一段要贴在这条 user 行尾的话。
 *
 * 为什么用回调而不是把桥的白饭状态 import 进来：reply.mjs 被 bridge.mjs 引，
 * 反过来引就成环了。回调还能让桥随时改口径（关掉、改碗价）而不用重启。
 */
let riceHint = null
export function setRiceHint(fn) {
  riceHint = typeof fn === 'function' ? fn : null
}

export function cacheStats() {
  const inTok = cacheStat.hit + cacheStat.miss
  return {
    req: cacheStat.req,
    hit: cacheStat.hit,
    miss: cacheStat.miss,
    rate: inTok ? +((cacheStat.hit / inTok) * 100).toFixed(1) : 0,
    lastHit: cacheStat.lastHit,
    lastIn: cacheStat.lastIn,
    last: cacheStat.lastIn ? +((cacheStat.lastHit / cacheStat.lastIn) * 100).toFixed(1) : 0,
    prefix: getSystem().length, // 每次重算（内容不变，只是拼串），别缓存成常量
  }
}

async function llmReply(r, { user, text, kind, song = null, profile = null, video = null, facts = null, history = null, maxLen = MAX_LEN, reco = null }, timeoutMs = 6000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const headers = { 'content-type': 'application/json' }
  if (r.key) headers.authorization = `Bearer ${r.key}`

  /**
   * 🔴 2026-10-26 实测（deepseek-flash 是**推理模型**）：
   *   max_tokens 60  ⇒ 60 个 token 全花在 reasoning_content 上，content 是空串，finish=length
   *   reasoning_effort:low ⇒ 照样烧 109 个推理 token，max=200 时又整段被推理吃掉，content 还是空
   *   thinking:{type:"disabled"} ⇒ 推理 0 token，1.0 秒回话，稳
   * 所以直播这种「要一句短话」的场景必须把思考关掉，不然又慢又空。
   * 这个字段是 DeepSeek 系的，别的接口不认，所以只对它发。
   */
  /* 对话历史（2026-10-29，A）。
   * 以前每条请求都是「system + 一条 user」，她不知道上一句说了什么 ——
   * 观众说「你认识汤令山吗」，她答完，观众补一句「汤令山是唱颜色的」，
   * 在她那儿这是两个陌生人说的话，只能从头再问一遍。这就是「聊不动」的根。
   *
   * 位置很关键：history 放在 system **之后** ——
   * deepseek 的前缀缓存从第一条消息往后算，system 一动缓存全废。
   * 放在后面只让「history + 当前那句」这一段不命中，system 那 2000 多 token 照命中。
   */
  const messages = [{ role: 'system', content: getSystem() }]
  if (Array.isArray(history)) {
    for (const m of history) {
      if (m && m.role && m.content) messages.push({ role: m.role, content: String(m.content) })
    }
  }
  /* 有了 3 轮历史之后不再叠 saidHint —— 两者记的是同一批句子
   * （history 里那 3 条 assistant 就是最近说过的 3 句），再叠一遍纯属浪费 token。
   * 只有没带历史的那条路（面板「试说一句」、启动探活）才用它兜住「别重复」。 */
  messages.push({
    role: 'user',
    content: userLine(kind, user, text, song, profile, video, facts, reco) + (messages.length > 1 ? '' : saidHint()),
  })

  const body = {
    model: r.model,
    temperature: 0.9,
    max_tokens: Number(CONF.maxTokens) || 120,
    messages,
  }
  if (/deepseek/i.test(r.base)) {
    /* 🔴 固定关思考（2026-10-30 主人第二次确认）。
     * 中间试过给「黎曼猜想」这类高难问题单独开 thinking，能答得更准，
     * 但一开就要把 max_tokens 提到 900+（推理会烧光额度、content 变空串），
     * 一条的成本和耗时都翻几倍 —— 主人判断不值，撤了。
     * 现在沿用「1 秒一句」的老路，准确性靠下面 userLine 里那句引导兜。 */
    body.thinking = { type: 'disabled' }
  }

  try {
    const res = await fetch(`${r.base}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers,
      body: JSON.stringify(body),
    })
    /* 🔴 光抛 `HTTP 400` 等于没说（2026-11-02 实测踩过）：
     * 模型名打错、key 不对、余额空，全都长成「HTTP 4xx」，
     * 面板上看到的就是一句没头没尾的状态码。
     * 接口的错误体里其实有 `error.message`（"Model Not Exist" / "Authentication Fails"），
     * 捞出来带上；捞不到再退回状态码。截 200 字，别把整坨 HTML 塞进日志。 */
    if (!res.ok) {
      let detail = ''
      try {
        const t = await res.text()
        try {
          const j = JSON.parse(t)
          detail = j?.error?.message || j?.msg || j?.message || ''
        } catch {
          detail = t.slice(0, 120)
        }
      } catch {
        // 错误体都读不出来就只报状态码
      }
      const hint =
        res.status === 400 ? '（模型名不对？先在面板上探测一下）'
        : res.status === 401 || res.status === 403 ? '（key 不对或没权限）'
        : res.status === 402 ? '（余额不足）'
        : res.status === 429 ? '（限流，等会儿再试）'
        : ''
      throw new Error(`HTTP ${res.status}${detail ? `：${String(detail).slice(0, 200)}` : ''}${hint}`)
    }
    const j = await res.json()

    /* 记账：usage 里有 prompt_cache_hit_tokens / prompt_cache_miss_tokens。
     * 每条都打会把日志刷满，所以第 1 条和每 10 条打一次。 */
    const u = j?.usage || {}
    if (u.prompt_tokens) {
      cacheStat.req++
      cacheStat.hit += u.prompt_cache_hit_tokens || 0
      cacheStat.miss += u.prompt_cache_miss_tokens || 0
      cacheStat.lastHit = u.prompt_cache_hit_tokens || 0
      cacheStat.lastIn = u.prompt_tokens || 0
      if (cacheStat.req === 1 || cacheStat.req % 10 === 0) {
        const c = cacheStats()
        console.log(
          `  [cache] 本条 ${cacheStat.lastHit}/${cacheStat.lastIn}（${c.last}%）· ` +
            `累计 ${c.rate}%（${c.req} 条）`,
        )
      }
    }
    /* 白饭账：这一条花了多少钱（元）。失败重试的那几次也算 —— 请求发出去了
     * 平台就计费，没返回 usage 只是我们看不见，bridge 那边会用真余额校准补上。 */
    if (u.prompt_tokens || u.completion_tokens) {
      const hit = u.prompt_cache_hit_tokens || 0
      const miss = u.prompt_cache_miss_tokens || Math.max(0, (u.prompt_tokens || 0) - hit)
      const outTok = u.completion_tokens || 0
      const yuan =
        (hit * TOKEN_PRICE.inHit + miss * TOKEN_PRICE.inMiss + outTok * TOKEN_PRICE.out) / 1e6
      costStat.yuan += yuan
      costStat.req++
      costStat.inTok += u.prompt_tokens || 0
      costStat.outTok += outTok
      costStat.last = yuan
    }
    // 有的中转/网关 HTTP 200 但 body 是 {"code":0,"msg":"..."}，别把这种当成功
    if (!j || !Array.isArray(j.choices)) {
      throw new Error(j?.msg || j?.error?.message || '接口没返回 choices（不是 OpenAI 兼容格式？）')
    }
    const msg = j.choices?.[0]?.message || {}
    const out = msg.content || ''
    if (!out && msg.reasoning_content) {
      // 推理把额度吃光了（见上面那段实测）。这不是"她不想说"，是配置不够，得报出来
      throw new Error(`只回了思考没回话（finish=${j.choices[0].finish_reason}），把 maxTokens 调大或关掉思考`)
    }
    /* 深度问题给 40 字（两段字幕），其余 20 字。
     * max_tokens 跟着放宽 —— 120 对 40 个汉字够用，但中转/推理模型会偷吃额度，
     * 给到 200 稳一点，反正按 token 计费的是实际输出。 */
    if (maxLen > MAX_LEN) body.max_tokens = 200
    /* 顺手去掉句尾句号：人设卡铁律要求「句尾不加句号」（字幕条不需要，
     * TTS 还会多停一下），但模型偶尔还是加上。本地话术本来就不带。 */
    const clean = out.replace(/^["「『]|["」』]$/g, '').replace(/。\s*$/, '')
    return clip(clean, maxLen)
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ 对外 */

/**
 * 哪些弹幕不用花 token。
 *
 * 🔴 2026-10-26 主人问「缓存命中怎么这么低」。实测直播这条链路是 84.5%，
 *    剩下的 15% 里有一半是**天然不可能命中**的（64-token 块粒度 + 每条不同的 user 消息）。
 *    真正能省的不是命中率，是**请求数** —— 每条弹幕都问一次模型，命中率再高也是白花钱。
 *
 * 这两类交给本地模板，理由不是省钱，是**本地答得更准**：
 *   · 礼物：必须点名、必须带上礼物名，模板比模型稳（模型偶尔会把名字写错）
 *   · 点歌：要报"排第几首"，这个队列状态模型根本不知道，本地才有
 * 其余（提问、闲聊、被骂、被夸）继续走模型 —— 那才是人设发挥作用的地方。
 */
function betterLocal({ kind = '', text = '' }) {
  /* 2026-10-27 改：礼物不再一律走本地。
   * 原因：礼物文案要跟性格走（毒嘴/女仆/有梗三种口气），本地模板只有一种。
   * 代价是每条多花一次 token、多等约 1 秒；点名不靠模型自觉 —— 下面出口有校验。
   * 面板上把「礼物用模型」关掉（gift.json 的 useLlm=false）就回到老行为。 */
  if (kind === 'like') return true
  /* 素材视频的开场/收尾永远走本地（2026-10-29）：
   * 视频已经在放了，这句要立刻出；而且模型不知道这段拍的是什么。 */
  if (kind === 'videoIntro' || kind === 'videoOutro') return true
  /* 放视频 / 「你能做什么」也走本地（2026-10-27）：
   *   · 放视频：桥已经真放了，本地模板保证「说了就真放了」，模型容易答成「我找找」
   *   · 能做什么：这是**能力清单**，交给模型就会多出「我会唱歌跳舞」这种做不到的承诺 */
  const s = String(text || '')
  if (RE.video.test(s) || RE.skill.test(s)) return true
  // 这里也去掉了 RE.gift：文字里出现「礼物」二字不等于送了礼物，
  // 让这类走模型，「主播是骗子别刷礼物」才能被当成人话理解而不是感谢。
  return RE.song.test(s)
}

async function makeReplyRaw(ctx) {
  // ⓪ 强制本地：面板把「礼物用模型」关掉时走这里（不用每处再判一遍配置）
  if (ctx?.forceLocal) return localReply(ctx)
  // ① 入口闸门：有人在借她的嘴发广告 / 报联系方式 → 不调模型，直接拒绝
  /* 🔴 假送礼**不走**这道闸门（2026-10-30）。
   * 观众会打「送出啤酒*100000000000」，长数字串会先被当成广告拦下，
   * 回一句「群号就不念啦」—— 答非所问，观众只看到她在胡说。
   * 这种句子本来就是假装送礼，交给下面的点破逻辑更对。
   * 出口闸门（adHit(out)）照旧兜底，不会真把联系方式念出去。 */
  const fakeHere = ctx?.kind !== 'gift' && isFakeGift(ctx?.text)
  const adWhy = fakeHere ? '' : adHit(ctx?.text)
  if (adWhy) {
    console.log(`  [guard] 拦下一条${adWhy}：${String(ctx.text).slice(0, 40)}`)
    return refuseAd()
  }
  if (betterLocal(ctx)) return localReply(ctx)
  const r = route()
  if (!r.ok) return localReply(ctx)
  if (Date.now() < coolUntil) return localReply(ctx) // 冷却中，别去撞墙
  try {
    /* 高难问题（黎曼猜想、费马大定理…）**只给字数、不开思考**（2026-10-30 主人定）。
     * 开思考确实答得更准，但 max_tokens 要提到 900+、耗时翻几倍，不值。
     * 现在靠的是 userLine 里那句「别一句就推掉」—— 零成本，效果已经够用。
     *
     * 小学算术连字数额度都不给：主人要她装蠢，答错反而能劝退刷题的。 */
    const hard = isHardQuestion(ctx?.text)
    const maxLen = hard || (ctx?.kind === 'chat' && needDeep(ctx?.text)) ? MAX_LEN_DEEP : MAX_LEN
    const out = await llmReply(r, { ...ctx, maxLen })
    if (out) {
      llmOk++
      if (coolStep) {
        console.log(`  [llm] 恢复（之前连续失败 ${coolStep} 次）`)
        coolStep = 0
      }
      // ② 出口闸门：模型被绕过了也还有这一层
      const outWhy = adHit(out)
      if (outWhy) {
        console.log(`  [guard] 回复里带${outWhy}，已替换：${out.slice(0, 40)}`)
        return refuseAd()
      }
      /* ③ 礼物必须点名（2026-10-27 加）。
       * 礼物改成走模型之后，性格是有了，但模型偶尔会省掉昵称 ——
       * 直播间里「谢谢你的小心心」和「谢谢阿伟的小心心」是两回事，
       * 后者才让观众觉得被看见了。漏了就退回本地模板，模板一定带名字。 */
      if (ctx.kind === 'gift' && ctx.user && !out.includes(ctx.user)) {
        console.log(`  [guard] 礼物回复没点名（${out.slice(0, 20)}），退回本地话术`)
        return localReply(ctx)
      }
      return out
    }
  } catch (e) {
    // 模型挂了不能让她哑掉：静默退回本地话术，按 5/15/60 秒递增退避
    const ms = tripCool()
    llmFails++
    lastErr = e?.message || String(e)
    lastErrAt = Date.now()
    console.error(`  [llm] 失败（连续 ${coolStep} 次），${Math.round(ms / 1000)} 秒内走本地话术：${lastErr}`)
  }
  return localReply(ctx)
}

/**
 * 对外只暴露这一个 —— 外面不用管"这句话是模型说的还是模板说的"，
 * 统一在这里记一笔，下一次调用就会带进 user 行（见 saidHint）。
 *
 * 拆成 Raw + 外壳，是因为里面 return 的出口有六七个（广告闸门、点歌、礼物、
 * 冷却、模型成功、模型失败、兜底）。逐个加 rememberSaid 一定会漏，
 * 包一层是唯一保证不漏的写法。
 */
export async function makeReply(ctx) {
  const out = await makeReplyRaw(ctx)
  // 面板「试说一句」不记 —— 那不是她说出口的话，别影响直播里「刚说过」的判断
  if (!ctx?.noRemember) rememberSaid(out)
  return out
}

/**
 * 启动时探一次：配了 key 不等于能用（中转挂了、余额空了、格式不对、模型名不对都算）。
 * 返回 { ok, why, sample }，bridge 拿它决定日志怎么写。
 */
export async function probeLLM() {
  const r = route()
  if (!r.ok) return { ok: false, why: r.why, label: '没配好' }
  /* 20 秒，不是 10（2026-11-02 实测踩过）。
   * deepseek-v4-pro 这种推理模型首字要 1 秒以上，遇上「桥刚起来自检」和
   * 「面板点探测」同时打接口，10 秒会先到点 —— 报出来的还是一句
   * `This operation was aborted`，看着像接口坏了，其实是超时。
   * 直播时每条弹幕仍然走 llmReply 自己的 6 秒（那里要快），这里只服务探活。 */
  const PROBE_MS = 20000
  try {
    const out = await llmReply(r, { user: '测试', text: '在吗', kind: 'chat' }, PROBE_MS)
    if (!out) return { ok: false, why: '接口通了但回的是空串', label: r.label }
    return { ok: true, sample: out, label: r.label }
  } catch (e) {
    const raw = e?.message || String(e)
    /* AbortError 的 message 是英文的 "This operation was aborted"，
     * 直接抛给面板等于没说。翻译成「多久没回」。 */
    const why =
      e?.name === 'AbortError' || /abort/i.test(raw)
        ? `等了 ${PROBE_MS / 1000} 秒没回话（接口太慢 / 模型名不对 / 网络卡住）`
        : raw
    return { ok: false, why: r.hint ? `${why} —— ${r.hint}` : why, label: r.label }
  }
}

/**
 * 试一份**还没落盘**的配置（2026-11-02）。
 *
 * 🔴 为什么不能「先存再试」：主人填了个错的模型名（手滑 / 接口改了名），
 *    一点「保存并测试」，能用的那份配置就被错的覆盖了 —— 直播中这一步等于
 *    当场把她弄哑。所以顺序必须是**先试，通了才存**（存的活由 bridge 干）。
 *
 * 做法：临时把内存里的 CONF 换成试的那份，试完无论成败都换回去。
 * 不碰磁盘，所以失败了配置一点没变。
 */
export async function probeLLMWith(over = {}) {
  reloadConf()
  const backup = { ...CONF }
  const tryConf = { ...CONF }
  if (over.base != null && String(over.base).trim()) tryConf.base = String(over.base).trim().replace(/\/+$/, '')
  if (over.key != null && String(over.key).trim()) tryConf.key = String(over.key).trim()
  if (over.model != null && String(over.model).trim()) tryConf.model = String(over.model).trim()
  CONF = tryConf
  routeCache = { at: 0, route: null }
  try {
    return await probeLLM()
  } finally {
    /* 无论成败都还原 —— 这里泄漏一次，后面每条弹幕都会走一份没存过的配置，
     * 而面板上显示的又是文件里的那份，两边对不上。 */
    CONF = backup
    routeCache = { at: 0, route: null }
  }
}

/**
 * 列一下这个接口能用的模型名。
 *
 * 面板「探测模型」按钮走这里。2026-11-02 改：**允许临时传 base/key** ——
 * 主人是「先填地址和 key、点探测、再挑一个」这个顺序，探测时那两样还没存盘。
 * 不传就用 llm.json 里现有的（换模型时不用重填 key）。
 *
 * 探测本身**不需要模型名**（GET /models 不认 model），所以这里不检查 model。
 */
export async function listModels(over = {}) {
  reloadConf()
  const base = String(over.base || process.env.REPLY_API_BASE || CONF.base || 'https://api.deepseek.com/v1')
    .trim()
    .replace(/\/+$/, '')
  const key = String(over.key || process.env.REPLY_API_KEY || CONF.key || '').trim()
  if (!base) return { ok: false, why: '还没填接口地址' }
  if (!key) return { ok: false, why: '还没填 API key' }
  const headers = { authorization: `Bearer ${key}` }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  try {
    const res = await fetch(`${base}/models`, { headers, signal: ctl.signal })
    /* 有的中转把错误也回 200 + HTML，先看状态码再解析，别让 JSON.parse 抛一句看不懂的 */
    if (!res.ok) {
      let detail = ''
      try {
        const t = await res.text()
        const j = JSON.parse(t)
        detail = j?.error?.message || j?.msg || t.slice(0, 200)
      } catch {
        // 非 JSON 错误体就算了，状态码已经够用
      }
      return {
        ok: false,
        why: `接口回了 HTTP ${res.status}${detail ? `：${detail}` : ''}` +
          (res.status === 401 || res.status === 403 ? '（key 不对？）' : ''),
      }
    }
    const j = await res.json()
    const ids = (Array.isArray(j?.data) ? j.data : [])
      .map((m) => (typeof m === 'string' ? m : m?.id))
      .filter(Boolean)
      .map(String)
    /* 有的中转（和部分兼容层）不实现 /models。这时候不该说「接口坏了」，
     * 而是明说「列不出来，手填吧」—— 手填的输入框面板上一直都有。 */
    if (!ids.length) return { ok: false, why: '这个接口没返回模型列表（可能不支持 /models），可以手动填模型名' }
    return { ok: true, ids, base, label: `@ ${base}` }
  } catch (e) {
    /* 区分「超时」和「连不上」。连不上最常见的原因是地址写错了
     * （多打一个路径段、https 写成 http、端口不对），提示要往那儿指。 */
    const why =
      e?.name === 'AbortError'
        ? '探测超时（15 秒）'
        : /fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(String(e?.message || e))
          ? `连不上 ${base} —— 地址写错了？${e?.cause?.code ? `（${e.cause.code}）` : ''}`
          : e?.message || String(e)
    return { ok: false, why }
  } finally {
    clearTimeout(timer)
  }
}

/** 现在实际会走哪儿（每次现算，别用模块加载时的旧值） */
export function describe() {
  const r = route()
  return r.ok ? `模型 ${r.label}` : `没连上模型（${r.why}），先用本地话术顶着`
}

const R = route()
export const llmConfigured = R.ok
export const replyMode = describe()

/**
 * 存接口配置（2026-11-02）。
 *
 * 只认 base / key / model 三个字段，写进 llm.json，然后**立刻**让内存里的
 * CONF 跟上 —— 下一条弹幕就走新的，不用重启桥。
 *
 * 🔴 三件事必须守住：
 *   1. 其它字段（maxTokens 之类）原样保留，别整份覆盖掉；
 *   2. key 传空串 = 不改（面板上那个框回填的是打码值，不能拿它覆盖真 key）；
 *   3. 写盘用 .tmp + rename，半截文件会让桥以为「没配」而静默退回本地话术。
 */
export function saveLlmCfg(patch = {}) {
  const cur = { ...(readJsonSafe(CONF_FILE) || {}) }
  const next = { ...cur }
  if (patch.base != null) {
    const v = String(patch.base).trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(v)) return { ok: false, why: '接口地址要以 http:// 或 https:// 开头' }
    next.base = v
  }
  /* 只有明确给了非空 key 才写。面板不会把真 key 发回来（见 bridge 的打码逻辑）。 */
  if (patch.key != null && String(patch.key).trim()) next.key = String(patch.key).trim()
  if (patch.model != null) {
    const v = String(patch.model).trim()
    if (!v) return { ok: false, why: '模型名不能是空的' }
    next.model = v
  }
  /* 老配置里的 mode 现在没用了。留着会让人以为还能切档 —— 直接删掉。 */
  delete next.mode
  delete next.dsh
  try {
    fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true })
    const tmp = `${CONF_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, CONF_FILE)
  } catch (e) {
    return { ok: false, why: '写 llm.json 失败：' + (e?.message || String(e)) }
  }
  CONF = next
  try {
    confMtime = fs.statSync(CONF_FILE).mtimeMs
  } catch {
    confMtime = 0
  }
  routeCache = { at: 0, route: null } // 立刻重算，别等 10 秒缓存过期
  return { ok: true, base: next.base || '', model: next.model || '', hasKey: Boolean(next.key), text: describe() }
}

/** 面板要显示「现在填的是什么」。key 打码，绝不把明文发给浏览器。 */
export function llmCfg() {
  reloadConf()
  const key = String(CONF.key || '')
  return {
    base: String(CONF.base || ''),
    model: String(CONF.model || ''),
    /* 只露尾巴 4 位。够确认「填的是哪把钥匙」，又不足以被抄走。 */
    keyMask: key ? (key.length <= 8 ? '••••' : `••••${key.slice(-4)}`) : '',
    hasKey: Boolean(key),
    env: {
      /* 环境变量能盖掉文件里的值。盖着的时候面板要明说，
       * 不然「存了没生效」会查很久。 */
      base: Boolean(process.env.REPLY_API_BASE),
      key: Boolean(process.env.REPLY_API_KEY || process.env.DEEPSEEK_API_KEY),
      model: Boolean(process.env.REPLY_MODEL),
    },
    text: describe(),
  }
}

/**
 * 以前这里是「热切换回复档」（flash / dsh / local）。2026-11-02 撤掉了：
 * 换模型现在走 saveLlmCfg，档位这个概念本身不存在了。
 *
 * 保留这个导出只为让老的调用方（bridge 的 /reply/mode）有个明确的拒绝，
 * 而不是静默成功却什么也没做。
 */
export function setReplyMode(m) {
  const v = String(m || '').trim().toLowerCase()
  return {
    ok: false,
    why: `回复档已经取消了（收到 ${v || '空'}）。现在只有一条路：设置 → 账号 → 接口与模型 里选模型。`,
  }
}

/** /healthz 用：每次现算，别用模块加载时的旧字符串 */
export function replyModeText() {
  return describe()
}

// 直接跑：node reply.mjs 阿伟 "点歌 孤勇者"
// 探接口：node reply.mjs --probe
// 列模型：node reply.mjs --models
// 预热：  node reply.mjs --warm      ← 开播前跑两次，第一条弹幕就不用全价买前缀
// 临时换模型（不改文件）：REPLY_MODEL=deepseek-v4-pro node reply.mjs --probe
if (process.argv[1] && process.argv[1].endsWith('reply.mjs')) {
  const args = process.argv.slice(2)

  if (args[0] === '--warm') {
    console.log('配置：', describe())
    probeLLM().then((p) => {
      const c = cacheStats()
      if (!p.ok) {
        console.log(`✗ 预热失败：${p.why}`)
        process.exit(1)
      }
      console.log(`✓ 前缀已写进缓存（${c.prefix} 字），样例「${p.sample}」`)
      console.log(
        `  本次命中 ${c.lastHit}/${c.lastIn}（${c.last}%）—— 第一次预热必然是 0%，` +
          `**再跑一次**才是真实命中率`,
      )
      process.exit(0)
    })
  } else if (args[0] === '--kb') {
    // 看知识库：node reply.mjs --kb            → 列所有块和触发词
    //           node reply.mjs --kb 学校堵车吗   → 这条弹幕会捞到哪几块
    const info = kbInfo()
    console.log(`知识库：${info.enabled ? '开' : '关'}，${info.blocks.length} 块`)
    const t = args.slice(1).join(' ').trim()
    if (!t) {
      for (const b of info.blocks) {
        console.log(`  · ${b.file}/${b.title}  (${b.chars} 字)  kw: ${b.kws.join('、')}`)
      }
    } else {
      const got = kbPick(t)
      console.log(`弹幕：${t}`)
      if (!got) console.log('  → 没踩到知识，user 行不加料（这是常态）')
      else {
        const titles = [...got.matchAll(/【(.+?)】/g)].map((m) => m[1])
        console.log(`  → 命中 ${titles.length} 块：${titles.join('、')}，共 ${got.length} 字`)
        console.log('-----')
        console.log(got.trim())
      }
    }
    process.exit(0)
  } else if (args[0] === '--probe' || args[0] === '--models') {
    console.log('配置：', describe())
    if (args[0] === '--models') {
      listModels().then((m) => {
        if (!m.ok) return console.log('✗ 列不出来：' + m.why)
        console.log(`✓ ${m.label} 可用模型：`)
        for (const id of m.ids) console.log('  ·', id)
      })
    } else {
      probeLLM().then((p) => {
        console.log(p.ok ? `✓ 通了（${p.label}），回的是「${p.sample}」` : `✗ 不通：${p.why}`)
        process.exit(p.ok ? 0 : 1)
      })
    }
  } else {
    const [user = '测试', text = '你好', kind = ''] = args
    ;(async () => {
      console.log('配置：', describe())
      // 单条试话术也先探一次，免得打印「模型」却悄悄用了本地话术
      const p = await probeLLM()
      console.log(p.ok ? `  自检通过（样例：${p.sample}）` : `  ⚠ 探不通，用本地话术：${p.why}`)
      const r = await makeReply({ user, text, kind })
      console.log(`  ${user}：${text}`)
      console.log(`  大肥鱼：${r}   (${r.length} 字)`)
    })()
  }
}
