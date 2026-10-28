/**
 * 连接器接口与注册表。
 *
 * 每个平台（WorkBuddy / Trae / manual）各实现一个 connector，
 * 上层只认 id，不认具体平台——T2b 接 OAuth 时只加文件，不改调用方。
 *
 * 契约：除 detect / forward 外全部可缺省。
 * 所以对外只暴露 callConnector()，由它把「方法不存在」翻译成 supported: false，
 * 而不是让调用方到处写 typeof connector.quota === 'function' 的判断。
 */

const registry = new Map()

/** 注册一个连接器。重复注册同 id 视为热替换（开发时改完重载用）。 */
export function registerConnector(def) {
  if (!def || !def.id) throw new Error('connector 缺少 id')
  if (!def.label) throw new Error(`connector ${def.id} 缺少 label`)
  const connector = { ...def, id: String(def.id), label: String(def.label) }
  registry.set(connector.id, connector)
  return connector
}

export function getConnector(id) {
  return registry.get(String(id ?? '')) || null
}

/**
 * 安全调用。
 *
 * 返回三种形态：
 *   { supported: false, reason }         连接器不存在，或没实现这个方法
 *   { supported: true, value }           正常返回（value 可以是 undefined）
 *   { supported: true, value: null, error } 方法抛了错——网络/授权失败都走这里
 *
 * 抛错不往外冒，是因为「签到接口 502」不该让整个面板渲染失败。
 */
export async function callConnector(id, method, ...args) {
  const connector = getConnector(id)
  if (!connector) return { supported: false, reason: `未注册的连接器：${id}` }

  const fn = connector[method]
  if (typeof fn !== 'function') {
    return { supported: false, reason: `连接器 ${connector.id} 不支持 ${method}` }
  }

  try {
    return { supported: true, value: await fn.apply(connector, args) }
  } catch (error) {
    return { supported: true, value: null, error: error?.message || String(error) }
  }
}
