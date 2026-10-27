# ManageAPI

**Manage the AI relays you bought: find out which is cheapest, catch the ones cutting corners, and reach every site through one key.**

Zero dependencies, no build step, fully local. One Node process plus one web page — your data never leaves the machine.

[中文](README.md) · **English**

![Overview](docs/screenshot-overview-en.png)

> The UI is bilingual (button to the left of the bell icon, top right); your choice is remembered in the browser.

---

## What it solves

If you buy from several AI relays, three things get in the way:

1. **You cannot tell which is cheaper.** Some quote `$2.5/M`, some quote "0.4×", some bill per 1K tokens, others per request or per group. Comparing them means normalising the units first.
2. **You cannot tell whether quality dropped.** The relay is alive, but it quietly forwards your requests to a cheaper model or lowers `max_tokens` so the answer gets cut short. Health checks never catch this.
3. **Switching is tedious.** Every client needs its own base URL and key, and you have to edit each one whenever a site gets cheaper.

ManageAPI addresses these three separately: **price comparison**, **probing**, and a **gateway**.

---

## Screens

Nine pages on the left, one job each:

| Page | Purpose |
|---|---|
| **Overview** | Headline conclusion, key stats, sites needing attention, site ranking |
| **Sites** | Balance trend, ratio changes, upstream notices; relay and key management (layout inspired by [bejix/upstream-ops](https://github.com/bejix/upstream-ops)) |
| **Free** | Free models and platform credits, kept out of paid comparison |
| **Pricing** | The same model compared across sites, prices editable inline |
| **Routing** | Candidate order for each model, with manual overrides |
| **Probes** | Fingerprint / truncation / billing / cache checks |
| **Gateway** | One endpoint for all traffic, with a routing log |
| **Usage** | Tokens by day / key / model / site |
| **Benchmarks** | Defaults for the base price (auto-filled on import) |

> The site-card layout (channel cards, group chips, toolbar) is inspired by [bejix/upstream-ops](https://github.com/bejix/upstream-ops): only the layout is borrowed; data and interactions are implemented here. Thanks to the author.

The top bar holds notifications, the docs entry and the language dropdown; the sidebar bottom has three fixed entries: Contact, Dark mode, Collapse.

Dark mode (navy + mint):

![Dark mode](docs/screenshot-dark.png)

The UI is bilingual; switch it from the top-bar dropdown. The choice is stored in `localStorage` and defaults to your browser language.

![Language switch](docs/screenshot-lang.png)

![English UI](docs/screenshot-pricing-en.png)

The **Docs** button in the top bar opens the built-in manual (one copy per language, with a table of contents):

![Docs](docs/screenshot-help.png)

---

## Quick start

Requires **Node.js ≥ 20**. No dependencies, no `npm install`. Runs on Windows, macOS and Linux — the only platform-specific code is the "open browser" call.

```bash
git clone https://github.com/ZYH1207/ManageAPI.git
cd ManageAPI
node daemon/index.js
```

Open <http://127.0.0.1:4319/>.

Optional flags:

```bash
node daemon/index.js --port 5000   # pick a port; falls through if taken
node daemon/index.js --open        # open the browser after start
```

The first run creates `~/.manage-api/` with an encryption key.

### Five steps

1. On **Sites**, add a relay (the base URL must end with `/v1`) and paste its key
2. Click **One-click sync**: models, balance and group detection run in sequence (without a token group detection is skipped)
3. If no group was detected, click **Import ratios** and pick the group you actually bought
4. For models without an official price, add one on **Benchmarks**, or load the built-in list
5. Run a probe on **Probes** so the tool knows which sites to trust

From then on the gateway picks sites for you, and you can override the order on **Routing**.

---

## Core idea: groups and ratios

A relay charges:

```
actual price = model base price × group ratio
```

A ratio of `0.1` means 90% off, `0.3` means 70% off.

**A "group" is the tier you bought.** One site often has a dozen — discount pool, Pro pool, enterprise channel, per-request billing, a dedicated expensive group for one model. The same model can differ several times over between groups, in both base price and ratio.

So you have to tell the tool which group you are in: the API only says which models a key can call, never which tier it belongs to — that is a commercial fact, not a technical one.

### Import ratios

Click **Import ratios** on a site card and it lists every group, each with its ratio and how many of your models it covers, usable ones first:

![Pick a group](docs/screenshot-groups.png)

Pick the one you bought → **Apply ratios** → the ratio is written to every model below, and Pricing / Routing / the gateway update immediately. The chosen group is stored on the key, so next time it is preselected.

Where the data comes from: with a token it reads `/api/v1/channels/available` (the richest source, **no model plaza required**); without one it falls back to `/api/v1/model-plaza`.

### Custom ratios and restore

![Sites](docs/screenshot-providers.png)

On the group ratio rows:

- **From site** — matches what the site publishes, untouched
- **Custom** — you edited it; the site's original value is shown next to it
- **Mixed** — models in this group no longer share one ratio (some were edited individually)
- **Restore** appears once you customise; **Restore all to site values** resets the whole site

Custom ratios have a real use: if a site claims 0.15 but a usage check shows you are effectively paying what 0.18 would cost, set 0.18 so comparisons stay honest.

### Deleting a group

A group is not an entity of its own — it is just a name on supply rows and keys — so what deleting it does depends on where it came from:

- **A group created by “+” on the Pricing page** — no key backs it, so its model rows are deleted along with the group
- **A group on a key** — the key stays; only the group assignment is cleared. Click **Pick group** on that key to import the group again; its models and ratios come back (the backend re-pulls the key's models, no manual sync needed)

Three entry points: the small **trash icon** on a group chip on the site card, the **Delete** button at the end of each group-ratio row, and the **delete button** in the Pricing table's group column.

### Pricing table: ratio or price

Every supply row has a **Mode** column, one of two:

- **Ratio** — the input/output boxes hold the **base price**; actual price = base × ratio (both the ratio and the price boxes stay editable)
- **Price** — the input/output boxes are the final price; the ratio box is disabled

The benchmark table is not a higher-priority source: it only auto-fills the base price when a site is imported, on exactly the same footing as a hand-typed number — your edit wins.

Switching modes converts between base and final price automatically, so the effective price does not jump.

Cache hit rate is its own column, taken from the latest probe; rows never probed show "—". The small text under blended cost is the off-peak price.

### Benchmarks

The benchmark table is the **default for the base price**: it auto-fills each row's input box on import and plays no part in the arithmetic afterwards — the actual price is still base box × ratio. Edit the box directly if you want a different number; the benchmark will not overwrite it.

Three sources:

| Source | What it does |
|---|---|
| **Import official prices** | Pulls the site's model base prices; fills gaps only, never overwrites |
| **Use this site's prices** | Takes one trusted site's existing prices as the baseline |
| **Load built-in prices** | A bundled list for cold start; **prices change often, verify** |

Built-in entries only fill gaps and are marked `reference:` in the Source column.

At the bottom of this page there is a **USD→CNY rate** field. It only affects sites priced in USD; CNY-priced sites are unaffected. It lives here because it is a price-conversion parameter you rarely touch.

> Note: the model plaza also exposes a field called `official_pricing`, but several sites fill it with one placeholder value for everything (e.g. every deepseek model reporting 0.15), so the tool ignores it and uses `pricing` (the site's base price) instead.

![Benchmarks](docs/screenshot-benchmark.png)

---

## Detecting degraded service

The usual problem is not a dead relay — it is "still works, but no longer the same model".

Each probe sends **five requests** per model:

| What relays do | How it is detected | Verdict |
|---|---|---|
| **Swap the model** | Demand the exact output `{"fp":"7Q2K","calc":391}` | Does the JSON match exactly? |
| **Lower max_tokens** | Ask it to count to 120 while requesting `max_tokens: 1500` | Highest number < 120, or `finish_reason=length` with far fewer tokens |
| **Inflate usage** | Compare `usage.prompt_tokens` with the real prompt size | More than 3× expected gets flagged |
| **Cache** | Send the same long prefix twice | Recorded and shown, not scored |
| **Self-identification** | Ask "what model are you" | **Recorded, never scored** — models misreport constantly |

All requests stream, so TTFT comes for free.

![Probes](docs/screenshot-probes.png)

Click any row to expand it: you see how the score was computed and the raw evidence from the last probe.

### How scoring works

Two dimensions, kept **separate**:

```
availability = (successful probes + successful real requests) / (successes + real outages)
integrity    = fingerprint pass × 0.5 + not-truncated × 0.3 + normal billing × 0.2
quality      = availability × integrity
```

**Failures are attributed before they count** (`core/failure.js`):

| Upstream response | Counts as outage? | Handling |
|---|---|---|
| 5xx, timeout, connection failure, non-JSON body | yes | lowers availability |
| Out of balance / over budget (402, 403 `INSUFFICIENT_BALANCE`) | no | 30-minute cooldown |
| Rate limited (429) | no | 5-minute cooldown |
| Model not in this group (404 `model not supported` / `not in group`) | no | 60-minute cooldown |

The "no" rows are not instability — that supply simply cannot serve right now (top up, wait out the limit, pick another group). Counting them as outages paints a wall of red for sites that only ran out of credit and drowns the real failures. Cooling supplies are skipped by routing and come back automatically after the cooldown or after one successful call; the UI labels them "out of credit / rate limited / model unavailable · cooling down" rather than "unstable".

Below 0.8 on either dimension means unusable; by default it sinks to the back and is only a last resort.

**How integrity (is the answer trustworthy?) is judged** — raw evidence only, never an average:

| Check | Verdict rule | Why |
|---|---|---|
| Fingerprint mismatch | **single shot** | swapping is deterministic; a network glitch does not change the answer into a different number |
| Truncated output / inflated usage | **2 samples** | one may be a cut stream rather than a broken site |
| Real-response anomalies (empty answer / inflated billing) | **5 samples, >20% bad** | the gateway can only verify these two objective signals |

Displayed pass rates are **smoothed** as `(pass+1)/(samples+1)`: with little evidence they stay near 100% and only converge once samples accumulate. A single odd probe therefore costs a few percent of quality instead of halving it and doubling the effective cost — **the penalty must match the strength of the evidence**.

> **Want suspicious sites to be usable?** The Probes page has an **Allow suspicious supplies** switch. When on,
> supplies flagged for fingerprint mismatch / truncation / inflated usage regain admission and compete on effective
> cost like everything else. Half the quality doubles the cost, so only a large enough discount wins, but they can
> genuinely return swapped or truncated answers; the trade-off is yours. The TTFT gate is separate and unaffected.

States: `healthy`, `degraded`, `unstable` (real outages > 20%, at least 3 samples), `inconclusive` (failures but fewer than 3 samples: not routable, not flagged), `stale`, `unknown`.

### Scores expire

Six hours by default, adjustable on the Probes page. An expired score is not used — **stale data is more dangerous than no data**, because it makes you think you already checked.

**"Expired" is about the last piece of usable evidence, not the last probe.** Probes and real calls are both evidence; whichever is newer wins:

- not probed for 7 hours, but called for real 10 minutes ago -> **not expired**, and a failure there surfaces honestly as `unstable` instead of being hidden behind "expired"
- not probed for 7 hours and no real traffic at all -> expired
- the traffic record itself is older than its 1-hour window -> not evidence (that is last round's history, not the current state)

The two clocks must agree: validity is "how many probe rounds may be missed", so **the probe interval may not exceed half the validity** (rejected when saving), otherwise every supply would expire between two rounds — exactly the trap that setting both to 6 hours fell into.

That is also why scheduled probing exists: without it, scores eventually all expire and routing degrades into picking the cheapest.

Auto-probe can be set to an interval (1 hour by default, can be off). The scheduler wakes every minute and picks supplies that are due (up to 10). Using "check + due" instead of a long timer means config changes apply instantly and a slow probe never makes the next round late.

The interval is **adaptive**: healthy supplies use your interval, everything else (unhealthy / inconclusive / expired / integrity suspicions / never probed) is re-probed at a third of it (10 minutes minimum) so problem sites get fresh evidence quickly. Cooling supplies are skipped. Probes run 4-way concurrent so one slow round cannot stall for tens of minutes.

### Sample count sets confidence

`healthy` means "nothing wrong given the evidence we have", not "verified reliable" — one successful sample and ten successful samples both read healthy, with very different certainty. So every supply carries a **confidence** level:

| Samples (probes + real calls) | Confidence |
|---|---|
| >= 10 | high |
| 3 - 9 | medium |
| < 3 | low (the UI shows "N samples") |

Confidence is disclosure only, it never changes routing — few samples do not mean unusable, just not yet measured enough.

### Real traffic counts too

Probes are synthetic and cannot see "5xx at peak hours". Every forwarded request also counts toward that site's availability, and its failures are attributed the same way (credit/rate-limit failures do not count). In practice: a site with healthy probes but three consecutive real failures drops to 63% availability, turns `unstable`, and gets skipped.

Traffic counts roll on a 1-hour window, validated on both the write and the read side — a site that broke in the morning and recovered in the afternoon should not be punished all day.

The gateway also samples two objective quality signals on **successful real responses**: **empty answer** (200, finished normally, but no content at all) and **inflated billing** (reported `prompt_tokens` more than 4× the estimated request size — gross inflation only). Fingerprint and truncation need a controlled prompt, so only probes can check those. Samples only affect scoring at 5 samples / 20% bad; below that they are recorded but not judged.

---

## Effective cost: why divide

```
effective cost = nominal price ÷ quality
```

It reads as "what you actually pay for one trustworthy answer".

Why not a weighted sum? Because "10% cheaper but 30% dumber" can still win a weighted sum, while dividing doubles the cost when quality halves — no discount outruns that. The formula is also explainable.

That is exactly how the Routing page sorts: the ¥0.65 site loses to the ¥4.23 site because it was judged suspicious:

![Routing](docs/screenshot-decision.png)

### Manual override

Fully automatic has one gap: **you cannot say "I want this one"**. So each row has ↑↓.

Manual order only affects rows that get routed at all:

- Slow / suspicious / unstable supplies never enter routing and cannot be dragged up — **admission is a hard rule, not an opinion** (turn on "Allow suspicious supplies" on the Probes page to readmit suspicious ones; the TTFT gate is unaffected)
- Expired / unprobed supplies are fallbacks behind healthy ones and do not take part in manual ordering
- New supplies not in the manual order are appended by automatic sort
- **Back to auto** clears the manual order

### First-token latency (slow tier limit)

Latency does **not** participate in ranking — different units, and folding it into a score distorts things. Instead there is an admission line: **Slow tier limit** at the top of the Routing page. Supplies above it are marked "Slow" and treated like unavailable ones: never routed, marked in the pricing table, and they lose the "Cheapest" badge.

- 20 fixed tiers (1000–20000ms), snapped at the 500ms boundary: 8600 → 9000, 8499 → 8000, 8500 rounds up
- Each tier carries a speed level (very fast / fast / normal / a bit slow / slow) — a label for humans; every decision compares raw milliseconds
- **Empty = no limit**, i.e. the original price-only mode
- If every candidate exceeds the gate, the gateway does not fall back: it returns `400 upstream_too_slow`

### Cache hit rate is shown, not priced in

Relays typically charge 10–20% for cached input tokens. Detection sends the same 1200+ token prefix twice and reads `cached_tokens` on the second call (with a 1.5s gap so the upstream can write it).

**It does not affect ranking.** The benefit depends on your usage: if your prefixes never repeat the hit rate is 0 and that "discount" means nothing. Sorting by list price guarantees worst-case cost; cache is a bonus.

---

## Free tier: a separate pool

Free relay models and free credits from agent platforms live on their own page, **excluded from paid comparison and from automatic routing**.

![Free page · relay pane](docs/screenshot-free-relay.png)

Two panes behind a top switcher:

| Pane | What it shows | Gates |
|---|---|---|
| **Free relay models** | Models whose actual price is 0, with a quota bar | fingerprint / truncation / quota used up / score expired |
| **Platform credits** | Accounts and remaining credits on WorkBuddy / CodeBuddy / ZCode, … | quota used up / session expired |

**Why they stay separate**: paid supplies share one comparable metric — effective cost. On the free side the price is always 0, so `0 ÷ quality` is always 0 and any weighted ranking collapses. The free side therefore uses **gates + a single sort key**: fail a gate and you are out entirely — no room for "cheap but bad".

**How to use it**:

```bash
# free only, for the whole client
base_url = http://127.0.0.1:4319/free/v1

# or mix, distinguished by model prefix
model = deepseek-v4.1-flash        # paid pool
model = free/deepseek-v4.1-flash   # free pool
```

A prefix can only *upgrade* a request into the free pool, never downgrade it back to paid, so the two entries never conflict. When the free pool runs dry the gateway returns `402 free_pool_exhausted` with each source's reset time and **never silently falls back to paid** — that would spend your money behind your back.

![Free page · platform pane](docs/screenshot-free-platform.png)

The platform pane supports multiple accounts, a daily check-in (idempotent — only one success per day) and reset countdowns. **The Check-in button only appears for platforms that implement automatic check-in**: WorkBuddy / CodeBuddy call the real endpoint and only write the ledger on success; manual platforms and ZCode have no automatic check-in, so no button appears. WorkBuddy / CodeBuddy can be connected with one click to read credits automatically, marked **experimental** — it uses the undocumented API the vendor ships to its own IDE, so a platform update may break it. When it breaks you just stop seeing numbers; nothing else is affected.

Both the Sites page and the Platforms pane ship a **preset catalogue** (SiliconFlow, ModelScope, DeepSeek, Moonshot, Zhipu, DashScope, Volcengine, OpenAI…). Pick one and the name and base URL are filled in — you only add a key. Vendors whose URL we could not confirm (AgentRouter, AnyRouter, PPIO) are left blank rather than guessed.

---

## Gateway: one key for every site

In your client:

| Field | Value |
|---|---|
| Base URL | `http://127.0.0.1:4319/v1` |
| API Key | the `sk-mapi-...` shown on the Gateway page |

Then request as usual; `model` takes the normalised name (`GET /v1/models` lists them). When you swap an upstream key, clients do not change.

![Gateway](docs/screenshot-gateway.png)

### How a site is picked

```
1. Admission: slow (over the TTFT gate) / degraded / unstable / no usable samples — never routed
   expired / unprobed — admitted, but as fallbacks behind healthy supplies (a real call is itself evidence)
2. Sort the admitted ones by effective cost (price ÷ quality), ascending
3. If the first fails, fall through to the next before responding to the client
4. Nothing admitted → 400 with the per-site reason, never a slow or suspicious substitute
```

The streaming boundary is the tricky part: **the first chunk must be read and confirmed not to be an error before response headers are committed**. Before that, switching is silent; after it, we can only end with an error.

### Response headers

| Header | Meaning |
|---|---|
| `X-ManageAPI-Provider` | Site that actually served the request (URL-encoded) |
| `X-ManageAPI-Attempts` | How many attempts it took |
| `X-ManageAPI-Quality` | Quality score of that supply |

The Gateway page logs every decision: who was chosen, the candidate order, and the failure reasons.

### Multiple keys

One key per client keeps usage attributable; a leaked key can be rotated without touching the rest. Each key can have a monthly token cap that returns 429 when exceeded.

### How usage is captured

Clients usually do not send `stream_options.include_usage`, so upstreams return no usage. The gateway **injects** the flag and then **filters out** the trailing chunk that contains only usage — the client sees exactly the same stream, but the gateway gets accurate numbers.

The cost is that streaming must be split by SSE event rather than passed through wholesale.

---

## Usage

![Usage](docs/screenshot-usage.png)

Aggregated by "day × key × site × model" into a separate `usage.json` — it is the only data that grows without bound, and mixing it into the config file would slow every write.

Tracks requests, errors, input/output tokens, cache hits, average latency and average TTFT. Four cuts: daily bars, by key, by model, by site, over 7 / 30 / 90 days.

**Only requests through the gateway are counted.** Direct calls to a site, or clients not using the gateway, are not included.

---

## Data and security

Everything lives in `~/.manage-api/`:

| File | Contents |
|---|---|
| `db.json` | Sites, credentials (encrypted), supplies, prices, probe records |
| `master.key` | AES-256-GCM key, generated on first run, mode 0600 |
| `benchmark.json` | Benchmark table, hand-editable |
| `free.json` | Free-pool platform accounts and credit ledger |
| `usage.json` | Usage aggregates (grows over time) |

Override the directory with `MANAGE_API_HOME=/path/to/data node daemon/index.js`.

**Automatic backups**: on startup and every 24 hours, `db.json`, `master.key`, `benchmark.json`, `free.json` and `usage.json` are copied into a timestamped folder under `manage-api-backups/` next to the data directory (by default `C:\Users\<you>\manage-api-backups\`). The last 30 copies are kept. Use `MANAGE_API_BACKUP_DIR` to change the location and `MANAGE_API_BACKUP_KEEP` to change the count.

**Restore**: stop the daemon, then copy `db.json` and `master.key` (plus any other needed files) back into `~/.manage-api/`. They must be restored together; a db without its `master.key` cannot decrypt any saved key.

**Single instance**: the daemon writes `daemon.lock` (PID + port) in the data directory. A second instance exits immediately instead of sharing the same data. A lock left by a crash is cleaned up on the next start when its PID is no longer alive; if you are sure no instance is running, you can delete the file manually.

The backup contains `master.key`, so treat it as sensitive: do not commit it or put it on a public drive.

**Threat model**: encryption protects against "leaked backup, file shared by mistake, accidentally committed". It does not protect against "this machine is already compromised", because the key sits in the same directory. Stronger protection needs a master password derived at startup — not implemented.

The daemon binds `127.0.0.1` only, has no authentication, and must not be exposed. **Do not bind `0.0.0.0`.**

---

## Known limitations

- **Balance is usually unreadable.** one-api's `/api/user/self` needs a "user access token" rather than an `sk-` key; many sites disable these endpoints; Sub2API's account APIs sit under `/api/v1/*` and only accept a login session. Workaround: click **Token** on the site card and paste a site login token (once per backend account, shared by the whole site). If it still fails, type the balance in — the tool never guesses.
- **Only `/v1/chat/completions` and `/v1/models` are proxied.** Embeddings, images and other endpoints are not.
- **Usage depends on the upstream returning `usage`.** A few sites do not, even when asked; those requests record 0 tokens but still count as requests.
- **Per-request supplies never enter the "cheapest" comparison.** Units are `/M` (per million tokens), `/1k`, and `/call` (the input price is the price per request); per-call and per-token are different dimensions and cannot be converted — per-call rows show "¥X/call", sort at the end of the group, and are excluded from the price spread. Monitoring estimates spend as requests × unit price.
  **The billing form is detected from the model plaza**: when its `billing_mode` is `per_request` / `image`, imported prices land as per-call, with the unit price = `per_request_price` × group multiplier (image groups use `image_rate_multiplier`) — the same arithmetic the site itself uses. Without a plaza (or when reading prices from available channels) the billing form is unknown and token pricing is assumed; you can switch the unit to `/call` manually.
- **One instance at a time.** The daemon refuses a second instance with `daemon.lock`; do not bypass the lock by starting two processes.

---

## Project layout

```
core/              Host-agnostic core (no framework dependencies)
  store.js           Data directory, atomic JSON writes, credential crypto
  backup.js          Daily automatic backup (db + master.key + side data)
  inventory.js       Sites / credentials / supplies CRUD, group ratios, gateway keys, routing log
  pricing.js         Cost normalisation, sorting, headline generation
  benchmark.js       Benchmark table
  model-prices.js    Built-in reference prices
  providers.js       Outbound calls: model list, balance, available channels / model plaza
  model-plaza.js     Model plaza parsing (group ratios + base prices)
  probe.js           Fingerprint / truncation / billing / cache probes
  score.js           Short-term scores (with TTL) and long-term scores (time decay)
  failure.js         Failure attribution: outage vs credit / rate limit / model missing (with cooldowns)
  quality-signals.js Real-response quality sampling: empty answer / inflated billing (token estimate)
  router.js          Candidate filtering and ordering
  usage.js           Usage aggregation (day × key × site × model)
  free.js            Free-pool detection: actual price = 0, free/ prefix, entry parsing
  quota.js           Free-quota ledger (requests / tokens / credits, day / month windows)
  rank-free.js       Free-pool gates and ordering (quality gates, never sorts)
  platforms/         Platform credits: connector interface, manual connector, ledger, own free.json
  catalog.js         Preset catalogue of common sites / platforms
  balance.js         Vendor balance adapters (SiliconFlow / DeepSeek / Moonshot)
  monitor.js         Monitor data: balance trend, ratio changes, notices, alerts, cooldowns

daemon/            Local HTTP server + gateway (same port)
  index.js           Startup, port selection, open browser
  instance-lock.js   Single-instance lock: PID + port, stale locks cleaned up
  server.js          HTTP routes, gateway forwarding, SSE splitting
  probe-runner.js    Probe executor (manual and scheduled)
  monitor-runner.js  Collector: balance / group ratios / notices
  scheduler.js       Scheduled probing and collection

web/               Frontend (vanilla JS, no build, no framework)
  index.html         Structure and the help document (zh + en)
  app.js             All rendering and interaction
  i18n.js            Language switch and the English dictionary
  free-relay.js      Free page · relay pane
  free-platform.js   Free page · platform pane
  style.css          CSS-variable dual theme

.test/             Tests and screenshot tooling
  mock-upstream.mjs  Fake relay (MODE=good|degraded|truncated|fail)
  run-*.mjs          End-to-end scripts
  seed-showcase.mjs  Generates the demo data used for README screenshots
  capture-shots.mjs  Headless Chrome screenshots (SHOT_LANG=en for English)
  check-lang.mjs     Round-trip check for the language switch
  check-free-relay.mjs   Free-pool gates and quota self-check
  check-free-platform.mjs Platform CRUD / idempotent check-in / ledger self-check
  check-workbuddy-quota.mjs Quota semantics: package vs per-cycle balance, same-tenant detection
  check-routable-offers.mjs Live-offer filter self-check: paused/ignored/delisted stay out of routing and probes
  check-group-delete.mjs Group deletion self-check: orphan groups go with their rows; key groups keep the key and can be re-imported
  dump-strings.mjs   Dumps every Chinese string in the UI, as a translation checklist

docs/              README images + design docs
  dsh-plugin-plan.md DSH plugin plan (feature list and extension points)
  free-api-plan.md   Free-tier plan (free relay models + platform credits)
```

`core/` has no host dependencies and can be reused on its own.

---

## Development

No build step — edit and refresh. `daemon/index.js` has no file watcher, so restart it after backend changes.

### Running tests

The monitor suite is self-contained — it starts its own fake upstreams and server, then exits:

```bash
node .test/run-monitor.mjs
```

The end-to-end probe test needs three fake relays and an instance pointing at them (`run-e2e.mjs` talks to port 4399):

```bash
# terminals 1-3: three fake relays with different defects
MODE=good PORT=5101 node .test/mock-upstream.mjs
MODE=degraded PORT=5102 node .test/mock-upstream.mjs
MODE=truncated PORT=5103 node .test/mock-upstream.mjs

# terminal 4: separate data dir, don't pollute your own
MANAGE_API_HOME=/tmp/e2e node daemon/index.js --port 4399

# terminal 5
node .test/run-e2e.mjs
```

`MODE` can be `good`, `degraded` (swapped + inflated), `truncated` (cut off), or `fail` (every chat call returns 503 — used by `run-gateway.mjs` as the "cheap but broken" relay). The gateway end-to-end test (routing, failover, streaming, auth) reuses the same setup with 5103 switched to `MODE=fail`, then runs `node .test/run-gateway.mjs`.

Additional self-contained checks:

```bash
node .test/check-routable-offers.mjs # paused/ignored/delisted offers stay out of routing and probes
node .test/check-group-delete.mjs    # orphan group deletes with its rows; key-backed group keeps the key
```

### Checking the language switch

After touching UI copy, run this to confirm switching to English and back leaves nothing behind:

```bash
chrome --headless=new --remote-debugging-port=9222 about:blank &
node .test/check-lang.mjs
```

### Regenerating README screenshots

```bash
MANAGE_API_HOME=/tmp/showcase node .test/seed-showcase.mjs
MANAGE_API_HOME=/tmp/showcase node daemon/index.js --port 4319

# another terminal
chrome --headless=new --remote-debugging-port=9222 about:blank
node .test/capture-shots.mjs                 # Chinese
SHOT_LANG=en node .test/capture-shots.mjs    # English
```

Site names in the demo data (云雀 / 星链 / 极光 / 苍穹) are entirely fictional.

---

## Roadmap

- **More upstream types** — optimised for one-api / new-api / Sub2API; other self-hosted gateways need manual prices
- **Per-request billing** — currently token-based only
- **Master-password key derivation** — stronger local key protection
- **Free-tier pool** — collect free relay models and free credits from agent platforms, on its own page with its own ranking, kept out of paid price comparison. See [`docs/free-api-plan.md`](docs/free-api-plan.md)
- **DSH plugin form** — more than a sidebar: register as a DSH provider so every real agent turn takes part in routing and feeds back into scoring. See [`docs/dsh-plugin-plan.md`](docs/dsh-plugin-plan.md)

---

## Acknowledgements

- [bejix/upstream-ops](https://github.com/bejix/upstream-ops) — the site-card layout (channel cards, group chips, toolbar) is inspired by it; only the layout is borrowed, data and interactions are implemented here. Thanks to the author.

## Feedback

- Issues: <https://github.com/ZYH1207/ManageAPI/issues>
- QQ group: 361801207
- Email: <2385377554@qq.com>
- Blog: <https://zyh1207.github.io/>

## License

[MIT](LICENSE)
