const assert = require('assert');
const {
  parseExplicitDeadline,
  daysUntil,
  summarizeExecution,
  requiredEdgePp,
  computeEv,
  scoreCandidate,
} = require('../.codex/skills/polymarket-scan/scripts/capital_roi');

const now = Date.parse('2026-05-23T00:00:00Z');

assert.strictEqual(
  parseExplicitDeadline('Will X happen by June 30, 2026?', now),
  '2026-06-30T23:59:00.000Z',
);

assert.strictEqual(
  parseExplicitDeadline('Will X happen on 2026-05-24?', now),
  '2026-05-24T23:59:00.000Z',
);

assert(daysUntil('2026-05-25T00:00:00Z', now) === 2);

const execution = summarizeExecution({
  bids: [{ price: '0.78', size: '100' }],
  asks: [
    { price: '0.80', size: '50' },
    { price: '0.81', size: '25' },
    { price: '0.83', size: '100' },
  ],
}, 79, 'token-1');

assert.strictEqual(execution.entryProb, 80);
assert.strictEqual(Number(execution.spreadPp.toFixed(6)), 2);
assert.strictEqual(Math.round(execution.askDepth2ppUsd), 60);

const fastHighProb = computeEv({
  entryProb: 80,
  rawFairProb: 90,
  evidenceReliability: 1,
  capitalHorizonDays: 2,
});
const slowMediumProb = computeEv({
  entryProb: 60,
  rawFairProb: 75,
  evidenceReliability: 1,
  capitalHorizonDays: 30,
});

assert(fastHighProb.evPerDay > slowMediumProb.evPerDay);
assert.strictEqual(Number(fastHighProb.evYield.toFixed(3)), 0.125);
assert.strictEqual(Number(slowMediumProb.evYield.toFixed(3)), 0.25);

assert(requiredEdgePp(80, 'confirmed/result-lag', 0) < requiredEdgePp(80, 'geopolitics/conflict', 0));

const liquidScore = scoreCandidate({
  entryProb: 80,
  volume: 100000,
  volume24hr: 10000,
  liquidity: 50000,
  capitalHorizonDays: 2,
  spreadPp: 1,
  askDepth2ppUsd: 5000,
});
const thinScore = scoreCandidate({
  entryProb: 80,
  volume: 100000,
  volume24hr: 10000,
  liquidity: 100,
  capitalHorizonDays: 2,
  spreadPp: 6,
  askDepth2ppUsd: 10,
});

assert(liquidScore > thinScore);

console.log('capital_roi tests passed');
