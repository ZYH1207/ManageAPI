/** Make formal and preview instances visible without persisting machine addresses. */
export async function initInstanceEntry() {
  const response = await fetch('/api/instance', { cache: 'no-store' })
  if (!response.ok) return
  const info = await response.json()
  const domain = location.hostname === 'manage-api.localhost' && !location.port
  const formal = domain && info.mode === 'formal'
  const label = formal ? '正式版本' : info.mode === 'preview' ? '开发预览 · 独立数据' : '正式实例 · 端口直连'
  const badge = document.createElement('span')
  badge.className = `badge ${formal ? 'ok' : 'warn'}`
  badge.id = 'instance-entry'
  badge.textContent = `${label} · v${info.version}`
  badge.title = `${location.origin} · ${info.build}`
  document.querySelector('.topbar-left')?.append(badge)

  const target = document.querySelector('#view-gateway')
  const note = document.createElement('div')
  note.id = 'instance-entry-note'
  note.className = 'card'
  const title = document.createElement('b')
  title.textContent = label
  const text = document.createElement('p')
  text.className = 'hint'
  if (formal) {
    text.textContent = '此域名始终连接这台电脑的正式实例。客户端使用 http://manage-api.localhost/v1；开发预览使用独立端口和数据。'
  } else if (info.mode === 'preview') {
    text.textContent = '这是独立的验收实例。这里修改的模型、Key 和路由不会自动同步到正式版本；请勿将预览地址填入日常客户端。'
  } else {
    text.textContent = '这是正式实例的端口入口。安装固定域名入口后，日常使用 http://manage-api.localhost/，网关使用 http://manage-api.localhost/v1。'
  }
  note.append(title, text)
  const attach = () => { if (target && !target.querySelector('#instance-entry-note')) target.prepend(note) }
  attach()
  if (target) new MutationObserver(attach).observe(target, { childList: true })

  // A formal page that is revisited after a release loads the current module graph.
  // Never reload while a user is editing a field or modal.
  if (!formal) return
  const loadedBuild = document.querySelector('meta[name="manageapi-build"]')?.content
  let checking = false
  async function checkRelease() {
    if (checking || document.hidden) return
    if (document.querySelector('.modal:not([hidden])') || document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')) return
    checking = true
    try {
      const r = await fetch('/api/instance', { cache: 'no-store' })
      if (!r.ok) return
      const current = await r.json()
      if (current.mode === 'formal' && loadedBuild && current.build !== loadedBuild) location.reload()
    } catch { /* A short restart does not replace a working page with an error. */ }
    finally { checking = false }
  }
  window.addEventListener('focus', checkRelease)
  document.addEventListener('visibilitychange', checkRelease)
  setInterval(checkRelease, 15000)
}
