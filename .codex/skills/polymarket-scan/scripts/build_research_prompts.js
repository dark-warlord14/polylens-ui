#!/usr/bin/env node
// Usage: node build_research_prompts.js --candidates <jsonl> --positions <json> [--max N]
//
// Reads scored candidates (JSON lines from extract_markets.js stdout — anything that
// is not a JSON object on its own line is ignored), reads the user's open positions
// (raw response from data-api.polymarket.com/positions), drops exact-slug overlaps
// and obvious semantic overlaps, fetches LIVE prices via Gamma for each survivor,
// drops anything outside 70-90%, fetches the CLOB order book when possible so
// entry price is based on executable best ask instead of displayed probability,
// classifies into a research bucket, and emits one ready-to-paste subagent
// prompt per surviving candidate to stdout, separated by `===CANDIDATE n===`
// markers.
//
// The orchestrator's only job afterwards is: read the file, dispatch one Agent call
// per block, in parallel.

const fs = require('fs');
const https = require('https');

// ---------- args ----------
const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
};
const candidatesPath = get('--candidates', null);
const positionsPath  = get('--positions', null);
const MAX = parseInt(get('--max', '30'), 10);
if (!candidatesPath) {
  console.error('Missing --candidates <path>');
  process.exit(1);
}

// ---------- load candidates ----------
const candidates = [];
for (const line of fs.readFileSync(candidatesPath, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s.startsWith('{')) continue;
  try { candidates.push(JSON.parse(s)); } catch { /* ignore */ }
}

// ---------- load positions ----------
let positions = [];
if (positionsPath && fs.existsSync(positionsPath)) {
  try {
    positions = JSON.parse(fs.readFileSync(positionsPath, 'utf8')) || [];
  } catch { positions = []; }
}
const heldSlugs = new Set(positions.map(p => p.slug).filter(Boolean));

// ---------- overlap helpers ----------
const STOP = new Set([
  'will','the','a','an','of','on','in','to','for','by','be','is','are','and','or',
  'this','that','at','from','with','as','vs','vs.','will','win','lose','more','less',
]);
const tokens = s => (s || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter(t => t && !STOP.has(t));

function semanticOverlap(candidate) {
  const cTok = new Set(tokens(candidate.title));
  for (const p of positions) {
    const pTok = tokens(p.title);
    let shared = 0;
    for (const t of pTok) if (cTok.has(t)) shared++;
    if (shared >= 3) {
      // same direction check: bet text matches outcome text
      const sameDir = (candidate.bet || '').toLowerCase() === (p.outcome || '').toLowerCase();
      if (sameDir) return true;
    }
  }
  return false;
}

// ---------- intra-candidate dedupe by event/direction ----------
function intraDedupe(list) {
  const seen = new Map(); // key -> best candidate
  for (const c of list) {
    // Strip trailing bucket-like suffixes for grouping (e.g. -260-279, -16c, -spread-home-2pt5)
    const eventKey = (c.slug || '')
      .replace(/-\d+(pt\d+)?(-[a-z]+)?$/i, '')
      .replace(/-(yes|no|over|under|draw)$/i, '');
    const key = `${eventKey}::${(c.bet || '').toLowerCase()}`;
    const prev = seen.get(key);
    if (!prev || (c.score || 0) > (prev.score || 0)) seen.set(key, c);
  }
  return [...seen.values()];
}

// ---------- gamma fetch ----------
function gammaFetch(slug) {
  return new Promise(resolve => {
    const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`;
    https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const arr = JSON.parse(body);
          resolve(arr && arr[0] ? arr[0] : null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function clobBookFetch(tokenId) {
  return new Promise(resolve => {
    if (!tokenId) return resolve(null);
    const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;
    https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeBookSide(side, direction) {
  const rows = Array.isArray(side) ? side : [];
  const sorted = rows
    .map(level => ({
      price: parseFloat(level.price),
      size: parseFloat(level.size),
    }))
    .filter(level => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0);
  sorted.sort((a, b) => direction === 'bid' ? b.price - a.price : a.price - b.price);
  return sorted;
}

function summarizeExecution(book, displayProb, tokenId) {
  const bids = normalizeBookSide(book && book.bids, 'bid');
  const asks = normalizeBookSide(book && book.asks, 'ask');
  const bestBid = bids[0] && bids[0].price;
  const bestAsk = asks[0] && asks[0].price;
  const bestAskSize = asks[0] && asks[0].size;
  const spread = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? bestAsk - bestBid : null;
  const askDepth2pp = Number.isFinite(bestAsk)
    ? asks
        .filter(level => level.price <= bestAsk + 0.02)
        .reduce((sum, level) => sum + (level.price * level.size), 0)
    : null;
  const entryProb = Number.isFinite(bestAsk) ? bestAsk * 100 : displayProb;
  const spreadPp = Number.isFinite(spread) ? spread * 100 : null;
  const executionPenaltyPp = Number.isFinite(spreadPp) ? Math.max(0, spreadPp - 1) : 2;
  return {
    tokenId,
    source: Number.isFinite(bestAsk) ? 'CLOB best ask' : 'Gamma outcomePrices fallback',
    entryProb,
    displayProb,
    bestBidPct: Number.isFinite(bestBid) ? bestBid * 100 : null,
    bestAskPct: Number.isFinite(bestAsk) ? bestAsk * 100 : null,
    bestAskSize: Number.isFinite(bestAskSize) ? bestAskSize : null,
    spreadPp,
    askDepth2ppUsd: Number.isFinite(askDepth2pp) ? askDepth2pp : null,
    executionPenaltyPp,
  };
}

// ---------- bucket classification ----------
function classify(c, liveExpiryMs) {
  const title = (c.title || '').toLowerCase();
  const now = Date.now();
  if (liveExpiryMs && liveExpiryMs < now) return 'Already-occurred';
  if (/\b(price|index|level|spx|nasdaq|btc|eth|stock|usd|eur|yield|cpi|inflation|count|tweets|posts|temperature|°c|degrees)\b/.test(title)) {
    return 'Verifiable facts';
  }
  if (/\bvs\.?\b|game|match|election|vote|launch|fight|round|cup|final|playoff|series/.test(title)) {
    return 'Event-pending';
  }
  return 'Structurally stable';
}

// ---------- prompt template ----------
function buildPrompt(c, live) {
  const url = live.eventUrl || `https://polymarket.com/markets/${c.slug}`;
  const entryProb = parseFloat(live.entryProb);
  const displayProb = parseFloat(live.displayProb);
  const baseMinEdge = entryProb >= 85 ? 3 : entryProb >= 75 ? 5 : 7;
  const minEdge = baseMinEdge + (Number.isFinite(live.executionPenaltyPp) ? live.executionPenaltyPp : 2);
  const maxEntryHint = Number.isFinite(entryProb) ? (entryProb + 1).toFixed(1) : 'UNKNOWN';
  const fmt = value => Number.isFinite(value) ? value.toFixed(1) : 'UNKNOWN';
  const fmt2 = value => Number.isFinite(value) ? value.toFixed(2) : 'UNKNOWN';
  return `You have WebSearch and WebFetch tools. You MUST use them. Do not return DROP without at least 3 attempted searches across 2+ independent sources.

Polymarket bet research.

Title: ${c.title}
Slug: ${c.slug}
Bet outcome: ${c.bet}
Displayed probability: ${fmt(displayProb)}%
Executable entry price: ${fmt(entryProb)}%
Entry source: ${live.executionSource}
Best bid / ask: ${fmt(live.bestBidPct)}% / ${fmt(live.bestAskPct)}%
Spread: ${fmt2(live.spreadPp)} pp
Best ask size: ${Number.isFinite(live.bestAskSize) ? live.bestAskSize.toFixed(2) : 'UNKNOWN'}
Ask depth within +2pp: $${Number.isFinite(live.askDepth2ppUsd) ? live.askDepth2ppUsd.toFixed(0) : 'UNKNOWN'}
Outcome token ID: ${live.tokenId || 'UNKNOWN'}
ROI: ${c.roi}%
Days left (live): ${live.liveDaysLeft.toFixed(2)}
Volume: $${(c.volume || 0).toLocaleString()}
Category: ${c.category}
Bucket: ${live.bucket}
URL: ${url}

Run the full research protocol for the "${live.bucket}" bucket from the polymarket-scan SKILL.md. Use 2+ independent sources. Then run 3-round grilling (bear case, data integrity, conviction). Then assign a risk tier (LOW / MED / HIGH).

ROI discipline:
- Estimate an independent raw fair probability from the evidence BEFORE comparing it to Polymarket's ${fmt(entryProb)}% executable entry price.
- Assign evidence_reliability: 0.85 official/locked result; 0.70 multiple current independent sources; 0.50 one primary plus secondary support; 0.30 subjective, polling-heavy, or fast-moving news.
- Compute adjusted_fair_probability = ${fmt(entryProb)} + evidence_reliability * (raw_fair_probability - ${fmt(entryProb)}). Use adjusted_fair_probability for all ROI math.
- Compute edge_pp = adjusted_fair_probability - ${fmt(entryProb)}.
- Require minimum edge of ${minEdge.toFixed(1)} percentage points (${baseMinEdge} pp base + ${fmt2(live.executionPenaltyPp)} pp execution/spread penalty). If edge_pp is lower, return DROP even if the bet is likely to win.
- Compute EV_per_$ = adjusted_fair_probability / ${fmt(entryProb)} - 1.
- Provide max_entry_price = adjusted_fair_probability - ${minEdge.toFixed(1)} percentage points. If live price is already above max_entry_price, return DROP.
- If spread > 4 pp, return DROP unless the edge is at least 2x the spread and ask depth supports the intended stake.
- Sanity check: a pick priced at ${fmt(entryProb)}% needs adjusted fair probability above ${(entryProb + minEdge).toFixed(1)}%; a max entry around ${maxEntryHint}% is not enough unless your fair probability supports it.

Return ONE of:
- GRADED PICK: risk tier + raw fair probability + evidence_reliability + adjusted fair probability + edge_pp + EV_per_$ + max_entry_price + 3 sourced bullets + bear case + verdict, ≤240 words
- DROP: one-line reason

Do not skip the web research.`;
}

// ---------- main ----------
(async () => {
  // 1. drop exact slug holds + semantic overlaps
  let pool = candidates.filter(c => !heldSlugs.has(c.slug) && !semanticOverlap(c));
  // 2. intra-candidate dedupe
  pool = intraDedupe(pool);
  // 3. cap
  pool = pool.slice(0, MAX);

  // 4. fetch live prices in parallel
  const enriched = await Promise.all(pool.map(async c => {
    const m = await gammaFetch(c.slug);
    if (!m || m.closed) return null;
    const prices = parseJsonArray(m.outcomePrices);
    const outcomes = parseJsonArray(m.outcomes);
    const tokenIds = parseJsonArray(m.clobTokenIds);
    const idx = outcomes.findIndex(o => (o || '').toLowerCase() === (c.bet || '').toLowerCase());
    if (idx < 0) return null;
    const displayProb = parseFloat(prices[idx]) * 100;
    if (!Number.isFinite(displayProb)) return null;
    const tokenId = tokenIds[idx];
    const book = await clobBookFetch(tokenId);
    const execution = summarizeExecution(book, displayProb, tokenId);
    if (!Number.isFinite(execution.entryProb) || execution.entryProb < 70 || execution.entryProb > 90) return null;
    const expiryMs = Date.parse(m.endDate || c.expiryDate);
    const liveDaysLeft = (expiryMs - Date.now()) / 86400000;
    if (liveDaysLeft < 0) return null;
    const eventSlug = m.events && m.events[0] && m.events[0].slug;
    return {
      c,
      live: {
        liveProb: execution.entryProb.toFixed(1),
        entryProb: execution.entryProb.toFixed(1),
        displayProb: execution.displayProb,
        executionSource: execution.source,
        bestBidPct: execution.bestBidPct,
        bestAskPct: execution.bestAskPct,
        bestAskSize: execution.bestAskSize,
        spreadPp: execution.spreadPp,
        askDepth2ppUsd: execution.askDepth2ppUsd,
        executionPenaltyPp: execution.executionPenaltyPp,
        tokenId: execution.tokenId,
        liveDaysLeft,
        eventUrl: eventSlug ? `https://polymarket.com/event/${eventSlug}` : null,
        bucket: classify(c, expiryMs),
      },
    };
  }));

  const survivors = enriched.filter(Boolean);

  // 5. emit prompts
  console.log(`SURVIVORS: ${survivors.length} (from ${candidates.length} candidates, ${pool.length} after overlap+dedupe)`);
  survivors.forEach(({ c, live }, i) => {
    console.log(`\n===CANDIDATE ${i + 1}===`);
    console.log(buildPrompt(c, live));
  });
})();
