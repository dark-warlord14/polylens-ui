---
name: polylens-data
description: Query the live Polymarket market data surfaced by PolyLens: the sharded outcome cache, market slug map, and deal schema.
---

# PolyLens Market Data

PolyLens exposes a cleaned Polymarket market cache that is ready to query. Use it when you need probabilities, expiry, liquidity, categories, or CLOB token ids. The raw API objects have already been flattened, so start here instead of re-fetching from Polymarket or parsing raw fields by hand.

## Canonical live data (`src/data/`)

This is the source of truth for the app. GitHub Actions refreshes it on schedule, and `npm run sync` does the same locally.

| File | Shape | Use |
|---|---|---|
| `cache_*.json` | `{ deals: [...] }` — sharded outcome rows | **Query these.** One `deal` per outcome, such as the "Yes" side of a market. |
| `index.json` | `{ timestamp, count, totalDeals, shards }` | Manifest; iterate `shards` to load all data. |
| `market_map.json` | `slug → { id, conditionId, endDate, closed, active, acceptingOrders, eventSlug, negRisk }` | Fast slug → market lookup. |

## Deal object schema

Each row in `cache_0N.json#deals`:

- `title`, `questionId`, `outcome` (`"Yes"`/`"No"`), `outcomeIdx`
- `probability` — **0–100 float, precomputed** (no `outcomePrices` parsing needed)
- `daysLeft` — **float days to resolution, precomputed**
- `volume`, `volume24hr`, `liquidity` — numeric
- `category`, `tags` (string array)
- `slug`, `marketId`, `conditionId`, **`tokenId`** (CLOB token id, direct)
- `expiryDate` (ISO date), `eventSlug`, `eventId`, `eventTitle`
- `acceptingOrders`, `enableOrderBook`, `active`, `closed`, `negRisk`
- `description`, `resolutionSource`

## Query recipes

All recipes read across every shard. Prefer the **node** form because it uses `index.json`, so it keeps working if the shard count changes.

### Filter: probability range + expiry + liquidity + sort

```js
// node
const fs = require('fs');
const idx = JSON.parse(fs.readFileSync('src/data/index.json'));
let out = [];
for (const s of idx.shards) {
  out.push(...JSON.parse(fs.readFileSync(`src/data/${s}`)).deals);
}
const hits = out
  .filter(d => d.probability >= 70 && d.probability <= 90
            && d.daysLeft <= 3 && d.liquidity >= 10000
            && d.outcome === 'Yes')
  .sort((a, b) => b.probability - a.probability);
console.log(JSON.stringify(hits, null, 1));
```

```bash
# jq equivalent (hard-codes shard names)
cat src/data/cache_0*.json \
  | jq -c '[.deals[]] | flatten
           | .[] | select(.probability>=70 and .probability<=90
                       and .daysLeft<=3 and .liquidity>=10000
                       and .outcome=="Yes")'
```

### Filter by category / tag

```bash
cat src/data/cache_0*.json | jq -c '[.deals[]]|flatten|.[]|select(.category=="Crypto")'
cat src/data/cache_0*.json | jq -c '[.deals[]]|flatten|.[]|select(.tags|index("Geopolitics"))'
```

### Resolve slug → market / URL

```js
const m = JSON.parse(fs.readFileSync('src/data/market_map.json'));
const entry = m['<slug>'];      // { id, conditionId, endDate, eventSlug, ... }
const url  = `https://polymarket.com/event/${entry.eventSlug || '<slug>'}`;
```

### Extract trading ids for a market

```bash
cat src/data/cache_0*.json | jq -c '[.deals[]]|flatten|.[]|select(.slug=="<slug>")|{tokenId,conditionId,outcome}'
```

### Dedupe against an existing positions file

```js
// positions shape: [{ slug }] (see user_positions_live.json)
const held = new Set(positions.map(p => p.slug));
const fresh = out.filter(d => !held.has(d.slug));
```

## Live URL

`https://polymarket.com/event/<eventSlug>` (or `<slug>` when no event slug). One per market.

## Gotcha — stale root dumps

The ~40 root-level `*.json` files (`all_markets.json`, `crypto_markets.json`, `fresh_markets.json`, `*_candidates.json`, etc.) are **stale manual snapshots** from past one-off scripts. Ignore them unless you explicitly want a historical snapshot. Always prefer `src/data/cache_*.json`.

## Origin (when you must fetch fresh)

`scripts/sync.js` reads from the Polymarket Gamma keyset API with `active=true` and `closed=false`. It tries stable order fields in this order: `volumeClob`, `liquidityClob`, `updatedAt`, then `createdAt`. If one order fails during pagination, sync falls back to the next.

```
https://gamma-api.polymarket.com/markets/keyset?active=true&closed=false&include_tag=true&limit=100&order=volumeClob&ascending=false
```

Raw API objects use stringified `outcomePrices`, `outcomes`, and `clobTokenIds`. `sync.js` flattens those into the deal rows above. Run `npm run sync` to refresh the cache instead of hand-parsing the API.
