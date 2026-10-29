// 盯 Magpie 的 usage.jsonl，判断"一轮对话结束"
// 每条请求一行；按 session 分组，流式请求的 stop 是 end_turn / stop / completed 就算这轮结束
// 非流式请求（没有 ttft_ms）是标题、权限判断之类的旁路调用，不参与判断；带 kind 的是客户端后台任务，也跳过
// Codex 的 responses 接口不回 stop，只能等这个 session 静默一段时间再算结束
const fs = require('node:fs')
const path = require('node:path')

const END = new Set(['end_turn', 'stop', 'completed', 'stop_sequence'])
const CONTINUE = new Set(['tool_use', 'tool_calls', 'pause_turn'])

// onStart(session) —— 这个 session 新一轮的第一条请求到了
// onEnd(sessions: [{ session, agent, provider }]) —— 同一时刻结束的多个对话合并成一次回调
// provider 传成 null 就不筛供应商：气泡在自动模式下会跟着正在用的 API 换，
// 但每轮对话的费用该怎么显示还是怎么显示，不会因为"现在显示的是别家"就吞掉
module.exports = function watchTurns(file, { provider, onStart, onEnd, settleMs = 6000, idleMs = 45000 }) {
  let offset = 0, rest = '', reading = false, again = false
  const timers = new Map() // session → { timer, agent }
  const active = new Set()  // 正在进行中的 session
  const prov = new Map()    // session → 这一轮用的供应商
  let batch = new Map(), batchTimer = 0

  try { offset = fs.statSync(file).size } catch {} // 只看启动之后的新请求

  function fire(session, agent) {
    timers.delete(session)
    active.delete(session)
    batch.set(session, { session, agent, provider: prov.get(session) || null })
    clearTimeout(batchTimer)
    batchTimer = setTimeout(() => { const list = [...batch.values()]; batch = new Map(); onEnd(list) }, 300)
  }
  function arm(session, agent, ms) {
    clearTimeout(timers.get(session)?.timer)
    timers.set(session, { agent, timer: setTimeout(() => fire(session, agent), ms) })
  }
  function disarm(session) { clearTimeout(timers.get(session)?.timer); timers.delete(session) }

  function onRow(r) {
    if (!r.session || r.kind || r.ttft_ms == null) return
    const p = provider?.()
    if (p && r.provider !== p) return
    if (r.provider) prov.set(r.session, r.provider)
    if (!active.has(r.session)) { active.add(r.session); onStart?.(r.session, r.agent, r.provider) }
    if (END.has(r.stop)) arm(r.session, r.agent, settleMs) // 等几秒：子代理结束后主对话还会接着发
    else if (CONTINUE.has(r.stop)) disarm(r.session)
    else arm(r.session, r.agent, idleMs) // 没有 stop（Codex、被打断、max_tokens）
  }

  function read() {
    if (reading) { again = true; return }
    reading = true
    fs.stat(file, (err, st) => {
      if (err) { reading = false; return }
      if (st.size < offset) { offset = st.size; rest = '' } // 文件被截断/轮换：从新末尾接着看
      if (st.size === offset) { done(); return }
      const s = fs.createReadStream(file, { start: offset, end: st.size - 1 })
      const chunks = []
      s.on('data', (c) => chunks.push(c))
      s.on('error', done)
      s.on('end', () => {
        offset = st.size
        const lines = (rest + Buffer.concat(chunks).toString('utf8')).split('\n')
        rest = lines.pop() // 最后一行可能还没写完
        for (const l of lines) { if (!l.trim()) continue; try { onRow(JSON.parse(l)) } catch {} }
        done()
      })
    })
    function done() { reading = false; if (again) { again = false; read() } }
  }

  // 盯目录而不是文件：Windows 上文件被替换后 fs.watch 会失效；再加个 5 秒的兜底轮询
  let watcher = null
  try { watcher = fs.watch(path.dirname(file), (_ev, name) => { if (!name || name === path.basename(file)) read() }) } catch {}
  const poll = setInterval(read, 5000)
  return { close() { watcher?.close(); clearInterval(poll); for (const t of timers.values()) clearTimeout(t.timer) }, _onRow: onRow }
}
