/**
 * 手动连接器：没装任何 Agent 客户端时的兜底。
 *
 * 只实现 detect 与 quota —— 其余方法缺省，callConnector 会返回 supported: false，
 * 界面上的「签到」因此退化成「手动标记已签」，额度靠用户自己填。
 * 这不是残缺实现：没有客户端就没有可调用的接口，硬编一个假实现只会骗自己。
 */
import { registerConnector } from './connector.js'

export const manualConnector = {
  id: 'manual',
  label: '手动',

  // 永远可用：它不依赖本机装了什么
  detect() {
    return { available: true }
  },

  // 直接读账号上手填的额度，不发任何请求
  quota(account) {
    const quota = account?.quota
    if (!quota) return { remaining: null, unit: null, refreshAt: null }
    const limit = Number(quota.limit)
    const used = Number(quota.used) || 0
    return {
      remaining: Number.isFinite(limit) ? Math.max(0, limit - used) : null,
      unit: quota.unit || null,
      refreshAt: quota.resetAt || null,
    }
  },
}

// 导入即注册：内置连接器是模块自带的，不该要求调用方额外记得登记
registerConnector(manualConnector)
