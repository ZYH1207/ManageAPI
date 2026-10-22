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

Eight pages on the left, one job each:

| Page | Purpose |
|---|---|
| **Overview** | Headline conclusion, key stats, sites needing attention, site ranking |
| **Sites** | Record relays and keys, sync models, import group ratios |
| **Pricing** | The same model compared across sites, prices editable inline |
| **Routing** | Candidate order for each model, with manual overrides |
| **Probes** | Fingerprint / truncation / billing / cache checks |
| **Gateway** | One endpoint for all traffic, with a routing log |
| **Usage** | Tokens by day / key / model / site |
| **Benchmarks** | The baseline that ratios convert against |

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
2. Click **Sync models** to fetch what it sells
3. Click **Import ratios** and pick the group you actually bought — ratios fill in automatically
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

### Benchmarks

Ratios need something to convert against. Three sources:

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
availability = (successful probes + successful real requests) / all samples
integrity    = fingerprint pass × 0.5 + not-truncated × 0.3 + normal billing × 0.2
quality      = availability × integrity
```

Below 0.8 on either dimension means unusable; by default it sinks to the back and is only a last resort.

> **Want suspicious sites to be usable?** The Probes page has an **Allow suspicious supplies** switch. When on,
> supplies flagged for fingerprint mismatch / truncation / inflated usage / expired scores are no longer pushed back —
> they compete on effective cost like everything else. Half the quality doubles the cost, so only a large enough
> discount wins, but they can genuinely return swapped or truncated answers; the trade-off is yours. The TTFT limit
> is separate and unaffected.

States: `healthy`, `degraded`, `unstable`, `stale`, `unknown`.

### Scores expire

Six hours by default, adjustable on the Probes page. An expired score is not used — **stale data is more dangerous than no data**, because it makes you think you already checked.

That is also why scheduled probing exists: without it, scores eventually all expire and routing degrades into picking the cheapest.

Auto-probe can be set to an interval (1 hour by default, can be off). The scheduler wakes every minute and picks supplies that are due (up to 10). Using "check + due" instead of a long timer means config changes apply instantly and a slow probe never makes the next round late.

### Real traffic counts too

Probes are synthetic and cannot see "5xx at peak hours". Every forwarded request also counts toward that site's availability. In practice: a site with healthy probes but three consecutive real failures drops to 63% availability, turns `unstable`, and gets skipped.

Traffic counts roll on a 1-hour window — a site that broke in the morning and recovered in the afternoon should not be punished all day.

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

Manual order only affects rows that are equally usable:

- Untrusted / too slow / expired supplies sink to the bottom by default and cannot be dragged up — **availability is a hard rule, not an opinion** (turn on "Allow suspicious supplies" on the Probes page if you want them to compete)
- New supplies not in the manual order are appended by automatic sort
- **Back to auto** clears the manual order

### First-token latency

Latency does **not** participate in ranking — different units, and folding it into a score distorts things. Instead there is an optional ceiling: supplies slower than the limit are excluded, marked "Too slow", and lose their "Cheapest" badge.

### Cache hit rate is shown, not priced in

Relays typically charge 10–20% for cached input tokens. Detection sends the same 1200+ token prefix twice and reads `cached_tokens` on the second call (with a 1.5s gap so the upstream can write it).

**It does not affect ranking.** The benefit depends on your usage: if your prefixes never repeat the hit rate is 0 and that "discount" means nothing. Sorting by list price guarantees worst-case cost; cache is a bonus.

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
1. Drop untrusted (unstable / degraded), too-slow, and expired supplies
2. Sort the rest by effective cost (price ÷ quality), ascending
3. If the first fails, fall through to the next before responding to the client
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
| `usage.json` | Usage aggregates (grows over time) |

Override the directory with `MANAGE_API_HOME=/path/to/data node daemon/index.js`.

**Threat model**: encryption protects against "leaked backup, file shared by mistake, accidentally committed". It does not protect against "this machine is already compromised", because the key sits in the same directory. Stronger protection needs a master password derived at startup — not implemented.

The daemon binds `127.0.0.1` only, has no authentication, and must not be exposed. **Do not bind `0.0.0.0`.**

---

## Known limitations

- **Balance is usually unreadable.** one-api's `/api/user/self` needs a "user access token" rather than an `sk-` key; many sites disable these endpoints; Sub2API's account APIs sit under `/api/v1/*` and only accept a login session. Workaround: click **Token** on the key row and paste a site login token. If it still fails, type the balance in — the tool never guesses.
- **Only `/v1/chat/completions` and `/v1/models` are proxied.** Embeddings, images and other endpoints are not.
- **Usage depends on the upstream returning `usage`.** A few sites do not, even when asked; those requests record 0 tokens but still count as requests.
- **Price units are per-million and per-thousand tokens only.** Per-request billing is not supported.
- **One instance at a time.** Multiple processes share one data directory and overwrite each other.

---

## Project layout

```
core/              Host-agnostic core (no framework dependencies)
  store.js           Data directory, atomic JSON writes, credential crypto
  inventory.js       Sites / credentials / supplies CRUD, group ratios, gateway keys, routing log
  pricing.js         Cost normalisation, sorting, headline generation
  benchmark.js       Benchmark table
  model-prices.js    Built-in reference prices
  providers.js       Outbound calls: model list, balance, available channels / model plaza
  model-plaza.js     Model plaza parsing (group ratios + base prices)
  probe.js           Fingerprint / truncation / billing / cache probes
  score.js           Short-term scores (with TTL) and long-term scores (time decay)
  router.js          Candidate filtering and ordering
  usage.js           Usage aggregation (day × key × site × model)

daemon/            Local HTTP server + gateway (same port)
  index.js           Startup, port selection, open browser
  server.js          HTTP routes, gateway forwarding, SSE splitting
  probe-runner.js    Probe executor (manual and scheduled)
  scheduler.js       Scheduled probing

web/               Frontend (vanilla JS, no build, no framework)
  index.html         Structure and the help document (zh + en)
  app.js             All rendering and interaction
  i18n.js            Language switch and the English dictionary
  style.css          CSS-variable dual theme

.test/             Tests and screenshot tooling
  mock-upstream.mjs  Fake relay (MODE=good|degraded|truncated|fail)
  run-*.mjs          End-to-end scripts
  seed-showcase.mjs  Generates the demo data used for README screenshots
  capture-shots.mjs  Headless Chrome screenshots (SHOT_LANG=en for English)
  check-lang.mjs     Round-trip check for the language switch
  dump-strings.mjs   Dumps every Chinese string in the UI, as a translation checklist

docs/              Images for the README
```

`core/` has no host dependencies and can be reused on its own.

---

## Development

No build step — edit and refresh. `daemon/index.js` has no file watcher, so restart it after backend changes.

### Running tests

```bash
# terminal 1: a healthy fake relay
MODE=good PORT=5101 node .test/mock-upstream.mjs

# terminal 2: end-to-end against it
node .test/run-e2e.mjs
```

`MODE` can be `good`, `degraded` (swapped + inflated), `truncated` (cut off), or `fail`.

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
- **DSH plugin form** — move the ledger into the DSH sidebar and register it as a tool, so an agent can answer "which site is cheapest right now"

---

## Feedback

- Issues: <https://github.com/ZYH1207/ManageAPI/issues>
- Email: <2385377554@qq.com>
- Blog: <https://zyh1207.github.io/>

## License

[MIT](LICENSE)
