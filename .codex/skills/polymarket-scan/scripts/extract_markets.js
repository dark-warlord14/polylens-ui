#!/usr/bin/env node
// Usage: node extract_markets.js [--strategy capital-roi] [--max-candidates N] [--days N] [--min-vol N] [--category NAME] [--prob-min N] [--prob-max N] [--now ISO]
// Reads ./src/data/cache.json and prints broad capital-ROI candidates as JSON lines.

const fs = require('fs');
const {
  pickResolutionDeadline,
  daysUntil,
  grossYield,
  scoreCandidate,
} = require('./capital_roi');

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
};

const STRATEGY = get('--strategy', 'capital-roi');
const MAX_CANDIDATES = parseInt(get('--max-candidates', get('--max', '100')), 10);
const MAX_DAYS = has('--days') ? parseFloat(get('--days')) : null;
const MIN_VOL = parseFloat(get('--min-vol', '1000'));
const MIN_LIQUIDITY = parseFloat(get('--min-liquidity', '0'));
const CATEGORY = get('--category', null);
const PROB_MIN = has('--prob-min') ? parseFloat(get('--prob-min')) : 5;
const PROB_MAX = has('--prob-max') ? parseFloat(get('--prob-max')) : null;
const NOW_OVERRIDE = get('--now', null);

if (STRATEGY !== 'capital-roi') {
  console.error(`Unsupported --strategy ${STRATEGY}. This skill now uses only capital-roi.`);
  process.exit(1);
}

const NOW_MS = NOW_OVERRIDE ? Date.parse(NOW_OVERRIDE) : Date.now();
if (Number.isNaN(NOW_MS)) {
  console.error('Invalid --now value:', NOW_OVERRIDE);
  process.exit(1);
}

function marketKey(d) {
  return d.conditionId || d.slug;
}

const raw = fs.readFileSync('./src/data/cache.json', 'utf8');
const data = JSON.parse(raw);

const grouped = new Map();
for (const d of data.deals || []) {
  if (!d.slug || d.closed || d.active === false || d.acceptingOrders === false || d.enableOrderBook === false) continue;
  if (!d.tokenId) continue;
  if (CATEGORY && d.category !== CATEGORY) continue;
  if (Number.isFinite(MIN_VOL) && (d.volume || 0) < MIN_VOL) continue;
  if (Number.isFinite(MIN_LIQUIDITY) && (d.liquidity || 0) < MIN_LIQUIDITY) continue;
  if (PROB_MIN !== null && d.probability < PROB_MIN) continue;
  if (PROB_MAX !== null && d.probability > PROB_MAX) continue;

  const resolutionDeadline = pickResolutionDeadline({
    question: d.title,
    description: d.description,
    endDate: d.expiryDate,
  }, d, NOW_MS);
  const resolutionMs = Date.parse(resolutionDeadline);
  if (Number.isFinite(resolutionMs) && resolutionMs < NOW_MS - 86400000) continue;
  const capitalHorizonDays = resolutionDeadline ? daysUntil(resolutionDeadline, NOW_MS) : null;
  if (!Number.isFinite(capitalHorizonDays)) continue;
  if (MAX_DAYS !== null && capitalHorizonDays > MAX_DAYS) continue;
  if (d.probability <= 0 || d.probability >= 99.9) continue;

  const gy = grossYield(d.probability);
  const grossYieldPerDay = gy / Math.max(1 / 24, capitalHorizonDays);
  const score = scoreCandidate({
    entryProb: d.probability,
    volume: d.volume,
    volume24hr: d.volume24hr,
    liquidity: d.liquidity,
    capitalHorizonDays,
    spreadPp: null,
    askDepth2ppUsd: null,
  });

  const candidate = {
    title: d.title,
    slug: d.slug,
    bet: d.outcome,
    outcomeIdx: d.outcomeIdx,
    tokenId: d.tokenId,
    conditionId: d.conditionId,
    eventSlug: d.eventSlug,
    eventId: d.eventId,
    eventTitle: d.eventTitle,
    prob: d.probability,
    displayProb: d.probability,
    grossYield: parseFloat((gy * 100).toFixed(2)),
    grossYieldPerDay: parseFloat((grossYieldPerDay * 100).toFixed(2)),
    score: parseFloat(score.toFixed(6)),
    daysLeft: d.daysLeft,
    capitalHorizonDays: parseFloat(capitalHorizonDays.toFixed(3)),
    volume: Math.round(d.volume || 0),
    volume24hr: Math.round(d.volume24hr || 0),
    liquidity: Math.round(d.liquidity || 0),
    category: d.category,
    tags: d.tags || [],
    expiryDate: d.expiryDate,
    resolutionDeadline,
    negRisk: !!d.negRisk,
    resolutionSource: d.resolutionSource || null,
    description: d.description || null,
  };

  const key = `${marketKey(d)}::${String(d.outcome).toLowerCase()}`;
  const prev = grouped.get(key);
  if (!prev || candidate.score > prev.score) grouped.set(key, candidate);
}

const markets = [...grouped.values()].sort((a, b) =>
  b.score - a.score ||
  b.grossYieldPerDay - a.grossYieldPerDay ||
  b.volume24hr - a.volume24hr ||
  b.volume - a.volume
);

console.log('STRATEGY:', STRATEGY);
console.log('SNAPSHOT:', new Date(data.timestamp).toISOString());
console.log('NOW:', new Date(NOW_MS).toISOString());
console.log('TOTAL_IN_RANGE:', markets.length);
console.log('---CANDIDATES---');
markets.slice(0, MAX_CANDIDATES).forEach(m => console.log(JSON.stringify(m)));
