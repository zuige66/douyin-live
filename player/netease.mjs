/**
 * 网易云音乐精简客户端 —— 只做点歌真正需要的三件事：搜索、取直链、验证登录。
 *
 * 为什么自己写：SinglePlayer（dsh-music-huazai）是 GPL-3.0，本仓库要公开，
 * 把它的代码抄进来整个仓库都得跟着 GPL。这里的 weapi / eapi 加密是社区公开的
 * 事实标准（NeteaseCloudMusicApi 等实现一致），按规范重写，不复制它的源码。
 *
 * 登录态直接读 DSH 音乐插件留下的 auth.json —— 主人已经在那边登录过 SVIP 账号
 * （vipType=11），不用重新扫码。读不到就明确报「没登录」，不偷偷退回匿名：
 * 匿名取不到 VIP 曲，只会得到一堆试听片段，比直接报错更难查。
 */
import { createHash, createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 项目根目录 —— 用 cwd 的话，从 player/ 里起服务就找不到 .run/ 了 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const IV = '0102030405060708'
const PRESET_KEY = '0CoJUm6Qyw8W8jud'
const EAPI_KEY = 'e82ckenh8dichen8'
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`

const DOMAIN = 'https://music.163.com'
const API_DOMAIN = 'https://interface.music.163.com'
const WEAPI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const API_UA = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)'

const DEVICE_ID = randomBytes(26).toString('hex')
const OSVER = 'Microsoft-Windows-10-Professional-build-19045-64bit'
const APPVER = '3.1.17.204416'

/* ══════════════════════════════════════════════════════════════════════
 * 登录态
 * ══════════════════════════════════════════════════════════════════════ */

/** 候选顺序：项目自己的 → DSH 音乐插件的。DSH_HOME 可覆盖。 */
function authFiles() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return [
    path.join(ROOT, '.run', 'netease-auth.json'),
    path.join(dshHome, 'dsh-music-huazai', 'auth.json'),
  ]
}

let cookieCache = { at: 0, value: '' }

/** 读网易云 Cookie。60 秒缓存 —— 每首歌都读盘没必要。 */
export function neteaseCookie() {
  if (cookieCache.value && Date.now() - cookieCache.at < 60_000) return cookieCache.value
  for (const file of authFiles()) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      const c = String(j.neteaseCookie || '')
      if (/(?:^|;)\s*MUSIC_U=/.test(c)) {
        cookieCache = { at: Date.now(), value: c }
        return c
      }
    } catch {
      /* 下一个 */
    }
  }
  cookieCache = { at: Date.now(), value: '' }
  return ''
}

/** 登录态从哪来 —— 面板上要显示出来，不然「为什么点歌只有试听」没法查 */
export function cookieSource() {
  const c = neteaseCookie()
  if (!c) return { ok: false, file: '', why: '没找到网易云登录态（先打开一次 DSH 音乐插件登录，或手动放 auth.json）' }
  for (const file of authFiles()) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (String(j.neteaseCookie || '') === c) return { ok: true, file, why: '' }
    } catch {}
  }
  return { ok: true, file: '(缓存)', why: '' }
}

/* ══════════════════════════════════════════════════════════════════════
 * 加密原语（weapi = 双重 AES-CBC + RSA；eapi = AES-ECB）
 * ══════════════════════════════════════════════════════════════════════ */

const md5 = (s) => createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex')

function aesEncrypt(text, mode, key, iv, format = 'base64') {
  const cipher = createCipheriv(
    mode === 'ecb' ? 'aes-128-ecb' : 'aes-128-cbc',
    Buffer.from(key, 'utf8'),
    mode === 'ecb' ? null : Buffer.from(iv, 'utf8'),
  )
  cipher.setAutoPadding(true)
  const enc = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()])
  return format === 'base64' ? enc.toString('base64') : enc.toString('hex').toUpperCase()
}

function rsaEncrypt(str) {
  /* RSA_NO_PADDING 要求输入恰好等于模长（1024bit = 128 字节）：
   * 必须分配完整 128 字节再从尾部写入（左补零）。写成 alloc(128-len) 会静默截断。 */
  const buf = Buffer.from(str, 'utf8')
  const padded = Buffer.alloc(128)
  buf.copy(padded, 128 - buf.length)
  return publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_NO_PADDING }, padded).toString('hex')
}

function weapi(object) {
  const text = JSON.stringify(object)
  let secretKey = ''
  for (let i = 0; i < 16; i++) secretKey += BASE62.charAt(Math.floor(Math.random() * 62))
  return {
    params: aesEncrypt(aesEncrypt(text, 'cbc', PRESET_KEY, IV), 'cbc', secretKey, IV),
    encSecKey: rsaEncrypt(secretKey.split('').reverse().join('')),
  }
}

function eapi(uri, object) {
  const text = JSON.stringify(object)
  const digest = md5(`nobody${uri}use${text}md5forencrypt`)
  const data = `${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return { params: aesEncrypt(data, 'ecb', EAPI_KEY, '', 'hex') }
}

/* ══════════════════════════════════════════════════════════════════════
 * 请求
 * ══════════════════════════════════════════════════════════════════════ */

function parseCookie(str) {
  const out = {}
  for (const item of String(str || '').split(';')) {
    const i = item.indexOf('=')
    if (i > 0) out[item.slice(0, i).trim()] = item.slice(i + 1).trim()
  }
  return out
}

const serialize = (obj) =>
  Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(obj[k]))}`)
    .join('; ')

/**
 * @param {string} uri  /api/xxx 形式
 * @param {object} data
 * @param {{crypto?: 'weapi'|'eapi', cookie?: string, timeout?: number}} opt
 */
async function request(uri, data, opt = {}) {
  const crypto = opt.crypto || 'weapi'
  const cookie = opt.cookie !== undefined ? opt.cookie : neteaseCookie()
  const cj = parseCookie(cookie)
  const headers = {}
  let url
  let payload

  if (crypto === 'weapi') {
    headers.Referer = DOMAIN
    headers['User-Agent'] = WEAPI_UA
    headers.Cookie = serialize(cj)
    const body = { ...data, csrf_token: cj.__csrf || '' }
    payload = new URLSearchParams(weapi(body)).toString()
    url = DOMAIN + '/weapi/' + uri.slice(5)
  } else {
    const header = {
      osver: OSVER,
      deviceId: DEVICE_ID,
      os: 'pc',
      appver: APPVER,
      versioncode: '140',
      mobilename: '',
      buildver: String(Date.now()).slice(0, 10),
      resolution: '1920x1080',
      __csrf: cj.__csrf || '',
      channel: 'netease',
      requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
    }
    if (cj.MUSIC_U) header.MUSIC_U = cj.MUSIC_U
    if (cj.MUSIC_A) header.MUSIC_A = cj.MUSIC_A
    headers.Cookie = serialize(header)
    headers['User-Agent'] = API_UA
    payload = new URLSearchParams(eapi(uri, { ...data, header })).toString()
    url = API_DOMAIN + '/eapi/' + uri.slice(5)
  }

  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), opt.timeout || 10_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload,
      signal: ctl.signal,
    })
    const text = await res.text()
    try {
      const j = JSON.parse(text)
      if (j && j.code != null) j.code = Number(j.code)
      return j
    } catch {
      return { code: res.status, raw: String(text).slice(0, 200) }
    }
  } finally {
    clearTimeout(t)
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 业务：搜索 / 取流 / 账号
 * ══════════════════════════════════════════════════════════════════════ */

/** 曲目对象跟桥认的字段完全一致（桥是拿 track.id 做队列对账的） */
function mapTrack(s) {
  if (!s || !s.id) return null
  const artists = (s.ar || s.artists || []).map((a) => String(a?.name ?? '')).filter(Boolean)
  const album = s.al || s.album || {}
  return {
    id: `netease:${s.id}`,
    provider: 'netease',
    songId: String(s.id),
    name: String(s.name ?? ''),
    artists,
    album: String(album.name ?? ''),
    durationMs: Number(s.dt ?? s.duration ?? 0) || 0,
    cover: String(album.picUrl ?? ''),
    vip: Number(s.fee ?? 0) === 1,
  }
}

export async function search(keywords, limit = 10, offset = 0) {
  const kw = String(keywords || '').trim()
  if (!kw) return []
  const r = await request('/api/cloudsearch/pc', { s: kw, type: 1, limit, offset, total: true })
  const songs = r?.result?.songs || []
  return songs.map(mapTrack).filter(Boolean)
}

/** 音质档位 → level 参数。高音质拿不到就逐级降，别一上来就失败。 */
const LEVEL_FALLBACK = {
  jymaster: ['hires', 'lossless', 'exhigh', 'standard'],
  hires: ['lossless', 'exhigh', 'standard'],
  lossless: ['exhigh', 'standard'],
  exhigh: ['standard'],
  standard: [],
}

/**
 * 取直链。
 * @returns {Promise<{url:string, level:string, trial:boolean, code:number, why?:string}>}
 */
export async function songUrl(songId, quality = 'exhigh') {
  const id = String(songId || '').replace(/\D/g, '')
  if (!id) return { url: '', level: '', trial: false, code: 0, why: '没有歌曲 id' }
  const levels = [quality, ...(LEVEL_FALLBACK[quality] || [])]
  let lastCode = '?'
  for (const level of levels) {
    const r = await request('/api/song/enhance/player/url/v1', { ids: `[${id}]`, level, encodeType: 'flac' }, { crypto: 'eapi' })
    lastCode = r?.code ?? '?'
    const d = r?.data?.[0]
    const url = String(d?.url || '')
    if (!url) continue
    return {
      url,
      level: String(d?.level || level),
      trial: d?.freeTrialInfo != null,
      code: Number(r?.code) || 0,
    }
  }
  return {
    url: '',
    level: '',
    trial: false,
    code: Number(lastCode) || 0,
    why: `取不到直链（code=${lastCode}，试过 ${levels.join('→')}）`,
  }
}

export async function userAccount() {
  const r = await request('/api/nuser/account/get', {})
  const p = r?.profile
  return {
    loggedIn: Boolean(p?.nickname),
    nickname: p?.nickname ? String(p.nickname) : '',
    avatar: p?.avatarUrl ? String(p.avatarUrl) : '',
    vipType: Number(r?.account?.vipType ?? 0),
    code: Number(r?.code) || 0,
  }
}

/** 歌词（画面可能要用；取不到就空，不影响播放） */
export async function lyric(songId) {
  const id = String(songId || '').replace(/\D/g, '')
  if (!id) return { lrc: '', tlyric: '' }
  try {
    const r = await request('/api/song/lyric/v1', { id, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 })
    return {
      lrc: String(r?.lrc?.lyric || ''),
      tlyric: String(r?.tlyric?.lyric || ''),
    }
  } catch {
    return { lrc: '', tlyric: '' }
  }
}
