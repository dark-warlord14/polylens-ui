const assert = require('assert');
const { packShards } = require('../scripts/sync');

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

console.log('shard.test: ALL PASS');
