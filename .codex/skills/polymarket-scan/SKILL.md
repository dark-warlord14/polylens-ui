---
name: polymarket-scan
description: Unified Polymarket scanner for researched, capital-efficient best bets. Scans all open categories, treats Polymarket price as executable entry rather than truth, uses independent research to estimate fair probability, then ranks only positive-EV picks by risk-adjusted expected return per day of deployed capital. Use whenever the user mentions scanning markets, Polymarket opportunities, best ROI, best bets, politics/election/geopolitics bets, or runs /polymarket-scan.
---

# Polymarket Scan — Capital ROI Strategy

## Objective

Find bets where independent research supports a fair probability above the executable Polymarket entry price, then rank surviving picks by expected return per day of capital lockup.

Core rule: **Polymarket price is the entry quote, not the probability estimate.** A 60c contract is not a 60% win estimate for this workflow; it is a price that must be beaten by research. A likely winner can still be a bad trade if EV/day is weak.

All categories are fair game by default: politics, sports, crypto, finance, culture, weather, geopolitics, neg-risk multi-outcome, and long-tail markets.

## Arguments

Parse optional flags:

- `--strategy capital-roi` default and only documented strategy
- `--max-candidates N` candidates to research after live enrichment, default `50`
- `--days N` optional maximum capital horizon
- `--max-capital-days N` optional alias for horizon filtering in final judgment
- `--min-vol N` minimum lifetime volume, default `1000`
- `--min-liquidity N` minimum liquidity, default `0`
- `--max-spread-pp N` max executable spread before prompt generation, default `4`
- `--category X` optional category restriction
- `--prob-min N`, `--prob-max N` optional entry-price band restriction; default broad prefilter is `--prob-min 5` to avoid stale dust/lottery contracts dominating gross ROI
- `--bankroll N` optional bankroll for sizing

Do not use legacy `--mode politics` behavior. If the user asks for politics, use `--category Politics` or let the broad scanner include politics naturally.

## Execution Steps

### 0. Anchor Time

Run:

```bash
node -e "console.log(new Date().toISOString())"
```

Use that ISO string for every deadline and horizon calculation.

### 1. Fetch User Positions

Fetch active positions to avoid recommending duplicates or correlated exposure:

```text
GET https://data-api.polymarket.com/positions?user=0x80574dc5417bd3f3dd2464fce9cf397622c5b732&sizeThreshold=.1&limit=100&offset=0
```

Store raw JSON as `/tmp/polymarket-scan-positions.json`. If the fetch fails, continue and note the gap in the portfolio summary.

Exclude exact slug matches and semantic overlaps: same event, same direction, or a closely correlated sub-event.

### 2. Sync Fresh Market Data

Run from repo root:

```bash
npm run sync
```

This fetches all active open Gamma markets via keyset pagination and writes:

- `src/data/cache.json`
- `src/data/market_map.json`

Abort if sync fails. Do not use stale cache.

### 3. Extract Broad Candidates

Run:

```bash
SKILL_DIR=".codex/skills/polymarket-scan"
node "$SKILL_DIR/scripts/extract_markets.js" \
  --strategy capital-roi \
  --max-candidates 100 \
  --now ANCHORED_NOW_ISO \
  [--days N] [--min-vol N] [--min-liquidity N] [--category X] [--prob-min N] [--prob-max N]
```

Save the JSON lines to `/tmp/polymarket-scan-candidates.jsonl`.

This stage is a broad prefilter only. It must not decide probability. It keeps candidates when they are open, tradable, have a token ID, have a determinable deadline, are not stale past-deadline contracts, and have plausible gross yield/day.

### 4. Live Enrichment And Prompt Generation

Run:

```bash
node "$SKILL_DIR/scripts/build_research_prompts.js" \
  --candidates /tmp/polymarket-scan-candidates.jsonl \
  --positions /tmp/polymarket-scan-positions.json \
  --max 50 \
  --now ANCHORED_NOW_ISO \
  [--max-spread-pp N] [--min-liquidity N] \
  > /tmp/polymarket-scan-prompts.txt
```

This script:

- refetches live Gamma metadata
- uses batch CLOB order books for executable ask/bid/spread/depth
- samples CLOB batch price history for price movement
- fetches recent Data API trades when condition IDs are available
- computes capital horizon, gross yield/day, required edge, and research bucket
- emits one subagent prompt per surviving candidate

### 5. Research Subagents

Spawn one subagent per prompt block, in parallel.

Every subagent must use web research. Do not return DROP without at least 3 attempted searches across 2+ independent sources.

Each subagent estimates probability from evidence before comparing to price:

```text
adjustedFairProb = entryProb + evidenceReliability * (rawFairProb - entryProb)
edge_pp = adjustedFairProb - entryProb
EV_yield = adjustedFairProb / entryProb - 1
EV_per_day = EV_yield / capitalHorizonDays
```

Evidence reliability:

| Evidence | Reliability |
| --- | --- |
| locked result or official/primary result | 0.85 |
| multiple current strong independent sources | 0.70 |
| one primary source plus supporting secondary evidence | 0.50 |
| subjective, fast-moving, polling/model-heavy, or conflict-market evidence | 0.30 |

Bucket research checklists:

- **confirmed/result-lag**: official result or 2 independent sources; only then fair probability may be 97-99%.
- **sports/game/event**: injuries/lineups, recent form, matchup, rest, venue, motivation, bookmaker line movement.
- **election/politics**: official polling/results, turnout, endorsements, field structure, deadlines, legal/process risk.
- **geopolitics/conflict**: wire source plus regional/official source inside 24h; identify all actors who must agree or refrain.
- **finance/crypto/commodity/rates**: live spot/threshold, volatility/ATR, support/resistance, catalysts, market hours, oracle source.
- **weather/stat/observable metric**: official measurement source, current value, forecast/model spread, threshold distance.
- **culture/awards/entertainment**: official releases, eligibility, betting/critic markets, announcement schedule, fanbase/manipulation risk.
- **neg-risk multi-outcome**: sibling outcome sums, mutually exclusive logic, hidden other risk, conversion/economic equivalence.

### 6. Grilling And Drop Rules

For every candidate, answer:

- What concrete evidence makes fair probability different from entry price?
- What is the strongest way this loses?
- What catalyst can change the probability before resolution?
- Is the entry executable near the quoted ask?
- Why is this a better use of capital than another positive-EV candidate?

Drop silently if:

- independent fair probability cannot be justified
- adjusted edge is below required edge
- live price exceeds max entry
- spread/depth makes entry unrealistic
- capital horizon makes EV/day weak versus alternatives
- resolution criteria or deadline are unclear
- source evidence conflicts in a way that makes the event genuinely uncertain
- the user already holds exact or correlated exposure

### 7. Aggregate And Rank

Normalize each graded pick:

```text
entryProb
rawFairProb
evidenceReliability
adjustedFairProb
edge_pp
EV_yield
capitalHorizonDays
EV_per_day
riskMultiplier = LOW 1.00, MEDIUM 0.70, HIGH 0.40
liquidityMultiplier = 1.00 if spread <=1pp and stake fits depth; 0.75 if spread <=3pp; 0.50 if thin/wide
riskAdjustedEVPerDay = EV_per_day * riskMultiplier * liquidityMultiplier
max_entry_price
```

Rank by:

1. `riskAdjustedEVPerDay`
2. `EV_yield`
3. `edge_pp`
4. executable liquidity/depth

Suggested sizing:

```text
kelly_fraction = (adjustedFairProb - entryProb) / (1 - entryProb)
suggested_fraction = 0.25 * kelly_fraction
```

Cap at 3% bankroll for LOW, 1.5% for MEDIUM, 0.5% for HIGH.

### 8. Ledger Feedback

Before final output:

```bash
node "$SKILL_DIR/scripts/roi_ledger.js" report
```

After final recommendations, add each recommended pick:

```bash
node "$SKILL_DIR/scripts/roi_ledger.js" add \
  --slug SLUG \
  --bet OUTCOME \
  --entry ENTRY_DECIMAL \
  --fair ADJUSTED_FAIR_DECIMAL \
  --risk LOW_OR_MED_OR_HIGH \
  --category CATEGORY \
  --capital-days CAPITAL_HORIZON_DAYS \
  --ev-day EV_PER_DAY_DECIMAL \
  --strategy capital-roi \
  --url URL
```

Use future CLV and realized ROI as process-control signals. Negative CLV in a category/risk bucket means raise required edge or drop that bucket until the sample improves.

## Final Output Format

Return only actionable recommendations. Do not mention dropped candidates.

```text
#N  [RISK] CATEGORY
TITLE
Bet: OUTCOME | Entry: XX% | Raw fair: XX% | Adj fair: XX% | Edge: +X.Xpp
EV yield: +X.X% | EV/day: +X.XX% | Risk-adj EV/day: +X.XX% | Max entry: XX%
Capital horizon: X.Xd to DATE | Book: BID/ASK, spread X.Xpp, +2pp depth $X
Stake: X.X% bankroll
Exact bet URL: https://polymarket.com/market/{market-slug}
Event URL: https://polymarket.com/event/{event-slug}

Research:
- Source-backed evidence 1
- Source-backed evidence 2
- Source-backed evidence 3
Bear case: ...
Capital verdict: why this beats alternative deployment.
```

Portfolio summary:

```text
Markets selected: N
Avg entry: XX%
Avg adjusted fair: XX%
Avg edge: +X.Xpp
Avg EV/day: +X.XX%
Avg capital horizon: X.Xd
Positions excluded: N exact/correlated
Data freshness: snapshot + anchored now
```

## Non-Negotiables

- Research probability independently before ROI math.
- Entry price must be executable.
- ROI/day beats raw win probability.
- All categories are allowed by default.
- No auto-trading or order placement.
- Never recommend a bet only because Polymarket displays a high probability.
- Always include the exact bet URL in final output so the user can place the intended market without hunting through the parent event page.
