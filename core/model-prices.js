/**
 * 内置官方参考价。
 *
 * 只是起点，不是真理——模型价格变动频繁，部分条目来自媒体转述而非官网原文。
 * 载入后请在基准价页核对，以各家官网为准。
 *
 * 单位：每百万 token。CNY 和 USD 都原样保留，由基准价表按汇率换算。
 */

export const REFERENCE_AS_OF = '2026-10-21'

export const REFERENCE_PRICES = {
  'deepseek-v4-pro': {
    in: 9,
    out: 27,
    offPeakIn: 4.5,
    offPeakOut: 13.5,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 高峰价；空闲时段（工作日 12-14、18-9 及周末）减半',
  },
  'deepseek-v4.1-flash': {
    in: 2,
    out: 8,
    offPeakIn: 1,
    offPeakOut: 4,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 高峰价（对应 deepseek-flash）；空闲时段减半',
  },
  'deepseek-v4.1': {
    in: 2,
    out: 8,
    offPeakIn: 1,
    offPeakOut: 4,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 按 flash 计；空闲时段减半',
  },
  'glm-5.3': { in: 8, out: 28, currency: 'CNY', source: '智谱 · 第三方评测转述' },
  'glm-5.3-flash': { in: 0.8, out: 2.8, currency: 'CNY', source: '智谱 · 第三方转述' },
  'kimi-k3': { in: 20, out: 100, currency: 'CNY', source: '月之暗面 · 媒体转述' },
  'qwen3.8-max': { in: 2, out: 6, currency: 'USD', source: '阿里云百炼 · 美元计价' },
  'minimax-m3.1-flash': { in: 1, out: 4, currency: 'CNY', source: 'MiniMax 官方' },
  'minimax-m3': { in: 2, out: 8, currency: 'CNY', source: '按 M3.1 Flash 降价幅度反推，仅供参考' },
}

const KNOWN_KEYS = Object.keys(REFERENCE_PRICES).sort((a, b) => b.length - a.length)

/**
 * 给一个模型名找参考价。
 * 先精确匹配，再按前缀匹配（处理 -0813 / -1 这类版本尾巴），长的优先，
 * 避免 deepseek-v4.1 抢掉 deepseek-v4.1-flash。
 */
export function resolveReference(modelKey) {
  const key = String(modelKey || '')
    .toLowerCase()
    .trim()
  if (!key) return null

  if (REFERENCE_PRICES[key]) return { matchedKey: key, ...REFERENCE_PRICES[key] }

  for (const known of KNOWN_KEYS) {
    if (key.startsWith(`${known}-`) || key.startsWith(`${known}_`)) {
      return { matchedKey: known, ...REFERENCE_PRICES[known] }
    }
  }
  return null
}

/** 列出所有内置参考价，供界面展示。 */
export function listReference() {
  return KNOWN_KEYS.map((key) => ({ modelKey: key, ...REFERENCE_PRICES[key] }))
}
