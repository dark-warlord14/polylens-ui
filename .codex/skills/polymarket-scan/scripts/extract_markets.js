#!/usr/bin/env node
// Usage: node extract_markets.js [--days N] [--min-vol N] [--category NAME]
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
const NOW_OVERRIDE = get('--now', null);

const NOW_MS = NOW_OVERRIDE ? Date.parse(NOW_OVERRIDE) : Date.now();
if (Number.isNaN(NOW_MS)) {
  console.error('Invalid --now value:', NOW_OVERRIDE);
  process.exit(1);
}

const CRYPTO_RE = /btc|eth|bitcoin|ethereum|solana|sol|xrp|ripple|dogecoin|doge|crypto|defi|nft|coinbase|binance|litecoin|cardano|avalanche|polygon|matic|chainlink|uniswap|pepe|shib|token|blockchain|altcoin|stablecoin|tether|usdc|usdt/i;

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

  if (prob < 70 || prob > 90)                                               continue;
  if (best.volume < MIN_VOL)                                                continue;
  if (CATEGORY && best.category !== CATEGORY)                               continue;
  if (CRYPTO_RE.test(best.title) || CRYPTO_RE.test(best.slug) ||
      CRYPTO_RE.test(best.category || ''))                                  continue;

  const roi   = parseFloat(((1 / (prob / 100)) - 1).toFixed(4));
  const score = prob * Math.log(best.volume) * roi;

  markets.push({
    title:      best.title,
    slug,
    bet:        best.outcome,
    prob,
    roi:        parseFloat((roi * 100).toFixed(1)),
    score:      parseFloat(score.toFixed(0)),
    daysLeft:   best.daysLeft,
    volume:     Math.round(best.volume),
    category:   best.category,
    expiryDate: best.expiryDate,
  });
}

markets.sort((a, b) => b.score - a.score);

console.log('SNAPSHOT:', new Date(data.timestamp).toISOString());
console.log('NOW:', new Date(NOW_MS).toISOString());
console.log('TOTAL_IN_RANGE:', markets.length);
console.log('---TOP30---');
markets.slice(0, 30).forEach(m => console.log(JSON.stringify(m)));
