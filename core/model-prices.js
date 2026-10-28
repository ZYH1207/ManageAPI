/**
 * 内置官方参考价。
 *
 * 只是起点，不是真理——模型价格变动频繁，部分条目来自聚合商（OpenRouter）
 * 而非官网原文。载入后请在基准价页核对，以各家官网为准。
 *
 * 收录原则：只收**主流模型**（各家旗舰 + 高用量中档）。长尾小模型、
 * 图像 / 语音 / 视频模型不收——管不过来，也值得管。新模型发布后不自动更新，
 * 基准价页可以手填（这是唯一长期可靠的渠道）。
 *
 * 单位：每百万 token。CNY（国内官方人民币价）与 RUSD（真实美元，国外官方价）
 * 原样保留；站内美元与人民币 1:1，这些数值作为倍率参照时直接可用，
 * 只有「官方有效成本」才把 RUSD 乘汇率换算（见 core/pricing.js 的口径说明）。
 *
 * 主要来源（2026-10-28 核对）：
 *   - DeepSeek：api-docs.deepseek.com/zh-cn/quick_start/pricing（官方，高峰价）
 *   - 智谱 GLM：docs.bigmodel.cn/cn/guide/start/pricing.md（官方）
 *   - MiniMax：platform.minimaxi.com/docs/pricing/overview.md（官方）
 *   - 通义千问：help.aliyun.com/zh/model-studio/model-pricing（百炼官方，全球/北京价）
 *   - Kimi K2.x / K3：百炼转述的月之暗面国内价
 *   - OpenAI / Anthropic / Google / xAI / 小米 / 阶跃 / Mistral 等：
 *     OpenRouter /api/v1/models 美元价（通常与官方美元价一致）
 */

export const REFERENCE_AS_OF = '2026-10-28'

export const REFERENCE_PRICES = {
  // ---- DeepSeek（官方，人民币，高峰价；空闲时段减半）
  'deepseek-v4-pro': {
    in: 9,
    out: 27,
    offPeakIn: 4.5,
    offPeakOut: 13.5,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 高峰价；空闲时段（工作日 9-12、14-18 以外及周末节假日）减半',
  },
  'deepseek-v4-pro-0813': {
    in: 9,
    out: 27,
    offPeakIn: 4.5,
    offPeakOut: 13.5,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 同 deepseek-v4-pro',
  },
  'deepseek-flash': {
    in: 2,
    out: 8,
    offPeakIn: 1,
    offPeakOut: 4,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 高峰价（即 V4.1-Flash-1017）；空闲时段减半',
  },
  'deepseek-v4.1-flash': {
    in: 2,
    out: 8,
    offPeakIn: 1,
    offPeakOut: 4,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 高峰价；空闲时段减半',
  },
  'deepseek-v4.1-flash-1017': {
    in: 2,
    out: 8,
    offPeakIn: 1,
    offPeakOut: 4,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 高峰价；空闲时段减半',
  },
  'deepseek-v4.1': {
    in: 2,
    out: 8,
    offPeakIn: 1,
    offPeakOut: 4,
    currency: 'CNY',
    source: 'DeepSeek 官方 · 按 flash 计；空闲时段减半',
  },

  // ---- 智谱 GLM（官方，人民币）
  'glm-5.3': { in: 8, out: 28, currency: 'CNY', source: '智谱官方' },
  'glm-5.3-flash': { in: 0.8, out: 2.8, currency: 'CNY', source: '智谱官方' },
  'glm-5.3-flashx': { in: 2, out: 7, currency: 'CNY', source: '智谱官方' },
  'glm-5.3-prime': { in: 16, out: 56, currency: 'CNY', source: '智谱官方' },
  'glm-5.2': { in: 8, out: 28, currency: 'CNY', source: '智谱官方' },
  'glm-5.1': { in: 8, out: 28, currency: 'CNY', source: '智谱官方 · 输入<32K 档为 6/24' },
  'glm-5': { in: 6, out: 22, currency: 'CNY', source: '智谱官方 · ≥32K 档；<32K 为 4/18' },
  'glm-4.7': { in: 4, out: 16, currency: 'CNY', source: '智谱官方 · 32K-200K 档；短输入更便宜' },

  // ---- Kimi（月之暗面，人民币；K3.1 Pro 为 OpenRouter 美元价）
  'kimi-k3': { in: 20, out: 100, currency: 'CNY', source: '月之暗面 · 官方价' },
  'kimi-k3.1-pro': { in: 2, out: 10, currency: 'RUSD', source: 'OpenRouter · Moonshot 美元价' },
  'kimi-k2.7-code': { in: 6.5, out: 27, currency: 'CNY', source: '月之暗面 · 官方价' },
  'kimi-k2.6': { in: 6.5, out: 27, currency: 'CNY', source: '月之暗面 · 官方价（K2 系列 12 月底下线）' },
  'kimi-k2.5': { in: 4, out: 21, currency: 'CNY', source: '月之暗面 · 官方价（K2 系列 12 月底下线）' },

  // ---- MiniMax（官方，人民币；M3 五折后）
  'minimax-m3.1-flash': { in: 1, out: 4, currency: 'CNY', source: 'MiniMax 官方' },
  'minimax-m3': { in: 2.1, out: 8.4, currency: 'CNY', source: 'MiniMax 官方 · 永久五折，输入 ≤512k 档' },
  'minimax-m2.5': { in: 2.1, out: 8.4, currency: 'CNY', source: 'MiniMax 官方' },

  // ---- 通义千问（阿里云百炼官方，人民币，北京/全球价）
  'qwen3.8-max': { in: 12, out: 36, currency: 'CNY', source: '阿里云百炼官方' },
  'qwen3.8-flash': { in: 0.8, out: 2.7, currency: 'CNY', source: '阿里云百炼官方' },
  'qwen3.7-max': { in: 12, out: 36, currency: 'CNY', source: '阿里云百炼官方' },
  'qwen3.7-plus': { in: 2, out: 8, currency: 'CNY', source: '阿里云百炼官方 · 限时 8 折后为 1.6/6.4' },
  'qwen3.7-flash': { in: 0.2, out: 0.8, currency: 'CNY', source: '阿里云百炼官方 · 输入≤32K 档' },
  'qwen3.6-flash': { in: 1.2, out: 7.2, currency: 'CNY', source: '阿里云百炼官方' },
  'qwen3.5-flash': { in: 0.2, out: 2, currency: 'CNY', source: '阿里云百炼官方' },
  'qwen-flash': { in: 0.15, out: 1.5, currency: 'CNY', source: '阿里云百炼官方 · 输入≤128K 档' },
  'qwen3-coder-flash': { in: 1, out: 4, currency: 'CNY', source: '阿里云百炼官方 · 输入≤32K 档' },
  'qwen3-vl-plus': { in: 1, out: 10, currency: 'CNY', source: '阿里云百炼官方 · 输入≤32K 档' },

  // ---- 小米 / 阶跃（OpenRouter 美元价）
  'mimo-v2.6-flash': { in: 0.14, out: 0.28, currency: 'RUSD', source: 'OpenRouter' },
  'mimo-v2.6-pro': { in: 0.435, out: 0.87, currency: 'RUSD', source: 'OpenRouter' },
  'mimo-v2.5-pro': { in: 0.48, out: 1.8, currency: 'RUSD', source: 'OpenRouter' },
  'step-5-preview': { in: 1, out: 2.7, currency: 'RUSD', source: 'OpenRouter' },

  // ---- OpenAI（OpenRouter 美元价，与官方一致）
  'gpt-5.5': { in: 5, out: 30, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.5-pro': { in: 30, out: 180, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.4': { in: 2.5, out: 15, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.4-mini': { in: 0.75, out: 4.5, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.4-nano': { in: 0.2, out: 1.25, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.2': { in: 1.75, out: 14, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.1': { in: 1.25, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5': { in: 1.25, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5-mini': { in: 0.25, out: 2, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5-nano': { in: 0.05, out: 0.4, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4.1': { in: 2, out: 8, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4.1-mini': { in: 0.4, out: 1.6, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4.1-nano': { in: 0.1, out: 0.4, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4o': { in: 2.5, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4o-mini': { in: 0.15, out: 0.6, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'o3': { in: 2, out: 8, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'o4-mini': { in: 1.1, out: 4.4, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6.1-terra': { in: 1, out: 5, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6.1-terra-pro': { in: 1, out: 5, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6-sol': { in: 2, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6-luna': { in: 0.1, out: 0.5, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-oss-120b': { in: 0.15, out: 0.6, currency: 'RUSD', source: 'OpenRouter · 开源模型托管价' },
  'gpt-oss-20b': { in: 0.018, out: 0.09, currency: 'RUSD', source: 'OpenRouter · 开源模型托管价' },

  // ---- Anthropic Claude（OpenRouter 美元价，与官方一致）
  'claude-opus-5.5': { in: 4, out: 20, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  // 站点常把版本号里的点写成横线（claude-opus-5-5）：不显式给条目的话，
  // 前缀匹配会把它错归到 claude-opus-5（5/25），价格差 25%——宁可多一行也别算错
  'claude-opus-5-5': { in: 4, out: 20, currency: 'RUSD', source: 'OpenRouter · claude-opus-5.5 的横线变体' },
  'claude-opus-5': { in: 5, out: 25, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-opus-4.8': { in: 5, out: 25, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-opus-4.7': { in: 5, out: 25, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-opus-4.6': { in: 5, out: 25, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-opus-4.5': { in: 5, out: 25, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-opus-4.1': { in: 15, out: 75, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-sonnet-5.5': { in: 2, out: 10, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-sonnet-5': { in: 2, out: 10, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-sonnet-4.6': { in: 3, out: 15, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-sonnet-4.5': { in: 3, out: 15, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-haiku-5.5': { in: 0.1, out: 0.5, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-haiku-4.5': { in: 1, out: 5, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },
  'claude-fable-5': { in: 10, out: 50, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },

  // ---- Google Gemini（OpenRouter 美元价）
  'gemini-4-argon': { in: 2, out: 10, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.8-flash': { in: 0.825, out: 4.125, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.7-flash': { in: 0.75, out: 3.75, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.6-flash': { in: 0.75, out: 3.75, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.5-flash': { in: 1.5, out: 9, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.5-flash-lite': { in: 0.3, out: 2.5, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.1-pro': { in: 2, out: 12, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.1-pro-preview': { in: 2, out: 12, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.5, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3-flash': { in: 0.5, out: 3, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3-flash-preview': { in: 0.5, out: 3, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-2.5-pro': { in: 1.25, out: 10, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },

  // ---- xAI Grok（OpenRouter 美元价）
  'grok-4.7': { in: 2, out: 6, currency: 'RUSD', source: 'OpenRouter · xAI 官方美元价' },
  'grok-4.6': { in: 2, out: 6, currency: 'RUSD', source: 'OpenRouter · xAI 官方美元价' },
  'grok-4.5': { in: 2, out: 6, currency: 'RUSD', source: 'OpenRouter · xAI 官方美元价' },
  'grok-4.3': { in: 1.25, out: 2.5, currency: 'RUSD', source: 'OpenRouter · xAI 官方美元价' },
  'grok-4.20': { in: 1.25, out: 2.5, currency: 'RUSD', source: 'OpenRouter · xAI 官方美元价' },

  // ---- Mistral（OpenRouter 美元价）
  'mistral-large-4-0': { in: 1.36, out: 4.18, currency: 'RUSD', source: 'OpenRouter' },
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
