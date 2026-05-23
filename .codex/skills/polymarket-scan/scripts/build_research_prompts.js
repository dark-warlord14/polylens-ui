#!/usr/bin/env node
// Usage: node build_research_prompts.js --candidates <jsonl> --positions <json> [--max N] [--now ISO]
//
// Enriches broad candidates with live Gamma metadata, executable CLOB books,
// price-history/trade-flow hints, then emits subagent prompts for independent
// probability research. Polymarket price is treated only as entry price.

const fs = require('fs');
const https = require('https');
const {
  parseJsonArray,
  pickResolutionDeadline,
  daysUntil,
  summarizeExecution,
  classifyResearchBucket,
  requiredEdgePp,
  grossYield,
  scoreCandidate,
} = require('./capital_roi');

const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
};

const candidatesPath = get('--candidates', null);
const positionsPath = get('--positions', null);
const MAX = parseInt(get('--max', '50'), 10);
const MAX_SPREAD_PP = parseFloat(get('--max-spread-pp', '4'));
const MIN_LIQUIDITY = parseFloat(get('--min-liquidity', '0'));
const NOW_OVERRIDE = get('--now', null);
const NOW_MS = NOW_OVERRIDE ? Date.parse(NOW_OVERRIDE) : Date.now();

if (!candidatesPath) {
  console.error('Missing --candidates <path>');
  process.exit(1);
}
if (Number.isNaN(NOW_MS)) {
  console.error('Invalid --now value:', NOW_OVERRIDE);
  process.exit(1);
}

function requestJson(method, host, path, body = null, timeoutMs = 8000) {
  return new Promise(resolve => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      host,
      path,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function gammaFetch(slug) {
  return requestJson('GET', 'gamma-api.polymarket.com', `/markets?slug=${encodeURIComponent(slug)}&limit=1`)
    .then(arr => arr && arr[0] ? arr[0] : null);
}

function batchBooks(tokenIds) {
  const unique = [...new Set(tokenIds.filter(Boolean))];
  if (!unique.length) return Promise.resolve(new Map());
  return requestJson('POST', 'clob.polymarket.com', '/books', unique.map(token_id => ({ token_id })))
    .then(rows => {
      const map = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        map.set(String(row.asset_id || row.token_id), row);
      }
      return map;
    });
}

function batchPriceHistory(tokenIds) {
  const unique = [...new Set(tokenIds.filter(Boolean))].slice(0, 20);
  if (!unique.length) return Promise.resolve(new Map());
  const endTs = Math.floor(NOW_MS / 1000);
  const startTs = endTs - 24 * 3600;
  return requestJson('POST', 'clob.polymarket.com', '/batch-prices-history', {
    markets: unique,
    start_ts: startTs,
    end_ts: endTs,
    interval: '1h',
    fidelity: 60,
  }).then(data => {
    const map = new Map();
    const history = data && data.history ? data.history : {};
    for (const [tokenId, points] of Object.entries(history)) map.set(String(tokenId), points || []);
    return map;
  });
}

function tradesFetch(conditionId) {
  if (!conditionId) return Promise.resolve([]);
  return requestJson('GET', 'data-api.polymarket.com', `/trades?market=${encodeURIComponent(conditionId)}&limit=50&takerOnly=false`)
    .then(rows => Array.isArray(rows) ? rows : []);
}

function loadCandidates() {
  const rows = [];
  for (const line of fs.readFileSync(candidatesPath, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { rows.push(JSON.parse(s)); } catch { /* ignore */ }
  }
  return rows;
}

function loadPositions() {
  if (!positionsPath || !fs.existsSync(positionsPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(positionsPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const STOP = new Set([
  'will', 'the', 'a', 'an', 'of', 'on', 'in', 'to', 'for', 'by', 'be', 'is', 'are',
  'and', 'or', 'this', 'that', 'at', 'from', 'with', 'as', 'vs', 'vs.', 'win',
  'lose', 'more', 'less', 'yes', 'no',
]);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOP.has(t));
}

function semanticOverlap(candidate, positions) {
  const cTok = new Set(tokens(`${candidate.title} ${candidate.eventTitle || ''}`));
  for (const p of positions) {
    if (p.slug && candidate.slug && p.slug === candidate.slug) return true;
    const pTok = tokens(`${p.title || p.market || ''}`);
    let shared = 0;
    for (const t of pTok) if (cTok.has(t)) shared++;
    const sameDir = String(candidate.bet || '').toLowerCase() === String(p.outcome || '').toLowerCase();
    if (shared >= 3 && sameDir) return true;
  }
  return false;
}

function intraDedupe(list) {
  const seen = new Map();
  for (const c of list) {
    const key = `${c.conditionId || c.eventSlug || c.slug}::${String(c.bet || '').toLowerCase()}`;
    const prev = seen.get(key);
    if (!prev || (c.score || 0) > (prev.score || 0)) seen.set(key, c);
  }
  return [...seen.values()];
}

function summarizeHistory(points, entryProb) {
  const rows = Array.isArray(points) ? points : [];
  const values = rows
    .map(p => parseFloat(p.p || p.price || p.value || p.y))
    .filter(Number.isFinite);
  if (values.length < 2) return { priceMove24hPp: null, historyPoints: values.length };
  return {
    priceMove24hPp: (entryProb / 100 - values[0]) * 100,
    historyPoints: values.length,
  };
}

function summarizeTrades(rows, tokenId) {
  const recent = Array.isArray(rows) ? rows : [];
  if (!recent.length) return { recentTrades: 0, latestTradeTs: null, avgTradePrice: null, tokenTradeCount: 0 };
  const tokenRows = recent.filter(r => !tokenId || String(r.asset) === String(tokenId));
  const prices = tokenRows.map(r => parseFloat(r.price)).filter(Number.isFinite);
  const avgTradePrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const latest = recent.map(r => parseInt(r.timestamp, 10)).filter(Number.isFinite).sort((a, b) => b - a)[0] || null;
  return {
    recentTrades: recent.length,
    latestTradeTs: latest,
    avgTradePrice,
    tokenTradeCount: tokenRows.length,
  };
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'UNKNOWN';
}

function buildPrompt(c, live) {
  const betUrl = `https://polymarket.com/market/${c.slug}`;
  const eventUrl = live.eventUrl || `https://polymarket.com/event/${c.eventSlug || c.slug}`;
  return `You have WebSearch and WebFetch tools. You MUST use them. Do not return DROP without at least 3 attempted searches across 2+ independent sources.

Polymarket capital-ROI bet research. Treat Polymarket price only as executable entry price, not as the probability estimate.

Title: ${c.title}
Slug: ${c.slug}
Bet outcome: ${c.bet}
Category: ${c.category}
Research bucket: ${live.bucket}
Resolution source: ${c.resolutionSource || live.resolutionSource || 'UNKNOWN'}
Exact bet URL: ${betUrl}
Event URL: ${eventUrl}

EXECUTION / MARKET DATA
Displayed probability: ${fmt(live.displayProb)}%
Executable entry price: ${fmt(live.entryProb)}%
Entry source: ${live.executionSource}
Best bid / ask: ${fmt(live.bestBidPct)}% / ${fmt(live.bestAskPct)}%
Spread: ${fmt(live.spreadPp, 2)} pp
Ask depth within +2pp: $${fmt(live.askDepth2ppUsd, 0)}
Volume / 24h volume / liquidity: $${(c.volume || 0).toLocaleString()} / $${(c.volume24hr || 0).toLocaleString()} / $${(c.liquidity || 0).toLocaleString()}
24h price move: ${fmt(live.priceMove24hPp, 2)} pp over ${live.historyPoints || 0} history points
Recent trades: ${live.recentTrades || 0}; token trades: ${live.tokenTradeCount || 0}; avg token trade price: ${fmt(live.avgTradePrice ? live.avgTradePrice * 100 : null)}%

CAPITAL / ROI
Capital horizon days: ${fmt(live.capitalHorizonDays, 2)}
Resolution deadline: ${live.resolutionDeadline || 'UNKNOWN'}
Gross max profit yield: ${fmt(live.grossProfitYield * 100, 2)}%
Gross max profit/day: ${fmt(live.grossProfitPerDay * 100, 2)}%
Required edge before recommendation: ${fmt(live.requiredEdgePp, 2)} pp

RESEARCH FRAMEWORK
Estimate rawFairProb from independent research BEFORE comparing it to the ${fmt(live.entryProb)}% entry price. Research all material components:
- current factual state and exact resolution criteria
- base rates and historical analogs
- scheduled catalysts before resolution
- actor/team/company incentives and constraints
- counter-evidence and strongest bear case
- sibling Polymarket markets, off-platform odds/data, price movement, and trade-flow clues

Bucket checklist:
- confirmed/result-lag: require official result or 2 independent sources; fair prob can be 97-99% only if locked.
- sports/game/event: injuries/lineups, recent form, matchup, rest, venue, motivation, bookmaker line movement.
- election/politics: official polls/results, turnout, endorsements, field structure, deadlines, legal/process risk.
- geopolitics/conflict: wire service plus regional/official source inside 24h; identify all actors that must agree or refrain.
- finance/crypto/commodity/rates: live spot/threshold, volatility/ATR, support/resistance, catalysts, market hours, oracle source.
- weather/stat/observable metric: official measurement source, current value, forecast/model spread, threshold distance.
- culture/awards/entertainment: official releases, eligibility, betting/critic markets, announcements schedule, fanbase/manipulation risk.
- neg-risk multi-outcome: sibling outcome sums, mutually exclusive logic, hidden "other" risk, conversion/economic equivalence.

ROI math to return if and only if research supports a bet:
- evidenceReliability: 0.85 locked/official; 0.70 multiple strong current sources; 0.50 one primary plus support; 0.30 subjective/fast-moving.
- adjustedFairProb = entryProb + evidenceReliability * (rawFairProb - entryProb)
- edge_pp = adjustedFairProb - entryProb
- EV_yield = adjustedFairProb / entryProb - 1
- EV_per_day = EV_yield / capitalHorizonDays
- max_entry_price = adjustedFairProb - required_edge_pp

Return ONE of:
- GRADED PICK: risk tier + exact bet URL + rawFairProb + evidenceReliability + adjustedFairProb + edge_pp + EV_yield + EV_per_day + max_entry_price + capital horizon + 3 source bullets + bear case + why this beats alternative capital deployment, <=300 words
- DROP: one-line reason

Drop if fair probability is not independently defensible, edge is below ${fmt(live.requiredEdgePp, 2)} pp, live price is above max entry, spread/depth makes entry unrealistic, or the capital horizon makes EV/day unattractive.`;
}

(async () => {
  const candidates = loadCandidates();
  const positions = loadPositions();
  let pool = intraDedupe(candidates.filter(c => !semanticOverlap(c, positions))).slice(0, MAX * 2);

  const gammaRows = await Promise.all(pool.map(async c => ({ c, m: await gammaFetch(c.slug) })));
  const liveBase = [];
  for (const { c, m } of gammaRows) {
    if (!m || m.closed || m.active === false || m.acceptingOrders === false) continue;
    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices);
    const tokenIds = parseJsonArray(m.clobTokenIds);
    const idx = outcomes.findIndex(o => String(o || '').toLowerCase() === String(c.bet || '').toLowerCase());
    if (idx < 0 || !tokenIds[idx]) continue;
    const displayProb = parseFloat(prices[idx]) * 100;
    if (!Number.isFinite(displayProb)) continue;
    liveBase.push({ c, m, idx, tokenId: String(tokenIds[idx]), displayProb });
  }

  const books = await batchBooks(liveBase.map(x => x.tokenId));
  const histories = await batchPriceHistory(liveBase.map(x => x.tokenId));
  const tradeRows = await Promise.all(liveBase.map(x => tradesFetch(x.m.conditionId || x.c.conditionId)));
  const enriched = [];

  for (let i = 0; i < liveBase.length; i++) {
    const { c, m, tokenId, displayProb } = liveBase[i];
    const execution = summarizeExecution(books.get(tokenId), displayProb, tokenId);
    if (!Number.isFinite(execution.entryProb)) continue;
    if (Number.isFinite(MAX_SPREAD_PP) && Number.isFinite(execution.spreadPp) && execution.spreadPp > MAX_SPREAD_PP) continue;
    if (Number.isFinite(MIN_LIQUIDITY) && (c.liquidity || 0) < MIN_LIQUIDITY) continue;

    const resolutionDeadline = pickResolutionDeadline(m, c, NOW_MS);
    const capitalHorizonDays = daysUntil(resolutionDeadline, NOW_MS);
    if (!Number.isFinite(capitalHorizonDays)) continue;

    const bucket = classifyResearchBucket(c, m, NOW_MS);
    const gy = grossYield(execution.entryProb);
    const event = Array.isArray(m.events) && m.events[0] ? m.events[0] : null;
    const history = summarizeHistory(histories.get(tokenId), execution.entryProb);
    const trades = summarizeTrades(tradeRows[i], tokenId);
    const required = requiredEdgePp(execution.entryProb, bucket, execution.executionPenaltyPp);
    const liveScore = scoreCandidate({
      entryProb: execution.entryProb,
      volume: c.volume,
      volume24hr: c.volume24hr,
      liquidity: c.liquidity,
      capitalHorizonDays,
      spreadPp: execution.spreadPp,
      askDepth2ppUsd: execution.askDepth2ppUsd,
    });

    enriched.push({
      c,
      live: {
        displayProb,
        entryProb: execution.entryProb,
        executionSource: execution.source,
        bestBidPct: execution.bestBidPct,
        bestAskPct: execution.bestAskPct,
        bestAskSize: execution.bestAskSize,
        spreadPp: execution.spreadPp,
        askDepth2ppUsd: execution.askDepth2ppUsd,
        executionPenaltyPp: execution.executionPenaltyPp,
        tokenId,
        capitalHorizonDays,
        resolutionDeadline,
        grossProfitYield: gy,
        grossProfitPerDay: gy / Math.max(1 / 24, capitalHorizonDays),
        requiredEdgePp: required,
        eventUrl: event && event.slug ? `https://polymarket.com/event/${event.slug}` : null,
        bucket,
        resolutionSource: m.resolutionSource || (event && event.resolutionSource),
        score: liveScore,
        ...history,
        ...trades,
      },
    });
  }

  enriched.sort((a, b) => b.live.score - a.live.score);
  const survivors = enriched.slice(0, MAX);
  console.log(`SURVIVORS: ${survivors.length} (from ${candidates.length} candidates, ${pool.length} after overlap+dedupe)`);
  survivors.forEach(({ c, live }, i) => {
    console.log(`\n===CANDIDATE ${i + 1}===`);
    console.log(buildPrompt(c, live));
  });
})();
