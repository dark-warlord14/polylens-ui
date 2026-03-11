/**
 * sync.js
 * Node.js script to fetch markets from Polymarket and save to JSON.
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../src/data/cache.json');
const MARKET_MAP_PATH = path.join(__dirname, '../src/data/market_map.json');

const CORE_CATEGORIES = ["Politics", "Elections", "Sports", "Crypto", "Finance", "Economy", "Geopolitics", "Tech", "Culture", "Climate & Science"];

async function fetchAllMarkets() {
    const pageSize = 500;
    let offset = 0;
    let all = [];
    let hasMore = true;
    let consecutiveErrors = 0;

    console.log("Starting fetch from Polymarket Gamma API...");

    while (hasMore) {
        const url = `https://gamma-api.polymarket.com/markets?limit=${pageSize}&offset=${offset}&active=true&closed=false`;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (data && Array.isArray(data) && data.length > 0) {
                all = all.concat(data);
                offset += data.length;
                consecutiveErrors = 0;
                console.log(`Fetched ${all.length} markets so far...`);
                if (data.length < pageSize) hasMore = false;
            } else {
                hasMore = false;
            }
        } catch (e) {
            consecutiveErrors++;
            console.warn(`Fetch error at offset ${offset}:`, e.message);
            if (consecutiveErrors > 2) hasMore = false;
            else offset += pageSize;
        }
        await new Promise(r => setTimeout(r, 100));
    }

    // Deduplicate
    const seen = new Set();
    return all.filter(m => {
        const id = m.id || m.slug;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

function processMarkets(markets) {
    const opportunities = [];
    const now = new Date();

    markets.forEach(m => {
        const endDate = m.end_date || m.endDate || m.resolution_date || m.resolutionDate;
        let prices = m.outcome_prices || m.outcomePrices;
        let outcomes = m.outcomes;

        if (!endDate || !prices || !outcomes) return;

        const volume = parseFloat(m.volume || 0);
        const expiry = new Date(endDate);
        const diffDays = (expiry - now) / (1000 * 60 * 60 * 24);
        if (diffDays <= 0) return;

        try {
            if (typeof prices === "string") prices = JSON.parse(prices);
            if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
        } catch (e) { return; }

        if (!Array.isArray(prices) || !Array.isArray(outcomes)) return;

        const apiCat = (m.category || "").toLowerCase();
        const titleLower = (m.question || m.description || "").toLowerCase();
        let category = "Other";

        if (apiCat.includes("election") || titleLower.includes("election") || titleLower.includes("vote") || titleLower.includes("ballot") || titleLower.includes("midterm")) {
            category = "Elections";
        } else if (apiCat.includes("politic") || titleLower.includes("president") || titleLower.includes("congress") || titleLower.includes("senate") || titleLower.includes("white house") || titleLower.includes("trump") || titleLower.includes("biden") || titleLower.includes("democrat") || titleLower.includes("republican")) {
            category = "Politics";
        } else if (apiCat.includes("geopolit") || titleLower.includes("iran") || titleLower.includes("russia") || titleLower.includes("ukraine") || titleLower.includes("china") || titleLower.includes("nato") || titleLower.includes("war") || titleLower.includes("military") || titleLower.includes("sanctions") || titleLower.includes("ceasefire") || titleLower.includes("nuclear")) {
            category = "Geopolitics";
        } else if (apiCat.includes("crypto") || titleLower.includes("bitcoin") || titleLower.includes("ethereum") || titleLower.includes(" btc") || titleLower.includes(" eth ") || titleLower.includes("solana") || titleLower.includes("defi") || titleLower.includes("nft") || titleLower.includes("altcoin") || titleLower.includes("crypto")) {
            category = "Crypto";
        } else if (apiCat.includes("finance") || titleLower.includes("s&p") || titleLower.includes("nasdaq") || titleLower.includes("stock") || titleLower.includes("fed ") || titleLower.includes("federal reserve") || titleLower.includes("interest rate") || titleLower.includes("crude oil") || titleLower.includes("oil price") || titleLower.includes("cpi") || titleLower.includes("inflation") || titleLower.includes("tariff") || titleLower.includes("trade war") || titleLower.includes("ipo")) {
            category = "Finance";
        } else if (apiCat.includes("economy") || titleLower.includes("gdp") || titleLower.includes("recession") || titleLower.includes("unemployment") || titleLower.includes("jobs report") || titleLower.includes("economic")) {
            category = "Economy";
        } else if (apiCat.includes("tech") || titleLower.includes("chatgpt") || titleLower.includes("openai") || titleLower.includes("artificial intelligence") || titleLower.includes("llm") || titleLower.includes("apple") || titleLower.includes("google") || titleLower.includes("microsoft") || titleLower.includes("meta ") || titleLower.includes("tesla") || titleLower.includes("elon") || titleLower.includes("spacex")) {
            category = "Tech";
        } else if (apiCat.includes("sport") || titleLower.includes(" nba ") || titleLower.includes(" nfl ") || titleLower.includes(" mlb ") || titleLower.includes("fifa") || titleLower.includes(" epl ") || titleLower.includes("premier league") || titleLower.includes("champion") || titleLower.includes("super bowl") || titleLower.includes("world cup") || titleLower.includes(" vs ") || titleLower.includes("basketball") || titleLower.includes("football") || titleLower.includes("soccer")) {
            category = "Sports";
        } else if (apiCat.includes("climate") || apiCat.includes("science") || titleLower.includes("climate") || titleLower.includes("nasa") || titleLower.includes("space") || titleLower.includes("weather") || titleLower.includes("earthquake") || titleLower.includes("hurricane")) {
            category = "Climate & Science";
        } else if (apiCat.includes("culture") || apiCat.includes("entertainment") || apiCat.includes("pop") || titleLower.includes("oscar") || titleLower.includes("grammy") || titleLower.includes("emmy") || titleLower.includes("eurovision") || titleLower.includes("movie") || titleLower.includes("album") || titleLower.includes("award")) {
            category = "Culture";
        } else if (m.category) {
            const first = m.category.split(",")[0].trim();
            if (first.length > 2 && !/^[0-9↑↓.%+\-]+$/.test(first)) {
                category = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
            }
        }

        const marketTitle = m.question || m.description || m.groupItemTitle || "Untitled Market";

        prices.forEach((p, idx) => {
            const prob = parseFloat(p);
            // Only include markets with at least $1000 volume and 1% probability to keep JSON small
            if (!isNaN(prob) && prob >= 0.01 && prob <= 0.99 && volume >= 1000) {
                opportunities.push({
                    title: marketTitle,
                    outcome: outcomes[idx] || "Yes",
                    probability: parseFloat((prob * 100).toFixed(1)),
                    daysLeft: parseFloat(Math.max(0, diffDays).toFixed(1)),
                    volume: volume,
                    category: category,
                    slug: m.slug,
                    outcomeIdx: idx,
                    expiryDate: endDate
                });
            }
        });
    });

    return opportunities;
}

async function run() {
    try {
        const markets = await fetchAllMarkets();
        const opportunities = processMarkets(markets);

        const marketMap = {};
        markets.forEach(m => {
            if (m.slug) {
                marketMap[m.slug] = {
                    endDate: m.end_date || m.endDate || m.resolution_date || m.resolutionDate,
                    closed: !!(m.closed || m.resolved)
                };
            }
        });

        const cacheData = {
            timestamp: Date.now(),
            count: markets.length,
            deals: opportunities
        };

        fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2));
        fs.writeFileSync(MARKET_MAP_PATH, JSON.stringify(marketMap, null, 2));

        console.log(`Sync complete: ${markets.length} markets, ${opportunities.length} opportunities saved.`);
    } catch (e) {
        console.error("Sync failed:", e);
        process.exit(1);
    }
}

run();
