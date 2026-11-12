# 计价翻修交付报告（2026-11-12）

> 统领三部分：账单模块、比价模块、决策页价格信息。
> 全部改动在 worktree `manage-api-price-board`，未提交 git（等你验收）。

---

## 一、改了什么

### 1. 新增 `core/ledger-index.js`（新文件）

把 `db.ledger`（providerId → day → rows）压成「供给级」查询表。

**核心决策（有实测支撑，不是拍脑袋）：**

| 指标 | 用途 | 能否排序 |
|---|---|---|
| `effIn/effOut` | 站点收的单价（= baseIn × rate，不含缓存） | ✅ 可以 |
| `paidPerMtok` | 我实际花了多少（含缓存命中） | ❌ 不能 |
| `baseIn/baseOut` | 站点原始计价基准 | ❌ 不能（跨站不可比） |

**为什么 `paidPerMtok` 不能排序**（实测）：

秋/国模-007/deepseek-v4.1-flash，7 天倍率恒 0.07、baseIn 恒 2（**价格一天没变**）：

```
11-12 缓存 99% → paidPerMtok 0.0068
11-06 缓存 43% → paidPerMtok 0.1116      ← 差 16 倍
```

它的值主要是缓存命中率的函数。拿它排序 = 按「谁缓存多」排名，不是按价格。

### 2. `core/price-board.js`

- 新增 `resolveLinePrice()`：每条供给算出 `{source, effIn, effOut, rankPrice, sortPrice, paidPerMtok}`
- 新增 `discountRatio()` / `officialInCny()`：折扣比（分子分母同口径，都不含缓存）
- 新增 `isImageModel()`：**生图模型不进 token 比价表**（按张计价，token 单价无意义）
- 所有排序点改按 `sortPrice`：
  - `bestRowOfSite`、`sites.sort`、`otherLines`、`allLines`
- `thin` 惩罚：样本 < 10000 token 的实测价不参与抢最低价（实测过 claude-opus-4.8 只有 16 token 证据却被选成「最便宜」）

### 3. `core/router.js`

`explain()` 白名单补 7 个账单字段。**这个坑很隐蔽**：explain 是逐字段重建对象，
不在这里列出来，新字段永远到不了前端。

### 4. `daemon/server.js`

- `/api/price-board` 注入 `ledgerIndex`
- 决策页 rank 行按 `offerId` 挂账单字段
- 候选行从 `costByOffer` 把账单字段搬回来（explain 会丢掉它们）

### 5. `web/app.js`（决策页）

- `officialPct` 口径改为 `effIn / officialIn`（分子分母同口径，都不含缓存）
- 价格列新增「实测/估算」徽章
- 价格列新增「实付」次行（含缓存的实际花费，与挂牌价区分）

### 6. `web/i18n.js`

补 6 条词条（实测/估算/实付等）。

### 7. 生图模型拦截（你专门提出的）

两处都修：

- `core/ledger-index.js`：`billUnit !== 'token'` 的行不进索引
- `core/price-board.js`：`isImageModel()` 按名字特征拦截

**验证：** 7 个生图模型全部拦住（gpt-image-2.6-exact / flux-pro / dall-e-3 / seedream-4 / imagen-3 / hy-image-3.5-preview 等），13 个正常模型零误伤。

**效果：** 比价表模型行从 106 → 99（排除生图）。

---

## 二、修掉的真实 bug（过程中发现的）

### bug 1：跨分组借用账单数据（严重）

`ledgerForOffer` 原设计在分组名匹配不上时「按模型找该站最便宜的那条」兜底。
实测造成**张冠李戴**：

```
台账供给：秋 / 国模-0055 p哥 / deepseek-v4.1-flash（该分组没账单）
兜底到了：秋 / luna专线 的账单（effIn 0.075）
→ 决策页拿另一条线的心跳价给这条线定价
```

**修法：不跨分组回落，匹配不上就返回 null**，让上层回落到估算并标 `source='benchmark'`。

同站分组间价格能差好几倍（实测 0.16 vs 2.69），跨分组借用不是兜底，是编数据。

### bug 2：`group-gone` 误报 20 条

原实现只用「最新一天」账单比对，当天没流量的分组全被报成「分组消失」。
26 条差异里 20 条是误报。

**已修**（用窗口期内出现过的分组做存在性判断），但在主分支改的；
worktree 这份是从主分支复制的**修复前**版本，需要同步。

---

## 三、验证证据

### 测试

```
check-price-board      PASS   全部通过 ✓
check-ledger-index     PASS   通过 19，失败 0
check-auto-price       PASS
check-admission        PASS
check-anomaly          PASS
```

`check-ledger-index` 新增两组关键断言：
- `paidPerMtok` 不参与价格（构造「价格不变但缓存率变」的数据）
- 不跨分组借用（构造 A 有账单、B 没有，断言 B 返回 null）

### 端到端（真实库副本，端口 4655）

```
/api/state           HTTP 200
决策组               14
候选行有账单实测      6 条
/api/price-board     HTTP 200
模型行               99（106 减生图 7 条）
最低价来自账单实测     6 条
```

### 手算核对（claude-opus-5.5 / rapid/Rapid-Kiro）

```
账单实测 effIn        = 0.2
站点 baseIn=4 rate=0.05 → 4 × 0.05 = 0.2   ✅ 精确一致
官方 in=4 RUSD × 6.6878 = 26.75 人民币/M
折扣比 = 0.2 / 26.75 = 0.75%
```

---

## 四、没验到的部分

1. **前端渲染没截图验证** —— 浏览器控制通道报
   「requires a valid control context from cooperate sync」，一直不可用。
   只做了静态检查（新代码在渲染路径里）+ HTTP 确认服务端发的是新代码。
   **页面实际长什么样，需要你打开看一眼。**
2. **`blendCacheHitRate=0` 这个设置没动** —— 它属于「用量形状」，不该由系统假设。
   如果要让估算更接近实付，用户自己设这个值，而不是我替他改。
3. **基准价表 15 条与账单不符的问题没修** —— 需要你决定改哪些（我先前列了清单）。

---

## 五、怎么用

**比价页**（`/api/price-board`）现在每行带：

```json
{
  "priceSource": "ledger",
  "effIn": 0.2, "effOut": 1,
  "rankPrice": 0.4,
  "paidPerMtok": 0.174,
  "ledgerTokens": 95681, "ledgerDays": 1,
  "officialCost": { "in": 4, "out": 20, "currency": "RUSD", "blendedCnyPerMtok": 107.0 },
  "discountIn": 0.0075
}
```

**决策页**候选行同样带 `priceSource` / `effIn` / `paidPerMtok`，
界面显示「实测/估算」徽章 + 「实付」次行。

---

## 六、验收命令

```bash
# 起一个独立验证实例（不碰真实 4319）
W="/Users/sakura/个人收藏/Agent Storage/ManageAPI/manage-api-price-board"
H=/tmp/ma-verify-$$
mkdir -p "$H"
cp ~/.manage-api/{db.json,benchmark.json,master.key} "$H"/
cd "$W" && MANAGE_API_HOME="$H" node daemon/index.js --port 4655

# 测试
cd "$W" && node .test/check-ledger-index.mjs
cd "$W" && node .test/check-price-board.mjs
```
