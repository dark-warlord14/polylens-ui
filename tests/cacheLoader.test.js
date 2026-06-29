const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadCache } = require('../src/js/cacheLoader');

function fileFetch(dir) {
  return async (p) => {
    const full = path.join(dir, p.replace(/^data\//, ''));
    if (!fs.existsSync(full)) return { ok: false, json: async () => { throw new Error('missing ' + p); } };
    const text = fs.readFileSync(full, 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
  };
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polylens-loader-'));
  const index = { timestamp: 999, count: 2, totalDeals: 4, shards: ['cache_01.json', 'cache_02.json'] };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, 'cache_01.json'), JSON.stringify({ deals: [{ slug: 'a' }, { slug: 'b' }] }));
  fs.writeFileSync(path.join(dir, 'cache_02.json'), JSON.stringify({ deals: [{ slug: 'c' }, { slug: 'd' }] }));

  (async () => {
    const res = await loadCache(fileFetch(dir));
    assert.strictEqual(res.count, 2);
    assert.strictEqual(res.totalDeals, 4);
    assert.strictEqual(res.timestamp, 999);
    assert.deepStrictEqual(res.deals.map(d => d.slug), ['a', 'b', 'c', 'd']);

    // Missing shard -> throws.
    fs.unlinkSync(path.join(dir, 'cache_02.json'));
    await assert.rejects(() => loadCache(fileFetch(dir)), /missing|ok|fetch|shard|load/i);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('cacheLoader.test: ALL PASS');
  })().catch((e) => { console.error(e); process.exit(1); });
}
