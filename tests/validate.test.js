const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATE = path.join(__dirname, '..', 'scripts', 'validate.js');
const MiB = 1024 * 1024;

function goodDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polylens-val-'));
  const deals = [];
  for (let i = 0; i < 150; i++) deals.push({ slug: `m-${i}` }); // > 100
  fs.writeFileSync(path.join(dir, 'cache_01.json'), JSON.stringify({ deals }));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    timestamp: Date.now(),
    count: 150,
    totalDeals: 150,
    shards: ['cache_01.json'],
  }));
  return dir;
}

// 1. Valid layout -> exit 0.
{
  const dir = goodDir();
  const r = spawnSync('node', [VALIDATE, dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('validate.test: valid-layout exit 0 OK');
}

// 2. Oversized shard -> exit 1.
{
  const dir = goodDir();
  // Overwrite shard with a > 24 MiB file.
  const big = Buffer.alloc(25 * MiB, 'x');
  fs.writeFileSync(path.join(dir, 'cache_01.json'), big);
  const r = spawnSync('node', [VALIDATE, dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `expected exit 1 for oversized shard, got ${r.status}`);
  assert.ok(/25 MiB|24 MiB|too large|exceeds/i.test(r.stdout + r.stderr), 'should mention size limit');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('validate.test: oversized-shard exit 1 OK');
}

// 3. totalDeals < 100 -> exit 1.
{
  const dir = goodDir();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    timestamp: Date.now(), count: 5, totalDeals: 5, shards: ['cache_01.json'],
  }));
  fs.writeFileSync(path.join(dir, 'cache_01.json'), JSON.stringify({ deals: [{ slug: 'a' }] }));
  const r = spawnSync('node', [VALIDATE, dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `expected exit 1 for low totalDeals, got ${r.status}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('validate.test: low-totalDeals exit 1 OK');
}

console.log('validate.test: ALL PASS');
