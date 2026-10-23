/**
 * 预置目录：常用站点的地址、常用平台的类型。
 *
 * 只收录**能确认的**信息：
 *   - baseUrl 填了的一定是官方文档里的 OpenAI 兼容地址
 *   - 拿不准的留空并标注「以官网为准」，让用户自己填——猜一个错的地址比留空更糟
 *
 * 这里只是「省打字」的辅助，不参与任何逻辑判断。
 */

/** 站点侧预置（中转站 + 模型厂商） */
export const PRESET_SITES = [
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    kind: 'vendor',
    balance: true,
    freeNote: '新用户送 14 元额度',
  },
  {
    id: 'modelscope',
    name: '魔搭 ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    kind: 'vendor',
    balance: false,
    freeNote: '每日免费推理额度（以官方为准）',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    kind: 'vendor',
    balance: true,
    freeNote: '按量计费，无免费额度',
  },
  {
    id: 'moonshot',
    name: 'Moonshot 月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    kind: 'vendor',
    balance: true,
    freeNote: '注册赠送额度（以官方为准）',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    kind: 'vendor',
    balance: false,
    freeNote: '部分模型有免费档',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    kind: 'vendor',
    balance: false,
    freeNote: '新用户各模型有免费 token',
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    kind: 'vendor',
    balance: false,
    freeNote: '每个模型 50 万 token 免费额度',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    kind: 'vendor',
    balance: false,
    freeNote: '按量计费',
  },
  {
    id: 'agentrouter',
    name: 'AgentRouter',
    baseUrl: '',
    kind: 'relay',
    balance: false,
    freeNote: '注册送额度，地址以官网为准',
  },
  {
    id: 'anyrouter',
    name: 'AnyRouter',
    baseUrl: '',
    kind: 'relay',
    balance: false,
    freeNote: '注册送额度，地址以官网为准',
  },
  {
    id: 'ppio',
    name: 'PPIO 派欧云',
    baseUrl: '',
    kind: 'vendor',
    balance: false,
    freeNote: '新用户赠送额度，地址以官网为准',
  },
]

/**
 * 平台侧预置（Agent 产品，没有公开 OpenAI 接口）。
 * connectorId 指向 core/platforms 里注册的连接器；没有对应连接器时，
 * 建出来的平台就是「手动」形态——只记账，不自动读。
 */
export const PRESET_PLATFORMS = [
  {
    id: 'workbuddy',
    label: 'WorkBuddy 国际版',
    connectorId: 'workbuddy',
    note: 'workbuddy.ai，登录后自动读积分与签到',
  },
  // 国内版（workbuddy-cn）不再出现在推荐位：它和国际版是同一个站点（workbuddy.ai）、
  // 同一套接口，只有客户端 UA 不同，两卡并存只是把同一份积分画两遍。
  // 连接器本身仍注册着，需要时可以直接按 connectorId 'workbuddy-cn' 建平台。
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    connectorId: 'codebuddy',
    note: 'WorkBuddy 国内版：copilot.tencent.com，接口同国际版',
  },
  {
    id: 'trae',
    label: 'TraeWork AI',
    connectorId: 'manual',
    note: '暂无自动连接，先手动记额度',
  },
  {
    id: 'qoder',
    label: 'Qoder',
    connectorId: 'manual',
    note: '暂无自动连接，先手动记额度',
  },
  {
    id: 'cline',
    label: 'Cline',
    connectorId: 'manual',
    note: '暂无自动连接，先手动记额度',
  },
  {
    id: 'modelscope-studio',
    label: '魔搭社区',
    connectorId: 'manual',
    note: '每日签到领 200 积分，先手动记',
  },
  {
    id: 'zcode',
    label: 'ZCode（智谱）',
    connectorId: 'zcode',
    note: 'zcode.z.ai，智谱的 AI 编程订阅；从本机 ZCode 客户端读额度',
  },
]

export function listPresetSites() {
  return PRESET_SITES
}

export function listPresetPlatforms() {
  return PRESET_PLATFORMS
}

export function findPresetPlatform(id) {
  return PRESET_PLATFORMS.find((p) => p.id === id) || null
}
