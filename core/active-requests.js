/**
 * 活跃请求追踪（内存态，随进程重启清空）。
 *
 * 回答的是「此刻哪个站正在服务哪个请求、跑到第几步了」，
 * 与 usage-detail（已完成请求的历史账）是两回事：
 *   - usage-detail：请求结束后落盘，永久保存
 *   - 本模块：请求进行中在内存里，close 时摘除，不留痕
 *
 * ── 为什么单独一层，不塞进 handleChatCompletions ───────────────────
 *
 * 那个函数有十几个 return 分支（参数校验、准入拒绝、免费池耗尽、上游全挂…），
 * 逐处加 register/unregister 必然漏一处，漏掉的那条就永远卡在「活跃」里。
 * 改成在路由层注册 + `res.on('close')` 自动摘除：无论从哪个分支返回，
 * Node 都会触发 close，一处挂载全覆盖。
 *
 * ── 数据安全 ─────────────────────────────────────────────────────
 *
 * 只存展示需要的字段，**不存请求正文、不存 Key、不存 token**。
 * 这个接口会被插件面板读，多存一个字段就多一份泄露面。
 */

/** 活跃请求上限：防止异常连接堆积把内存吃满 */
const MAX_ACTIVE = 256
/** 超过这个时长还没结束的视为僵尸，读的时候过滤掉（但不主动删，交给 close） */
const STALE_MS = 10 * 60 * 1000

const active = new Map()
let seq = 0

/**
 * 注册一个活跃请求。
 *
 * @param {object} info 展示字段（不含任何敏感内容）
 * @param {import('node:http').ServerResponse} res
 * @returns {{id:string, update:(patch:object)=>void, done:()=>void}}
 */
export function trackActive(info, res) {
  const id = `ar_${Date.now().toString(36)}_${(seq += 1).toString(36)}`
  const entry = {
    id,
    startedAt: Date.now(),
    // 只挑白名单字段：传多了也只保留这些
    model: info?.model ?? null,
    providerId: info?.providerId ?? null,
    providerName: info?.providerName ?? null,
    group: info?.group ?? null,
    protocol: info?.protocol ?? 'chat',
    stream: Boolean(info?.stream),
    keyName: info?.keyName ?? null,
    // 运行期由 update() 推进，不落盘
    phase: info?.phase ?? 'routing',
    attempts: 0,
    ttftMs: null,
  }
  // 超限时丢最老的一条（异常连接堆积的兜底）
  if (active.size >= MAX_ACTIVE) {
    const oldest = active.keys().next().value
    if (oldest) active.delete(oldest)
  }
  active.set(id, entry)

  let closed = false
  const done = () => {
    if (closed) return
    closed = true
    active.delete(id)
  }
  // 幂等：Node 在 finish / close / abort 都可能触发，只认第一次。
  // 两个都挂：finish 在「响应完整写完」时触发（正常结束），
  // close 在「连接关闭」时触发（客户端断开、异常、或写完后再关）。
  // 只挂 close 时，若 keep-alive 连接不立即关，记录会滞留到超时才清。
  if (res && typeof res.on === 'function') {
    res.on('close', done)
    res.on('finish', done)
  }

  return {
    id,
    update(patch) {
      if (closed || !patch) return
      const allowed = ['providerId', 'providerName', 'group', 'phase', 'attempts', 'ttftMs', 'model', 'stream']
      for (const k of allowed) {
        if (patch[k] !== undefined) entry[k] = patch[k]
      }
    },
    done,
  }
}

/** 读当前活跃请求（新→旧），自动过滤僵尸条目 */
export function listActive() {
  const now = Date.now()
  const out = []
  for (const [id, e] of active) {
    if (now - e.startedAt > STALE_MS) { active.delete(id); continue }
    out.push({ ...e, elapsedMs: now - e.startedAt })
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/** 供测试注入/清空 */
export function clearActive() { active.clear() }
