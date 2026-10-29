// 桌面余额气泡：从 Magpie 本机网关读余额（/v1/magpie/quotas）和用量（/v1/magpie/usage）
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const watchTurns = require('./turns')

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json')
const ERR_FILE = path.join(app.getPath('userData'), 'error.log')
// 出问题别静默：主进程未捕获的异常记到 error.log（超过 256KB 就轮转一次）
function logErr(where, e) {
  try {
    if (fs.existsSync(ERR_FILE) && fs.statSync(ERR_FILE).size > 256 * 1024) fs.renameSync(ERR_FILE, ERR_FILE + '.1')
    fs.appendFileSync(ERR_FILE, `[${new Date().toISOString()}] ${where}: ${e?.stack || e}
`)
  } catch {}
}
process.on('uncaughtException', (e) => logErr('uncaught', e))
process.on('unhandledRejection', (e) => logErr('unhandled', e))
const DEFAULTS = {
  gateway: process.env.MAGPIE_GATEWAY || 'http://127.0.0.1:3425',
  provider: null,      // null = 跟随正在使用的 API（看 usage.jsonl 最后一条请求）；填 id 就是钉死这个供应商
  pollSec: 10,         // 读 Magpie 缓存的频率（不打上游）
  refreshMin: 60,      // 定时让 Magpie 去上游重查余额的间隔（分钟）；对话结束和手动刷新另算
  turnRefreshMin: 30,  // 对话结束触发上游刷新时两次之间至少隔多少分钟
  providerRefreshFloor: 60, // 所有供应商的最小查询间隔（分钟），防止把上游查爆
  providerRefreshMin: {}, // 单个供应商覆盖上面的间隔（分钟），如 { "cdn-yyapi": 10 }
  refreshCapPerDay: 150,  // 每个供应商每天最多自动查多少次（10 分钟一次约 144）；手动刷新不受限
  usageFile: path.join(os.homedir(), '.config', 'magpie', 'usage.jsonl'),
  toastSec: 60,        // 本次费用气泡停留时长
  currency: 'CNY',     // 默认计价币种（未单独设置过的供应商用它）：'CNY' 人民币 / 'USD' 美元
  usdRate: 6.67,       // 默认美元→人民币汇率（未单独设置过的供应商用它）
  currencies: {},      // 按供应商单独保存的币种/汇率：{ providerId: { currency, usdRate } }
  scale: 1,
  flip: false,         // 镜像：角色在左、泡泡在右
  x: null, y: null,
}
let config = { ...DEFAULTS }
try { config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } } catch {}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)) } catch {}
}
if (!config.providerRefreshMin || typeof config.providerRefreshMin !== 'object') config.providerRefreshMin = {}
if (!config.currencies || typeof config.currencies !== 'object') config.currencies = {}

// 余额缓存：上游查询被限流（429）或 key 报错时继续显示上次读到的数，不让气泡变空
const CACHE_FILE = path.join(app.getPath('userData'), 'last-balance.json')
const REFRESH_FILE = path.join(app.getPath('userData'), 'refresh-state.json')
function readJSON(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return def } }
function writeJSON(file, v) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)) } catch {} }
const lastBalance = readJSON(CACHE_FILE, {})   // provider → { value, prefix, suffix, at }
const refreshState = readJSON(REFRESH_FILE, {}) // provider → { last, level, until, error }

const BASE = 250 // 与 dsh-whale-widget 的 --dshw-base 上限一致
let bubble, popup, tray
const state = { providers: [], provider: null, balance: null, today: null, week: null, error: null, at: 0 }
let turns = null
// session → 这轮开始前 Magpie 记的累计费用；sessionCost 是最近一次轮询看到的累计费用
const turnBase = new Map(), sessionCost = new Map()
const shown = new Map() // session → { base, at }：气泡里正在显示的那一轮
const recent = [] // 最近结束的几轮对话，弹窗里列出来

// "$46.48" / "¥12.3" / "12.30 CNY" → { value, prefix, suffix }
function parseMoney(s) {
  if (s == null) return null
  const m = String(s).match(/^(.*?)(-?[\d,]*\.?\d+)(.*)$/)
  if (!m) return null
  const value = Number(m[2].replace(/,/g, ''))
  return Number.isFinite(value) ? { value, prefix: m[1].trim(), suffix: m[3].trim(), raw: String(s) } : null
}

async function getJSON(p, init) {
  const r = await fetch(config.gateway + p, { ...init, signal: AbortSignal.timeout(init?.method === 'POST' ? 60000 : 8000) })
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`)
  return r.json()
}

// 一个供应商挂多把 key（云影就是 3 把），余额值相同的视为同一个账户，去重后
// 各把 key 的读数分开列出来；显示用的余额取其中最高的一个（是同一个账号，不累加）
function collectProviders(quotas) {
  const map = new Map()
  for (const q of quotas?.data || []) {
    let p = map.get(q.provider)
    if (!p) map.set(q.provider, p = { id: q.provider, name: q.name || q.provider, kind: q.kind || null, list: [], readAt: 0 })
    const money = parseMoney(q.balance)
    const at = Date.parse(q.readAt) || 0
    // 忽略供应商回传的币种符号：显示币种完全由用户指定的 config.currency 决定
    p.list.push({ user: q.user, value: money ? money.value : null, prefix: '', suffix: '', at, error: q.error || null })
    if (at > p.readAt) p.readAt = at
  }
  return [...map.values()].map((p) => {
    const seen = new Map() // 余额值 → 账户
    for (const a of p.list) {
      if (a.value == null) continue
      const k = a.value.toFixed(6)
      if (!seen.has(k)) seen.set(k, { ...a, users: [] })
      seen.get(k).users.push(a.user)
    }
    const accounts = [...seen.values()].sort((a, b) => b.value - a.value)
    const failed = p.list.filter((a) => a.value == null)
    // 多把 key 其实是同一个账号：几个读数不一样时以最高的为准（不累加，欠费的那个也不抵别的）
    const top = accounts.length ? Math.max(...accounts.map((a) => a.value)) : null
    return {
      id: p.id, name: p.name, kind: p.kind, readAt: p.readAt, accounts,
      missing: failed.map((a) => ({ user: a.user, error: a.error || '没读到余额' })),
      balance: accounts.length ? { value: top, prefix: '', suffix: '' } : null,
      failed: failed.length,
      error: accounts.length ? null : (failed[0]?.error || '余额查询失败'),
    }
  })
}

// 鼠标中键切到的供应商：只影响"这一次显示什么"，不改自动逻辑，重启就回到自动
// manualAuto 是按下中键时自动模式本来选中的那个；自动那边换人了（或对不上）就交还自动
let manualId = null
let manualAuto = null

// 选中的供应商：配置里钉死了就用它；中键切过就先看那个；否则自动
// 自动 = 跟着 usage.jsonl 里最后一条对话请求走，正在用哪个 API 就显示哪个
const hasBalance = (p) => !!p?.balance || !!lastBalance[p?.id]

function pickProvider() {
  const list = state.providers || []
  const usable = hasBalance
  // 中键临时切到的供应商优先：只影响"现在显示哪个"，退出前一直保持。
  // 钉死了 config.provider 时也一样，否则中键就切不动（会一直返回钉死的那个）
  if (manualId) {
    const hit = list.find((p) => p.id === manualId)
    if (hit) {
      // 没钉死供应商（自动模式）时，自动那边换人了就交还自动，中键那下只算"看一眼"
      if (!config.provider) {
        const { latest } = recentServed()
        const nowAuto = (latest && list.find((p) => p.id === latest && usable(p))) || null
        if (nowAuto && manualAuto && nowAuto.id !== manualAuto) { manualId = null; manualAuto = null }
        else return hit
      } else return hit
    }
    manualId = null; manualAuto = null // 这个供应商没了，退回原逻辑
  }
  if (config.provider) {
    const hit = list.find((p) => p.id === config.provider)
    if (hit) return hit
  }
  // 自动：跟着正在用的 API 走
  const { latest } = recentServed()
  let auto = (latest && list.find((p) => p.id === latest && usable(p))) || null
  if (!auto) {
    // 最近用的那个没有余额可读（订阅型），就继续显示上一个能读到余额的
    const keepId = state.provider
    auto = (keepId && list.find((p) => p.id === keepId && usable(p))) || list.find(usable) || list[0] || null
  }
  return auto
}

// usage.jsonl 的尾巴：每个供应商最后一次"对话"请求的时间 + 最新的是谁
// 标题、权限判断这类旁路调用没有 ttft_ms（也不带 session），跳过
// 否则订阅型的 codex 会因为它自己生成的标题被选中，而它没有余额可显示
function recentServed() {
  const at = new Map()
  let latest = null, latestAt = 0
  try {
    const lines = readTail(config.usageFile, 1 << 16).split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      let r
      try { r = JSON.parse(lines[i]) } catch { continue }
      if (!r.provider || !r.session || r.kind || r.ttft_ms == null) continue
      const t = Date.parse(r.t) || 0
      if (!at.has(r.provider)) at.set(r.provider, t) // 从后往前扫，先遇到的就是最近一次
      if (t > latestAt) { latestAt = t; latest = r.provider }
    }
  } catch {}
  return { latest, latestAt, at }
}

// 余额：优先用刚查到的；查不到（429 / key 报错）就退回上次读到的，标成 stale
function balanceFor(p) {
  if (!p) return null
  const at = p.readAt || Date.now()
  if (p.balance) {
    const prev = lastBalance[p.id]
    if (!prev || Math.abs(prev.value - p.balance.value) > 1e-9) {
      lastBalance[p.id] = { ...p.balance, at }
      writeJSON(CACHE_FILE, lastBalance)
    }
    return { ...p.balance, at, stale: false }
  }
  const old = lastBalance[p.id]
  return old ? { value: old.value, prefix: '', suffix: '', at: old.at, stale: true } : null
}

// 按 key 拆开的用量：云影这种一个供应商挂多把 key 的，能看出每把 key 花了多少
function keysFor(summary, provider) {
  return (summary?.providerKeys || []).filter((k) => k.provider === provider).map((k) => ({
    id: k.id, name: k.providerKeyName || k.providerKeyId || k.id, calls: k.calls || 0, errors: k.errors || 0,
    cost: k.cost || 0, input: k.input || 0, output: k.output || 0,
  })).sort((a, b) => b.cost - a.cost)
}

function usageFor(summary, provider) {
  const models = (summary?.models || []).filter((m) => m.provider === provider).map((m) => ({
    id: m.id, name: m.name || m.model, calls: m.calls || 0, errors: m.errors || 0,
    input: m.input || 0, output: m.output || 0, cacheRead: m.cache_read || 0, cacheWrite: m.cache_write || 0,
    reasoning: m.reasoning || 0, cost: m.cost || 0, unpriced: m.unpriced || 0,
  })).sort((a, b) => b.cost - a.cost || b.calls - a.calls)
  const sum = (k) => models.reduce((a, m) => a + m[k], 0)
  return {
    period: summary?.period, since: summary?.since, models,
    total: { calls: sum('calls'), input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), cost: sum('cost') },
  }
}

function broadcast(channel, payload) {
  for (const w of [bubble, popup]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
}

// Magpie 自己也是置顶窗口，谁后激活谁在上面：要弹东西的时候把气泡提回最前面，
// 不然贴着屏幕左边时会被 Magpie 的窗口盖住，看着像没显示
function raise() {
  if (bubble && !bubble.isDestroyed()) bubble.moveTop()
}

let polling = false
let pollAgain = false
let lastSummary = null // 最近一次 /usage?period=today 的结果，换供应商时不必等下一轮

// 用手上的数据算出"现在该显示哪个供应商"并写进 state
function applyCurrent() {
  const cur = pickProvider()
  const prevBalance = state.provider === cur?.id ? state.balance : null
  state.provider = cur?.id || null
  state.providerName = cur?.name || ''
  state.accounts = cur?.accounts || []
  state.balance = balanceFor(cur)
  state.today = cur && lastSummary ? usageFor(lastSummary, cur.id) : null
  state.keys = cur && lastSummary ? keysFor(lastSummary, cur.id) : []
  state.error = cur ? (state.balance ? null : (cur.error || '这个供应商没有余额可读')) : '没有读到带余额的供应商'
  const cc = curCfg(cur?.id)
  state.currency = cc.currency
  state.usdRate = cc.usdRate
  return prevBalance
}
// 立刻生效：中键/菜单点完马上就换，不等网络。之前要等下一轮 poll，
// 撞上在途请求（或网络慢）时就像"点了没反应、卡住了"
function applyNow() {
  try {
    applyCurrent()
    state.at = Date.now()
    broadcast('state', state)
    updateTray()
  } catch (e) { logErr('applyNow', e) }
}

async function poll() {
  // 上一轮还没回来：记下这次，等它回来立刻补一轮；直接丢掉会让点击看起来没生效
  if (polling) { pollAgain = true; return }
  polling = true
  pollAgain = false
  try {
    const [quotas, today] = await Promise.all([getJSON('/v1/magpie/quotas'), getJSON('/v1/magpie/usage?period=today')])
    // 订阅型（codex）本来就没有余额，不需要出现在插件里
    state.providers = collectProviders(quotas).filter((p) => p.kind !== 'subscription')
    lastSummary = today
    const prevBalance = applyCurrent()
    state.at = Date.now()

    // 扣费由"本次对话"气泡展示；这里只提示充值
    if (prevBalance && state.balance) {
      const delta = state.balance.value - prevBalance.value
      if (delta >= 0.005) { broadcast('delta', { delta, balance: state.balance }); raise() }
    }
    noteSessions(today)
  } catch (e) {
    state.error = '连不上 Magpie：' + (e.cause?.code || e.message)
  } finally {
    polling = false
  }
  broadcast('state', state)
  updateTray()
  if (pollAgain) { pollAgain = false; setTimeout(() => { poll() }, 50) }
}

// —— 本次对话费用：用 Magpie 按手填价格算好的 session 累计费用，结束时减去开始前的值 ——
function noteSessions(summary) {
  for (const x of summary?.sessions || []) sessionCost.set(x.id, x.cost || 0)
  agentNames = new Map((summary?.agents || []).map((a) => [a.id, a.name || a.id]))
}
let agentNames = new Map()

function onTurnStart(session) {
  if (!turnBase.has(session)) turnBase.set(session, sessionCost.get(session) ?? 0)
}

async function onTurnEnd(list) {
  let today
  try { today = await getJSON('/v1/magpie/usage?period=today') } catch { return }
  noteSessions(today)
  const items = []
  for (const { session, agent, provider } of list) {
    const now = sessionCost.get(session) ?? 0
    // 气泡还没消失时同一个对话又结束一次（子代理、DeepSeek Harness 的连续 stop），接着累加，不另起一轮
    const prev = shown.get(session), merge = !!prev && Date.now() - prev.at < config.toastSec * 1000
    let base = merge ? prev.base : turnBase.get(session) ?? 0
    turnBase.delete(session)
    if (now < base) base = 0 // 跨过零点，"今日"累计清零了
    const cost = now - base
    if (cost < 0.00005) continue
    shown.set(session, { base, at: Date.now() })
    items.push({ session, agent, agentName: agentNames.get(agent) || agent, provider, title: titleFor(agent, session), cost, merge, at: Date.now() })
  }
  if (items.length) {
    for (const it of items) if (it.merge) { const i = recent.findIndex((r) => r.session === it.session); if (i >= 0) recent.splice(i, 1) }
    recent.unshift(...items); recent.splice(12)
    state.recent = recent
    broadcast('turn', { items, balance: state.balance })
    broadcast('state', state)
    raise()
  }
  refreshSoon()
}

// 对话结束触发的上游刷新：按供应商自己的节奏走，默认 10 分钟内最多一次，
// 期间又有对话结束就在窗口末尾补一次（DeepSeek Harness 一轮里会连着回好几个 stop）
function refreshSoon(p = state.provider) {
  if (!p) return
  const s = refreshState[p] || {}
  if (s.until && Date.now() < s.until) return // 429 退避中，别再问了
  if (capReached(p)) return // 今天查够了
  const gap = Math.max(config.turnRefreshMin, providerFloorMin(p)) * 60000
  const wait = Math.max(lastRefreshAt[p] || 0, s.last || 0) + gap - Date.now()
  if (wait <= 0) { refreshBalance(p); return }
  if (trailing) return
  trailing = setTimeout(() => { trailing = 0; refreshSoon(state.provider) }, wait)
}

// 会话标题：Claude 读本机会话记录里的 custom-title / ai-title，Codex 读 session_index.jsonl
const titleCache = new Map()
function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally { fs.closeSync(fd) }
}
const JSTR = String.raw`"((?:[^"\\]|\\.)*)"` // 一个 JSON 字符串字面量，捕获里面的内容
function lastMatch(text, re) { let m, v = null; while ((m = re.exec(text))) v = m[1]; return v }
function titleFor(agent, session) {
  let t = null
  try {
    if (agent === 'claude-desktop' || agent === 'claude-code' || agent === 'claude') {
      const root = path.join(os.homedir(), '.claude', 'projects')
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, session + '.jsonl')
        if (!fs.existsSync(f)) continue
        const tail = readTail(f, 1 << 20)
        t = lastMatch(tail, new RegExp('"customTitle":' + JSTR, 'g')) || lastMatch(tail, new RegExp('"aiTitle":' + JSTR, 'g'))
        break
      }
    } else if (agent === 'codex') {
      const tail = readTail(path.join(os.homedir(), '.codex', 'session_index.jsonl'), 1 << 18)
      const id = session.replace(/[^\w-]/g, '')
      t = lastMatch(tail, new RegExp(`"id":"${id}","thread_name":` + JSTR, 'g'))
    }
    if (t) t = JSON.parse(`"${t}"`)
  } catch {}
  if (t) titleCache.set(session, t)
  return t || titleCache.get(session) || null
}

// —— 上游余额：对话结束 / 每小时 / 手动，三种时机都走这里 ——
// 只查当前这个供应商（网关支持 refresh?provider=xxx），别把别的供应商一起拖下水：
// 云影这类接口查余额有次数限制，全量刷新很快就 429
// 查失败（429 / key 报错）就退避，成功清零，退避状态记到磁盘，重启不会立刻又去打
const BACKOFF_MIN = [10, 30, 120, 360, 720, 1440]
const lastRefreshAt = {} // 供应商 → 上次发起查询的时间
let refreshing = null, refreshAgain = false, refreshTarget = null, trailing = 0

function providerFloorMin(p) {
  const own = Number(config.providerRefreshMin?.[p])
  return Number.isFinite(own) && own > 0 ? own : (Number(config.providerRefreshFloor) || 60)
}

// 每天每个供应商的自动查询次数上限：再饿不死也先保账号
function capReached(p) {
  const s = refreshState[p]
  const day = new Date().toISOString().slice(0, 10)
  return !!s && s.day === day && (s.count || 0) >= (Number(config.refreshCapPerDay) || 24)
}

function refreshBalance(p = state.provider, { force = false, gapMin = 0 } = {}) {
  if (!p) return Promise.resolve()
  const s = refreshState[p] || {}
  if (!force) {
    if (s.until && Date.now() < s.until) return Promise.resolve()
    if (capReached(p)) return Promise.resolve()
    const gap = Math.max(gapMin, config.turnRefreshMin, providerFloorMin(p)) * 60000
    // lastRefreshAt 是本次运行的，s.last 是上次运行的：重启也不该立刻再打一遍
    if (Date.now() - Math.max(lastRefreshAt[p] || 0, s.last || 0) < gap) return Promise.resolve()
  }
  if (refreshing) { refreshAgain = true; refreshTarget = p; return refreshing }
  lastRefreshAt[p] = Date.now()
  refreshing = getJSON('/v1/magpie/quotas/refresh?provider=' + encodeURIComponent(p), { method: 'POST' })
    .then((res) => noteRefresh(p, res, null))
    .catch((e) => noteRefresh(p, null, e))
    .then(poll)
    .finally(() => {
      refreshing = null
      const again = refreshAgain, next = refreshTarget
      refreshAgain = false; refreshTarget = null
      if (again && next) refreshBalance(next, { force })
    })
  return refreshing
}

// 这次查询到底成功没有：HTTP 错、供应商返回错误、没有余额都算失败
function noteRefresh(p, res, err) {
  const s = refreshState[p] || (refreshState[p] = {})
  const day = new Date().toISOString().slice(0, 10)
  if (s.day !== day) { s.day = day; s.count = 0 } // 跨天重置计数
  s.count = (s.count || 0) + 1
  const rows = res ? (res.data || []).filter((q) => q.provider === p) : []
  const ok = !err && rows.some((q) => !q.error && parseMoney(q.balance))
  const msg = err ? String(err.cause?.code || err.message || err) : (rows.find((q) => q.error)?.error || (rows.length ? null : '没有返回余额'))
  if (ok) {
    s.level = 0; s.until = 0; s.error = null; s.last = Date.now()
  } else {
    s.level = Math.min((s.level || 0) + 1, BACKOFF_MIN.length)
    s.until = Date.now() + BACKOFF_MIN[s.level - 1] * 60000
    s.error = msg
    s.last = Date.now()
  }
  writeJSON(REFRESH_FILE, refreshState)
  state.refresh = { provider: p, error: ok ? null : msg, until: s.until, level: s.level || 0 }
}

async function loadWeek() {
  if (!state.provider) return
  try {
    state.week = usageFor(await getJSON('/v1/magpie/usage?period=7d'), state.provider)
    broadcast('state', state)
  } catch {}
}

function clampToScreen(x, y, w, h) {
  const wa = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea
  return [Math.min(Math.max(x, wa.x), wa.x + wa.width - w), Math.min(Math.max(y, wa.y), wa.y + wa.height - h)]
}

// 取 4 的倍数：125%/150%/175% 缩放下换算成物理像素都是整数，窗口尺寸不会漂
const bubbleSize = () => Math.round(BASE * config.scale / 4) * 4
function lockSize(w, sz) { w.setMinimumSize(sz, sz); w.setMaximumSize(sz, sz) }

function createBubble() {
  const size = bubbleSize()
  const wa = screen.getPrimaryDisplay().workArea
  let x = config.x ?? wa.x + wa.width - size - 16
  let y = config.y ?? wa.y + wa.height - size - 16
  ;[x, y] = clampToScreen(x, y, size, size)
  bubble = new BrowserWindow({
    x, y, width: size, height: size, frame: false, transparent: true, resizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  })
  bubble.setAlwaysOnTop(true, 'screen-saver')
  lockSize(bubble, size)
  bubble.setIgnoreMouseEvents(true, { forward: true })
  bubble.loadFile(path.join(__dirname, 'ui', 'bubble.html'))
  bubble.once('ready-to-show', () => { bubble.showInactive(); raise() })
}

function createPopup() {
  popup = new BrowserWindow({
    width: 400, height: 300, frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  popup.setAlwaysOnTop(true, 'screen-saver')
  popup.loadFile(path.join(__dirname, 'ui', 'popup.html'))
  popup.on('blur', () => { if (!popup.isDestroyed()) popup.hide() })
}

// 弹窗放在气泡左侧，放不下就放右侧；垂直方向底边对齐角色
function placePopup(h) {
  const b = bubble.getBounds()
  const w = 400
  const wa = screen.getDisplayMatching(b).workArea
  const left = b.x - w + Math.round(b.width * 0.12), right = b.x + b.width - Math.round(b.width * 0.12)
  // 镜像后泡泡在右边，弹窗也优先放右侧
  let x = config.flip ? right : left
  if (config.flip ? x + w > wa.x + wa.width : x < wa.x) x = config.flip ? left : right
  let y = b.y + b.height - h
  ;[x, y] = clampToScreen(x, y, w, h)
  popup.setBounds({ x, y, width: w, height: h })
}

let popupHiddenAt = 0
function togglePopup() {
  if (popup.isVisible()) { popup.hide(); return }
  // 点气泡会先让弹窗失焦隐藏，紧接着又触发点击 —— 300ms 内视为"关闭"
  if (Date.now() - popupHiddenAt < 300) return
  popup.webContents.send('state', state)
  popup.webContents.send('opened')
  loadWeek()
  placePopup(popup.getBounds().height)
  popup.show()
  popup.focus()
}

function updateTray() {
  if (!tray) return
  const b = state.balance, r = state.refresh
  let tip = b ? `${state.providerName} 余额 ${fmtMoney(b)}` : (state.error || 'Magpie 余额气泡')
  if (b?.stale) tip += `（缓存，${new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false })} 读取）`
  if (r?.error && r.until > Date.now()) tip += `\n查询受限：${r.error}，${Math.round((r.until - Date.now()) / 60000)} 分钟后再试`
  tray.setToolTip(tip)
  tray.setContextMenu(buildMenu())
}
// 用 electron.exe 直接跑本目录时，自启要带上应用路径
// 路径换成正斜杠：Electron 写注册表 Run 项时会吞掉参数里的反斜杠
const loginArgs = () => app.isPackaged ? {} : { path: process.execPath, args: [__dirname.split('\\').join('/')] }
// —— 币种显示层：忽略供应商回传符号，按"该供应商自己"的币种换算到人民币显示 ——
// 每个供应商单独保存币种/汇率（config.currencies[id]），没设置过就退回全局默认
// 指定 CNY：数值原样用 ¥ 显示；指定 USD：数值当作美元，乘汇率换成人民币用 ¥ 显示
function curCfg(pid = state.provider) {
  const e = (pid && config.currencies[pid]) || {}
  const currency = e.currency === 'USD' ? 'USD' : (e.currency === 'CNY' ? 'CNY' : (config.currency === 'USD' ? 'USD' : 'CNY'))
  const raw = Number(e.usdRate ?? config.usdRate)
  const usdRate = Number.isFinite(raw) && raw > 0 ? raw : 6.67
  return { currency, usdRate }
}
function toCNY(v, pid = state.provider) { const c = curCfg(pid); return c.currency === 'USD' ? v * c.usdRate : v }
function fmtAmount(v, pid = state.provider) { const c = toCNY(v, pid); return '¥' + (c < 0.01 && c > 0 ? c.toFixed(4) : c.toFixed(2)) }
function fmtMoney(b, pid = state.provider) { return b ? fmtAmount(b.value, pid) : '—' }

// 角色在窗口里占右侧 59.45%，镜像后换到左侧；挪一下窗口让角色尽量留在原地
// 贴着屏幕边时位移会被吃掉，记下翻转前的位置，没拖动过就原样翻回去，避免来回切换越漂越远
const ROLE_W = 0.5945
let flipUndo = null
function setFlip(on) {
  if (config.flip === on) return
  config.flip = on
  const size = bubbleSize(), [bx, by] = bubble.getPosition()
  const shift = Math.round(size * (1 - ROLE_W)) * (on ? 1 : -1)
  let [x, y] = clampToScreen(bx + shift, by, size, size)
  if (flipUndo && flipUndo.to[0] === bx && flipUndo.to[1] === by) [x, y] = flipUndo.from
  flipUndo = { from: [bx, by], to: [x, y] }
  bubble.setBounds({ x, y, width: size, height: size })
  config.x = x; config.y = y; saveConfig()
  if (popup.isVisible()) popup.hide()
  bubble.webContents.send('flip', on)
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '供应商', submenu: state.providers.length ? [
      { label: '自动（最近在用的 API）', type: 'radio', checked: !config.provider,
        click: () => { config.provider = null; manualId = null; manualAuto = null; saveConfig(); state.week = null; applyNow(); poll(); refreshSoon() } },
      { type: 'separator' },
      ...state.providers.map((p) => ({
        label: `${p.name}  ${p.balance ? fmtMoney(p.balance) : (p.error || '—')}${p.failed ? `（${p.failed} 个 key 没读到）` : ''}`,
        type: 'radio', checked: config.provider === p.id,
        click: () => { config.provider = p.id; manualId = null; manualAuto = null; saveConfig(); state.week = null; applyNow(); poll(); refreshBalance(p.id, { gapMin: config.refreshMin }) },
      })),
    ] : [{ label: '（暂无）', enabled: false }] },
    { label: '大小', submenu: [0.6, 0.8, 1, 1.2].map((s) => ({
      label: `${Math.round(s * 100)}%`, type: 'radio', checked: config.scale === s,
      click: () => {
        const old = bubbleSize(), [bx, by] = bubble.getPosition()
        config.scale = s
        const sz = bubbleSize()
        bubble.setMinimumSize(1, 1); bubble.setMaximumSize(10000, 10000)
        bubble.setBounds({ x: bx + old - sz, y: by + old - sz, width: sz, height: sz })
        lockSize(bubble, sz)
        const [x, y] = bubble.getPosition(); config.x = x; config.y = y; saveConfig()
      },
    })) },
    { label: '镜像翻转', type: 'checkbox', checked: config.flip, click: (it) => setFlip(it.checked) },
    { label: '立即刷新余额', click: () => refreshBalance(state.provider, { force: true }) },
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings(loginArgs()).openAtLogin,
      click: (it) => app.setLoginItemSettings({ openAtLogin: it.checked, ...loginArgs() }) },
    { label: '显示 / 隐藏气泡', click: () => bubble.isVisible() ? bubble.hide() : bubble.showInactive() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
}

// —— IPC：拖动、点击、命中区域 ——
let drag = null
ipcMain.on('drag-start', (_e, p) => { const [x, y] = bubble.getPosition(); drag = { x, y, sx: p.x, sy: p.y } })
ipcMain.on('drag-move', (_e, p) => {
  if (!drag) return
  const size = bubbleSize()
  const [x, y] = clampToScreen(Math.round(drag.x + p.x - drag.sx), Math.round(drag.y + p.y - drag.sy), size, size)
  // 非整数缩放（如 125%）下移动透明窗口会逐次多长 1px，每次都把尺寸钉回去
  bubble.setBounds({ x, y, width: size, height: size })
  if (popup.isVisible()) popup.hide()
})
ipcMain.on('drag-end', () => { if (!drag) return; drag = null; const [x, y] = bubble.getPosition(); config.x = x; config.y = y; saveConfig() })
ipcMain.on('hit', (_e, on) => { if (bubble && !bubble.isDestroyed()) bubble.setIgnoreMouseEvents(!on, { forward: true }) })
ipcMain.on('click', () => togglePopup())

// 中键：按顺序切到下一个能读到余额的供应商，换完把气泡亮 4 秒让人看见切到谁了
// 只是临时改"现在显示哪个"，自动那条逻辑没动：轮回到自动本来要显示的那个时，就交还自动
ipcMain.on('cycle', () => {
  try {
    const readable = (state.providers || []).filter(hasBalance).map((p) => p.id)
    if (readable.length < 2) return
    const cur = manualId || state.provider
    const at = readable.indexOf(cur)
    const next = readable[(at + 1) % readable.length] // at < 0（当前不在列表里）时自然从第一个开始
    manualId = null // 先放下，看看自动模式本来会显示谁
    const autoId = pickProvider()?.id || null
    // 轮到的正好是自动本来要显示的那个，就交还自动，别白钉一次
    if (next === autoId) { manualAuto = null } else { manualId = next; manualAuto = autoId }
    applyNow() // 立刻换显示，不等下一轮 poll
    poll() // 顺手补一轮最新数据（在途的话会自己排队）
    if (bubble && !bubble.isDestroyed()) { raise(); bubble.webContents.send('peek') }
  } catch (e) { logErr('cycle', e) }
})
ipcMain.on('menu', () => buildMenu().popup({ window: bubble }))
ipcMain.on('popup-height', (_e, h) => { if (popup.isVisible()) placePopup(Math.ceil(h)); else popup.setSize(400, Math.ceil(h)) })
ipcMain.on('popup-hide', () => popup.hide())
ipcMain.handle('get-state', () => state)
ipcMain.handle('get-toast-sec', () => config.toastSec)
ipcMain.on('refresh', () => refreshBalance(state.provider, { force: true }))
ipcMain.handle('get-scale', () => config.scale)
ipcMain.handle('get-flip', () => config.flip)
// 币种/汇率按供应商单独保存：只改当前显示的这个供应商，不动别的
function setCurCfg(pid, patch) {
  if (!pid) return
  const e = config.currencies[pid] || (config.currencies[pid] = {})
  if (patch.currency) e.currency = patch.currency === 'USD' ? 'USD' : 'CNY'
  if (patch.usdRate != null) {
    const n = Number(patch.usdRate)
    if (Number.isFinite(n) && n > 0) e.usdRate = n
  }
  saveConfig(); applyNow()
}
ipcMain.handle('get-currency', () => ({ ...curCfg(), provider: state.provider }))
ipcMain.on('set-currency', (_e, c) => { setCurCfg(state.provider, { currency: c }) })
ipcMain.on('set-rate', (_e, r) => { setCurCfg(state.provider, { usdRate: r }) })
// file:// 页面里的 canvas 读不到图片像素（跨源污染），角色的透明度蒙版在主进程算好再给页面
let roleMask = null
ipcMain.handle('get-mask', () => {
  if (!roleMask) {
    const im = nativeImage.createFromPath(path.join(__dirname, 'assets', 'role.png'))
    const { width: w, height: h } = im.getSize()
    const bgra = im.toBitmap()
    const a = new Uint8Array(w * h)
    for (let i = 0; i < a.length; i++) a[i] = bgra[i * 4 + 3]
    roleMask = { w, h, data: a }
  }
  return roleMask
})

app.whenReady().then(() => {
  createBubble()
  createPopup()
  popup.on('hide', () => { popupHiddenAt = Date.now() })
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')).resize({ width: 16, height: 16 }))
  tray.on('click', () => bubble.isVisible() ? bubble.hide() : bubble.showInactive())
  updateTray()
  poll().then(() => refreshBalance(state.provider, { gapMin: config.refreshMin }))
  setInterval(poll, config.pollSec * 1000)
  setInterval(() => refreshBalance(state.provider, { gapMin: config.refreshMin }), config.refreshMin * 60 * 1000)
  // 不按供应商筛：自动模式下气泡会跟着正在用的 API 换，别让"现在显示的是别家"把这次对话的费用吞掉
  turns = watchTurns(config.usageFile, { onStart: onTurnStart, onEnd: onTurnEnd })
  if (process.env.BUBBLE_SELFTEST) require('./selftest')({ app, bubble, popup, state, config, setFlip, onTurnStart, onTurnEnd, turnBase, sessionCost, refreshBalance, refreshState, pickProvider }, process.env.BUBBLE_SELFTEST)
})
app.on('second-instance', () => bubble?.showInactive())
app.on('window-all-closed', (e) => e.preventDefault())
