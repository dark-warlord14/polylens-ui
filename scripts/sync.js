/**
 * Fetch active Polymarket markets through Gamma keyset pagination and write the
 * cache consumed by the browser UI and the polymarket-scan skill.
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../src/data/cache.json');
const MARKET_MAP_PATH = path.join(__dirname, '../src/data/market_map.json');
const ORDER_CANDIDATES = (process.env.POLYMARKET_SYNC_ORDER || 'volumeClob|liquidityClob|updatedAt|createdAt')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function categoryForMarket(m) {
  const apiCat = String(m.category || '').trim();
  const tagLabels = Array.isArray(m.tags) ? m.tags.map(t => t.label || t.slug).filter(Boolean) : [];
  const text = `${m.question || ''} ${m.description || ''} ${apiCat} ${tagLabels.join(' ')}`.toLowerCase();

  if (/election|primary|runoff|ballot|referendum|nominee|senate|governor|mayor|parliament/.test(text)) return 'Elections';
  if (/politic|president|congress|white house|trump|biden|democrat|republican|minister|government/.test(text)) return 'Politics';
  if (/geopolit|iran|russia|ukraine|china|nato|war|military|sanction|ceasefire|nuclear|israel|gaza|houthi/.test(text)) return 'Geopolitics';
  if (/sport| nba | nfl | mlb | nhl |fifa| epl |premier league|champion|super bowl|world cup| vs |basketball|football|soccer|tennis|ufc/.test(text)) return 'Sports';
  if (/crypto|bitcoin|ethereum| btc| eth |solana|defi|nft|altcoin|xrp|doge|token/.test(text)) return 'Crypto';
  if (/finance|s&p|nasdaq|stock|fed |federal reserve|interest rate|crude oil|oil price|cpi|inflation|tariff|ipo|yield/.test(text)) return 'Finance';
  if (/economy|gdp|recession|unemployment|jobs report|economic/.test(text)) return 'Economy';
  if (/tech|chatgpt|openai|artificial intelligence|llm|apple|google|microsoft|meta |tesla|elon|spacex/.test(text)) return 'Tech';
  if (/climate|science|weather|nasa|space|earthquake|hurricane|temperature/.test(text)) return 'Climate & Science';
  if (/culture|entertainment|oscar|grammy|emmy|eurovision|movie|album|award|celebrity/.test(text)) return 'Culture';
  if (apiCat && !/^[0-9↑↓.%+\-]+$/.test(apiCat)) return apiCat.split(',')[0].trim();
  return 'Other';
}

async function fetchAllMarkets(options = {}) {
  const pageSize = options.pageSize || 100;
  // Keep generated cache files below GitHub's 100 MB hard file limit by
  // default. Set POLYMARKET_SYNC_MAX_PAGES=0 only for local full-universe scans.
  const maxPages = options.maxPages ?? parseInt(process.env.POLYMARKET_SYNC_MAX_PAGES || '120', 10);
  const fetchFn = options.fetchFn || fetch;
  const sleepMs = options.sleepMs ?? 80;
  const preferredOrders = options.orders || (ORDER_CANDIDATES.length > 0 ? ORDER_CANDIDATES : ['volumeClob']);

  console.log('Starting fetch from Polymarket Gamma keyset API...');
  console.log(`Trying order fields in order: ${preferredOrders.join(' | ') || 'none (API default)'}`);

  const failures = [];
  for (const candidate of preferredOrders) {
    try {
      return await fetchMarketsForOrder({ order: candidate, pageSize, maxPages, fetchFn, sleepMs });
    } catch (e) {
      failures.push(`${candidate}: ${e.message}`);
      if (!isRetryableOrderFailure(e)) throw e;
      console.log(`Order ${candidate} failed during pagination (${e.message}); trying fallback...`);
    }
  }

  throw new Error(`No valid order field completed pagination; tried: ${failures.join('; ')}`);
}

async function fetchMarketsForOrder({ order, pageSize, maxPages, fetchFn, sleepMs }) {
  let afterCursor = null;
  let all = [];
  let page = 0;

  while (true) {
    const params = buildQueryParams({ limit: pageSize, afterCursor, order });
    const res = await fetchWithRetry(`https://gamma-api.polymarket.com/markets/keyset?${params}`, { fetchFn });
    if (!res.ok) {
      const payloadText = await safeReadResponseText(res);
      const err = new Error(`Gamma keyset HTTP ${res.status}: ${payloadText || 'unknown error'}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();

    const markets = Array.isArray(data.markets) ? data.markets : [];
    all = all.concat(markets);
    page += 1;
    console.log(`Fetched ${all.length} markets across ${page} pages...`);

    if (maxPages > 0 && page >= maxPages) {
      console.log(`Reached POLYMARKET_SYNC_MAX_PAGES=${maxPages}; stopping early for interactive scan.`);
      break;
    }
    if (!data.next_cursor || markets.length < pageSize) break;
    afterCursor = data.next_cursor;
    await new Promise(r => setTimeout(r, sleepMs));
  }

  const seen = new Set();
  return all.filter(m => {
    const id = m.id || m.slug || m.conditionId;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function isRetryableOrderFailure(e) {
  const status = e && e.status;
  const message = String(e && e.message || '');
  return status === 429 || status >= 500 || /order fields are not valid/i.test(message);
}

async function fetchWithRetry(url, options = {}) {
  const attempts = options.attempts || 3;
  const fetchFn = options.fetchFn || fetch;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchFn(url);
      if (res.ok || attempt === attempts) return res;
      const body = await safeReadResponseText(res);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const err = new Error(`Gamma keyset HTTP ${res.status}: ${body || 'invalid request'}`);
        err.status = res.status;
        throw err;
      }
      lastError = new Error(`Gamma keyset HTTP ${res.status}: ${body || 'retryable request error'}`);
      lastError.status = res.status;
    } catch (e) {
      lastError = e;
      if (attempt === attempts) throw e;
    }
    await new Promise(r => setTimeout(r, 500 * attempt));
  }
  throw lastError;
}

function buildQueryParams({ limit, order, afterCursor }) {
  const params = new URLSearchParams({
    limit: String(limit),
    active: 'true',
    closed: 'false',
    include_tag: 'true',
    ascending: 'false',
  });
  if (order) params.set('order', order);
  if (afterCursor) params.set('after_cursor', afterCursor);
  return params;
}

async function safeReadResponseText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function processMarkets(markets) {
  const opportunities = [];
  const now = Date.now();

  for (const m of markets) {
    const endDate = m.endDateIso || m.endDate || m.resolutionDate || m.umaEndDateIso || m.umaEndDate;
    const prices = parseJsonArray(m.outcomePrices);
    const outcomes = parseJsonArray(m.outcomes);
    const tokenIds = parseJsonArray(m.clobTokenIds);
    if (!endDate || !prices.length || !outcomes.length || !tokenIds.length) continue;

    const expiryMs = Date.parse(endDate);
    const diffDays = Number.isFinite(expiryMs) ? (expiryMs - now) / 86400000 : null;
    const volume = parseFloat(m.volumeNum || m.volume || 0);
    const volume24hr = parseFloat(m.volume24hrClob || m.volume24hr || 0);
    const liquidity = parseFloat(m.liquidityNum || m.liquidityClob || m.liquidity || 0);
    const category = categoryForMarket(m);
    const title = m.question || m.groupItemTitle || m.description || 'Untitled Market';
    const event = Array.isArray(m.events) && m.events[0] ? m.events[0] : null;
    const tags = Array.isArray(m.tags) ? m.tags.map(t => t.label || t.slug).filter(Boolean) : [];

    prices.forEach((p, idx) => {
      const prob = parseFloat(p);
      if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return;
      if (!tokenIds[idx]) return;
      opportunities.push({
        title,
        outcome: outcomes[idx] || String(idx),
        probability: parseFloat((prob * 100).toFixed(2)),
        daysLeft: diffDays === null ? null : parseFloat(Math.max(0, diffDays).toFixed(3)),
        volume,
        volume24hr,
        liquidity,
        category,
        tags,
        slug: m.slug,
        marketId: m.id,
        conditionId: m.conditionId,
        questionId: m.questionID,
        outcomeIdx: idx,
        tokenId: tokenIds[idx],
        expiryDate: endDate,
        acceptingOrders: m.acceptingOrders !== false,
        enableOrderBook: m.enableOrderBook !== false,
        active: m.active !== false,
        closed: !!m.closed,
        negRisk: !!(m.negRisk || (event && event.negRisk)),
        eventSlug: event && event.slug,
        eventId: event && event.id,
        eventTitle: event && event.title,
        resolutionSource: m.resolutionSource || (event && event.resolutionSource) || null,
        description: m.description || (event && event.description) || null,
      });
    });
  }

  return opportunities;
}

const SHARD_PREFIX = '{"deals":';
const SHARD_SUFFIX = ']}';

/**
 * Pack a deals array into shards whose minified serialized size stays at or
 * below targetBytes. A single deal larger than targetBytes occupies its own
 * shard (deals are never split). Returns shard metadata + total count; the
 * caller writes each shard as JSON.stringify({ deals: shard.deals }).
 */
function packShards(deals, targetBytes = 20 * 1024 * 1024) {
  const shards = [];
  let current = [];
  let sumLen = 0;

  const shardBytes = (len, count) =>
    SHARD_PREFIX.length + 1 /*[*/ + len + Math.max(0, count - 1) /*commas*/ + SHARD_SUFFIX.length;

  const flush = () => {
    if (current.length === 0) return;
    const name = `cache_${String(shards.length + 1).padStart(2, '0')}.json`;
    shards.push({ name, deals: current });
    current = [];
    sumLen = 0;
  };

  for (const deal of deals) {
    const dealLen = JSON.stringify(deal).length;
    const projected = shardBytes(sumLen + dealLen, current.length + 1);
    if (current.length > 0 && projected > targetBytes) {
      flush();
    }
    current.push(deal);
    sumLen += dealLen;
  }
  flush();

  return { shards, totalDeals: deals.length };
}

const CACHE_DIR = path.join(__dirname, '../src/data');
const MiB = 1024 * 1024;
const SHARD_LIMIT_BYTES = 24 * MiB;

/** Write sharded cache + index into dir. Removes stale cache_*.json first. */
function writeShardedCache({ dir, timestamp, count, deals, marketMap }) {
  fs.mkdirSync(dir, { recursive: true });

  // Remove any stale shard files from a prior run, plus the legacy single cache.json.
  for (const f of fs.readdirSync(dir)) {
    if (/^cache_\d+\.json$/.test(f) || f === 'cache.json') fs.unlinkSync(path.join(dir, f));
  }

  const { shards, totalDeals } = packShards(deals);

  for (const shard of shards) {
    const serialized = JSON.stringify({ deals: shard.deals });
    if (serialized.length > SHARD_LIMIT_BYTES) {
      throw new Error(`Shard ${shard.name} is ${(serialized.length / MiB).toFixed(1)} MiB, exceeds ${SHARD_LIMIT_BYTES / MiB} MiB limit`);
    }
    fs.writeFileSync(path.join(dir, shard.name), serialized);
  }

  const index = {
    timestamp,
    count,
    totalDeals,
    shards: shards.map(s => s.name),
  };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, 'market_map.json'), JSON.stringify(marketMap || {}));

  return { shardCount: shards.length, totalDeals };
}

async function run() {
  try {
    const markets = await fetchAllMarkets();
    const opportunities = processMarkets(markets);
    const marketMap = {};

    for (const m of markets) {
      if (!m.slug) continue;
      const event = Array.isArray(m.events) && m.events[0] ? m.events[0] : null;
      marketMap[m.slug] = {
        id: m.id,
        conditionId: m.conditionId,
        endDate: m.endDateIso || m.endDate || m.umaEndDateIso || m.umaEndDate,
        closed: !!m.closed,
        active: m.active !== false,
        acceptingOrders: m.acceptingOrders !== false,
        eventSlug: event && event.slug,
        negRisk: !!(m.negRisk || (event && event.negRisk)),
      };
    }

    const { shardCount, totalDeals } = writeShardedCache({
      dir: CACHE_DIR,
      timestamp: Date.now(),
      count: markets.length,
      deals: opportunities,
      marketMap,
    });

    console.log(`Sync complete: ${markets.length} markets, ${totalDeals} tradable outcomes across ${shardCount} shard(s).`);
  } catch (e) {
    console.error('Sync failed:', e);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { fetchAllMarkets, packShards, writeShardedCache };
