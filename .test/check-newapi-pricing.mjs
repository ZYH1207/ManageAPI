/**
 * new-api 公开价格表（/api/pricing）适配自检。
 *
 * 现场：格子API 只有 Key 能打通 /v1/models，站点没开「模型广场」、渠道接口要管理员，
 * 于是「分组倍率 + 输入/输出单价」永远读不到——分组空、定价空。
 * 这个站其实有公开的 /api/pricing（new-api 自带）。
 *
 * 钉死四件事：
 *   1. ratio 口径：输入 = model_ratio×2，输出 ×completion_ratio，缓存读 ×cache_ratio；
 *   2. 表达式口径（billing_mode=tiered_expr）：系数就是「美元/百万 token」，
 *      而且这时 model_ratio 常常是占位 37.5（$75/M 的假价），绝不能信；
 *   3. 占位 37.5 且没有表达式 → 跳过（不落假价）；
 *   4. 分组倍率表原样带出（含 ratio 为 "auto" 字符串的分组 → rate null）。
 *
 * 用法：node .test/check-newapi-pricing.mjs
 */
import { createServer } from 'node:http'
import { fetchNewApiPricing, toPricingModel } from '../core/newapi-pricing.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

const PORT = 5293
const UP = `http://127.0.0.1:${PORT}`

let payload = null
const up = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.url.startsWith('/api/pricing')) return payload ? send(200, payload) : send(404, {})
  return send(404, {})
})
await new Promise((r) => up.listen(PORT, '127.0.0.1', r))

try {
  console.log('[1] ratio 口径')
  {
    const m = toPricingModel({ model_name: 'glm-5.3-flash', model_ratio: 0.75, completion_ratio: 3.5, cache_ratio: 0.2875 })
    ok(m.billingMode === 'token', '按量计费')
    ok(near(m.inPrice, 1.5), `输入 0.75×2 = 1.5（实际 ${m.inPrice}）`)
    ok(near(m.outPrice, 5.25), `输出 0.75×3.5×2 = 5.25（实际 ${m.outPrice}）`)
    ok(near(m.cacheReadPrice, 0.43125), `缓存读 0.75×0.2875×2（实际 ${m.cacheReadPrice}）`)
  }

  console.log('[2] 表达式口径：系数即美元/百万 token，ratio 占位不算')
  {
    const m = toPricingModel({
      model_name: 'deepseek-v4.1-flash-1017',
      model_ratio: 37.5,
      billing_mode: 'tiered_expr',
      billing_expr:
        'weekday("Asia/Shanghai") >= 1 ? tier("高峰", p * 0.285714285714286 + c * 1.142857142857143 + cr * 0.005714285714286 + cc * 0) : tier("空闲", p * 0.1428 + c * 0.5714)',
    })
    ok(near(m.inPrice, 0.285714285714286), `输入取第一档系数（实际 ${m.inPrice}）`)
    ok(near(m.outPrice, 1.142857142857143), `输出取第一档系数（实际 ${m.outPrice}）`)
    ok(m.inPrice !== 75, '没有掉进 ratio=37.5 的 $75/M 假价')
  }

  console.log('[3] 占位值 / 按次计费')
  {
    ok(toPricingModel({ model_name: 'x', model_ratio: 37.5 }) === null, 'ratio=37.5 且无表达式 → 跳过')
    const img = toPricingModel({ model_name: 'img', model_ratio: 0.25, completion_ratio: 120 })
    ok(near(img.outPrice, 60), '生图类输出倍率 120 也照算')
    const per = toPricingModel({ model_name: 'p', quota_type: 1, model_price: 0.1466 })
    ok(per.billingMode === 'per_request' && near(per.callPrice, 0.1466), 'quota_type=1 → 按次')
    const fixed = toPricingModel({ model_name: 'f', billing_mode: 'tiered_expr', billing_expr: 'tier("标准", fixed(0.1466))' })
    ok(fixed.billingMode === 'per_request' && near(fixed.callPrice, 0.1466), 'fixed(x) 表达式 → 按次')
  }

  console.log('[4] 整表：分组倍率 + byGroup')
  {
    payload = {
      success: true,
      group_ratio: { default: 1, 'gezicloud企业特价': 0.5, 'glm5.3-gezi企业折扣': 0.7, auto: 'auto' },
      usable_group: { default: '官方原价', auto: '低价优先' },
      data: [
        { model_name: 'deepseek-v4.1-flash-1017', model_ratio: 37.5, billing_mode: 'tiered_expr', billing_expr: 'tier("标准", p * 0.2857 + c * 1.1428)', enable_groups: ['default', 'gezicloud企业特价'] },
        { model_name: 'glm-5.3-flash', model_ratio: 0.75, completion_ratio: 3.5, cache_ratio: 0.2875, enable_groups: ['default', 'glm5.3-gezi企业折扣'] },
        { model_name: 'placeholder-model', model_ratio: 37.5 },
      ],
    }
    const r = await fetchNewApiPricing({ baseUrl: `${UP}/v1` })
    ok(r.source === 'pricing', `source=pricing（实际 ${r.source}）`)
    ok(r.groups.length === 4, `4 个分组（实际 ${r.groups.length}）`)
    ok(r.groups.find((g) => g.name === 'gezicloud企业特价')?.rate === 0.5, '分组倍率读出 0.5')
    ok(r.groups.find((g) => g.name === 'auto')?.rate === null, 'ratio 是 "auto" → rate null（不瞎填 1）')
    ok(r.models.length === 2, `占位模型被跳过，剩 2 个（实际 ${r.models.length}）`)
    ok(r.byGroup.length === 4, `(分组,模型) 4 条（实际 ${r.byGroup.length}）`)
    ok(r.byGroup.filter((x) => x.group === 'gezicloud企业特价').length === 1, '特价分组只挂 1 个模型')
  }

  console.log('[5] 站点没开价格表 → 可读的错')
  {
    payload = null
    let msg = ''
    try {
      await fetchNewApiPricing({ baseUrl: `${UP}/v1` })
    } catch (e) {
      msg = String(e.message || e)
    }
    ok(/404/.test(msg), `报错提到 404（${msg.slice(0, 60)}）`)
  }
} finally {
  up.close()
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
