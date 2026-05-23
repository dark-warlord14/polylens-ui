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

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseExplicitDeadline(text, nowMs = Date.now()) {
  const s = String(text || '');
  const iso = s.match(/\b(20\d{2})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?Z?)?\b/);
  if (iso) {
    const date = new Date(Date.UTC(
      parseInt(iso[1], 10),
      parseInt(iso[2], 10) - 1,
      parseInt(iso[3], 10),
      parseInt(iso[4] || '23', 10),
      parseInt(iso[5] || '59', 10),
      parseInt(iso[6] || '0', 10),
    ));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const monthDay = s.match(/\b(?:by|before|on|through|until)\s+([A-Za-z]+)\s+(\d{1,2})(?:,\s*(20\d{2}))?\b/i);
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    const day = parseInt(monthDay[2], 10);
    let year = monthDay[3] ? parseInt(monthDay[3], 10) : new Date(nowMs).getUTCFullYear();
    if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
    let date = new Date(Date.UTC(year, month, day, 23, 59, 0));
    if (!monthDay[3] && date.getTime() + 86400000 < nowMs) {
      year += 1;
      date = new Date(Date.UTC(year, month, day, 23, 59, 0));
    }
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const byMonth = s.match(/\b(?:by|before|in|during)\s+([A-Za-z]+)\s+(20\d{2})\b/i);
  if (byMonth) {
    const month = MONTHS[byMonth[1].toLowerCase()];
    const year = parseInt(byMonth[2], 10);
    if (!Number.isInteger(month) || !Number.isInteger(year)) return null;
    const date = new Date(Date.UTC(year, month + 1, 0, 23, 59, 0));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

function pickResolutionDeadline(market, candidate, nowMs = Date.now()) {
  return parseExplicitDeadline(market && market.question, nowMs) ||
    parseExplicitDeadline(market && market.description, nowMs) ||
    parseExplicitDeadline(candidate && candidate.title, nowMs) ||
    (market && (market.endDateIso || market.endDate || market.umaEndDateIso || market.umaEndDate)) ||
    (candidate && candidate.expiryDate) ||
    (market && market.events && market.events[0] && market.events[0].endDate) ||
    null;
}

function daysUntil(iso, nowMs = Date.now(), floorDays = 1 / 24) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(floorDays, (ms - nowMs) / 86400000);
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
    executionPenaltyPp: Number.isFinite(spreadPp) ? Math.max(0, spreadPp - 1) : 2,
  };
}

function classifyResearchBucket(candidate, market, nowMs = Date.now()) {
  const title = `${candidate && candidate.title || ''} ${market && market.question || ''}`.toLowerCase();
  const endMs = Date.parse((market && (market.endDateIso || market.endDate)) || (candidate && candidate.expiryDate));
  if (Number.isFinite(endMs) && endMs < nowMs) return 'confirmed/result-lag';
  if (market && (market.negRisk || (market.events && market.events[0] && market.events[0].negRisk))) return 'neg-risk multi-outcome';
  if (/\b(election|primary|runoff|vote|referendum|parliament|mayor|senate|governor|nominee|seats?|minister)\b/.test(title)) return 'election/politics';
  if (/\b(ceasefire|peace|sanction|treaty|military|strike|war|hostilities|iran|gaza|ukraine|russia|china|israel|houthi)\b/.test(title)) return 'geopolitics/conflict';
  if (/\b(vs\.?|game|match|fight|round|cup|final|playoff|series|nba|nfl|mlb|nhl|soccer|tennis|ufc)\b/.test(title)) return 'sports/game/event';
  if (/\b(price|index|level|spx|nasdaq|btc|eth|stock|usd|eur|yield|cpi|inflation|oil|gold|bitcoin|ethereum|solana|crypto|fed|rate)\b/.test(title)) return 'finance/crypto/commodity/rates';
  if (/\b(weather|temperature|rain|snow|hurricane|earthquake|count|tweets|posts|views|downloads)\b/.test(title)) return 'weather/stat/observable metric';
  if (/\b(oscar|grammy|emmy|album|movie|box office|award|eurovision|song|artist|celebrity)\b/.test(title)) return 'culture/awards/entertainment';
  return 'general event/status';
}

function requiredEdgePp(entryProb, bucket, executionPenaltyPp = 0) {
  let base;
  if (entryProb >= 90) base = 2.5;
  else if (entryProb >= 80) base = 4;
  else if (entryProb >= 65) base = 6;
  else if (entryProb >= 40) base = 8;
  else base = 10;

  if (/conflict|geopolitics|crypto|commodity|rates/.test(bucket)) base += 2;
  if (/confirmed/.test(bucket)) base = Math.min(base, 2);
  return base + Math.max(0, executionPenaltyPp || 0);
}

function grossYield(entryProb) {
  return (1 / (entryProb / 100)) - 1;
}

function computeEv({ entryProb, rawFairProb, evidenceReliability, capitalHorizonDays, riskMultiplier = 1, liquidityMultiplier = 1 }) {
  const adjustedFairProb = entryProb + evidenceReliability * (rawFairProb - entryProb);
  const edgePp = adjustedFairProb - entryProb;
  const evYield = adjustedFairProb / entryProb - 1;
  const evPerDay = evYield / Math.max(1 / 24, capitalHorizonDays);
  return {
    adjustedFairProb,
    edgePp,
    evYield,
    evPerDay,
    riskAdjustedEvPerDay: evPerDay * riskMultiplier * liquidityMultiplier,
  };
}

function scoreCandidate({ entryProb, volume, volume24hr, liquidity, capitalHorizonDays, spreadPp, askDepth2ppUsd }) {
  const gy = grossYield(entryProb);
  const gpd = gy / Math.max(1 / 24, capitalHorizonDays);
  const volumeScore = Math.log10(Math.max(10, volume || 0) + Math.max(0, volume24hr || 0) * 5);
  const liquidityScore = Math.log10(Math.max(10, liquidity || 0) + Math.max(0, askDepth2ppUsd || 0));
  const spreadPenalty = Number.isFinite(spreadPp) ? Math.max(0.1, 1 - Math.max(0, spreadPp - 1) / 8) : 0.5;
  return gpd * volumeScore * liquidityScore * spreadPenalty;
}

module.exports = {
  parseJsonArray,
  parseExplicitDeadline,
  pickResolutionDeadline,
  daysUntil,
  normalizeBookSide,
  summarizeExecution,
  classifyResearchBucket,
  requiredEdgePp,
  grossYield,
  computeEv,
  scoreCandidate,
};
