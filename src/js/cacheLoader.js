/**
 * Shared cache loader. Browser: loaded as a classic <script> before main.js,
 * exposing global `loadCache`. Node: exports { loadCache } for tests.
 *
 * Reads data/index.json, fetches every listed shard, and flattens their
 * `deals` arrays into one, preserving shard + in-shard order.
 */
async function loadCache(fetchFn) {
  const indexRes = await fetchFn('data/index.json');
  if (!indexRes || !indexRes.ok) throw new Error('Failed to load data/index.json');
  const index = await indexRes.json();

  const shardResponses = await Promise.all(
    (index.shards || []).map((name) => fetchFn('data/' + name))
  );
  for (const r of shardResponses) {
    if (!r || !r.ok) throw new Error('Failed to load a cache shard');
  }
  const shardJsons = await Promise.all(shardResponses.map((r) => r.json()));

  const deals = shardJsons.flatMap((s) => (s && Array.isArray(s.deals)) ? s.deals : []);

  return {
    deals,
    count: index.count,
    totalDeals: index.totalDeals,
    timestamp: index.timestamp,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadCache };
}
