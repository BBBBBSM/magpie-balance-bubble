const api = window.bubbleApi
const $ = (id) => document.getElementById(id)
let period = 'today'
let last = null

const tok = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function render(s) {
  last = s
  const b = s.balance
  // 币种显示：忽略供应商回传符号，按 state.currency 换算到人民币，一律用 ¥ 显示
  const cny = (v) => (s.currency === 'USD' ? v * (s.usdRate || 6.67) : v)
  const m = (v) => { const c = cny(v); return '¥' + (c < 0.01 && c > 0 ? c.toFixed(4) : c.toFixed(2)) }
  $('provider').textContent = s.providerName || s.provider || 'Magpie'
  // 查询受限时余额可能是几小时前的：标一下读取时间，别让人以为是实时值
  const old = b && Date.now() - (b.at || 0) > 60 * 60000
  const asOf = b ? (b.stale ? `（缓存 · ${new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false })}）`
    : old ? `（读于 ${new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false })}）` : '') : ''
  $('balance').textContent = b ? '余额 ' + m(b.value) + asOf : (s.error || '')
  // 一个供应商挂多把 key（云影就是这样）：每把 key 是一个账户，余额分开列
  const accts = s.accounts || []
  const miss = s.missing || []
  $('accts').innerHTML = accts.length + miss.length > 1 ? [
    ...accts.map((a) => {
    const age = a.at ? Math.round((Date.now() - a.at) / 60000) : null
    const tip = (a.users || []).join(' / ') + (a.error ? ' · ' + a.error : '') + (age != null ? ` · ${age} 分钟前查询` : '')
    return `<span class="acct${a.value <= 0 ? ' zero' : ''}" title="${esc(tip)}">${esc((a.users || [])[0] || '')} <b>${m(a.value)}</b></span>`
    }),
    // 读不到余额的 key 也列出来，标成"—"，别让它凭空消失
    ...miss.map((m) => `<span class="acct miss" title="${esc(m.error)}">${esc(m.user || '')} <b>—</b></span>`),
  ].join('') : ''

  const u = period === 'today' ? s.today : s.week
  if (period === 'turns') {
    const r = s.recent || []
    const sum = r.reduce((a, x) => a + x.cost, 0)
    $('sum').innerHTML = `<span>最近 ${r.length} 轮对话 <span class="meta">按 Magpie 价格表计</span></span><span class="cost">${m(sum)}</span>`
    $('list').innerHTML = r.length ? r.map((x) => `
      <div class="row">
        <div class="r1"><span class="name" title="${esc(x.title || x.session)}">${esc(x.title || x.session.slice(0, 13))}</span><span class="rc">${m(x.cost)}</span></div>
        <div class="r2"><span>${esc(x.agentName || x.agent)}${x.provider && x.provider !== s.provider ? ' · ' + esc((s.providers || []).find((p) => p.id === x.provider)?.name || x.provider) : ''}</span><span>${new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false })}</span></div>
      </div>`).join('') : '<div class="empty">气泡启动后还没有对话结束</div>'
  } else if (!u) {
    $('sum').innerHTML = ''
    $('list').innerHTML = `<div class="empty">${period === 'week' ? '加载中…' : esc(s.error || '暂无数据')}</div>`
  } else {
    const t = u.total
    $('sum').innerHTML = `<span>${period === 'today' ? '今日' : '近 7 天'}消费 <span class="meta">${t.calls} 次 · ${tok(t.input + t.output + t.cacheRead + t.cacheWrite)} tokens</span></span><span class="cost">${m(t.cost)}</span>`
    const max = Math.max(...u.models.map((x) => x.cost), 1e-9)
    $('list').innerHTML = u.models.length ? u.models.map((x) => {
      // 总用量：本模型在当前统计范围内全部 token（输入+输出+缓存读+缓存写，与汇总口径一致）
      const used = (x.input || 0) + (x.output || 0) + (x.cacheRead || 0) + (x.cacheWrite || 0)
      // 缓存命中率：命中缓存的读取 /（未命中输入 + 缓存读取）
      const hitBase = (x.input || 0) + (x.cacheRead || 0)
      const hit = hitBase > 0 ? (x.cacheRead || 0) / hitBase * 100 : null
      const hitTxt = hit == null ? '命中 —' : '命中 ' + (hit >= 10 ? hit.toFixed(0) : hit.toFixed(1)) + '%'
      return `
      <div class="row">
        <div class="r1">
          <span class="name" title="${esc(x.id)}">${esc(x.name)}</span>
          <span class="rtail">
            <span class="metric" title="本模型总用量（输入+输出+缓存，当前范围）">Σ ${tok(used)}</span>
            <span class="metric hit" title="缓存命中率 = 缓存读 /（输入 + 缓存读）">${hitTxt}</span>
            <span class="rc">${m(x.cost)}</span>
          </span>
        </div>
        <div class="bar"><i style="width:${(x.cost / max * 100).toFixed(1)}%"></i></div>
        <div class="r2">
          <span>${x.calls} 次${x.errors ? ` · ${x.errors} 失败` : ''}</span>
          <span>输入 <b>${tok(x.input)}</b></span>
          <span>输出 <b>${tok(x.output)}</b></span>
          ${x.cacheRead ? `<span>缓存读 <b>${tok(x.cacheRead)}</b></span>` : ''}
          ${x.cacheWrite ? `<span>缓存写 <b>${tok(x.cacheWrite)}</b></span>` : ''}
          ${x.unpriced ? `<span>${x.unpriced} 次未计价</span>` : ''}
        </div>
      </div>` }).join('') : '<div class="empty">这段时间没有调用</div>'

    // 多把 key 时再按 key 分开看
    const keys = s.keys || []
    if (keys.length > 1) {
      $('list').innerHTML += '<div class="sub">按 key</div>' + keys.map((k) => `
        <div class="row">
          <div class="r1"><span class="name" title="${esc(k.id)}">${esc(k.name)}</span><span class="rc">${m(k.cost)}</span></div>
          <div class="r2">
            <span>${k.calls} 次${k.errors ? ` · ${k.errors} 失败` : ''}</span>
            <span>输入 <b>${tok(k.input)}</b></span>
            <span>输出 <b>${tok(k.output)}</b></span>
          </div>
        </div>`).join('')
    }
  }
  const cd = s.refresh?.error && s.refresh.until > Date.now() ? ` · 余额查询受限（${s.refresh.error}），${Math.round((s.refresh.until - Date.now()) / 60000)} 分钟后再试` : ''
  // 币种图标：人民币显示 ¥，美元显示 $
  const curBtn = $('currency')
  const isUsd = s.currency === 'USD'
  curBtn.textContent = isUsd ? '$' : '¥'
  curBtn.classList.toggle('usd', isUsd)
  curBtn.title = isUsd ? `当前按美元计价（汇率 ${s.usdRate}）；左键切换为人民币，右键修改汇率` : '当前按人民币计价；左键切换为美元'
  $('foot').textContent = s.at ? '更新于 ' + new Date(s.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' · 数据来自 Magpie' + cd : ''
  requestAnimationFrame(() => api.popupHeight(document.body.scrollHeight))
}

for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    period = t.dataset.p
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t))
    if (last) render(last)
  })
}
$('close').addEventListener('click', () => api.popupHide())
// 左键：人民币 ↔ 美元 切换；右键：手动输入/更新美元→人民币汇率
$('currency').addEventListener('click', () => {
  const now = last?.currency === 'USD' ? 'USD' : 'CNY'
  api.setCurrency(now === 'USD' ? 'CNY' : 'USD')
})
$('currency').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const v = window.prompt('输入美元兑人民币汇率（1 美元 = ? 人民币）', String(last?.usdRate ?? 6.67))
  if (v == null) return
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) api.setRate(n)
})
$('refresh').addEventListener('click', (e) => { api.refresh(); e.currentTarget.classList.add('spin'); setTimeout(() => $('refresh').classList.remove('spin'), 1500) })
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.popupHide() })
api.on('state', render)
api.on('opened', () => { const c = $('card'); c.style.animation = 'none'; void c.offsetWidth; c.style.animation = '' })
api.getState().then(render)
