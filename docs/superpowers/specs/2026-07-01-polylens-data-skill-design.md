# Polymarket Data Skill — Design

**Date:** 2026-07-01
**Goal:** Add a `SKILL.md` so AI agents can access and query the Polymarket market data the PolyLens web app exposes — without reading dozens of files or hand-rolling schemas.

## Scope

Docs only. Zero code changes. Single new file: `SKILL.md` at project root.

## Non-goals

- No helper scripts, no data catalog generation, no changes to `sync.js` or the UI.
- Not a guide to building/modifying the dashboard UI.
- Does not cover the stale root-level ad-hoc dumps beyond a "don't use these" note.

## Deliverable

`SKILL.md` — Claude skill frontmatter (`name`, `description`) so it is discoverable/invokable, followed by plain-markdown reference.

## Sections

1. **What it is** — one line: live Polymarket market data surfaced by the PolyLens web app.
2. **Canonical live data** — the agent-friendly view, already derived:
   - `src/data/cache_01.json`, `cache_02.json`, `cache_03.json` — each `{ deals: [...] }`, a sharded cache of outcome-level rows. ~23k deals across 12k markets. This is what agents should query.
   - `src/data/index.json` — `{ timestamp, count, totalDeals, shards }` manifest.
   - `src/data/market_map.json` — `slug → { id, conditionId, endDate, closed, active, acceptingOrders, eventSlug, negRisk }` for fast slug lookup.
   - Refreshed by GitHub Actions and `npm run sync` (`scripts/sync.js`).
3. **Origin** — Polymarket Gamma API (`gamma-api.polymarket.com/markets`), keyset pagination ordered by `volume_num,liquidity_num`, `active=true,closed=false`. Raw API market objects have stringified `outcomePrices`/`outcomes`/`clobTokenIds`; `sync.js` flattens these into the clean deal rows below.
4. **Deal object schema** (one row per outcome, e.g. the "Yes" side of a market):
   - `title`, `questionId`, `outcome` ("Yes"/"No"), `outcomeIdx`
   - `probability` — already 0–100 float (no parsing needed)
   - `daysLeft` — float days to resolution (precomputed)
   - `volume`, `volume24hr`, `liquidity` — numeric
   - `category`, `tags` (string array)
   - `slug`, `marketId`, `conditionId`, `tokenId` (CLOB token id, direct)
   - `expiryDate` (ISO date), `eventSlug`, `eventId`, `eventTitle`
   - `acceptingOrders`, `enableOrderBook`, `active`, `closed`, `negRisk`
   - `description`, `resolutionSource`
5. **Query recipes** — copy-paste snippets that read across all three shards (`jq` over concatenated input, or a node loop over `index.json`'s `shards`):
   - filter by probability range (e.g. 70–90)
   - filter by expiry window (`daysLeft`)
   - filter by minimum liquidity/volume
   - filter by category/tag
   - resolve slug → market via `market_map.json`
   - dedupe against a positions file
   - sort by probability / liquidity / expiry
   - extract `tokenId` + `conditionId` for trading
6. **Live URL** — `https://polymarket.com/event/<slug>` for any market.
7. **Gotcha** — the ~40 root-level `*.json` files (e.g. `all_markets.json`, `crypto_markets.json`, `fresh_markets.json`) are stale manual snapshots from past one-off scripts. Prefer `src/data/cache_*.json` unless historical snapshots are explicitly wanted.

## Acceptance

- `SKILL.md` exists at project root with valid frontmatter.
- An agent reading only `SKILL.md` can derive market probability, filter by prob/expiry/liquidity/category, resolve a slug to a URL, and know which files are canonical vs stale.
- No source code modified.
