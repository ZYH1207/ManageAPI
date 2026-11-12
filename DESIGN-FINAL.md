# 计价翻修最终设计（数据验证后定稿）

> 基于真实账单 3.2 亿 token 的验证结论。不是拍脑袋的方案。

---

## 一、数据验证结论汇总

| 指标 | 结果 | 出处 |
|---|---|---|
| 缓存占输入 | **94.9%** | 全库 30.4 亿 token |
| `offerCost` 估算偏差 >30% | **23/24 条** | 与账单实付比对 |
| `paidPerMtok` 跨天波动 >30% | **18/20 条** | 90% 不稳定 |
| `effIn` 跨天波动 <5% | **13/20 条** | 65% 稳定 |
| 台账倍率 vs 账单倍率 一致 | **25/27 条** | 倍率基本可信 |

**核心洞察：`paidPerMtok` 被缓存命中率污染，`effIn/effOut` 才是纯价格。**

---

## 二、三个指标的正确定位

```
effIn / effOut        = baseIn/baseOut × rate
                        ↑ 纯价格，不含缓存，跨天稳定，可用于排序

paidPerMtok           = actualCost ÷ totalTokens
                        ↑ 含缓存效应，波动可达 16 倍，只用于"我花了多少"

officialCost          = benchmark × fx
                        ↑ 原厂参考，15/32 条不准，只作折扣分母
```

### 关键：折扣比的分子分母必须同口径

```js
❌ 错：paidPerMtok / officialCost      // 分子含缓存，分母不含
✅ 对：effIn / (officialIn × fx)       // 两边都不含缓存
```

---

## 三、决策系统的数据流

```
┌─ 供给级价格（用于排序、路由、决策）─────────┐
│  优先：账单 effIn/effOut（实测，稳定）        │
│  降级：offerCost（估算，标"估算"）            │
│  降级：null（标记"未定价"）                  │
└──────────────────────────────────────┘
           ↓
┌─ 展示层（用户看的数字）──────────────────┐
│  挂牌价：effIn/effOut      [实测/估算]   │
│  原厂价：officialCost                  │
│  折扣比：effIn / officialIn             │
│  我花了：paidPerMtok + 总花费            │
└──────────────────────────────────────┘
```

---

## 四、实施清单

### P0 · 账单数据接进比价模块（纯增字段，不改原逻辑）

`core/price-board.js` 的 `buildPriceBoard()` 增加参数 `ledgerIndex`：

```js
// 新增：每个 (站,分组,模型) 的价格快照
ledgerIndex = Map<`${pid}|${group}|${model}`, {
  effIn, effOut, effCacheRead,      // 实测单价（稳定）
  paidPerMtok,                       // 实付（仅供参考）
  rate,                              // 实测倍率
  tokens, requests, days,            // 样本量
  lastDay,                           // 数据新鲜度
}>
```

每行（`sites[]` / `allLines[]`）新增：

```js
priceSource: 'ledger' | 'benchmark' | 'none',
effIn, effOut,                       // 实测（有则用）
paidPerMtok,
officialIn, officialOut,             // 原厂
officialRatioIn, officialRatioOut,   // 折扣比
ledgerSamples: { tokens, days },
```

**原则：不删任何现有字段，只加。**

### P1 · 排序改用实测价

`buildPriceBoard` 的排序键从 `blendedCnyPerMtok` 改为：

```
rankPrice = effIn !== null ? effIn×w + effOut×(1-w) : blendedCnyPerMtok
```

并在输出里标明这一行用的哪个。

### P2 · 比价页 UI

折叠行增加两列：

```
模型               实付/M   挂牌/M   原厂    折扣   实测
gpt-6.1-sol(秋)    0.0468   0.094/0.47  ¥53.50  0.9‰   3天/8.2M tok
```

展开行的每条线同样显示来源标记。

### P3 · 决策页

- `officialPct` 改用 `effIn / officialIn`（同口径）
- 候选行加数据来源徽章
- 价格列显示"实测/估算"

### P4 · 币种校准建议

只输出建议清单，不自动改。

---

## 五、必须遵守的红线

1. **不修改 `offerCost` 的语义** —— 它算挂牌价，是对的
2. **不用 `paidPerMtok` 排序** —— 它被缓存污染
3. **每行必须标来源** —— 用户看不到就是被误导
4. **样本量 < 1000 token 的记录不参与排序** —— 噪音
5. **跨天波动 >30% 的标记 "波动中"** —— 站方可能调过价

---

## 六、验证方法

每改一步都要过：

1. 单元测试（`.test/check-price-board.mjs` 扩展）
2. 真实库冒烟（106 个模型行不出错）
3. **抽样人工核对**：挑 3~5 个模型，手算一遍对不对
4. **前端渲染验证**：CDP 截图确认

---

## 七、这一轮不做的事

- ❌ 自动 probe 全量模型
- ❌ 自动改 benchmark 币种
- ❌ 改 offerCost / officialCost 算法
- ❌ 接入"预测缓存率"这类启发式（缓存率是用户行为，不该被系统假设）
