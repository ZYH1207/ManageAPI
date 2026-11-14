/**
 * D 棒 · Host 集成层的 daemon 只读/回写客户端。
 *
 * 直接复用 C 棒 `lib/http.js#daemonRequest`：loopback-only、路径/query 校验、
 * 防任意反代（每次必须显式 allowedPattern）、超时归一、响应瘦身。
 * 这里只把三种固定用途收敛成方法，绝不允许调用方自带 method/path。
 *
 *  - getState()   GET  /api/state?light=1  （经 routes.sanitizeState 脱敏）
 *  - postIngest() POST /api/ingest/usage   （C 棒已授权的用量回写端点）
 *  - probe()      GET  /api/health
 *
 * 不 import node:fs，不写任何数据文件；所有写入仍只经 daemon HTTP。
 */

import { daemonRequest } from '../http.js'
import { sanitizeState } from '../routes.js'

export const STATE_PATTERN = /^\/api\/state$/
export const INGEST_PATTERN = /^\/api\/ingest\/usage$/
export const HEALTH_PATTERN = /^\/api\/health$/

/**
 * @param {{port?:number, baseUrl?:string, fetchImpl?:Function, timeoutMs?:number}} [options]
 */
export function createDaemonClient(options = {}) {
  const port = Number(options.port) || 4319
  const baseUrl = options.baseUrl || `http://127.0.0.1:${port}`
  const fetchImpl = options.fetchImpl
  const timeoutMs = Number(options.timeoutMs) || undefined

  async function getState({ light = true } = {}) {
    return daemonRequest({
      baseUrl,
      method: 'GET',
      path: '/api/state',
      query: light ? { light: '1' } : {},
      allowedPattern: STATE_PATTERN,
      sanitize: sanitizeState,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    })
  }

  async function postIngest(payload) {
    return daemonRequest({
      baseUrl,
      method: 'POST',
      path: '/api/ingest/usage',
      allowedPattern: INGEST_PATTERN,
      body: payload ?? {},
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    })
  }

  async function probe() {
    return daemonRequest({
      baseUrl,
      method: 'GET',
      path: '/api/health',
      allowedPattern: HEALTH_PATTERN,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    })
  }

  return { port, baseUrl, getState, postIngest, probe }
}
