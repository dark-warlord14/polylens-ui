# Sharded Cache — Deploy Pipeline Fix

**Date:** 2026-06-29
**Status:** Approved
**Scope:** Unblock the Cloudflare deploy pipeline. Retain 100% of active markets.

## Problem

The Cloudflare deploy (`npx wrangler deploy`, Workers Static Assets) fails whenever
`src/data/cache.json` exceeds the **25 MiB per-file asset limit**:

```
Asset too large. /opt/buildhome/repo/src/data/cache.json = 48.2 MiB > 25 MiB.
```

`scripts/sync.js` writes a single pretty-printed `cache.json` from up to 12,000
fetched Polymarket markets. At peak market volume the minified output is ~33 MiB
(pretty-printed ~48 MiB) — over the ceiling. The May 23 "Fix data sync cache size"
commit only lowered `maxPages` from `0` to `120`; 120 pages can still exceed 25 MiB,
so the failure is intermittent and will recur.

Constraint from the user: **no active market may be dropped, and no fields trimmed.**
Both size-reduction levers (fewer markets, fewer fields) are therefore off the table.
A single static file cannot hold the data, so the data must be split.

## Solution

Shard `cache.json` into multiple static files, each under 24 MiB, plus an index
manifest. The UI and the `polymarket-scan` skill fetch the index, then all shards,
and merge into the same `deals` array they consume today.

## File layout (`src/data/`)

```
index.json         { timestamp, count, totalDeals, shards: ["cache_01.json", ...] }
cache_01.json      { deals: [...] }      each minified, packed to <= 20 MiB target
cache_02.json      { deals: [...] }
...
market_map.json    (unchanged — ~1.2 MiB, single file)
```

The old `src/data/cache.json` is removed.

- **Shard target:** 20 MiB. **Hard limit enforced by `validate.js`:** 24 MiB per shard.
  20 MiB target leaves headroom so normal growth never trips the 24 MiB guard, and 24 MiB
  stays safely under Cloudflare's 25 MiB asset ceiling.
- All output **minified** (`JSON.stringify(obj)`, no indent) to maximize headroom.

## Changes

### 1. `scripts/sync.js`

Replace the single `writeFileSync(CACHE_PATH, ...)` with a shard packer.

- Extract a pure function `packShards(deals, targetBytes=20*1048576)` →
  `{ shards: Array<{ name, deals }>, totalDeals }`. It greedily accumulates deals into
  the current shard; when `JSON.stringify(shard)` length crosses `targetBytes`, it closes
  the shard and starts the next. Shard names are `cache_01.json`, `cache_02.json`, …
  zero-padded.
- After processing markets, call `packShards(opportunities)`.
- Write each shard minified to `src/data/cache_<NN>.json`.
- Write `src/data/index.json` (minified): `{ timestamp, count: markets.length, totalDeals, shards: [<names>] }`.
- `market_map.json` write is unchanged.
- Before writing, delete any stale `cache_*.json` from a prior run so shard count can
  shrink without leaving orphan files.

### 2. `src/js/cacheLoader.js` (new, shared)

Exports `loadCache(fetchFn)`:

- `fetchFn('data/index.json')` → parse → `{ shards, count, totalDeals, timestamp }`.
- `Promise.all(shards.map(name => fetchFn('data/' + name).then(r => r.json())))`.
- Flatten all `deals` arrays into one, preserving order.
- Return `{ deals, count, totalDeals, timestamp }`.

`main.js` `initDashboard` calls `loadCache(fetch)` and uses the result exactly as it
used `cache.deals/count/timestamp` before. Error handling stays in `main.js`.

### 3. `.codex/skills/polymarket-scan/scripts/extract_markets.js`

Replace `fs.readFileSync('./src/data/cache.json')` (line ~45) with:

- Read `./src/data/index.json`.
- For each shard in `index.shards`, read `./src/data/<name>`, extend a `deals` array.
- Downstream code unchanged (operates on the merged `deals`).

### 4. `scripts/validate.js` (the deploy guard)

Rewrite to validate the sharded layout:

- Parse `src/data/index.json`; assert it has `shards` (non-empty array), `totalDeals`,
  `count`, `timestamp`.
- For each listed shard: assert the file exists and `fs.statSync(...).size < 24 MiB`.
- Assert `totalDeals >= 100`.
- Assert `timestamp` present and `Date.now() - timestamp < 3600000`.
- Any failure → `console.error` + `process.exit(1)`, which fails the CI job before commit/push/deploy.

### 5. `wrangler.jsonc` (new, committed)

Pin Workers Static Assets config so Cloudflare stops auto-generating it via
non-interactive fallback each build:

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

## Tests (plain Node `assert`, matching `tests/capital_roi.test.js` style)

No test framework, no browser. Deterministic fixtures, no network in tests.

- **`tests/shard.test.js`** — generate a synthetic `deals` array large enough to span
  ≥2 shards at the 20 MiB target (e.g. 20k deals). Run `packShards`. Assert:
  every shard's `JSON.stringify` length < 24 MiB; at most one shard under target;
  concatenated deals have no duplicate keys; `length === totalDeals`; returned shard
  names are sequential and zero-padded.

- **`tests/validate.test.js`** — write a temp `src/data` dir with a valid `index.json`
  + small shards; spawn `node scripts/validate.js` with `CACHE_DIR` overridden → exit 0.
  Then write one shard > 24 MiB → exit 1. (`validate.js` must accept a dir argument or
  env var so it can be pointed at a temp dir.)

- **`tests/cacheLoader.test.js`** — write a temp dir with `index.json` + 2 shard files;
  call `loadCache` with a `fetchFn` that reads from disk; assert merged `deals` order,
  count, dedup behavior, and returned stats.

- **`package.json`** `test` script → run all `tests/*.test.js` (currently broken; points
  at deleted `capital_roi.test.js`).

### CI wiring

`.github/workflows/sync-data.yml` gains a step after `npm run sync`, before validate:

```yaml
      - name: Run tests
        run: npm test
```

`validate.js` already runs next; the deploy guard and the unit tests both gate the
commit/push.

## Behavior preserved

- 100% of active markets retained — sharding only changes storage shape, not content.
- UI and skill consume the same merged `deals` array as before.
- `market_map.json` unchanged.

## Out of scope

- Stuck local merge state, README inaccuracies, `npm test` legacy beyond re-pointing,
  scratch-file/branch cleanup, skill-dir dedup, field trimming, KV/R2 migration.
- Local messy state (half-staged merge, deleted `capital_roi.*`) will be discarded as a
  prep step before implementation; the sharding work starts from clean `origin/main`.

## Risks

- **Orphan shards:** prior run's `cache_03.json` lingering when a new run produces only 2.
  Mitigated: sync deletes stale `cache_*.json` before writing.
- **Shard split mid-market:** a market's multiple outcomes may land in different shards.
  Harmless — `deals` rows are independent and order only affects default sort, which the
  UI re-sorts anyway.
- **`validate.js` must be runnable against a temp dir** for testing — requires accepting a
  path argument/env var. Small, backwards-compatible change (default remains `src/data`).
