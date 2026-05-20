#!/usr/bin/env node
// Track recommendation quality over time.
//
// Usage:
//   node roi_ledger.js add --slug SLUG --bet Yes --entry 0.78 --fair 0.86 --risk LOW [--close 0.82] [--resolved 1]
//   node roi_ledger.js report

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0];
const ledgerPath = process.env.POLYMARKET_ROI_LEDGER ||
  path.join(process.cwd(), '.polymarket-skill', 'roi-ledger.jsonl');

function get(flag, def = null) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
}

function num(flag) {
  const value = get(flag);
  if (value === null) return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usage(exitCode = 1) {
  console.error(`Usage:
  node roi_ledger.js add --slug SLUG --bet OUTCOME --entry 0.78 --fair 0.86 --risk LOW [--title TEXT] [--category TEXT] [--url URL] [--close 0.82] [--resolved 1]
  node roi_ledger.js report`);
  process.exit(exitCode);
}

function readRows() {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function addRow() {
  const slug = get('--slug');
  const bet = get('--bet');
  const entry = num('--entry');
  const fair = num('--fair');
  const risk = get('--risk');
  if (!slug || !bet || !Number.isFinite(entry) || !Number.isFinite(fair) || !risk) usage();

  const row = {
    ts: new Date().toISOString(),
    slug,
    bet,
    title: get('--title'),
    category: get('--category'),
    risk,
    entry,
    fair,
    edge_pp: (fair - entry) * 100,
    ev_per_dollar: fair / entry - 1,
    close: num('--close'),
    resolved: num('--resolved'),
    url: get('--url'),
    source: get('--source', 'skill-recommendation'),
  };

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
  console.log(`ADDED ${slug} ${bet}: edge=${row.edge_pp.toFixed(2)}pp ev=${(row.ev_per_dollar * 100).toFixed(2)}%`);
  console.log(`LEDGER ${ledgerPath}`);
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

function summarize(name, rows) {
  const avgEdge = average(rows.map(r => r.edge_pp));
  const avgEv = average(rows.map(r => r.ev_per_dollar));
  const withClose = rows.filter(r => Number.isFinite(r.close));
  const avgClv = average(withClose.map(r => (r.close - r.entry) * 100));
  const resolved = rows.filter(r => Number.isFinite(r.resolved));
  const avgRoi = average(resolved.map(r => (r.resolved / r.entry) - 1));
  console.log([
    name.padEnd(18),
    `n=${String(rows.length).padStart(3)}`,
    `edge=${avgEdge === null ? 'NA' : `${avgEdge.toFixed(2)}pp`}`.padStart(14),
    `ev=${avgEv === null ? 'NA' : `${(avgEv * 100).toFixed(2)}%`}`.padStart(12),
    `clv=${avgClv === null ? 'NA' : `${avgClv.toFixed(2)}pp`}`.padStart(13),
    `roi=${avgRoi === null ? 'NA' : `${(avgRoi * 100).toFixed(2)}%`}`.padStart(13),
  ].join('  '));
}

function report() {
  const rows = readRows();
  console.log(`LEDGER ${ledgerPath}`);
  if (!rows.length) {
    console.log('No rows yet.');
    return;
  }
  summarize('ALL', rows);

  for (const field of ['risk', 'category', 'source']) {
    const groups = new Map();
    for (const row of rows) {
      const key = row[field] || 'UNKNOWN';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    console.log(`\nBY ${field.toUpperCase()}`);
    [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .forEach(([key, group]) => summarize(key.slice(0, 18), group));
  }
}

if (command === 'add') addRow();
else if (command === 'report') report();
else usage();
