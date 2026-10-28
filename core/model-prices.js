/**
 * 内置官方参考价。
 *
 * 只是起点，不是真理——模型价格变动频繁，部分条目来自聚合商（OpenRouter）
 * 而非官网原文。载入后请在基准价页核对，以各家官网为准。
 *
 * 收录原则（2026-10-28 应作者要求一次性补全）：能查到官方 / 聚合商美元价的
 * 文本模型尽量全收，国内厂商（DeepSeek / 智谱 / MiniMax / Kimi / 千问 / 腾讯 /
 * 小米 / 阶跃）以官网人民币价优先，没有官方人民币价的用 OpenRouter 美元价。
 * **图像 / 语音 / 视频 / 按次计费模型不收**（量纲不同，塞进每百万 token 的表会算错）。
 * 之后价格变动不自动更新：基准价页手填，或等下一轮人工核对。
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
 *   - Kimi K2.x / K3：月之暗面官方（platform.kimi.com）国内价
 *   - OpenAI / Anthropic / Google / xAI / Mistral / 腾讯混元 / 小米 MiMo /
 *     ByteDance Seed 等：OpenRouter /api/v1/models 美元价（与官方美元价一致）
 *
 * 匹配口径见 resolveReference：归一化名称（横线/点、日期尾巴）+ 别名表 +
 * 前缀匹配 + highspeed/ultraspeed 变体推算。daemon 启动时会自动把这份表
 * 补进基准价表（只补空缺），不用手点「载入内置参考价」。
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
  // 站点常把版本号里的点写成横线（claude-opus-5-5）：canonicalName 已把
  // 5-5 归一到 5.5，不会错归 claude-opus-5，不再需要显式条目
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

  // ==================================================================
  // 2026-10-28 一次性补全（应作者要求，此后不再自动扩充）：
  // OpenAI / Anthropic / Google / xAI 补齐 OpenRouter 在售的主流文本模型；
  // 国内厂商补齐站点常见的混元 / MiMo / MiniMax / Kimi / Seed 系列。
  // ==================================================================

  // ---- OpenAI（补充：OpenRouter 官方美元价，与各家官网一致）
  'gpt-3.5-turbo-0613': { in: 1, out: 2, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-3.5-turbo-16k': { in: 3, out: 4, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4': { in: 30, out: 60, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4-turbo': { in: 10, out: 30, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4o-2024-05-13': { in: 5, out: 15, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4o-2024-08-06': { in: 2.5, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4o-2024-11-20': { in: 2.5, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-4o-mini-2024-07-18': { in: 0.15, out: 0.6, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5-pro': { in: 30, out: 180, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.1-codex': { in: 1.25, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.1-codex-max': { in: 1.25, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.2-chat': { in: 5, out: 30, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价（gpt-5.2 的 chat 专口）' },
  'gpt-5.2-codex': { in: 1.75, out: 14, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.2-pro': { in: 30, out: 180, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.3-codex': { in: 1.75, out: 14, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.4-pro': { in: 30, out: 180, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.6-luna-pro': { in: 0.2, out: 1.2, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.6-sol': { in: 4, out: 20, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.6-sol-pro': { in: 4, out: 20, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.6-terra': { in: 2, out: 12, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-5.6-terra-pro': { in: 2, out: 12, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6-astra': { in: 10, out: 50, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6-astra-pro': { in: 10, out: 50, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6-luna-pro': { in: 0.1, out: 0.5, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6-sol-pro': { in: 2, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6.1-sol': { in: 2, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-6.1-sol-pro': { in: 2, out: 10, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'gpt-chat-latest': { in: 5, out: 30, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价（chat 专口）' },
  'o1': { in: 15, out: 60, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'o1-pro': { in: 150, out: 600, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'o3-mini': { in: 1.1, out: 4.4, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'o3-mini-high': { in: 1.1, out: 4.4, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'o3-pro': { in: 20, out: 80, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },
  'o4-mini-high': { in: 1.1, out: 4.4, currency: 'RUSD', source: 'OpenRouter · OpenAI 官方美元价' },

  // ---- Anthropic（补充：OpenRouter 官方美元价；Sonnet 4 与 4.5 同价）
  'claude-sonnet-4': { in: 3, out: 15, currency: 'RUSD', source: 'Anthropic 官方美元价（与 Sonnet 4.5 同价）' },
  'claude-fable-5.1': { in: 10, out: 50, currency: 'RUSD', source: 'OpenRouter · Anthropic 官方美元价' },

  // ---- Google（补充：OpenRouter 官方美元价）
  'gemini-2.5-pro-preview': { in: 1.25, out: 10, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.1-flash-lite-preview': { in: 0.25, out: 1.5, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemini-3.1-pro-preview-customtools': { in: 2, out: 12, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemma-2-27b-it': { in: 0.65, out: 0.65, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemma-3-4b-it': { in: 0.05, out: 0.1, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemma-3-12b-it': { in: 0.05, out: 0.15, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemma-3-27b-it': { in: 0.08, out: 0.35, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemma-4-26b-a4b-it': { in: 0.09, out: 0.3, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },
  'gemma-4-31b-it': { in: 0.2, out: 0.4, currency: 'RUSD', source: 'OpenRouter · Google 官方美元价' },

  // ---- xAI（补充：OpenRouter 官方美元价）
  'grok-4.20-multi-agent': { in: 1.25, out: 2.5, currency: 'RUSD', source: 'OpenRouter · xAI 官方美元价' },
  'grok-build-0.1': { in: 1, out: 2, currency: 'RUSD', source: 'OpenRouter · xAI 官方美元价' },

  // ---- 腾讯混元（OpenRouter 美元价；腾讯文档站有反爬，拿不到官方人民币原文）
  'hy3': { in: 0.132, out: 0.528, currency: 'RUSD', source: 'OpenRouter · 腾讯混元 Hy3' },
  'hy4-preview': { in: 0.834, out: 2.501, currency: 'RUSD', source: 'OpenRouter · 腾讯混元 Hy4 preview' },

  // ---- 小米 MiMo（OpenRouter 美元价）
  'mimo-v2.5': { in: 0.4, out: 2, currency: 'RUSD', source: 'OpenRouter · 小米 MiMo 官方美元价' },

  // ---- MiniMax（补充：OpenRouter 美元价，与官方人民币价×汇率一致）
  'minimax-m2': { in: 0.255, out: 1.02, currency: 'RUSD', source: 'OpenRouter · MiniMax 官方美元价' },
  'minimax-m2.1': { in: 0.3, out: 1.2, currency: 'RUSD', source: 'OpenRouter · MiniMax 官方美元价' },
  'minimax-m2.7': { in: 0.3, out: 1.2, currency: 'RUSD', source: 'OpenRouter · MiniMax 官方美元价' },

  // ---- 月之暗面 Kimi（补充：OpenRouter 美元价；K2 老型号）
  'kimi-k2': { in: 0.57, out: 2.3, currency: 'RUSD', source: 'OpenRouter · Moonshot 官方美元价' },
  'kimi-k2-0905': { in: 0.6, out: 2.5, currency: 'RUSD', source: 'OpenRouter · Moonshot 官方美元价' },

  // ---- DeepSeek（补充：官方美元价 + 旧名）
  'deepseek-chat': { in: 0.27, out: 1.1, currency: 'RUSD', source: 'DeepSeek 官方美元价（V3.x chat）' },
  'deepseek-v3.2': { in: 0.28, out: 0.42, currency: 'RUSD', source: 'OpenRouter · DeepSeek 官方美元价' },

  // ---- 智谱 GLM（补充：官方人民币价）
  'glm-4.5': { in: 0.6, out: 2.2, currency: 'RUSD', source: 'OpenRouter · 智谱官方美元价' },
  'glm-4.5-air': { in: 0.13, out: 0.85, currency: 'RUSD', source: 'OpenRouter · 智谱官方美元价' },
  'glm-4.6': { in: 0.55, out: 2.2, currency: 'RUSD', source: 'OpenRouter · 智谱官方美元价' },
  'glm-4.6v': { in: 0.3, out: 0.9, currency: 'RUSD', source: 'OpenRouter · 智谱官方美元价' },
  'glm-4.7-flash': { in: 0.0605, out: 0.4, currency: 'RUSD', source: 'OpenRouter · 智谱官方美元价' },
  'glm-5-turbo': { in: 7, out: 26, currency: 'CNY', source: '智谱官方 · ≥32K 档；<32K 为 5/22' },
  'glm-5v-turbo': { in: 7, out: 26, currency: 'CNY', source: '智谱官方 · ≥32K 档；<32K 为 5/22' },

  // ---- 字节 Seed（OpenRouter 美元价）
  'seed-1.6': { in: 0.25, out: 2, currency: 'RUSD', source: 'OpenRouter · 字节 Seed 官方美元价' },
  'seed-1.6-flash': { in: 0.075, out: 0.3, currency: 'RUSD', source: 'OpenRouter · 字节 Seed 官方美元价' },
  'seed-2.0-lite': { in: 0.25, out: 2, currency: 'RUSD', source: 'OpenRouter · 字节 Seed 官方美元价' },
  'seed-2.0-code': { in: 0.5, out: 3, currency: 'RUSD', source: 'OpenRouter · 字节 Seed 官方美元价' },
  'seed-2.0-mini': { in: 0.1, out: 0.4, currency: 'RUSD', source: 'OpenRouter · 字节 Seed 官方美元价' },

  // ---- 通义千问 / 阶跃（补充）
  'qwen3.8-max-prime': { in: 4, out: 12, currency: 'RUSD', source: 'OpenRouter · 阿里云百炼官方美元价' },
  'qwen3.8-omni-flash': { in: 0.15, out: 0.47, currency: 'RUSD', source: 'OpenRouter · 阿里云百炼官方美元价' },
  'qwen3-coder-next': { in: 0.12, out: 0.8, currency: 'RUSD', source: 'OpenRouter · 阿里云百炼官方美元价' },
  'step-3.7-flash': { in: 0.2, out: 1.15, currency: 'RUSD', source: 'OpenRouter · 阶跃官方美元价' },
  'step-3.5-flash': { in: 0.1, out: 0.3, currency: 'RUSD', source: 'OpenRouter · 阶跃官方美元价' },
}

/** 别名表：站点常用叫法 → 库内条目。只做一层指向，不递归。 */
const ALIASES = {
  // 混元：站点常写裸名 / fast 变体，官方均按 hy4-preview 提供
  hy4: 'hy4-preview',
  'hy4-preview-f': 'hy4-preview',
  // Kimi：裸 k2.7 就是 K2.7 Code；k3.1 系列首个（也是唯一）模型是 k3.1-pro
  'kimi-k2.7': 'kimi-k2.7-code',
  'kimi-k3.1': 'kimi-k3.1-pro',
  // DeepSeek 官方：旧模型名请求由 Flash 服务并按 Flash 价格计费
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
  // chat 专口的裸写法
  'chat-latest': 'gpt-chat-latest',
}

/**
 * 归一化模型名：去掉供应商前缀（anthropic/claude-…）、点横线互转（4-5 → 4.5）、
 * -v 前缀（v4.1 → 4.1）、以及一堆装饰尾巴（日期戳 / -thinking / -preview …）。
 * 库内键与查询键两侧都用它，避免只归一一边造成的系统性错配。
 */
const DATE_TAIL = /-(?:19|20)\d{6}(?=-|$)/
const DECOR_TAIL = /-(?:thinking|highspeed|ultraspeed|preview|latest|beta|exp|hc)(?=-|$)/
export function canonicalName(name) {
  let s = String(name || '').toLowerCase().trim()
  s = s.replace(/^[a-z0-9_.-]+\//, '')
  s = s.replace(/[-:]free$/, '').replace(/:batch$/, '')
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s.replace(DATE_TAIL, '').replace(DECOR_TAIL, '')
    if (s === before) break
  }
  s = s.replace(/(?<!\d)(\d)[-_](\d)(?!\d)/g, '$1.$2')
  s = s.replace(/-v(\d)/g, '-$1')
  return s.replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/**
 * 变体加价规则：同一模型的高速版在部分官方渠道单独计价。
 *   -highspeed   输出 ×2（Kimi 高速版的通行口径，估算值）
 *   -ultraspeed  入/出 ×10（MiMo，OpenRouter 实价验证）
 * -thinking 不加价（DeepSeek / Anthropic / Kimi 思考模式均同价）。
 * 返回 null 表示按原价。
 */
const VARIANT_RULES = [
  { re: /-highspeed$/, mult: { out: 2 } },
  { re: /-ultraspeed$/, mult: { in: 10, out: 10 } },
]
function variantMultiplier(key) {
  for (const rule of VARIANT_RULES) {
    if (rule.re.test(key)) return rule.mult
  }
  return null
}

const KNOWN_KEYS = Object.keys(REFERENCE_PRICES).sort((a, b) => b.length - a.length)
const CANON_INDEX = new Map()
for (const key of KNOWN_KEYS) {
  const c = canonicalName(key)
  // 同名冲突（如显式收录的横线变体）先到先得，价格一致时无影响
  if (!CANON_INDEX.has(c)) CANON_INDEX.set(c, key)
}
const CANON_KEYS = [...CANON_INDEX.keys()].sort((a, b) => b.length - a.length)

/**
 * 给一个模型名找参考价。匹配顺序：
 *   1. 别名表 → 2. 原名精确 → 3. 归一化名精确 → 4. 归一化前缀（长者优先，
 *   避免 deepseek-v4.1 抢掉 deepseek-v4.1-flash）。
 *   命中后再按 -highspeed / -ultraspeed 变体推算加价。
 * 查不到返回 null——宁可空着，也不给错数。
 */
export function resolveReference(modelKey) {
  const raw = String(modelKey || '').toLowerCase().trim()
  if (!raw) return null
  // 别名既认原名也认归一化名（kimi-k3-1 → kimi-k3.1 → kimi-k3.1-pro）
  const key = ALIASES[raw] || ALIASES[canonicalName(raw)] || raw

  let entry = null
  let exactSelf = false
  if (REFERENCE_PRICES[key]) {
    entry = { matchedKey: key, ...REFERENCE_PRICES[key] }
    exactSelf = true
  } else {
    const ck = canonicalName(key)
    const exact = CANON_INDEX.get(ck)
    if (exact) {
      entry = { matchedKey: exact, ...REFERENCE_PRICES[exact] }
    } else {
      for (const known of CANON_KEYS) {
        if (ck.startsWith(`${known}-`) || ck.startsWith(`${known}_`)) {
          const matchedKey = CANON_INDEX.get(known)
          entry = { matchedKey, ...REFERENCE_PRICES[matchedKey] }
          break
        }
      }
    }
  }
  if (!entry) return null

  // 变体加价只在前缀/归一化间接命中时套用：库里显式收录的
  // 'mimo-v2.6-pro-ultraspeed' 本身就是 ×10 后的实价，再乘一遍就错了
  const mult = exactSelf ? null : variantMultiplier(key)
  if (mult) {
    entry = {
      ...entry,
      in: mult.in ? entry.in * mult.in : entry.in,
      out: mult.out ? entry.out * mult.out : entry.out,
      offPeakIn: mult.in && entry.offPeakIn != null ? entry.offPeakIn * mult.in : entry.offPeakIn,
      offPeakOut: mult.out && entry.offPeakOut != null ? entry.offPeakOut * mult.out : entry.offPeakOut,
      variant: mult.out === 2 ? 'highspeed' : 'ultraspeed',
    }
  }
  return entry
}

/** 列出所有内置参考价，供界面展示。 */
export function listReference() {
  return KNOWN_KEYS.map((key) => ({ modelKey: key, ...REFERENCE_PRICES[key] }))
}
