---
name: polymarket-scan
description: Unified Polymarket scanner for near-expiry best bets and global politics/geopolitics markets. Pulls latest data, fetches user's active positions to avoid duplicates, filters sweet-spot markets, validates with live sources, computes executable entry price, capital horizon, profit yield, EV yield, EV/day, and ranks by risk-adjusted time value. Use this skill whenever the user mentions scanning markets, finding best bets, Polymarket opportunities, analyzing open markets, politics/election/geopolitics bets, or runs /polymarket-scan or $polymarket-politics.
---

# Polymarket Scan — Unified Best Bets

## Purpose

Find the highest risk-adjusted, time-adjusted open markets where:
- Generic mode: probability sits in the **70–90% sweet spot** (ROI: 11–43%), default listed horizon ≤ 3 days
- Politics mode: probability sits in the **55–80% sweet spot** (ROI: 25–82%), default listed horizon ≤ 14 days, and category is **Politics**, **Elections**, **Geopolitics**, **World**, **International Affairs**, or **Society**
- Volume is meaningful (≥ $5,000 by default)
- News/facts from **multiple independent sources** support the market's current pricing — or reveal a misprice
- Independent fair probability exceeds the live Polymarket price by enough margin to produce positive expected value after uncertainty
- The finance case is realistic: output must state capital horizon, gross profit yield, EV yield, EV/day, spread/depth, and whether the ranking is driven by edge, speed, or liquidity
- The user does **not already hold** a position in this market

## Arguments

Parse optional flags from the user's request:
- `--days N` → filter daysLeft ≤ N (default: 3)
- `--min-vol N` → minimum volume in USD (default: 5000)
- `--category X` → restrict to one category (default: all)
- `--mode politics` → use politics categories, 55–80% probability range, 14-day max listed horizon unless `--days` is provided
- `--prob-min N`, `--prob-max N` → override probability band
- `--min-edge N` → minimum fair-probability edge in percentage points (default: dynamic by risk/price)
- `--bankroll N` → optional bankroll in USD for suggested sizing; if omitted, report stake as bankroll percentage only
- `--max-capital-days N` → optional maximum days until likely resolution/capital release; if omitted, keep longer-resolution candidates but penalize them through EV/day

---

## Execution Steps

### STEP 0 — Anchor current time

Run `node -e "console.log(new Date().toISOString())"` and treat that ISO string as the authoritative "now" for the entire scan. Do **NOT** trust any date appearing in system reminders, CLAUDE.md, or your own assumptions — they can be hours or days off. Every "expired / live" decision in later steps must compare against this anchored value.

Sanity check: if at any point you find yourself dropping >40% of top-30 candidates as "already expired", re-anchor `now` first — you almost certainly have the wrong date.

---

### STEP 0.5 — Fetch User's Active Positions (Subagent)

Spawn a subagent to fetch the user's current open positions in parallel with STEP 1. This prevents recommending markets the user already holds **or overlaps with**.

```
GET https://data-api.polymarket.com/positions?user=0x80574dc5417bd3f3dd2464fce9cf397622c5b732&sizeThreshold=.1&limit=100&offset=0
```

Extract from each position: `market` (slug/condition ID), `title`, `outcome`. Store as `userPositions`.

**Overlap detection — two layers:**

1. **Exact slug match**: silently drop any candidate whose slug matches a held position.

2. **Semantic overlap**: silently drop any candidate that bets on the same real-world outcome as a held position, even if it is a different market. Two markets overlap when they share the same underlying event and the user's held outcome and the candidate's bet outcome are logically correlated — i.e., if the held position wins, the candidate is very likely to win too (or lose too). Examples of overlapping pairs to drop:
   - User holds "Team A wins Series" → drop "Team A wins Game 5" (same direction, sub-event)
   - User holds "Fed cuts rates in May" → drop "Fed funds rate below X% by June" (same catalyst)
   - User holds "Candidate X wins election" → drop "Party X wins majority" (correlated outcome)
   - User holds "YES on event A" in one market slug → drop another slug asking effectively the same question with slightly different wording
   
   Use title and outcome text similarity to detect this. If two candidates share ≥3 meaningful keywords AND the bet direction is the same, treat as overlap and silently drop the candidate.

If the API errors or returns empty, proceed without the filter and note "Could not fetch user positions" in the portfolio summary.

---

### STEP 1 — Fetch Latest Data Locally

Run the sync script from the project root to fetch fresh Polymarket data directly from the Gamma API. This writes `src/data/cache.json` and `src/data/market_map.json` in real time — no reliance on CI cadence or git state.

```bash
npm run sync
```

Report the result (markets fetched, opportunities saved, or error). If sync fails, abort — do not fall back to stale cache.

---

### STEP 2 — Extract & Score Markets

Run the bundled script with arguments parsed above. This is the single repo-local Polymarket skill; do not use home-directory/global Polymarket skill paths.

```bash
SKILL_DIR=".codex/skills/polymarket-scan"
```

For generic scans:

```bash
node "$SKILL_DIR/scripts/extract_markets.js" \
  --days MAX_DAYS \
  --min-vol MIN_VOL \
  --now ANCHORED_NOW_ISO \
  [--category CATEGORY]
```

For politics/geopolitics scans:

```bash
node "$SKILL_DIR/scripts/extract_markets.js" \
  --mode politics \
  --days MAX_DAYS \
  --min-vol MIN_VOL \
  --prob-min 55 \
  --prob-max 80 \
  --now ANCHORED_NOW_ISO
```

The script recomputes `daysLeft` from anchored time (not the stale value baked into the cache at sync time) and drops anything with `daysLeft < 0`.

The script also emits preliminary finance fields:
- `questionDeadline` when the title has an explicit date like `by June 30, 2026`
- `capitalDaysLeft`, using the explicit title deadline when it conflicts with Gamma `endDate`
- `grossProfitPerDay`, a preliminary gross yield/day for candidate ordering

These fields are only a first pass. Later steps must verify the actual live question, description, trading status, and resolution deadline from Gamma and the market page.

Parse the JSON lines to get the top 30 candidates. Cross-reference against `userPositions` from STEP 0.5 — silently drop any slug that matches an active user position or overlaps semantically (see STEP 0.5 overlap rules).

**Intra-candidate deduplication**: among the top 30 candidates themselves, if two candidates cover the same real-world outcome (same underlying event, same direction), keep only the higher-scored one and silently drop the other.

---

### STEP 3 — Fetch Live Prices & URLs from Gamma API

Cached probabilities can be hours stale, so fetch live prices for each of the top 30 candidates:

```
GET https://gamma-api.polymarket.com/markets?slug={slug}&limit=1
```

From the response:
- `outcomePrices` — JSON string array of live prices (e.g. `["0.43","0.57"]`) — use these instead of cached probability
- `outcomes` — JSON string array of outcome labels (to match prices to outcomes)
- `clobTokenIds` — JSON string array of CLOB outcome token IDs, in the same order as `outcomes`
- `events[0].slug` — parent event slug → build URL as `https://polymarket.com/event/{events[0].slug}`
- `question`, `description`, `endDate`, `endDateIso`, `active`, `closed`, `acceptingOrders`, `events[0].endDate` — use these to verify the real trading/resolution horizon

Store `liveProb` and `eventUrl` per candidate. Drop any candidate where the live price has shifted outside the active probability range: generic mode `70–90%`, politics mode `55–80%`, unless explicit probability flags were supplied.

Fetch the executable CLOB order book for the candidate outcome token:

```bash
curl "https://clob.polymarket.com/book?token_id=OUTCOME_TOKEN_ID"
```

Use the best ask as `entryProb` when available. If no order book is available, use Gamma `outcomePrices` only as a fallback and require an extra 2 pp of edge. Record best bid, best ask, spread, best ask size, and approximate ask depth within +2 pp.

Treat `entryProb` as the **entry price**, not as evidence. A market being 80% likely is not enough; it is only actionable if independent research supports an adjusted fair probability high enough above the executable entry price to create expected value.

#### Horizon and finance sanity check

Before researching a candidate, determine:

```text
listedEndDate       = Gamma market endDate, if present
eventEndDate        = Gamma parent event endDate, if present
questionDeadline    = explicit deadline parsed from live question/title, e.g. "by June 30, 2026"
descriptionDeadline = explicit deadline or resolution date in the description, if present
resolutionDeadline  = best available actual outcome deadline:
  1. explicit date in the live question/title
  2. explicit date in the description
  3. market endDate
  4. event endDate
capitalHorizonDays = max(1, (resolutionDeadline - ANCHORED_NOW) / 86400000)
```

If `listedEndDate` conflicts with an explicit date in the question, trust the question/description for `resolutionDeadline` and note the mismatch internally. Do **not** call the listed date "expiry" in the final output unless it is also the resolution deadline. Confirm `active=false`, `closed=true`, or `acceptingOrders=false` before saying trading is closed.

Compute finance terms:

```text
grossProfitYield = (1 / entryProb) - 1
EV_yield = (adjustedFairProb / entryProb) - 1
grossProfitPerDay = grossProfitYield / capitalHorizonDays
EV_per_day = EV_yield / capitalHorizonDays
breakEvenProb = entryProb
fairOdds = 1 / adjustedFairProb
```

Annualized return is usually misleading for binary event risk. If mentioned, label it as a rough simple annualized comparison only; do not use it as the main ranking metric.

---

### STEP 4 — Classify Candidates by Type

Before spawning research subagents, classify each surviving candidate into one of four buckets. This classification is passed to its subagent so it knows which research protocol to apply.

| Bucket | Classification rule |
|--------|-------------------|
| **Already-occurred** | expiryDate in the past OR title references a specific past date/event |
| **Verifiable facts** | Outcome depends on a live-checkable number (price, index level, count, stat) |
| **Event-pending** | Outcome depends on something happening in the next 1–3 days (game, vote, launch, decision) |
| **Structurally stable** | Long-arc outcome (capture, release, leadership change) very unlikely to flip in the remaining window |
| **Political/election** | Election, primary, runoff, referendum, parliamentary seats, party/nominee outcome |
| **Political/geopolitical** | Ceasefire, sanctions, treaty, peace deal, military action, state conflict |
| **Political decision/status** | Appointment, resignation, leadership status, bill/signature/official decision |

---

### STEP 5 — Build prompts + dispatch research subagents

First, generate one prompt per surviving candidate using the helper script. This prevents the orchestrator from skipping candidates due to manual fatigue:

```bash
node "$SKILL_DIR/scripts/build_research_prompts.js" \
  --candidates /tmp/polymarket-scan-candidates.jsonl \
  --positions /tmp/polymarket-scan-positions.json \
  [--mode politics --prob-min 55 --prob-max 80] \
  > /tmp/polymarket-scan-prompts.txt
```

Where the candidates file is the JSON-lines output of `extract_markets.js` and the positions file is the raw response from STEP 0.5. The script applies the user-positions overlap filter, fetches live prices via Gamma, verifies the live probability band, computes capital-horizon/yield fields, classifies the bucket (STEP 4), and emits one ready-to-paste subagent prompt per surviving candidate, separated by `===CANDIDATE n===` markers.

Then **spawn one subagent per emitted prompt — all in a single message, all in parallel**. There is no cap: every candidate the script emits gets its own subagent. Research is the bottleneck, not the count, and parallel subagents make it cheap. If the script emits 22 prompts, dispatch 22 Agent calls. Do not skip any.

Each subagent runs the full pipeline for its market: research (STEP 5 protocol) → grilling (STEP 5.5) → risk tier assignment (STEP 6). It returns either a fully-graded pick or a silent drop.

**MANDATORY**: every subagent prompt produced by the helper script must literally contain the line *"You have WebSearch and WebFetch tools. You MUST use them. Do not return DROP without at least 3 attempted searches across 2+ independent sources."* Tool inheritance is unreliable across environments — without an explicit instruction, subagents will silently return DROP without ever calling the web tools.

Each subagent must validate using at least 2 independent sources. A single source is not sufficient — the whole point is to catch cases where one outlet is wrong or behind.

#### Expected-value requirement

Every subagent must estimate an independent raw fair probability before looking at the final recommendation. Do not recommend a market just because the outcome is likely. Recommend only when the estimated probability is meaningfully above the executable entry price.

Shrink raw estimates toward the market before sizing or ranking:

```text
adjustedFairProb = entryProb + evidenceReliability * (rawFairProb - entryProb)
```

Use `adjustedFairProb`, not raw confidence, for EV math. Evidence reliability:

| Evidence quality | Reliability |
|------------------|-------------|
| Official/locked result or 2+ primary sources | 0.85 |
| Multiple current independent high-quality sources | 0.70 |
| One primary source plus secondary support | 0.50 |
| Subjective, polling-heavy, fast-moving, or model-driven | 0.30 |

Compute:

```text
edge_pp = adjustedFairProb - entryProb
EV_per_$ = adjustedFairProb / entryProb - 1
max_entry_price = adjustedFairProb - required_edge_pp
grossProfitYield = 1 / entryProb - 1
capitalHorizonDays = days until the actual resolution deadline, not merely Gamma endDate
EV_per_day = EV_per_$ / capitalHorizonDays
grossProfitPerDay = grossProfitYield / capitalHorizonDays
```

Default required edge:

| Live price / risk | Minimum edge |
|-------------------|--------------|
| LOW risk, liveProb ≥ 85% | 3 pp |
| LOW/MED risk, liveProb 75–84.9% | 5 pp |
| MED risk, liveProb 70–74.9% | 7 pp |
| HIGH risk or active-conflict/timing markets | 10 pp, otherwise drop |

If `edge_pp` is below the required edge, silently drop the market even if all sources point in the bet direction. If the market is already above `max_entry_price`, it is not an entry anymore.

Execution penalties:
- Add `max(0, spread_pp - 1)` to the required edge.
- If the best ask is missing, add 2 pp to the required edge and label the price as non-executable.
- If spread is >4 pp, drop unless adjusted edge is at least 2x the spread and the ask depth supports the intended stake.
- If the expected stake cannot be entered within +2 pp of best ask, size to available depth or drop.

#### Research protocol per market type:

**Already-occurred markets:**
- Search: `"[event] result [date]"` + `"[event] outcome [month year]"`
- Require 2 confirming sources (e.g. Reuters + AP, or official result + major outlet)
- If both confirm → mark **CONFIRMED**, set effective probability to 97–99%

**Price/stat markets (stocks, indices, forex, commodities):**
- Query current value from at least 2 sources (Bloomberg/Reuters/EIA/WSJ/Yahoo Finance)
- Compare against the market's threshold with a margin buffer
- Run technical analysis — this matters because a market at 70% probability that has strong counter-trend technicals and an imminent catalyst is riskier than the probability suggests:
  - **Trend**: Is price above or below key moving averages (20d, 50d, 200d)?
  - **Momentum**: RSI level, MACD signal line crossover
  - **Key levels**: Nearest support and resistance vs. the strike
  - **Catalysts**: Any scheduled events in the remaining window (Fed speakers, earnings, macro data)?
  - **Volatility**: Recent ATR — can the market realistically reach the strike before expiry?
- If technicals contradict the bet direction, downgrade to 🔴 HIGH risk or silently drop

**Political/geopolitical markets:**
- Search: `"[topic] [month year]"` + `"[topic] latest news"`
- Require at least one wire service (Reuters/AP/AFP) + one regional or government source
- If sources conflict, do not recommend — contested narratives mean the market is genuinely uncertain

Politics mode source requirements:
- Election markets: if the vote is complete, require 2 sources reporting the certified or projected winner; if upcoming, check latest polling/aggregators and structural factors such as incumbency, turnout, runoff dynamics, or fragmented fields.
- Political decisions: look for official statements, legislative records, credible journalist sourcing, leaked drafts, and scheduled votes/deadlines.
- Geopolitical/conflict markets: require a wire service plus a regional/official source published within the last 24h for active conflict zones; check whether one actor or multiple parties must agree.
- Leadership/status markets: confirm current status first, then search for active legal, health, coalition, or scandal risks in the next window.

**Sports markets:**
- Confirm full team context before recommending — odds are set by people with good data, so you need to know what they know:
  - **Injury report**: Official league injury lists. Key absences can flip the outcome.
  - **Recent form**: Last 5 games W/L for each team
  - **Head-to-head**: Last 3–5 meetings between these teams
  - **Home/away splits**: Both teams' records at home vs. away
  - **Rest**: Days since last game; back-to-back situations
  - **Motivation**: Playoff seeding, elimination scenarios, rivalry context
  - **Line movement**: Significant movement against Polymarket's implied probability is a red flag
- If a key player (All-Star, franchise player, starting pitcher/QB) is OUT and the live Polymarket price doesn't reflect it, flag as **POTENTIAL MISPRICE**
- Require at least 2 independent sources covering injuries AND odds/analysis

**Misprice detection:** If 2+ sources strongly confirm an outcome but market probability is below 92%, flag as **POTENTIAL MISPRICE — underpriced edge**.

---

### STEP 5.5 — Prediction Grilling (2–3 Rounds)

Stress-test each candidate through adversarial challenge rounds. The goal is to find reasons the bet fails, not reasons it wins — picks that survive earn higher confidence.

**Round 1 — Bear Case:**
Ask: *"What is the single most likely scenario where this bet loses?"*
- If a plausible bear case exists with >30% probability, downgrade to 🔴 HIGH risk
- If bear case probability exceeds 40%, silently drop

**Round 2 — Data Integrity Check:**
- Is the research current? (live Gamma price is fresh, but is the news also recent?)
- Do sibling markets (same event, different outcome brackets) contradict this pick? Check live prices of all outcomes in the same event.
- Does the implied probability from books/lines match Polymarket within 10%? A >10% divergence needs explanation.
- Is volume concentrated in the last few hours (sudden shift) or spread evenly? Sudden spikes can indicate informed trading against your position.
- Is the spread wide because the displayed price is stale or not executable? Use the CLOB best ask, not midpoint or last trade.
- Why is the market price wrong? State the specific reason: stale public info, low-liquidity lag, event already occurred, book/market divergence, or a structural status quo edge. If there is no concrete reason, drop.

**Round 3 — Conviction Test:**
Complete this sentence: *"I am betting [outcome] because [specific evidence], and the bear case fails because [counter-evidence]."*
- If you cannot fill it with concrete evidence (not just "the market implies it"), do not include the pick.

Only picks that pass all 3 rounds proceed to the subagent's risk tier assignment below.

---

### STEP 6 — Risk Tier Assignment (within each subagent)

Assign a risk tier. Silently drop markets that don't meet inclusion criteria.

| Tier | Criteria |
|------|----------|
| 🟢 **LOW** | Past event confirmed by 2+ sources / verifiable stat already met / structurally near-impossible to flip; edge ≥ required edge |
| 🟡 **MEDIUM** | Likely based on news but 2–3 days of uncertainty remain / depends on one decision; edge ≥ required edge |
| 🔴 **HIGH** | Active conflict/chaos environment / depends on unpredictable actor / near threshold / conflicting sources; include only with edge ≥ 10 pp and exceptional evidence |

Silent drop criteria (never mention in output):
- daysLeft ≤ 0 and outcome not confirmed by 2+ sources
- volume < $5,000
- price markets where current price is within 5% of strike and direction is unclear
- User already holds a position in this market (exact slug match)
- Market outcome semantically overlaps with a held position (same real-world event + correlated direction)
- Duplicate of a higher-scored candidate in the same scan (intra-candidate overlap)
- Any crypto market (BTC, ETH, Bitcoin, Ethereum, Solana, XRP, Dogecoin, DeFi, NFT, Coinbase, Binance, altcoin, stablecoin, etc.)
- fairProb cannot be justified from concrete evidence
- edge_pp below the required edge for the risk/price bucket
- EV_per_$ ≤ 0 after fair-probability estimate
- EV_per_day is unattractive versus available shorter-duration picks with comparable or lower risk
- live price exceeds max_entry_price
- Order book/spread appears too thin to enter near the quoted live price
- adjustedFairProb after evidence-reliability shrinkage no longer clears the edge threshold
- resolutionDeadline cannot be determined from the live market question, description, or official resolution source

Each subagent returns its result to the main agent as either:
- A **graded pick** (passed all 3 grilling rounds + risk tier assigned + fairProb/edge/EV/maxEntry reported), or
- A **silent drop** (failed any round or drop criterion — subagent returns nothing)

---

### STEP 6.5 — Aggregate Subagent Results (Main Agent)

Once all subagents complete, collect all graded picks returned. Do not include any market a subagent silently dropped.

Normalize every pick to these fields:

```text
liveProb
entryProb
rawFairProb
evidenceReliability
adjustedFairProb
edge_pp = adjustedFairProb - entryProb
EV_per_$ = adjustedFairProb / entryProb - 1
max_entry_price
grossProfitYield = 1 / entryProb - 1
resolutionDeadline
capitalHorizonDays
EV_per_day = EV_per_$ / capitalHorizonDays
grossProfitPerDay = grossProfitYield / capitalHorizonDays
riskMultiplier = LOW 1.00, MEDIUM 0.70, HIGH 0.40
liquidityMultiplier = 1.00 if spread <= 1pp and intended stake fits within +2pp depth; 0.75 if spread <= 3pp; 0.50 if spread <= 4pp or depth is thin
financeScore = EV_per_day * riskMultiplier * liquidityMultiplier
riskTier
```

If a subagent gives a pick without these fields, either compute them from its text or drop it as incomplete. Suggested sizing is fractional Kelly with strict caps:

```text
kelly_fraction = (adjustedFairProb - entryProb) / (1 - entryProb)
suggested_fraction = 0.25 * kelly_fraction
```

Cap suggested size at 3% bankroll for LOW, 1.5% for MEDIUM, and 0.5% for HIGH. If `--bankroll` was provided, convert the capped percentage to USD. Otherwise report the capped percentage only.

Proceed to STEP 7 with only positive-EV surviving picks. Rank by `financeScore desc → EV_per_day desc → EV_per_$ desc → edge_pp desc`. Risk gates still apply first: do not let a fast high-risk market outrank a lower-risk market unless its risk-adjusted daily EV is materially better and the evidence is current. Never rank by raw probability alone.

---

### STEP 6.6 — ROI Feedback Loop

Before finalizing, run the ledger report if it exists:

```bash
node "$SKILL_DIR/scripts/roi_ledger.js" report
```

Use it as a process-control signal:
- Positive CLV means prior picks moved in the recommended direction before close; keep thresholds.
- Negative CLV by category/risk bucket means the process is not beating later market prices; add 2 pp required edge for that bucket in this scan.
- Negative realized ROI with positive CLV can be variance; do not overfit unless there are at least 20 resolved picks in the bucket.
- Negative realized ROI and negative CLV means the bucket is failing; drop that bucket or require HIGH-risk-level edge.

After reporting final picks, append each recommended entry so future scans can measure calibration and CLV:

```bash
node "$SKILL_DIR/scripts/roi_ledger.js" add \
  --slug SLUG \
  --bet OUTCOME \
  --entry ENTRY_DECIMAL \
  --fair ADJUSTED_FAIR_DECIMAL \
  --risk LOW_OR_MED_OR_HIGH \
  --category CATEGORY \
  --url URL
```

---

### STEP 7 — Final Ranked Output

Print a clean ranked list of the **top 10 actionable picks**, sorted by the STEP 6.5 finance ranking.

Format each pick as:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#N  [RISK TIER EMOJI]  CATEGORY
TITLE
Bet: OUTCOME  |  Entry: XX%  |  Raw fair: XX%  |  Adj fair: XX%  |  Edge: +X.Xpp  |  EV yield: +X.X%
Max profit yield: +X.X%  |  EV/day: +X.XX%  |  Max entry: XX%  |  Stake: X.X% bankroll
Capital horizon: X.Xd to RESOLUTION_DATE  |  Volume: $XXX,XXX  |  Book: BID/ASK, spread X.Xpp, +2pp depth $XXX
Score: XXXX  |  https://polymarket.com/event/{event-slug}

RESEARCH:
• [Source 1: finding with outlet name]
• [Source 2: finding with outlet name]
• [TA/Team note: technical or team context — e.g. "RSI 42, below 50d MA, no scheduled catalyst" or "Sabres -130 at books, 4-game win streak, Islanders missing Horvat/Palmieri/Romanov"]
• Bear case: [one line — the most likely way this bet loses]
• Misprice thesis: [one line — why Polymarket is underpricing this outcome]
• Finance verdict: [one line — why the yield/time/liquidity justify tying up capital]
• Verdict: [one line — why bear case is outweighed, citing the evidence]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then print a **Portfolio Summary**:

```
PORTFOLIO SUMMARY (equal-weight)
─────────────────────────────────
Markets selected:   N
Avg probability:    XX%
Avg edge:           +X.Xpp
Avg EV yield:       +X.X%
Avg EV/day:         +X.XX%
Avg capital horizon: X.Xd
Expected return:    +X.X% on suggested sizing over ~Xd
Positions excluded:  N exact holds + N overlapping markets
Researched:         R / S surviving candidates (XX%)
Data freshness:     [snapshot timestamp + anchored now]
```

If `Researched` is below 80%, append a one-line warning: `⚠ Coverage incomplete — N candidates skipped without research.` Coverage gaps are a process bug, not a feature.

---

## Key Rules

These apply across all steps — they exist because edge cases here have historically caused bad picks:

- **Output is recommendations only** — never mention markets that were dropped, skipped, or disqualified.
- **Positive EV and time value beat high win probability** — a 90% market with fair probability 91% is usually worse than a 76% market with fair probability 84%, and a long capital lockup can make an otherwise positive-EV bet less attractive than a faster one.
- **No finance case, no bet** — every final pick needs executable entry price, raw fair probability, adjusted fair probability, edge, EV yield, max profit yield, EV/day, capital horizon, max entry, and suggested size. Missing fields mean the pick is not actionable.
- **Never chase above max entry** — if the price moves past max_entry_price while writing the answer, remove the pick or mark it as stale, not actionable.
- **Size by edge and uncertainty** — use the fractional-Kelly cap in STEP 6.5; do not equal-weight HIGH and LOW risk picks.
- **Crypto is excluded at the scoring stage** — apply the filter in STEP 2 so they never enter the pipeline at all.
- **Executable prices override display prices** — use CLOB best ask when available, then Gamma `outcomePrices` only as fallback. Stale cache probabilities can be many hours old.
- **Question deadline overrides misleading API endDate** — if the title says "by June 30" and `endDate` says May 31, compute capital horizon from June 30 and keep `acceptingOrders`/book data separate from resolution timing.
- **daysLeft ≤ 0** — include only if 2+ sources confirm the outcome is already locked; otherwise drop.
- **Geopolitical markets** (Israel, Iran, Houthi, Yemen, Russia, Gaza): verify with wire service + regional source — conflict state changes hourly.
- **Commodity price markets within 8% of strike during active conflict**: drop — too much tail risk from sudden moves.
- **Sports with daysLeft < 0.5**: verify game status from 2 sources; drop if in-progress or outcome unconfirmed.
- **Multi-bucket markets** (tweet counts, score ranges): check live prices for all sibling buckets before recommending any.
- **Edge-aligned prioritization** — When ranking is close, prefer: Trump/celebrity/tweet-count markets (historically high hit rate), Serie A and La Liga sports picks, and esports BO3 matches. Deprioritize: Premier League matches (outcome variance exceeds pricing), geopolitical timing bets with deadline < 24h (timing risk kills edge), and multi-candidate speculative election markets.
