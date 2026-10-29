// 自检：BUBBLE_SELFTEST=<输出目录> npm start —— 默认收起 → 对话结束弹本次费用 → 并发轮播 → 充值弹 5 秒 → 点角色开/关 → 点泡泡开明细 → 拖动，截图后退出
const fs = require('node:fs')
const path = require('node:path')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = async function selftest({ app, bubble, popup, state, config, setFlip, onTurnStart, onTurnEnd, turnBase, sessionCost, refreshBalance, refreshState, pickProvider }, out) {
  fs.mkdirSync(out, { recursive: true })
  const log = []
  const _push = log.push.bind(log)
  log.push = (x) => { _push(x); fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n')) }
  // 截图失败（窗口刚隐藏/GPU 抽风会报 UnknownVizError）不影响后面的检查
  const shot = async (w, name) => { try { fs.writeFileSync(path.join(out, name), (await Promise.race([w.webContents.capturePage(), wait(3000).then(() => { throw new Error('超时') })])).toPNG()) } catch (e) { log.push(`截图 ${name} 失败: ${e.message}`) } }
  const isOpen = () => bubble.webContents.executeJavaScript("document.getElementById('pop').classList.contains('open')")
  const text = () => bubble.webContents.executeJavaScript("[...document.querySelectorAll('.text > div')].map((e) => e.textContent).join(' | ')")
  bubble.webContents.on('console-message', (e) => log.push('bubble: ' + (e.message ?? e)))
  popup.webContents.on('console-message', (e) => log.push('popup: ' + (e.message ?? e)))
  await wait(4000)
  log.push('state: ' + JSON.stringify({ provider: state.provider, balance: state.balance, error: state.error }))
  log.push('启动后气泡打开: ' + await isOpen())
  await shot(bubble, '1-closed.png')

  const b0 = bubble.getBounds()
  const send = (type, x, y) => bubble.webContents.sendInputEvent({ type, x, y, globalX: b0.x + x, globalY: b0.y + y, button: 'left', clickCount: 1 })
  const click = async (x, y) => { send('mouseMove', x, y); await wait(100); send('mouseDown', x, y); send('mouseUp', x, y); await wait(700) }
  const rx = Math.round(b0.width * 0.7), ry = Math.round(b0.height * 0.72) // 角色身体
  const px = Math.round(b0.width * 0.4), py = Math.round(b0.height * 0.25)  // 泡泡中部

  await click(px, py)
  log.push('收起时点泡泡位置 → 明细弹窗: ' + popup.isVisible())

  const bal = state.balance || { value: 46.11, prefix: '$', suffix: '' }
  // 真实走一遍：拿今天花得最多的 Claude 会话，假装这轮开始前它少花了 0.42
  const today = await (await fetch('http://127.0.0.1:3425/v1/magpie/usage?period=today')).json()
  const sid = today.sessions?.find((x) => x.agent === 'claude-desktop')?.id || 'none'
  onTurnStart(sid); turnBase.set(sid, (sessionCost.get(sid) || 0) - 0.42)
  await onTurnEnd([{ session: sid, agent: 'claude-desktop' }])
  await wait(1000)
  log.push(`对话结束(${sid.slice(0, 8)}) 1s 后打开: ` + await isOpen() + ' 内容: ' + await text())
  log.push('toastMs: ' + await bubble.webContents.executeJavaScript('toastMs'))
  await shot(bubble, '2-turn.png')
  await wait(9000)
  log.push('10s 仍打开: ' + await isOpen())
  log.push('recent: ' + JSON.stringify(state.recent?.map((r) => [r.title, +r.cost.toFixed(4)])))

  // 同一个会话再结束一次：接着累加而不是另起一条
  turnBase.set(sid, (sessionCost.get(sid) || 0) - 0.1)
  await onTurnEnd([{ session: sid, agent: 'claude-desktop' }])
  await wait(500)
  log.push('同会话再次结束 → recent 条数 ' + state.recent.length + ' 内容: ' + await text())

  // 并发：两个对话同时结束，轮流显示
  bubble.webContents.send('turn', { items: [{ session: 'p1', agentName: 'Codex', title: '整理钻石兑换活动分析方法', cost: 0.12 }, { session: 'p2', agentName: 'DeepSeek Harness', title: null, cost: 0.03 }] })
  await wait(500)
  const seen = new Set([await text()])
  for (let i = 0; i < 3; i++) { await wait(4000); seen.add(await text()) }
  log.push('并发轮播看到: ' + [...seen].join('  ||  '))
  await shot(bubble, '2b-multi.png')

  await click(rx, ry)
  log.push('弹出时点角色 → 收起: ' + !(await isOpen()))
  bubble.webContents.send('delta', { delta: -0.37, balance: bal })
  await wait(800)
  log.push('扣费的余额变动不再弹: ' + !(await isOpen()))

  await click(rx, ry)
  log.push('点角色 → 打开: ' + await isOpen() + ' 内容: ' + await text())
  await shot(bubble, '3-info.png')
  await click(px, py)
  log.push('点泡泡 → 明细弹窗: ' + popup.isVisible())
  await shot(popup, '4-popup.png')
  popup.hide(); await wait(400)
  await click(rx, ry)
  log.push('再点角色 → 收起: ' + !(await isOpen()))

  // 常驻打开时来充值：显示 5 秒后回到余额，仍保持打开
  await click(rx, ry)
  bubble.webContents.send('delta', { delta: 1.5, balance: bal })
  await wait(800)
  log.push('常驻中来充值: ' + await text())
  await wait(5000)
  log.push('5.8s 后仍打开: ' + await isOpen() + ' 内容: ' + await text())
  await click(rx, ry)

  // 弹窗"最近对话"标签
  await click(px, py); await wait(300)
  await popup.webContents.executeJavaScript("document.querySelector('.tab[data-p=turns]').click()")
  await wait(400)
  log.push('最近对话标签: ' + await popup.webContents.executeJavaScript("document.getElementById('list').innerText.replace(/\\s+/g, ' ').slice(0, 160)"))
  await shot(popup, '4b-turns.png')
  popup.hide(); await wait(400)

  // 查询受限要退避：拿一个不存在的供应商试，查不到余额就该记成失败并推后下次查询
  await refreshBalance('__nope__', { force: true })
  await wait(1200)
  const bo = refreshState['__nope__'] || {}
  log.push('刷新失败 → 退避: ' + `level=${bo.level} 推后=${bo.until > Date.now() ? Math.round((bo.until - Date.now()) / 60000) + ' 分钟' : '无'} 原因=${bo.error}`)

  // 这轮对话用的不是气泡当前显示的供应商：不能拿别家的余额当"剩余"
  const other = (state.providers || []).find((p) => p.id !== state.provider) || { id: 'x', name: '别家' }
  bubble.webContents.send('turn', { items: [{ session: 'other', provider: other.id, cost: 0.5, title: null, agentName: 'Codex' }] })
  await wait(600)
  log.push('别家的一轮 → 内容: ' + await text() + '（hint 应为供应商名而不是"剩余"）')
  await click(rx, ry) // 收掉
  await wait(300)

  // 中键：按顺序轮换显示的供应商 —— 只换这次显示的内容，自动模式（config.provider）不动
  const mid = (type, x, y) => bubble.webContents.sendInputEvent({ type, x, y, globalX: b0.x + x, globalY: b0.y + y, button: 'middle', clickCount: 1 })
  const midClick = async () => { mid('mouseDown', rx, ry); mid('mouseUp', rx, ry); await wait(1500); return state.provider }
  const canCycle = (state.providers || []).filter((p) => p.balance || p.id === state.provider).length >= 2
  const p0 = state.provider
  const p1 = await midClick()
  log.push(`${canCycle ? '中键一次' : '中键一次(只有一个供应商，应无变化)'}: ${p0} → ${p1}，气泡亮起: ${await isOpen()} 内容: ${await text()}`)
  await shot(bubble, '7-cycle.png')
  const p2 = await midClick()
  const p3 = await midClick()
  log.push(`中键两次/三次: → ${p2} → ${p3}（应 p1≠p0、p2≠p1、p3=p1），自动模式未改动: config.provider=${config.provider}`)

  send('mouseMove', rx, ry); await wait(50); send('mouseDown', rx, ry)
  for (let i = 1; i <= 5; i++) { send('mouseMove', rx - i * 10, ry - i * 6); await wait(30) }
  send('mouseUp', rx - 50, ry - 30); await wait(300)
  const b1 = bubble.getBounds()
  log.push(`拖动 → 移动 (${b1.x - b0.x}, ${b1.y - b0.y})，气泡打开: ${await isOpen()}`)
  bubble.setBounds(b0)

  // 镜像：角色换到左侧、窗口右移让角色留在原地，文字不镜像，点击命中跟着翻
  setFlip(true); await wait(500)
  const b2 = bubble.getBounds()
  const css = (sel) => bubble.webContents.executeJavaScript(`getComputedStyle(document.querySelector('${sel}')).transform`)
  log.push(`镜像 → 窗口右移 ${b2.x - b0.x}，root ${await css('.root')}，text ${await css('.text')}`)
  const send2 = (type, x, y) => bubble.webContents.sendInputEvent({ type, x, y, globalX: b2.x + x, globalY: b2.y + y, button: 'left', clickCount: 1 })
  const click2 = async (x, y) => { send2('mouseMove', x, y); await wait(100); send2('mouseDown', x, y); send2('mouseUp', x, y); await wait(700) }
  await click2(b2.width - rx, ry)
  log.push('镜像后点左侧角色 → 打开: ' + await isOpen() + ' 内容: ' + await text())
  await shot(bubble, '5-flip.png')
  await click2(b2.width - px, py)
  log.push('镜像后点泡泡 → 明细弹窗: ' + popup.isVisible() + `，弹窗在气泡${popup.getBounds().x > b2.x ? '右' : '左'}侧`)
  await shot(popup, '6-flip-popup.png')
  popup.hide(); await wait(300)
  setFlip(false); await wait(300)
  log.push('取消镜像 → 窗口回到原位: ' + (bubble.getBounds().x === b0.x))
  fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n'))
  app.quit()
}
