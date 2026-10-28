# 故障信号接口（给自动路由用）

诊断系统（探针 / 空回合守卫）发现「这家供给真的不能用」时，会通过这个接口向外报告。
路由侧收到后**自己决定**怎么处理——诊断不知道路由存在，两者完全解耦。

实现：`core/fault-signal.js`　测试：`.test/check-fault-signal.mjs`

---

## 一、核心原则：不影响干活就不打扰你

这是用户定的规矩，也是这套接口最重要的一条：

| 情况 | 发不发 | 级别 |
|---|---|---|
| 空回合 → 本地解析重建成功 | ❌ 不发 | `notice`（只落库） |
| 空回合 → 补问救回来了 | ❌ 不发 | `notice`（只落库） |
| 空回合 → 补问也空 / 没别家可换 | ✅ 发 | `degraded` |
| 5 分钟内同一供给空过 3 次（哪怕这次救回） | ✅ 发 | `faulty` |
| 探针判指纹不符 / 输出截断 / 用量虚报 | ✅ 发 | `faulty` |
| 复检通过 / 探针恢复正常 | ✅ 发（解除） | `active: false` |

**只有 `notice` 不广播。** 它照样落库，诊断页上看得见，但不会打扰路由。

---

## 二、两种取用方式（缺一个都会出问题）

### 1. 推：进程内订阅（实时）

```js
import { subscribeFaults } from '../core/fault-signal.js'

const off = subscribeFaults((signal) => {
  if (signal.active) {
    // signal.level    === 'faulty' | 'degraded'
    // signal.suggested === 'avoid' | 'deprioritize'
    // signal.scope    → { providerId, providerName, offerId, modelKey, model }
    // signal.hits     → 窗口内第几次（越多次越该避开）
    // signal.expiresAt→ 自动失效时间；到期会自己从快照里消失
  } else {
    // 已恢复：把这条供给放回候选
  }
})

off() // 退订
```

订阅者抛异常**不会影响网关主流程**（会被吞掉并记日志），所以可以放心写业务。

### 2. 拉：读快照（重启后 / 随时查）

推送只覆盖「发生的那一瞬间」。重启之后、或者信号早就发过的时候，只能靠拉：

```js
import { faultSnapshot } from '../core/inventory.js'
const faults = await faultSnapshot()   // Map<offerId, signal>
```

或者走 HTTP（给外部进程 / 界面用）：

```
GET /api/faults
→ { active: [...], summary: {...}, subscribers: n, history: [...] }
```

**挑优时应该读这个**，而不是只依赖推送。

---

## 三、信号形状

```js
{
  id: 'fs_xxx',
  ts: '2026-10-28T10:00:00.000Z',
  kind: 'empty-turn' | 'integrity',
  level: 'notice' | 'degraded' | 'faulty',
  active: true,                    // false = 解除信号
  scope: {
    providerId, providerName,
    offerId,                       // ← 挑优时按这个过滤最准
    modelKey, model
  },
  reason: '人话，可直接显示',
  suggested: 'none' | 'deprioritize' | 'avoid',
  hits: 3,                         // 窗口内命中次数
  expiresAt: '...' | null,         // degraded 15 分钟 / faulty 30 分钟 / notice null
  detail: { ... }                  // 附加事实，仅供排查，不必消费
}
```

`notice` 级的 `expiresAt` 是 `null`——它是历史留痕，不是故障。

---

## 四、几个已经处理掉的坑

**黑名单不会永久。** 所有故障信号都带 `expiresAt`（degraded 15 分钟 / faulty 30 分钟）。
即使「恢复」那条信号丢了（进程重启、兜底路径没走到），到期也会自动失效。
最坏情况是它多试一次坏站，而不是永远不用好站。

**恢复信号一定会发。** 改道复检连续正常、探针重新通过，都会发 `active: false`。
不发的话你那边只会收到「有问题」，永远收不到「好了」，那家站再也没机会被选中。

**同一供给同一类问题只留一条。** 去重键是 `kind::offerId`，重复发生时更新 `hits`
而不是插新记录——否则一次故障会堆出一串几乎一样的信号。

**临时改道已经并进快照。** `faultSnapshot()` 会把「某家正被守卫改道」也算成
`degraded`。否则你只看信号的话会漏掉这个事实，又把流量派回去。

---

## 五、如果你那边想自己判断严重度

判定规则是纯函数，可以直接引用来复用同一套口径（不建议另写一份，两边会漂）：

```js
import { judgeEmptyFault } from '../core/fault-signal.js'
judgeEmptyFault({ hits: 3, recovered: true, hadFallback: true })
// → { level: 'faulty', suggested: 'avoid', broadcast: true, reason: '...' }
```
