/**
 * validate.js
 * Ensures the generated sharded data files are valid, fresh, and under the
 * Cloudflare Workers Static Assets per-file limit (25 MiB; we enforce 24 MiB).
 *
 * Usage: node scripts/validate.js [dataDir]   (defaults to ../src/data)
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'src', 'data');

const MAX_BYTES = 24 * 1024 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;
const MIN_DEALS = 100;

try {
  const indexPath = path.join(DATA_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error('index.json does not exist.');
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  if (!Array.isArray(index.shards) || index.shards.length === 0) {
    throw new Error("Invalid index: 'shards' array is missing or empty.");
  }
  if (typeof index.totalDeals !== 'number' || index.totalDeals < MIN_DEALS) {
    throw new Error(`Suspicious data: totalDeals=${index.totalDeals} < ${MIN_DEALS}. Aborting to protect production.`);
  }
  if (!index.timestamp || Date.now() - index.timestamp > MAX_AGE_MS) {
    throw new Error('Timestamp is missing or more than 1 hour old.');
  }

  for (const name of index.shards) {
    const shardPath = path.join(DATA_DIR, name);
    if (!fs.existsSync(shardPath)) {
      throw new Error(`Shard listed in index is missing on disk: ${name}`);
    }
    const size = fs.statSync(shardPath).size;
    if (size > MAX_BYTES) {
      throw new Error(`Shard ${name} is ${(size / (1024 * 1024)).toFixed(1)} MiB — exceeds ${(MAX_BYTES / (1024 * 1024))} MiB deploy limit.`);
    }
  }

  console.log(`Validation Passed: ${index.totalDeals} deals across ${index.shards.length} shard(s). All shards < ${MAX_BYTES / (1024 * 1024)} MiB.`);
  process.exit(0);
} catch (e) {
  console.error('Validation Failed:', e.message);
  process.exit(1);
}
