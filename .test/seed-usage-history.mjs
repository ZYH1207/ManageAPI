/** 往 usage.json 里补 13 天历史，让按天柱图有形状。仅在测试数据目录里用。 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dir = process.env.MANAGE_API_HOME
if (!dir) throw new Error('需要 MANAGE_API_HOME')

const db = JSON.parse(await readFile(join(dir, 'db.json'), 'utf8'))
const keys = db.settings.gateway.keys
const providers = db.providers
const models = ['test-model-a', 'test-model-b']

let usage
try {
  usage = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'))
} catch {
  usage = { version: 1, days: {} }
}

let seed = 7
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

for (let offset = 29; offset >= 1; offset -= 1) {
  const day = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)
  const bucket = {}
  for (const key of keys) {
    for (const model of models) {
      const provider = providers[Math.floor(rand() * providers.length)]
      const requests = 4 + Math.floor(rand() * 26)
      const inputPer = 320 + Math.floor(rand() * 1400)
      const outputPer = 120 + Math.floor(rand() * 520)
      bucket[`${key.id}|${provider.id}|${model}`] = {
        requests,
        errors: rand() < 0.25 ? 1 + Math.floor(rand() * 2) : 0,
        input: requests * inputPer,
        output: requests * outputPer,
        cached: 0,
        latencySum: requests * (900 + Math.floor(rand() * 2600)),
        latencyCount: requests,
        ttftSum: requests * (240 + Math.floor(rand() * 520)),
        ttftCount: requests,
      }
    }
  }
  usage.days[day] = bucket
}

await writeFile(join(dir, 'usage.json'), JSON.stringify(usage, null, 2), 'utf8')
console.log(`已写入 ${Object.keys(usage.days).length} 天数据`)
