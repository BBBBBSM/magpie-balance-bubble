const api = window.bubbleApi
const $ = (id) => document.getElementById(id)
const root = $('root'), body = $('body'), pop = $('pop'), img = $('img')
const amountEl = $('amount'), labelEl = $('label'), hintEl = $('hint')
const LOW = 5 // 低于这个余额标红
const GAIN_MS = 5000 // 充值气泡停留时长；本次对话费用的停留时长由主进程配置（默认 60 秒）
const ROTATE_MS = 4000 // 多个对话同时结束时轮流显示
let toastMs = 60000
api.getToastSec?.().then((s) => { if (s) toastMs = s * 1000 })
const sound = new Audio('../assets/cost.wav')
sound.volume = 0.5

const provName = (id) => (last?.providers || []).find((p) => p.id === id)?.name || id
// 币种显示：忽略供应商回传符号，按 state.currency 换算到人民币，一律用 ¥ 显示
const toCNY = (v) => (last?.currency === 'USD' ? v * (last.usdRate || 6.67) : v)
const money = (v) => { const c = toCNY(v); return '¥' + (c < 0.01 && c > 0 ? c.toFixed(4) : c.toFixed(2)) }

// 思考气泡默认收起：点角色开/关（显示余额）；对话结束弹出本次费用 1 分钟，充值弹 5 秒
let pinned = false // 用户点开的
let toasts = [] // { key, kind: 'cost' | 'gain', amount, title, agentName, until }
let toastIdx = 0, toastTimer = 0, rotateTimer = 0
let last = null
const toast = () => toasts.length ? toasts[toastIdx % toasts.length] : null
const setOpen = () => pop.classList.toggle('open', pinned || toasts.length > 0)

// —— 余额数字滚动 ——
let shown = null, rollTimer = 0
function rollTo(target, b) {
  cancelAnimationFrame(rollTimer)
  if (shown == null || !pop.classList.contains('open')) { shown = target; amountEl.textContent = money(target, b); return }
  const from = shown, t0 = performance.now(), dur = 700
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3)
    shown = from + (target - from) * e
    amountEl.textContent = money(shown, b)
    if (k < 1) rollTimer = requestAnimationFrame(step)
  }
  rollTimer = requestAnimationFrame(step)
}

function render(s) {
  last = s
  if (toast()) return renderToast()
  amountEl.classList.remove('cost', 'gain')
  if (!s.balance) {
    labelEl.textContent = s.error ? 'Magpie' : '余额'
    amountEl.textContent = '—'
    amountEl.classList.remove('low')
    hintEl.textContent = s.error ? (s.error.includes('连不上') ? '未连接' : s.error) : '读取中…'
    return
  }
  // 余额查询被限流（429 等）或读数已经很久时，标一下，免得以为是实时值
  const old = Date.now() - (s.balance.at || 0) > 6 * 3600e3
  labelEl.textContent = (s.providerName || s.provider) + (s.balance.stale || old ? ' 余额（缓存）' : ' 余额')
  rollTo(s.balance.value, s.balance)
  // 低余额标红以换算后的人民币为准（美元模式下少量美元可能对应十几块人民币）
  amountEl.classList.toggle('low', toCNY(s.balance.value) < LOW)
  const t = s.today?.total
  hintEl.textContent = t ? `今日 ${money(t.cost, s.balance)} · ${t.calls} 次` : '今日 —'
}

function renderToast() {
  const t = toast(), b = last?.balance
  cancelAnimationFrame(rollTimer)
  const n = toasts.length > 1 ? `(${toastIdx % toasts.length + 1}/${toasts.length}) ` : ''
  labelEl.textContent = t.kind === 'gain' ? '余额增加' : n + (t.title || t.agentName || '本次对话')
  labelEl.title = t.title || ''
  amountEl.textContent = (t.kind === 'gain' ? '+' : '-') + money(t.amount, b)
  amountEl.classList.remove('low')
  amountEl.classList.toggle('cost', t.kind === 'cost')
  amountEl.classList.toggle('gain', t.kind === 'gain')
  // 这轮对话用的不是当前显示的供应商时，别拿别家的余额当"剩余"
  const other = t.provider && t.provider !== last?.provider
  hintEl.textContent = other ? provName(t.provider) : (b ? '剩余 ' + money(b.value, b) : '')
}

function bump() { amountEl.classList.remove('bump'); void amountEl.offsetWidth; amountEl.classList.add('bump') }

// 到期的拿掉；全拿完就收起
function expire() {
  clearTimeout(toastTimer)
  const now = Date.now()
  toasts = toasts.filter((t) => t.until > now)
  if (toasts.length) toastTimer = setTimeout(expire, Math.min(...toasts.map((t) => t.until)) - now + 20)
  syncRotate()
  if (toasts.length) { renderToast(); return }
  setOpen()
  // 收起时等淡出后再换回余额内容，避免文字闪一下
  if (pinned) render(last); else setTimeout(() => { if (!toasts.length && last) render(last) }, 250)
}
function syncRotate() {
  if (toasts.length > 1 && !rotateTimer) rotateTimer = setInterval(() => { toastIdx++; renderToast(); bump() }, ROTATE_MS)
  if (toasts.length <= 1 && rotateTimer) { clearInterval(rotateTimer); rotateTimer = 0; toastIdx = 0 }
}

function push(items) {
  for (const it of items) {
    const i = toasts.findIndex((t) => t.key === it.key)
    if (i >= 0) toasts.splice(i, 1)
    toasts.push(it)
  }
  toastIdx = toasts.length - 1 // 先显示最新的
  shown = last?.balance?.value ?? shown
  expire()
  setOpen()
  bump()
}

// 对话结束：主进程用 Magpie 记的 session 累计费用算出这一轮花了多少
function onTurn({ items }) {
  push(items.map((x) => ({ key: x.session, kind: 'cost', amount: x.cost, title: x.title, agentName: x.agentName, provider: x.provider, until: Date.now() + toastMs })))
  sound.currentTime = 0; sound.play().catch(() => {})
}
function onDelta(d) {
  if (d.delta > 0) push([{ key: 'gain', kind: 'gain', amount: d.delta, until: Date.now() + GAIN_MS }])
}

// 点角色：变动气泡在显示时，点一下直接收起；否则切换常驻气泡
function toggleBubble() {
  clearTimeout(peekTimer); peeked = false // 用户自己点了就以点击为准
  if (toasts.length) { toasts = []; expire(); pinned = false }
  else pinned = !pinned
  if (last) render(last)
  setOpen()
}

// 中键切换后把气泡亮一下，让人看见切到哪个供应商了（本来就开着就只换内容，不自动收）
let peeked = false, peekTimer = 0
function peek() {
  if (!last) return
  cancelAnimationFrame(rollTimer)
  if (pinned || toasts.length) { render(last); return }
  peeked = true
  pinned = true
  shown = null
  render(last)
  setOpen()
  clearTimeout(peekTimer)
  peekTimer = setTimeout(() => {
    if (!peeked) return
    peeked = false
    pinned = false
    setOpen()
    render(last)
  }, 4000)
}
api.on('peek', peek)

api.on('state', render)
api.on('delta', onDelta)
api.on('turn', onTurn)
api.getState().then((s) => { if (!last) render(s) })

// —— 命中检测：只有角色的不透明像素和泡泡形状接鼠标，其余穿透到桌面 ——
let alpha = null
let flipped = false
const setFlip = (on) => { flipped = !!on; root.classList.toggle('flip', flipped) }
api.getFlip().then(setFlip)
api.on('flip', setFlip)
api.getMask().then((m) => { alpha = m })

function overRole(x, y) {
  const r = img.getBoundingClientRect()
  if (!alpha || x < r.left || y < r.top || x >= r.right || y >= r.bottom) return false
  let px = Math.floor((x - r.left) / r.width * alpha.w)
  if (flipped) px = alpha.w - 1 - px
  const py = Math.floor((y - r.top) / r.height * alpha.h)
  return alpha.data[py * alpha.w + px] > 40
}
function overBubble(x, y) {
  const el = document.elementFromPoint(x, y)
  return !!el && el.closest('svg') != null && el.tagName !== 'svg'
}
const hitAt = (x, y) => overRole(x, y) || overBubble(x, y)

let hitOn = false
function setHit(on) { if (on !== hitOn) { hitOn = on; api.hit(on) } }

// —— 拖动 / 点击 / 右键 ——
let press = null
window.addEventListener('mousemove', (e) => {
  if (press) {
    if (!press.moved && Math.hypot(e.screenX - press.sx, e.screenY - press.sy) > 4) {
      press.moved = true
      root.classList.add('dragging')
      body.classList.remove('pressed')
      api.dragStart({ x: press.sx, y: press.sy })
    }
    if (press.moved) api.dragMove({ x: e.screenX, y: e.screenY })
    return
  }
  setHit(hitAt(e.clientX, e.clientY))
})
window.addEventListener('mousedown', (e) => {
  // 中键：切到下一个供应商（自动 → 云影 → hei → 自动……），只换显示内容，不动自动逻辑
  if (e.button === 1) { e.preventDefault(); if (hitAt(e.clientX, e.clientY)) api.cycle(); return }
  if (e.button !== 0 || !hitAt(e.clientX, e.clientY)) return
  press = { sx: e.screenX, sy: e.screenY, moved: false, role: overRole(e.clientX, e.clientY) }
  body.classList.add('pressed')
})
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !press) return
  const p = press; press = null
  body.classList.remove('pressed')
  root.classList.remove('dragging')
  if (p.moved) api.dragEnd()
  else if (p.role) toggleBubble()
  else api.click() // 点泡泡 → 打开用量明细
  setHit(hitAt(e.clientX, e.clientY))
})
window.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault() })
window.addEventListener('contextmenu', (e) => { e.preventDefault(); if (hitAt(e.clientX, e.clientY)) api.menu() })
document.addEventListener('mouseleave', () => { if (!press) setHit(false) })
