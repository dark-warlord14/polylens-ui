# Polymarket Data Skill — Design

**Date:** 2026-07-01
**Goal:** Add a `SKILL.md` that gives AI agents a clear path into the Polymarket data exposed by PolyLens, without forcing them to inspect every cache file or infer the schema.

## Scope

One served reference file, `src/SKILL.md`, plus a header link in `src/index.html` and a guard test. No runtime behavior changes, no new dependency, and no data pipeline change.

## Non-goals

- No helper scripts, no data catalog generation, no changes to `sync.js` data pipeline.
- Not a guide to building/modifying the dashboard UI behavior.
- Does not cover the stale root-level ad-hoc dumps beyond a "don't use these" note.

## Deliverable

`src/SKILL.md` — Claude skill frontmatter (`name`, `description`) followed by a plain Markdown reference. Cloudflare Pages serves it from the `src/` asset root at `https://polylens.aivault.securityjunky.com/SKILL.md`. A "Data API" link in the dashboard header (`.network-link`, opens `/SKILL.md` in a new tab) makes it easy to find. `tests/skill.test.js` checks that the file has frontmatter and that `index.html` links to it.

## Sections

1. **What it is** — one line: live Polymarket market data surfaced by the PolyLens web app.
2. **Canonical live data** — the agent-friendly view, already derived:
   - `src/data/cache_01.json`, `cache_02.json`, `cache_03.json` — each `{ deals: [...] }`, a sharded cache of outcome-level rows. ~23k deals across 12k markets. This is what agents should query.
   - `src/data/index.json` — `{ timestamp, count, totalDeals, shards }` manifest.
   - `src/data/market_map.json` — `slug → { id, conditionId, endDate, closed, active, acceptingOrders, eventSlug, negRisk }` for fast slug lookup.
   - Refreshed by GitHub Actions and `npm run sync` (`scripts/sync.js`).
3. **Origin** — Polymarket Gamma keyset API (`gamma-api.polymarket.com/markets/keyset`), queried with `active=true`, `closed=false`, and `include_tag=true`. `sync.js` tries `volumeClob`, `liquidityClob`, `updatedAt`, then `createdAt`, falling back if an order fails during pagination. Raw API market objects have stringified `outcomePrices`/`outcomes`/`clobTokenIds`; `sync.js` flattens these into the clean deal rows below.
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
5. **Query recipes** — copy-paste snippets that read across every shard (`jq` over concatenated input, or a node loop over `index.json`'s `shards`):
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

- `src/SKILL.md` exists with valid frontmatter.
- An agent reading only `SKILL.md` can derive market probability, filter by prob/expiry/liquidity/category, resolve a slug to a URL, and know which files are canonical vs stale.
- The only source change is the dashboard link that exposes `/SKILL.md`.
