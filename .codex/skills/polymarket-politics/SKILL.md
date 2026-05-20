---
name: polymarket-politics
description: Scan Polymarket for the best global politics bets expiring in 1-14 days (Politics, Elections, Geopolitics, World, International Affairs, Society categories) in the 55-80% probability range. Validates picks with wire services and regional sources, grills each pick adversarially, skips markets the user already holds, and ranks by ROI vs. risk. Use this skill whenever the user asks about political markets, elections, geopolitical bets, world events, international politics opportunities, global conflicts, regional elections, international summits, referendums, leadership changes, sanctions, or says things like "what's happening politically", "any election bets", "good geopolitics plays", "scan politics markets", "what's going on in [country/region]", or "any good global events" — even if they don't say "Polymarket" explicitly.
---

# Polymarket Politics Scan — Global Politics & Elections (1–14 Days)

## Purpose

Find the highest ROI, lowest-risk political markets expiring within 14 days where:
- Category is **Politics**, **Elections**, **Geopolitics**, **World**, **International Affairs**, or **Society**
- Probability sits in the **55–80% sweet spot** (ROI: 25–82%)
- Volume is meaningful (≥ $5,000 by default)
- At least **2 independent, authoritative sources** support the current pricing — or reveal a misprice
- Independent fair probability exceeds live Polymarket price by enough margin to justify the uncertainty
- The user does **not already hold** a position in this market

## Arguments

Parse optional flags from the user's request:
- `--days N` → filter daysLeft ≤ N (default: 7, max: 14)
- `--min-vol N` → minimum volume in USD (default: 5000)
- `--min-edge N` → minimum fair-probability edge in percentage points (default: dynamic by risk/price)
- `--bankroll N` → optional bankroll in USD for suggested sizing; if omitted, report stake as bankroll percentage only

---

## Execution Steps

### STEP 0 — Anchor current time

Run `node -e "console.log(new Date().toISOString())"` and treat that ISO string as the authoritative "now" for the entire scan. Do **NOT** trust any date appearing in system reminders, cached `daysLeft`, or your own assumptions. Every "expired / live" decision in later steps must compare against this anchored value.

Sanity check: if at any point you find yourself dropping >40% of top-30 candidates as "already expired", re-anchor `now` first — you almost certainly have the wrong date.

---

### STEP 0.5 — Fetch User's Active Positions (Subagent)

Spawn a subagent to fetch the user's current open positions in parallel with STEP 1. This prevents recommending markets the user already holds.

```
GET https://data-api.polymarket.com/positions?user=0x80574dc5417bd3f3dd2464fce9cf397622c5b732&sizeThreshold=.1&limit=100&offset=0
```

Extract from each position: `market` (slug/condition ID), `title`, `outcome`. Store as `userPositions`.

Build a `userEntityIndex` for semantic overlap detection: for each held position's `title`, extract key entities — country/region names, person names, political party/office names, bill/treaty names. Store as a flat list of lowercased tokens per slug.

If the API errors or returns empty, proceed without the filter and note "Could not fetch user positions" in the portfolio summary.

---

### STEP 1 — Fetch Latest Data Locally

Run the sync script from the project root to fetch fresh Polymarket data directly from the Gamma API. This writes `src/data/cache.json` and `src/data/market_map.json` in real time — no reliance on CI cadence or git state.

```bash
npm run sync
```

Report the result (markets fetched, opportunities saved, or error). If sync fails, switch to live Gamma API lookups for candidate prices and clearly mark the cache as stale; do not pretend the local snapshot is current.

---

### STEP 2 — Extract & Score Markets

Run the bundled script with arguments parsed above. Resolve `SKILL_DIR` to this skill's directory. In this repo, use `SKILL_DIR=".codex/skills/polymarket-politics"`; after global installation, use `SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/polymarket-politics"`:

```bash
node "$SKILL_DIR/scripts/extract_politics.js" \
  --days MAX_DAYS \
  --min-vol MIN_VOL \
  --now ANCHORED_NOW_ISO
```

This returns Politics, Elections, Geopolitics, World, International Affairs, and Society category markets. Parse the JSON lines to get the top 30 candidates.

Cross-reference against `userPositions` from STEP 0.5 using two filters (both silent drops, tracked separately):
1. **Slug match** — exact slug in userPositions → drop
2. **Semantic overlap** — extract key entities from candidate title (country, person, party, bill, treaty); apply the following tiered logic:
   - **Same parent event** (same `eventSlug` as a held position) → always drop; different seat/percentage brackets of the same election or same event are highly correlated
   - **≥ 3 entities match** a held position's entity list → drop; this signals the same geopolitical situation, same actors, same timeframe
   - **Exactly 2 entities match** → keep **only if** the resolution question is meaningfully different (e.g., "ceasefire extension" vs. "permanent peace deal", "party A wins seats" vs. "party B wins seats" in a different race). Note the correlation in the output under RESEARCH. Drop if the question is asking the same thing in different words.

Track counts for Portfolio Summary: `slugExcluded` and `semanticExcluded`.

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

Store `liveProb` and `eventUrl` per candidate. Drop any candidate where the live price has shifted outside 55–80%.

Fetch the executable CLOB order book for the candidate outcome token:

```bash
curl "https://clob.polymarket.com/book?token_id=OUTCOME_TOKEN_ID"
```

Use the best ask as `entryProb` when available. If no order book is available, use Gamma `outcomePrices` only as a fallback and require an extra 2 pp of edge. Record best bid, best ask, spread, best ask size, and approximate ask depth within +2 pp.

Treat `entryProb` as the entry price, not as evidence. The goal is not to find political outcomes that are merely likely; it is to find outcomes where current evidence supports an adjusted fair probability materially above the executable entry price.

---

### STEP 4 — Group Candidates by Sub-Type

Organise remaining candidates into buckets to guide targeted research:

| Bucket | Examples | Key question |
|--------|----------|--------------|
| **Election outcome** | Presidential/parliamentary vote results | Is the result already called or polling showing a clear winner? |
| **Political decision** | Will X sign Y / appoint Z / pass bill | Any official announcements or credible leaks in the last 24h? |
| **Geopolitical event** | Ceasefire, sanctions, treaty signing, military action | What do wire services say about current state? |
| **Leadership/status** | Will X remain in office / be arrested / resign | Is there any active credible threat to the current status quo? |
| **International affairs / society** | Referendums, mass protests, international summits, state visits, international org decisions (UN, NATO, EU, AU, ASEAN) | Is there an official scheduled date or vote? What are the latest official statements? |

---

### STEP 5 — Multi-Source Research Validation (Subagents)

Spawn parallel subagents grouped by the following six regions. Assign one subagent per group. Candidates with no clear regional affiliation (e.g. UN/NATO/G7 decisions) go to whichever region is most affected or to a dedicated "International Orgs" slot within an existing subagent.

| Subagent | Scope |
|----------|-------|
| **Americas** | USA, Canada, Mexico, Brazil, Argentina, rest of Latin America & Caribbean |
| **Europe** | EU member states, UK, Ukraine, Russia (European context), Balkans, Caucasus |
| **Middle East** | Israel, Palestine, Iran, Yemen, Saudi Arabia, Turkey, Gulf states, North Africa |
| **Africa** | Sub-Saharan Africa, Horn of Africa, West Africa, Southern Africa |
| **Asia-Pacific** | China, India, Japan, South Korea, Southeast Asia, Australia, Pacific Islands |
| **Central Asia & International** | Central Asia (Kazakhstan, Uzbekistan, etc.), international org decisions (UN, NATO, IMF, WTO, ASEAN, AU, OAS) |

For each of the **top 15 candidates by score**, validate using at least 2 independent, authoritative sources. Political information spreads fast and can be wrong — cross-source confirmation is what separates a real edge from noise.

Before recommending any candidate, estimate an independent raw fair probability from the sources and compare it to the executable entry price.

Shrink raw estimates toward the market before sizing or ranking:

```text
adjustedFairProb = entryProb + evidenceReliability * (rawFairProb - entryProb)
```

Use `adjustedFairProb`, not raw confidence, for EV math. Evidence reliability:

| Political evidence quality | Reliability |
|----------------------------|-------------|
| Official/certified result or 2+ primary sources | 0.85 |
| Wire service plus independent regional/official source | 0.70 |
| One strong source plus weaker corroboration | 0.50 |
| Polling-heavy, leak-driven, active negotiation, or conflict narrative | 0.30 |

Compute:

```text
edge_pp = adjustedFairProb - entryProb
EV_per_$ = adjustedFairProb / entryProb - 1
max_entry_price = adjustedFairProb - required_edge_pp
```

Default required edge:

| Political market type | Minimum edge |
|-----------------------|--------------|
| Result already called / official status quo with no credible threat | 4 pp |
| Polling consensus or single decision-maker with clear public signals | 6 pp |
| Multi-party negotiation, conflict zone, sanctions, resignations, arrests | 10 pp |
| Polling within margin of error or sources conflict | Drop |

If `edge_pp` is below the required edge, silently drop the market even if the outcome is more likely than not. If the live price is above `max_entry_price`, it is not an entry anymore.

Execution penalties:
- Add `max(0, spread_pp - 1)` to the required edge.
- If the best ask is missing, add 2 pp to the required edge and label the price as non-executable.
- If spread is >4 pp, drop unless adjusted edge is at least 2x the spread and the ask depth supports the intended stake.
- If the expected stake cannot be entered within +2 pp of best ask, size to available depth or drop.

#### Source tiers (use the highest tier available):

| Tier | Sources |
|------|---------|
| **Primary** | Official government announcements, election authority results, parliament records |
| **Wire services** | Reuters, AP, AFP, Bloomberg News — these are the baseline for political facts |
| **Regional authority** | BBC, Al Jazeera, DW, France24, local national outlets for the relevant country |
| **Analysis** | Foreign Policy, The Economist, Council on Foreign Relations, Politico Europe |

Using two Tier 1/2 sources is the gold standard. A single wire service + one regional outlet is acceptable. Two regional outlets without wire confirmation = 🔴 HIGH risk at best.

#### Research protocol per market type:

**Election outcome markets:**
- Search: `"[election name] [year] results"` + `"[election name] latest polling [month]"`
- If the vote is complete: require 2 sources reporting the certified or projected winner
- If voting is upcoming (daysLeft > 0): check the most recent polls, any polling aggregators, and whether there's a consensus or a tight race
- Note any structural factors: is this an incumbent advantage, a first-round vs. runoff situation, or a fragmented field?
- Flag if polls show the market probability diverges significantly from polling averages — that's a potential misprice in either direction

**Political decision markets (bills, appointments, signings):**
- Search: `"[decision] [country] [month year]"` + `"[bill/appointment] latest news"`
- Look for: official statements, credible journalist sourcing, leaked drafts or timelines
- Flag if no credible source mentions the decision at all — absence of news in a fast-moving political cycle is meaningful
- Note any scheduled votes, meetings, or deadlines that fall within the expiry window

**Geopolitical / conflict markets (ceasefire, sanctions, military action):**
- These move fast — verify with 2 wire services and note the timestamp of each source
- Check whether multiple parties need to agree (harder) vs. a single actor's decision (clearer)
- For ceasefire/peace markets: check if talks are active, stalled, or broken off. A stalled negotiation makes "ceasefire by [date]" much less likely than the market might imply.
- For sanctions markets: verify with government press releases + wire confirmation
- For military action markets: check both sides' official statements and independent reporting

**Leadership / status markets (will X remain in office, be arrested, resign):**
- These are structurally stable unless something has actively changed — confirm the current status first
- Search: `"[person] [country] [status] [month year]"` + any recent scandal/health/legal news
- If nothing has changed in the last week, a high probability of status quo is usually well-founded
- Flag immediately if there's any active legal proceeding, health news, or political crisis that could alter the status

**Misprice detection:** If 2+ authoritative sources strongly confirm an outcome but market probability is below 85%, flag as **POTENTIAL MISPRICE — underpriced edge** with the source evidence.

---

### STEP 5.5 — Prediction Grilling (2–3 Rounds)

Stress-test each candidate adversarially before finalizing. The goal is to surface the real risk, not rationalize the bet.

**Round 1 — Bear Case:**
Ask: *"What is the single most likely scenario where this bet loses?"*
- Elections: late-breaking scandal, surprise turnout effect, polling miss in a specific demographic
- Decisions: political horse-trading, unexpected coalition opposition, procedural delay
- Geopolitics: one party walks away from talks, escalation by a third actor, domestic political pressure blocks a deal
- If a plausible bear case exists with >30% probability, downgrade to 🔴 HIGH risk. Above 40%, silently drop.

**Round 2 — Data Integrity Check:**
- Is the research current? Political situations can flip in hours — verify source timestamps
- Do sibling markets (same event, different outcome brackets) contradict this pick? Check live prices of all outcomes in the same event.
- Does the implied probability from prediction markets (Metaculus, PredictIt, Manifold) align with Polymarket within 10%? A large divergence needs explanation.
- Has there been any significant line movement in the last 24h? Sharp money moving against the position is a red flag.
- Is the spread wide because the displayed price is stale or not executable? Use the CLOB best ask, not midpoint or last trade.
- Why is Polymarket wrong? State the specific misprice thesis: stale public information, low-liquidity lag, official result not priced in, polling/market divergence, or overreaction to old news. If there is no concrete reason, drop.

**Round 3 — Conviction Test:**
Complete this sentence: *"I am betting [outcome] because [specific evidence], and the bear case fails because [counter-evidence]."*
- If you cannot fill it with concrete evidence from named sources — not just "the market implies it" — do not include the pick.

Only picks that pass all 3 rounds proceed to STEP 6.

---

### STEP 6 — Risk Assessment

Assign a risk tier. Silently drop markets that don't meet inclusion criteria.

| Tier | Criteria |
|------|----------|
| 🟢 **LOW** | Result already called by official source or 2+ wire services / structurally stable status quo with no credible threat in window / polling consensus >10pp ahead; edge ≥ required edge |
| 🟡 **MEDIUM** | Likely based on polling/news but meaningful uncertainty remains / single credible decision-maker / depends on a scheduled vote within the window; edge ≥ required edge |
| 🔴 **HIGH** | Active conflict or fast-moving negotiation / polling near margin of error / depends on multiple parties agreeing; include only with edge ≥ 10 pp and exceptional evidence |

Silent drop criteria (never mention in output):
- daysLeft ≤ 0 and outcome not confirmed by 2+ authoritative sources
- volume < $5,000
- Active conflict zones where situation is changing hourly and no consensus exists
- User already holds a position in this market
- Any market where the 2 sources actively contradict each other on the core fact
- fairProb cannot be justified from named current sources
- edge_pp below the required edge for the political-risk bucket
- EV_per_$ ≤ 0 after fair-probability estimate
- live price exceeds max_entry_price
- Order book/spread appears too thin to enter near the quoted live price
- adjustedFairProb after evidence-reliability shrinkage no longer clears the edge threshold

---

### STEP 6.5 — Position Sizing & Ranking

Normalize every surviving pick to:

```text
liveProb
entryProb
rawFairProb
evidenceReliability
adjustedFairProb
edge_pp = adjustedFairProb - entryProb
EV_per_$ = adjustedFairProb / entryProb - 1
max_entry_price
riskTier
```

Drop any incomplete pick. Suggested sizing is fractional Kelly with strict caps:

```text
kelly_fraction = (adjustedFairProb - entryProb) / (1 - entryProb)
suggested_fraction = 0.25 * kelly_fraction
```

Cap suggested size at 3% bankroll for LOW, 1.5% for MEDIUM, and 0.5% for HIGH. If `--bankroll` was provided, convert the capped percentage to USD. Otherwise report the capped percentage only.

Rank by `risk tier (LOW first) → EV_per_$ desc → edge_pp desc`, not raw probability.

### STEP 6.6 — ROI Feedback Loop

Before finalizing, run the shared scan ledger report if it exists:

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/polymarket-scan/scripts/roi_ledger.js" report
```

Use it as a process-control signal:
- Positive CLV means prior picks moved in the recommended direction before close; keep thresholds.
- Negative CLV by political risk bucket means the process is not beating later market prices; add 2 pp required edge for that bucket in this scan.
- Negative realized ROI with positive CLV can be variance; do not overfit unless there are at least 20 resolved picks in the bucket.
- Negative realized ROI and negative CLV means the bucket is failing; drop that bucket or require HIGH-risk-level edge.

After reporting final picks, append each recommended entry so future scans can measure calibration and CLV:

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/polymarket-scan/scripts/roi_ledger.js" add \
  --slug SLUG \
  --bet OUTCOME \
  --entry ENTRY_DECIMAL \
  --fair ADJUSTED_FAIR_DECIMAL \
  --risk LOW_OR_MED_OR_HIGH \
  --category Politics \
  --url URL
```

### STEP 7 — Final Ranked Output

Print a clean ranked list of the **top 10 actionable picks**, sorted by the STEP 6.5 ranking.

Format each pick as:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#N  [RISK TIER EMOJI]  CATEGORY  |  REGION/COUNTRY
TITLE
Bet: OUTCOME  |  Entry: XX%  |  Raw fair: XX%  |  Adj fair: XX%  |  Edge: +X.Xpp  |  EV: +X.X%/$
Max entry: XX%  |  Stake: X.X% bankroll  |  Volume: $XXX,XXX  |  Expires: X.Xd
Score: XXXX  |  https://polymarket.com/event/{event-slug}

RESEARCH:
• [Source 1: finding with outlet name + timestamp if available]
• [Source 2: finding with outlet name + timestamp if available]
• [Context note: polling gap / structural factor / recent development]
• Bear case: [one line — the most likely way this bet loses]
• Misprice thesis: [one line — why Polymarket is underpricing this outcome]
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
Avg EV per $:       +X.X%
Expected return:    +X.X% on suggested sizing over ~Xd
Excluded (slug match):     N exact position duplicates
Excluded (semantic match): N overlapping exposure markets
Data freshness:     [git pull result + snapshot timestamp]
```

---

## Key Rules

- **Output is recommendations only** — never mention markets that were dropped, skipped, or disqualified.
- **Positive EV beats high win probability** — a political outcome can be likely and still be a bad bet if the market is already pricing it correctly.
- **No edge, no bet** — every final pick needs executable entry price, raw fair probability, adjusted fair probability, edge, EV, max entry, and suggested size. Missing fields mean the pick is not actionable.
- **Never chase above max entry** — if the price moves past max_entry_price while writing the answer, remove the pick or mark it as stale, not actionable.
- **Size by edge and uncertainty** — use the fractional-Kelly cap in STEP 6.5; do not equal-weight HIGH and LOW risk picks.
- **Executable prices override display prices** — use CLOB best ask when available, then Gamma `outcomePrices` only as fallback. Stale cache probabilities can be many hours old.
- **Source timestamps matter** — political situations evolve hourly. A Reuters article from 3 days ago may be irrelevant. Note when each source was published.
- **Geopolitical markets in active conflict zones** (Russia/Ukraine, Israel/Gaza, Iran, Sudan, etc.): require wire service + regional source published within the last 24h. Drop if no current reporting exists.
- **daysLeft ≤ 0** — include only if 2+ authoritative sources confirm the outcome is already locked.
- **Conflicting authoritative sources** — if Reuters and AP contradict each other on a core fact, drop the market. The uncertainty is real and the market can't be reliably called.
- **Prediction market divergence** — if Polymarket is >10% away from Metaculus, PredictIt, or Manifold on the same question, investigate why before including. It's either a misprice edge or a reason to be cautious.
