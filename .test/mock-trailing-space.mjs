/**
 * 复现「站点令牌列表返回带尾随空格的分组名」导致的重复插入。
 *
 * MODE=before  模拟修复前（写 offer.group 不归一化）
 * MODE=after   模拟修复后（统一 normalizeGroup）
 *
 * 这个 mock 只提供 detect-groups 需要的两个接口：
 *   GET /v1/models          模型清单
 *   GET /api/v1/keys        令牌列表（分组名故意带尾随空格）
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 5150)
// 分组名带尾随空格——这是真实站点（秋/绿萝）的行为
const GROUP_WITH_SPACE = '国模-0045 p哥 '
const MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'kimi-k3']
const KEY = 'sk-test-trailing-0001'

createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (url.pathname === '/v1/models') {
    return send(200, { data: MODELS.map((id) => ({ id, object: 'model' })) })
  }

  // Sub2API 的令牌列表：group.name 带尾随空格
  if (url.pathname === '/api/v1/keys') {
    return send(200, {
      data: {
        items: [
          {
            id: 1,
            key: KEY,
            name: '测试Key',
            group: { id: 40, name: GROUP_WITH_SPACE, rate_multiplier: 0.045 },
          },
        ],
      },
    })
  }

  // 分组列表：同一个分组（名字也带空格）+ 倍率
  if (url.pathname === '/api/v1/groups/available') {
    return send(200, {
      data: [
        {
          id: 40,
          name: GROUP_WITH_SPACE,
          rate_multiplier: 0.045,
          peak_rate_enabled: false,
        },
      ],
    })
  }

  if (url.pathname === '/api/v1/settings/public') {
    return send(200, { code: 0, data: { registration_enabled: false } })
  }

  return send(404, { error: 'not found' })
}).listen(PORT, () => {
  console.log(`mock 站已启动 http://127.0.0.1:${PORT}（分组名带尾随空格）`)
})
