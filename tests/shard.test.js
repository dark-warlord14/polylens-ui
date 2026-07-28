const assert = require('assert');
const { fetchAllMarkets, packShards, writeShardedCache } = require('../scripts/sync');

// Build N synthetic deals of realistic-ish size.
function makeDeals(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      title: `Market ${i} with a reasonably long question string to pad size`,
      outcome: i % 2 === 0 ? 'Yes' : 'No',
      probability: 50 + (i % 50),
      daysLeft: 1 + (i % 30),
      volume: 1000 * i,
      volume24hr: 100 * i,
      liquidity: 500 * i,
      category: 'Crypto',
      tags: ['tag-a', 'tag-b'],
      slug: `market-${i}`,
      tokenId: `tok-${i}`,
      conditionId: `cond-${i}`,
      description: 'x'.repeat(200),
    });
  }
  return out;
}

// 1. Small target forces multiple shards; completeness + sizing hold.
{
  const deals = makeDeals(500);
  const TARGET = 4000; // bytes — small so many shards form, fast test
  const { shards, totalDeals } = packShards(deals, TARGET);

  assert.strictEqual(totalDeals, deals.length, 'totalDeals must equal input length');

  // Each shard must serialize under target (deals here are all smaller than target).
  for (const s of shards) {
    const bytes = JSON.stringify({ deals: s.deals }).length;
    assert.ok(bytes <= TARGET, `shard ${s.name} is ${bytes} > target ${TARGET}`);
  }

  // Multiple shards expected for 500 deals at 4KB target.
  assert.ok(shards.length >= 2, `expected >=2 shards, got ${shards.length}`);

  // Names sequential + zero-padded.
  shards.forEach((s, i) => {
    const expected = `cache_${String(i + 1).padStart(2, '0')}.json`;
    assert.strictEqual(s.name, expected, `shard name ${s.name} != ${expected}`);
  });

  // Completeness: concatenated deals equal input, order preserved, no dupes/loss.
  const merged = shards.flatMap(s => s.deals);
  assert.strictEqual(merged.length, deals.length, 'merged length mismatch');
  assert.deepStrictEqual(merged, deals, 'merged deals must equal input deals');
  console.log(`shard.test: small-target OK (${shards.length} shards, ${totalDeals} deals)`);
}

// 2. Default target (20 MiB): a modest input fits in one shard.
{
  const deals = makeDeals(10);
  const { shards, totalDeals } = packShards(deals); // default 20 MiB
  assert.strictEqual(shards.length, 1, '10 small deals should fit one shard');
  assert.strictEqual(totalDeals, 10);
  assert.strictEqual(shards[0].name, 'cache_01.json');
  console.log('shard.test: default-target OK');
}

// 3. Empty input -> no shards, totalDeals 0.
{
  const { shards, totalDeals } = packShards([]);
  assert.strictEqual(totalDeals, 0);
  assert.strictEqual(shards.length, 0);
  console.log('shard.test: empty-input OK');
}

// 4. writeShardedCache: writes index.json + shards, no cache.json, stale cleanup.
{
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polylens-shard-'));
  const deals = makeDeals(60);
  writeShardedCache({
    dir,
    timestamp: 1234567890000,
    count: 30,
    deals,
    marketMap: { 'market-1': { id: 'x' } },
  });

  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.strictEqual(index.timestamp, 1234567890000);
  assert.strictEqual(index.count, 30);
  assert.strictEqual(index.totalDeals, 60);
  assert.ok(Array.isArray(index.shards) && index.shards.length >= 1);

  // No legacy single cache.json should be written.
  assert.ok(!fs.existsSync(path.join(dir, 'cache.json')), 'cache.json must not be written');

  // Every shard file referenced by index exists and parses.
  const merged = [];
  for (const name of index.shards) {
    const p = path.join(dir, name);
    assert.ok(fs.existsSync(p), `missing shard file ${name}`);
    const shard = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(Array.isArray(shard.deals), `${name} has no deals array`);
    merged.push(...shard.deals);
  }
  assert.deepStrictEqual(merged, deals, 'round-trip merge must equal input');

  // market_map.json still written.
  const mm = JSON.parse(fs.readFileSync(path.join(dir, 'market_map.json'), 'utf8'));
  assert.deepStrictEqual(mm, { 'market-1': { id: 'x' } });

  // Stale-shard cleanup: write a fake old shard, re-run, confirm it is removed.
  fs.writeFileSync(path.join(dir, 'cache_99.json'), '{}');
  writeShardedCache({ dir, timestamp: 1, count: 1, deals: makeDeals(5), marketMap: {} });
  assert.ok(!fs.existsSync(path.join(dir, 'cache_99.json')), 'stale shard must be removed');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('shard.test: writeShardedCache OK');
}

// 5. fetchAllMarkets: an order that fails after page one falls back.
(async () => {
  const calls = [];
  const fetchFn = async (url) => {
    const parsed = new URL(url);
    const order = parsed.searchParams.get('order');
    const cursor = parsed.searchParams.get('after_cursor');
    calls.push({ order, cursor });

    if (order === 'badOrder' && cursor === 'next') {
      return {
        ok: false,
        status: 500,
        text: async () => 'upstream pagination failure',
      };
    }

    const start = cursor === 'next' ? 2 : 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        markets: [
          { id: `${order}-${start}`, slug: `${order}-${start}` },
          { id: `${order}-${start + 1}`, slug: `${order}-${start + 1}` },
        ],
        next_cursor: cursor ? null : 'next',
      }),
    };
  };

  const markets = await fetchAllMarkets({
    orders: ['badOrder', 'goodOrder'],
    pageSize: 2,
    maxPages: 2,
    fetchFn,
    sleepMs: 0,
  });

  assert.deepStrictEqual(
    markets.map((m) => m.id),
    ['goodOrder-1', 'goodOrder-2', 'goodOrder-3'],
  );
  assert.ok(calls.some((c) => c.order === 'badOrder' && c.cursor === 'next'), 'bad order must reach failing page');
  assert.ok(calls.some((c) => c.order === 'goodOrder' && c.cursor === 'next'), 'good order must retry from first page');
  console.log('shard.test: order-fallback OK');
  console.log('shard.test: ALL PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
