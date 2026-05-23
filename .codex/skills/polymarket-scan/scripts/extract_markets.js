#!/usr/bin/env node
// Usage: node extract_markets.js [--days N] [--min-vol N] [--category NAME] [--mode all|politics] [--prob-min N] [--prob-max N] [--now ISO]
// Reads ./src/data/cache.json and prints top 30 candidates as JSON lines.

const fs = require('fs');

const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
};

const MAX_DAYS = parseInt(get('--days', '3'), 10);
const MIN_VOL  = parseInt(get('--min-vol', '5000'), 10);
const CATEGORY = get('--category', null);
const MODE = get('--mode', 'all');
const PROB_MIN = parseFloat(get('--prob-min', MODE === 'politics' ? '55' : '70'));
const PROB_MAX = parseFloat(get('--prob-max', MODE === 'politics' ? '80' : '90'));
const NOW_OVERRIDE = get('--now', null);

const NOW_MS = NOW_OVERRIDE ? Date.parse(NOW_OVERRIDE) : Date.now();
if (Number.isNaN(NOW_MS)) {
  console.error('Invalid --now value:', NOW_OVERRIDE);
  process.exit(1);
}

const CRYPTO_RE = /btc|eth|bitcoin|ethereum|solana|sol|xrp|ripple|dogecoin|doge|crypto|defi|nft|coinbase|binance|litecoin|cardano|avalanche|polygon|matic|chainlink|uniswap|pepe|shib|token|blockchain|altcoin|stablecoin|tether|usdc|usdt/i;
const POLITICS_CATS = new Set([
  'Politics',
  'Elections',
  'Geopolitics',
  'World',
  'International Affairs',
  'Society',
]);

const MONTHS = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

function parseQuestionDeadline(title) {
  const text = String(title || '');
  const match = text.match(/\bby\s+([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2})\b/i);
  if (!match) return null;

  const month = MONTHS[match[1].toLowerCase()];
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) return null;

  // Polymarket "by DATE" markets commonly resolve at 11:59 PM ET.
  // Use 03:59:00Z the next day as a conservative UTC proxy during EDT.
  const deadline = new Date(Date.UTC(year, month, day + 1, 3, 59, 0));
  return Number.isNaN(deadline.getTime()) ? null : deadline.toISOString();
}

const raw  = fs.readFileSync('./src/data/cache.json', 'utf8');
const data = JSON.parse(raw);

// Recompute daysLeft from real now (cache value is stale: it was frozen at sync time).
// Group by slug so we can compare both outcomes per market.
const bySlug = {};
data.deals
  .map(d => {
    const expiryMs = Date.parse(d.expiryDate);
    const liveDaysLeft = Number.isFinite(expiryMs)
      ? (expiryMs - NOW_MS) / 86400000
      : d.daysLeft;
    return { ...d, daysLeft: liveDaysLeft };
  })
  .filter(d => d.daysLeft >= 0 && d.daysLeft <= MAX_DAYS)
  .forEach(d => {
    if (!bySlug[d.slug]) bySlug[d.slug] = [];
    bySlug[d.slug].push(d);
  });

const markets = [];
for (const [slug, outcomes] of Object.entries(bySlug)) {
  const best = outcomes.reduce((a, b) => a.probability > b.probability ? a : b);
  const prob = best.probability;

  if (prob < PROB_MIN || prob > PROB_MAX)                                   continue;
  if (best.volume < MIN_VOL)                                                continue;
  if (CATEGORY && best.category !== CATEGORY)                               continue;
  if (MODE === 'politics' && !POLITICS_CATS.has(best.category))             continue;
  if (CRYPTO_RE.test(best.title) || CRYPTO_RE.test(best.slug) ||
      CRYPTO_RE.test(best.category || ''))                                  continue;

  const roi   = parseFloat(((1 / (prob / 100)) - 1).toFixed(4));
  const questionDeadline = parseQuestionDeadline(best.title);
  const resolutionMs = questionDeadline ? Date.parse(questionDeadline) : Date.parse(best.expiryDate);
  const capitalDaysLeft = Number.isFinite(resolutionMs)
    ? Math.max(1 / 24, (resolutionMs - NOW_MS) / 86400000)
    : best.daysLeft;
  const grossProfitPerDay = roi / Math.max(1, capitalDaysLeft);
  const score = prob * Math.log(best.volume) * roi * Math.min(2, Math.max(0.25, grossProfitPerDay * 30));

  markets.push({
    title:      best.title,
    slug,
    bet:        best.outcome,
    prob,
    roi:        parseFloat((roi * 100).toFixed(1)),
    grossProfitPerDay: parseFloat((grossProfitPerDay * 100).toFixed(2)),
    score:      parseFloat(score.toFixed(0)),
    daysLeft:   best.daysLeft,
    capitalDaysLeft: parseFloat(capitalDaysLeft.toFixed(2)),
    volume:     Math.round(best.volume),
    category:   best.category,
    expiryDate: best.expiryDate,
    questionDeadline,
  });
}

markets.sort((a, b) => b.score - a.score);

console.log('SNAPSHOT:', new Date(data.timestamp).toISOString());
console.log('NOW:', new Date(NOW_MS).toISOString());
console.log('TOTAL_IN_RANGE:', markets.length);
console.log('---TOP30---');
markets.slice(0, 30).forEach(m => console.log(JSON.stringify(m)));
