# Sharded Cache — Deploy Pipeline Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single oversized `src/data/cache.json` with sharded files so Cloudflare Workers Static Assets deploy never hits the 25 MiB per-file limit, while retaining 100% of active markets.

**Architecture:** `sync.js` packs `deals` into multiple `cache_<NN>.json` shards (each ≤20 MiB target) plus an `index.json` manifest. A shared `cacheLoader.js` merges shards for both the browser UI and the `polymarket-scan` skill. `validate.js` enforces a 24 MiB hard ceiling per shard so CI fails before a broken deploy.

**Tech Stack:** Node 18 (sync/validate/tests), vanilla browser JS (UI), Cloudflare Workers Static Assets (deploy). No test framework — plain Node `assert` matching `tests/capital_roi.test.js`.

## Global Constraints

- **No market dropped, no fields trimmed** — sharding changes storage shape only; merged `deals` must equal today's `deals` byte-for-byte in content.
- **Shard target 20 MiB, hard limit 24 MiB** (Cloudflare asset ceiling is 25 MiB).
- **All generated JSON minified** — `JSON.stringify(obj)` with no indent.
- **Tests are plain Node `assert` scripts** in `tests/*.test.js`, no jest/mocha/playwright, no network in tests (deterministic fixtures only).
- **Commit signing:** this repo signs commits with a passphrase-protected SSH key. If a commit prompts for a passphrase and fails non-interactively, use `git -c commit.gpgsign=false commit ...` (as done for the design-doc commit).
- **Start from clean `origin/main`.** The messy local working state (staged skill rework, deleted `capital_roi.*`, untracked scratch files) is out of scope and ignored.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/sync.js` (modify) | Add + export `packShards()`; rewrite the write step to emit shards + `index.json`; guard `run()` behind `require.main`. |
| `src/js/cacheLoader.js` (create) | Pure `loadCache(fetchFn)` that reads `index.json`, fetches all shards, flattens `deals`. Used by browser + Node test. |
| `src/js/main.js` (modify) | `initDashboard` calls `loadCache(fetch)` instead of fetching `cache.json`. |
| `scripts/validate.js` (modify) | Validate sharded layout; accept optional data-dir arg; 24 MiB shard guard. |
| `.codex/skills/polymarket-scan/scripts/extract_markets.js` (modify) | Read shards via `index.json` instead of `cache.json`. |
| `wrangler.jsonc` (create) | Pin Workers Static Assets config. |
| `tests/shard.test.js` (create) | Test `packShards` completeness, sizing, naming. |
| `tests/cacheLoader.test.js` (create) | Test `loadCache` merge against temp-dir fixtures. |
| `tests/validate.test.js` (create) | Test `validate.js` pass/oversized-fail via temp dirs. |
| `package.json` (modify) | Fix `test` script to run all `tests/*.test.js`. |
| `.github/workflows/sync-data.yml` (modify) | Add `npm test` step after sync, before validate. |

---

### Task 1: `packShards` pure function (TDD)

**Files:**
- Modify: `scripts/sync.js` (add `packShards`, export it, guard `run()`)
- Test: `tests/shard.test.js`

**Interfaces:**
- Produces: `packShards(deals: Array, targetBytes?: number = 20*1024*1024) -> { shards: Array<{ name: string, deals: Array }>, totalDeals: number }`. Names are `cache_01.json`, `cache_02.json`, … zero-padded to 2 digits.

- [ ] **Step 1: Write the failing test**

Create `tests/shard.test.js`:

```js
const assert = require('assert');
const { packShards } = require('../scripts/sync');

// Build N synthetic deals of realistic-ish size.
function makeDeals(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      title: `Market ${i} with a reasonably long question string to pad size`,
      outcome: i % 2 === 0 ? 'Yes' : 'No',
      probability: 50 + (i % 50),
      daysLeft: 1 + (i % 30),
      volume: 1000 * i,
      volume24hr: 100 * i,
      liquidity: 500 * i,
      category: 'Crypto',
      tags: ['tag-a', 'tag-b'],
      slug: `market-${i}`,
      tokenId: `tok-${i}`,
      conditionId: `cond-${i}`,
      description: 'x'.repeat(200),
    });
  }
  return out;
}

// 1. Small target forces multiple shards; completeness + sizing hold.
{
  const deals = makeDeals(500);
  const TARGET = 4000; // bytes — small so many shards form, fast test
  const { shards, totalDeals } = packShards(deals, TARGET);

  assert.strictEqual(totalDeals, deals.length, 'totalDeals must equal input length');

  // Each shard must serialize under target (deals here are all smaller than target).
  for (const s of shards) {
    const bytes = JSON.stringify({ deals: s.deals }).length;
    assert.ok(bytes <= TARGET, `shard ${s.name} is ${bytes} > target ${TARGET}`);
  }

  // Multiple shards expected for 500 deals at 4KB target.
  assert.ok(shards.length >= 2, `expected >=2 shards, got ${shards.length}`);

  // Names sequential + zero-padded.
  shards.forEach((s, i) => {
    const expected = `cache_${String(i + 1).padStart(2, '0')}.json`;
    assert.strictEqual(s.name, expected, `shard name ${s.name} != ${expected}`);
  });

  // Completeness: concatenated deals equal input, order preserved, no dupes/loss.
  const merged = shards.flatMap(s => s.deals);
  assert.strictEqual(merged.length, deals.length, 'merged length mismatch');
  assert.deepStrictEqual(merged, deals, 'merged deals must equal input deals');
  console.log(`shard.test: small-target OK (${shards.length} shards, ${totalDeals} deals)`);
}

// 2. Default target (20 MiB): a modest input fits in one shard.
{
  const deals = makeDeals(10);
  const { shards, totalDeals } = packShards(deals); // default 20 MiB
  assert.strictEqual(shards.length, 1, '10 small deals should fit one shard');
  assert.strictEqual(totalDeals, 10);
  assert.strictEqual(shards[0].name, 'cache_01.json');
  console.log('shard.test: default-target OK');
}

// 3. Empty input -> single empty shard is fine, totalDeals 0.
{
  const { shards, totalDeals } = packShards([]);
  assert.strictEqual(totalDeals, 0);
  assert.strictEqual(shards.length, 0);
  console.log('shard.test: empty-input OK');
}

console.log('shard.test: ALL PASS');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/shard.test.js`
Expected: FAIL — `Cannot find module '../scripts/sync'` or `packShards is not a function` (sync.js runs `run()` at require time and may also error on network).

- [ ] **Step 3: Guard `run()` and add `packShards` in `scripts/sync.js`**

In `scripts/sync.js`, change the final two lines from:

```js
run();
```

to:

```js
if (require.main === module) {
  run();
}

module.exports = { packShards };
```

Then add the `packShards` function immediately above `async function run() {` (before the `run` definition):

```js
const SHARD_PREFIX = '{"deals":';
const SHARD_SUFFIX = ']}';

/**
 * Pack a deals array into shards whose minified serialized size stays at or
 * below targetBytes. A single deal larger than targetBytes occupies its own
 * shard (deals are never split). Returns shard metadata + total count; the
 * caller writes each shard as JSON.stringify({ deals: shard.deals }).
 */
function packShards(deals, targetBytes = 20 * 1024 * 1024) {
  const shards = [];
  let current = [];
  let sumLen = 0;

  const shardBytes = (len, count) =>
    SHARD_PREFIX.length + 1 /*[*/ + len + Math.max(0, count - 1) /*commas*/ + SHARD_SUFFIX.length;

  const flush = () => {
    if (current.length === 0) return;
    const name = `cache_${String(shards.length + 1).padStart(2, '0')}.json`;
    shards.push({ name, deals: current });
    current = [];
    sumLen = 0;
  };

  for (const deal of deals) {
    const dealLen = JSON.stringify(deal).length;
    const projected = shardBytes(sumLen + dealLen, current.length + 1);
    if (current.length > 0 && projected > targetBytes) {
      flush();
    }
    current.push(deal);
    sumLen += dealLen;
  }
  flush();

  return { shards, totalDeals: deals.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/shard.test.js`
Expected: `shard.test: ALL PASS` and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync.js tests/shard.test.js
git -c commit.gpgsign=false commit -m "feat(sync): add packShards for sharded cache"
```

---

### Task 2: Emit shards + `index.json` from `run()`

**Files:**
- Modify: `scripts/sync.js` (the write section of `run()`)
- Test: extend `tests/shard.test.js` with an end-to-end sync-shard test using a tiny fixture via a subprocess is overkill; instead test the write helper directly.

**Interfaces:**
- Produces: `run()` writes `src/data/index.json`, `src/data/cache_<NN>.json` (minified), deletes stale `cache_*.json`, and writes `market_map.json` as before. No more `src/data/cache.json`.
- Produces: exported helper `writeShardedCache({ dir, timestamp, count, deals, marketMap })` so the test can call it against a temp dir without running the full network sync.

- [ ] **Step 1: Write the failing test**

Append to `tests/shard.test.js`:

```js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { packShards, writeShardedCache } = require('../scripts/sync');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polylens-shard-'));
  const deals = makeDeals(60);
  writeShardedCache({
    dir,
    timestamp: 1234567890000,
    count: 30,
    deals,
    marketMap: { 'market-1': { id: 'x' } },
  });

  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.strictEqual(index.timestamp, 1234567890000);
  assert.strictEqual(index.count, 30);
  assert.strictEqual(index.totalDeals, 60);
  assert.ok(Array.isArray(index.shards) && index.shards.length >= 1);

  // No legacy single cache.json should be written.
  assert.ok(!fs.existsSync(path.join(dir, 'cache.json')), 'cache.json must not be written');

  // Every shard file referenced by index exists and parses.
  const merged = [];
  for (const name of index.shards) {
    const p = path.join(dir, name);
    assert.ok(fs.existsSync(p), `missing shard file ${name}`);
    const shard = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(Array.isArray(shard.deals), `${name} has no deals array`);
    merged.push(...shard.deals);
  }
  assert.deepStrictEqual(merged, deals, 'round-trip merge must equal input');

  // market_map.json still written.
  const mm = JSON.parse(fs.readFileSync(path.join(dir, 'market_map.json'), 'utf8'));
  assert.deepStrictEqual(mm, { 'market-1': { id: 'x' } });

  // Stale-shard cleanup: write a fake old shard, re-run, confirm it is removed.
  fs.writeFileSync(path.join(dir, 'cache_99.json'), '{}');
  writeShardedCache({ dir, timestamp: 1, count: 1, deals: makeDeals(5), marketMap: {} });
  assert.ok(!fs.existsSync(path.join(dir, 'cache_99.json')), 'stale shard must be removed');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('shard.test: writeShardedCache OK');
}
console.log('shard.test: ALL PASS');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/shard.test.js`
Expected: FAIL — `writeShardedCache is not a function`.

- [ ] **Step 3: Implement `writeShardedCache` and wire it into `run()`**

In `scripts/sync.js`, add this helper (place it after `packShards`):

```js
const CACHE_DIR = path.join(__dirname, '../src/data');
const MiB = 1024 * 1024;
const SHARD_LIMIT_BYTES = 24 * MiB;

/** Write sharded cache + index into dir. Removes stale cache_*.json first. */
function writeShardedCache({ dir, timestamp, count, deals, marketMap }) {
  fs.mkdirSync(dir, { recursive: true });

  // Remove any stale shard files from a prior run.
  for (const f of fs.readdirSync(dir)) {
    if (/^cache_\d+\.json$/.test(f)) fs.unlinkSync(path.join(dir, f));
  }

  const { shards, totalDeals } = packShards(deals);

  for (const shard of shards) {
    const serialized = JSON.stringify({ deals: shard.deals });
    if (serialized.length > SHARD_LIMIT_BYTES) {
      throw new Error(`Shard ${shard.name} is ${(serialized.length / MiB).toFixed(1)} MiB, exceeds ${SHARD_LIMIT_BYTES / MiB} MiB limit`);
    }
    fs.writeFileSync(path.join(dir, shard.name), serialized);
  }

  const index = {
    timestamp,
    count,
    totalDeals,
    shards: shards.map(s => s.name),
  };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, 'market_map.json'), JSON.stringify(marketMap || {}));

  return { shardCount: shards.length, totalDeals };
}
```

Then replace the write block inside `run()`. Find this block:

```js
    const cacheData = {
      timestamp: Date.now(),
      count: markets.length,
      deals: opportunities,
    };

    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2));
    fs.writeFileSync(MARKET_MAP_PATH, JSON.stringify(marketMap, null, 2));

    console.log(`Sync complete: ${markets.length} markets, ${opportunities.length} tradable outcomes saved.`);
```

Replace it with:

```js
    const { shardCount, totalDeals } = writeShardedCache({
      dir: CACHE_DIR,
      timestamp: Date.now(),
      count: markets.length,
      deals: opportunities,
      marketMap,
    });

    console.log(`Sync complete: ${markets.length} markets, ${totalDeals} tradable outcomes across ${shardCount} shard(s).`);
```

The now-unused `CACHE_PATH` and `MARKET_MAP_PATH` consts at the top may stay (harmless) or be removed; leave them to keep the diff small.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/shard.test.js`
Expected: `shard.test: ALL PASS`, exit 0.

- [ ] **Step 5: Smoke-test the real sync end-to-end (optional but recommended)**

Run: `POLYMARKET_SYNC_MAX_PAGES=2 npm run sync`
Then verify:
```bash
ls src/data/        # expect index.json, cache_01.json, market_map.json, NO cache.json
node -e "console.log(require('./src/data/index.json'))"
```
Expected: prints index with `shards`, `count`, `totalDeals`, `timestamp`. `cache.json` absent.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync.js tests/shard.test.js
git -c commit.gpgsign=false commit -m "feat(sync): write sharded cache + index.json"
```

---

### Task 3: `cacheLoader.js` shared merge module (TDD)

**Files:**
- Create: `src/js/cacheLoader.js`
- Test: `tests/cacheLoader.test.js`

**Interfaces:**
- Produces: `loadCache(fetchFn) -> Promise<{ deals: Array, count: number, totalDeals: number, timestamp: number }>`. `fetchFn(path)` mirrors `fetch` — returns a `Promise` of `{ ok: boolean, json: () => Promise<any> }`.
- Browser: `loadCache` is a global (loaded via `<script>` before `main.js`).
- Node: `module.exports = { loadCache }`.

- [ ] **Step 1: Write the failing test**

Create `tests/cacheLoader.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadCache } = require('../src/js/cacheLoader');

function fileFetch(dir) {
  return async (p) => {
    const full = path.join(dir, p.replace(/^data\//, ''));
    if (!fs.existsSync(full)) return { ok: false, json: async () => { throw new Error('missing ' + p); } };
    const text = fs.readFileSync(full, 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
  };
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polylens-loader-'));
  const index = { timestamp: 999, count: 2, totalDeals: 4, shards: ['cache_01.json', 'cache_02.json'] };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, 'cache_01.json'), JSON.stringify({ deals: [{ slug: 'a' }, { slug: 'b' }] }));
  fs.writeFileSync(path.join(dir, 'cache_02.json'), JSON.stringify({ deals: [{ slug: 'c' }, { slug: 'd' }] }));

  (async () => {
    const res = await loadCache(fileFetch(dir));
    assert.strictEqual(res.count, 2);
    assert.strictEqual(res.totalDeals, 4);
    assert.strictEqual(res.timestamp, 999);
    assert.deepStrictEqual(res.deals.map(d => d.slug), ['a', 'b', 'c', 'd']);

    // Missing shard -> throws.
    fs.unlinkSync(path.join(dir, 'cache_02.json'));
    await assert.rejects(() => loadCache(fileFetch(dir)), /missing|ok|fetch/i);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('cacheLoader.test: ALL PASS');
  })().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/cacheLoader.test.js`
Expected: FAIL — `Cannot find module '../src/js/cacheLoader'`.

- [ ] **Step 3: Create `src/js/cacheLoader.js`**

```js
/**
 * Shared cache loader. Browser: loaded as a classic <script> before main.js,
 * exposing global `loadCache`. Node: exports { loadCache } for tests.
 *
 * Reads data/index.json, fetches every listed shard, and flattens their
 * `deals` arrays into one, preserving shard + in-shard order.
 */
async function loadCache(fetchFn) {
  const indexRes = await fetchFn('data/index.json');
  if (!indexRes || !indexRes.ok) throw new Error('Failed to load data/index.json');
  const index = await indexRes.json();

  const shardResponses = await Promise.all(
    (index.shards || []).map((name) => fetchFn('data/' + name))
  );
  for (const r of shardResponses) {
    if (!r || !r.ok) throw new Error('Failed to load a cache shard');
  }
  const shardJsons = await Promise.all(shardResponses.map((r) => r.json()));

  const deals = shardJsons.flatMap((s) => (s && Array.isArray(s.deals)) ? s.deals : []);

  return {
    deals,
    count: index.count,
    totalDeals: index.totalDeals,
    timestamp: index.timestamp,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadCache };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/cacheLoader.test.js`
Expected: `cacheLoader.test: ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/js/cacheLoader.js tests/cacheLoader.test.js
git -c commit.gpgsign=false commit -m "feat(ui): add shared sharded-cache loader"
```

---

### Task 4: Wire `main.js` to `loadCache`

**Files:**
- Modify: `src/index.html` (add `<script>` tag for `cacheLoader.js` before `main.js`)
- Modify: `src/js/main.js` (the `initDashboard` try-block, ~lines 135-154)

**Interfaces:**
- Consumes: `loadCache` global from Task 3.

- [ ] **Step 1: Add the script tag**

In `src/index.html`, find the existing `<script src="js/main.js"></script>` (or equivalent main script include) and add the loader before it:

```html
<script src="js/cacheLoader.js"></script>
<script src="js/main.js"></script>
```

(If `main.js` is loaded with `defer` or at a different path, match the existing attribute; the loader MUST come first.)

- [ ] **Step 2: Replace the fetch block in `initDashboard`**

Find this block in `src/js/main.js`:

```js
    try {
        const response = await fetch('data/cache.json');
        if (!response.ok) throw new Error('Network response was not ok');
        const cache = await response.json();

        if (cache && cache.deals && cache.deals.length > 0) {
            allOpportunities = cache.deals;
            updateStats(cache.count, allOpportunities.length, cache.timestamp);
            applyFilters();
        }
    } catch (error) {
```

Replace it with:

```js
    try {
        const cache = await loadCache(fetch);

        if (cache && cache.deals && cache.deals.length > 0) {
            allOpportunities = cache.deals;
            updateStats(cache.count, allOpportunities.length, cache.timestamp);
            applyFilters();
        }
    } catch (error) {
```

- [ ] **Step 3: Manual verify**

Run: `npm run serve` (serves `src/` on :8080). Open `http://localhost:8080/`, confirm the dashboard renders markets and the "last sync" timestamp shows (requires `src/data/index.json` + shards present from Task 2's smoke test or a fresh `npm run sync`).
Expected: markets render, no console errors about `cache.json`.

- [ ] **Step 4: Commit**

```bash
git add src/index.html src/js/main.js
git -c commit.gpgsign=false commit -m "feat(ui): load markets from sharded cache"
```

---

### Task 5: `validate.js` sharded-layout guard (TDD)

**Files:**
- Modify: `scripts/validate.js` (rewrite; accept optional data-dir arg)
- Test: `tests/validate.test.js`

**Interfaces:**
- Produces: `node scripts/validate.js [dataDir]` — defaults to `src/data`. Exits 0 on valid sharded layout, 1 otherwise. Checks: `index.json` present + has `shards`/`totalDeals`/`count`/`timestamp`; every shard file exists and is < 24 MiB; `totalDeals >= 100`; `timestamp` within 1h.

- [ ] **Step 1: Write the failing test**

Create `tests/validate.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATE = path.join(__dirname, '..', 'scripts', 'validate.js');
const MiB = 1024 * 1024;

function goodDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polylens-val-'));
  const deals = [];
  for (let i = 0; i < 150; i++) deals.push({ slug: `m-${i}` }); // > 100
  fs.writeFileSync(path.join(dir, 'cache_01.json'), JSON.stringify({ deals }));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    timestamp: Date.now(),
    count: 150,
    totalDeals: 150,
    shards: ['cache_01.json'],
  }));
  return dir;
}

// 1. Valid layout -> exit 0.
{
  const dir = goodDir();
  const r = spawnSync('node', [VALIDATE, dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('validate.test: valid-layout exit 0 OK');
}

// 2. Oversized shard -> exit 1.
{
  const dir = goodDir();
  // Overwrite shard with a > 24 MiB file.
  const big = Buffer.alloc(25 * MiB, 'x');
  fs.writeFileSync(path.join(dir, 'cache_01.json'), big);
  const r = spawnSync('node', [VALIDATE, dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `expected exit 1 for oversized shard, got ${r.status}`);
  assert.ok(/25 MiB|24 MiB|too large|exceeds/i.test(r.stdout + r.stderr), 'should mention size limit');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('validate.test: oversized-shard exit 1 OK');
}

// 3. totalDeals < 100 -> exit 1.
{
  const dir = goodDir();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    timestamp: Date.now(), count: 5, totalDeals: 5, shards: ['cache_01.json'],
  }));
  fs.writeFileSync(path.join(dir, 'cache_01.json'), JSON.stringify({ deals: [{ slug: 'a' }] }));
  const r = spawnSync('node', [VALIDATE, dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `expected exit 1 for low totalDeals, got ${r.status}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('validate.test: low-totalDeals exit 1 OK');
}

console.log('validate.test: ALL PASS');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/validate.test.js`
Expected: FAIL — current `validate.js` looks for `cache.json` with a `deals` array; the temp dirs have no `cache.json`, so it exits 1 on the "valid" case too.

- [ ] **Step 3: Rewrite `scripts/validate.js`**

Replace the entire contents of `scripts/validate.js` with:

```js
/**
 * validate.js
 * Ensures the generated sharded data files are valid, fresh, and under the
 * Cloudflare Workers Static Assets per-file limit (25 MiB; we enforce 24 MiB).
 *
 * Usage: node scripts/validate.js [dataDir]   (defaults to ../src/data)
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'src', 'data');

const MAX_BYTES = 24 * 1024 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;
const MIN_DEALS = 100;

try {
  const indexPath = path.join(DATA_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error('index.json does not exist.');
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  if (!Array.isArray(index.shards) || index.shards.length === 0) {
    throw new Error("Invalid index: 'shards' array is missing or empty.");
  }
  if (typeof index.totalDeals !== 'number' || index.totalDeals < MIN_DEALS) {
    throw new Error(`Suspicious data: totalDeals=${index.totalDeals} < ${MIN_DEALS}. Aborting to protect production.`);
  }
  if (!index.timestamp || Date.now() - index.timestamp > MAX_AGE_MS) {
    throw new Error('Timestamp is missing or more than 1 hour old.');
  }

  for (const name of index.shards) {
    const shardPath = path.join(DATA_DIR, name);
    if (!fs.existsSync(shardPath)) {
      throw new Error(`Shard listed in index is missing on disk: ${name}`);
    }
    const size = fs.statSync(shardPath).size;
    if (size > MAX_BYTES) {
      throw new Error(`Shard ${name} is ${(size / (1024 * 1024)).toFixed(1)} MiB — exceeds ${(MAX_BYTES / (1024 * 1024))} MiB deploy limit.`);
    }
  }

  console.log(`Validation Passed: ${index.totalDeals} deals across ${index.shards.length} shard(s). All shards < ${MAX_BYTES / (1024 * 1024)} MiB.`);
  process.exit(0);
} catch (e) {
  console.error('Validation Failed:', e.message);
  process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/validate.test.js`
Expected: `validate.test: ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/validate.js tests/validate.test.js
git -c commit.gpgsign=false commit -m "feat(validate): guard sharded layout + 24 MiB shard limit"
```

---

### Task 6: Skill reads shards

**Files:**
- Modify: `.codex/skills/polymarket-scan/scripts/extract_markets.js` (lines 3, 5, 45-46)

**Interfaces:**
- Consumes: sharded layout from Task 2 (`index.json` + `cache_<NN>.json`).

- [ ] **Step 1: Update the reader**

In `.codex/skills/polymarket-scan/scripts/extract_markets.js`, ensure `path` is required. Change line 5 area from:

```js
const fs = require('fs');
```

to:

```js
const fs = require('fs');
const path = require('path');
```

Replace lines 45-46:

```js
const raw = fs.readFileSync('./src/data/cache.json', 'utf8');
const data = JSON.parse(raw);
```

with:

```js
const DATA_DIR = './src/data';
const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8'));
const data = { deals: [] };
for (const name of index.shards || []) {
  const shard = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  if (Array.isArray(shard.deals)) data.deals = data.deals.concat(shard.deals);
}
```

Also update the comment on line 3 from "Reads ./src/data/cache.json" to "Reads ./src/data sharded cache (index.json + cache_*.json)".

- [ ] **Step 2: Verify the skill still runs**

Run (requires sharded data present — from Task 2 smoke test):
```bash
node .codex/skills/polymarket-scan/scripts/extract_markets.js --max-candidates 3
```
Expected: prints up to 3 candidate JSON lines, no error about `cache.json`. (If no markets match defaults, empty output is acceptable as long as it does not crash reading files.)

- [ ] **Step 3: Commit**

```bash
git add .codex/skills/polymarket-scan/scripts/extract_markets.js
git -c commit.gpgsign=false commit -m "feat(skill): read sharded cache in extract_markets"
```

---

### Task 7: Pin `wrangler.jsonc`, fix `npm test`, add CI test step

**Files:**
- Create: `wrangler.jsonc`
- Modify: `package.json` (test script)
- Modify: `.github/workflows/sync-data.yml` (add test step)

- [ ] **Step 1: Create `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "polylens-ui",
  "compatibility_date": "2026-06-29",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "src" },
  "observability": { "enabled": true }
}
```

- [ ] **Step 2: Fix the `test` script in `package.json`**

Change:

```json
    "test": "node tests/capital_roi.test.js",
```

to:

```json
    "test": "for f in tests/*.test.js; do echo \"-- $f\"; node \"$f\" || exit 1; done",
```

- [ ] **Step 3: Add the CI test step**

In `.github/workflows/sync-data.yml`, after the `Run sync script` step and before the `Validate data` step, insert:

```yaml
      - name: Run tests
        run: npm test
```

The relevant section becomes:

```yaml
      - name: Run sync script
        run: npm run sync
        env:
          POLYMARKET_SYNC_MAX_PAGES: 120

      - name: Run tests
        run: npm test

      - name: Validate data
        run: node scripts/validate.js
```

- [ ] **Step 4: Verify locally**

Run: `npm test`
Expected: all three test files run and print `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc package.json .github/workflows/sync-data.yml
git -c commit.gpgsign=false commit -m "chore: pin wrangler config, wire npm test into CI"
```

---

### Task 8: Full pipeline verification + deploy check

**Files:** none (verification only)

- [ ] **Step 1: Clean local data and run the real sync**

```bash
rm -f src/data/cache.json src/data/cache_*.json src/data/index.json
POLYMARKET_SYNC_MAX_PAGES=120 npm run sync
```
Expected: console `Sync complete: <N> markets, <M> tradable outcomes across <K> shard(s).`

- [ ] **Step 2: Validate + test**

```bash
node scripts/validate.js && npm test
```
Expected: `Validation Passed: ...` then all tests `ALL PASS`, exit 0.

- [ ] **Step 3: Inspect shard sizes**

```bash
ls -la src/data/
du -h src/data/cache_*.json
```
Expected: `index.json`, one or more `cache_*.json` each < 24 MiB, `market_map.json`, no `cache.json`.

- [ ] **Step 4: UI smoke**

```bash
npm run serve
```
Open `http://localhost:8080/`, confirm markets render and last-sync shows.

- [ ] **Step 5: Push and watch the Cloudflare deploy**

```bash
git push origin main
```
Then open the Cloudflare Pages/Workers build log for this commit. Expected: build succeeds (no `Asset too large` error). Confirm the live site `https://polylens.aivault.securityjunky.com/` loads fresh data and `data/index.json` + shards are served (e.g. `curl -s https://polylens.aivault.securityjunky.com/data/index.json`).

- [ ] **Step 6: Final commit if any verification tweaks**

(Only if Steps 1-5 surfaced fixes.) Otherwise done — no commit needed.

---

## Self-Review

**Spec coverage:**
- Shard packer (sync.js) → Task 1 ✓
- Emit shards + index, remove cache.json, stale cleanup → Task 2 ✓
- Shared merge module (cacheLoader.js) → Task 3 ✓
- main.js uses loader → Task 4 ✓
- extract_markets reads shards → Task 6 ✓
- validate.js 24 MiB guard + dir arg → Task 5 ✓
- wrangler.jsonc committed → Task 7 ✓
- Tests (shard, validate, cacheLoader) plain-assert → Tasks 1, 5, 3 ✓
- package.json test script fixed → Task 7 ✓
- CI test step → Task 7 ✓
- Minified output → Task 2 (`JSON.stringify` no indent) ✓
- Retain all markets, no field trim → packShards never drops deals ✓

**Placeholder scan:** none — every code step contains full code.

**Type/name consistency:**
- `packShards(deals, targetBytes=20*1024*1024)` — used identically in Tasks 1, 2.
- `writeShardedCache({dir, timestamp, count, deals, marketMap})` — defined Task 2, used Task 2.
- `loadCache(fetchFn) -> {deals, count, totalDeals, timestamp}` — defined Task 3, consumed Task 4 with same field names (`cache.count`, `cache.timestamp`) as the prior code path.
- `index.shards` / `index.totalDeals` / `index.count` / `index.timestamp` — consistent across sync (Task 2), cacheLoader (Task 3), validate (Task 5), extract_markets (Task 6).
- Shard file shape `{ deals: [...] }` — consistent across all readers.
