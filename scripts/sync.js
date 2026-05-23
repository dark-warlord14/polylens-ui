/**
 * Fetch active Polymarket markets through Gamma keyset pagination and write the
 * cache consumed by the browser UI and the polymarket-scan skill.
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../src/data/cache.json');
const MARKET_MAP_PATH = path.join(__dirname, '../src/data/market_map.json');

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

async function fetchAllMarkets() {
  const pageSize = 100;
  const maxPages = parseInt(process.env.POLYMARKET_SYNC_MAX_PAGES || '0', 10);
  let afterCursor = null;
  let all = [];
  let page = 0;

  console.log('Starting fetch from Polymarket Gamma keyset API...');

  while (true) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      active: 'true',
      closed: 'false',
      include_tag: 'true',
      order: 'volume_num,liquidity_num',
      ascending: 'false',
    });
    if (afterCursor) params.set('after_cursor', afterCursor);

    const url = `https://gamma-api.polymarket.com/markets/keyset?${params}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Gamma keyset HTTP ${res.status}`);
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
    await new Promise(r => setTimeout(r, 80));
  }

  const seen = new Set();
  return all.filter(m => {
    const id = m.id || m.slug || m.conditionId;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok || attempt === attempts) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (attempt === attempts) throw e;
    }
    await new Promise(r => setTimeout(r, 500 * attempt));
  }
  throw lastError;
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

    const cacheData = {
      timestamp: Date.now(),
      count: markets.length,
      deals: opportunities,
    };

    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2));
    fs.writeFileSync(MARKET_MAP_PATH, JSON.stringify(marketMap, null, 2));

    console.log(`Sync complete: ${markets.length} markets, ${opportunities.length} tradable outcomes saved.`);
  } catch (e) {
    console.error('Sync failed:', e);
    process.exit(1);
  }
}

run();
