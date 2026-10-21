/** 用 sk- key 试 Sub2API 的管理接口，看哪些能读。 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'

const db = await store.readDb()
const provider = db.providers[0]
const credential = db.credentials.find((c) => c.providerId === provider.id)
const apiKey = await inv.revealSecret(credential.id)

// 从对话地址推断管理域名：api.xxx.com → xxx.com
const host = new URL(provider.baseUrl).host
const candidates = [host, host.replace(/^api\./, '')].filter((v, i, a) => a.indexOf(v) === i)

const paths = [
  '/api/v1/auth/me',
  '/api/v1/user/profile',
  '/api/v1/keys',
  '/api/v1/usage',
  '/api/v1/subscription',
  '/api/v1/billing',
  '/api/v1/models',
]

console.log('对话地址:', provider.baseUrl)
console.log('待测域名:', candidates.join(', '))
console.log('Key 尾号:', credential.tail, '\n')

for (const domain of candidates) {
  for (const path of paths) {
    const url = `https://${domain}${path}`
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      const text = await res.text()
      const preview = text.slice(0, 260).replace(/\s+/g, ' ')
      console.log(`${res.status}  ${url}`)
      if (res.status === 200) console.log(`      ${preview}`)
    } catch (error) {
      console.log(`ERR ${url} — ${error.message}`)
    }
  }
}
