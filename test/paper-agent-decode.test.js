import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { PUMP, MAYHEM } from '../src/config.js';
import { agentSellEvents, decodeLogs, transactionEvents } from '../src/chain.js';

const TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58();
const mint = key(1), otherMint = key(2), user = key(3), router = key(4);
const signature = 'confirmed-signature';
const reserves = { virtualSol: '9007199254740997', virtualTokens: '18446744073709551615',
  realSol: '9007199254740993', realTokens: '18446744073709551614' };

function trade({ mint: address = mint, buy = false, solAmount = '9007199254740995',
  tokenAmount = '18446744073709551613', state = reserves, length = 129 } = {}) {
  const bytes = Buffer.alloc(Math.max(129, length));
  TRADE.copy(bytes);
  new PublicKey(address).toBuffer().copy(bytes, 8);
  bytes.writeBigUInt64LE(BigInt(solAmount), 40);
  bytes.writeBigUInt64LE(BigInt(tokenAmount), 48);
  bytes[56] = Number(buy);
  new PublicKey(user).toBuffer().copy(bytes, 57);
  bytes.writeBigInt64LE(1700000000n, 89);
  for (const [name, offset] of [['virtualSol', 97], ['virtualTokens', 105], ['realSol', 113], ['realTokens', 121]]) {
    bytes.writeBigUInt64LE(BigInt(state[name]), offset);
  }
  return bytes.subarray(0, length);
}
const data = bytes => `Program data: ${bytes.toString('base64')}`;
const scope = (program, depth, lines, success = true) => [
  `Program ${program} invoke [${depth}]`, ...lines,
  `Program ${program} ${success ? 'success' : 'failed: custom program error: 0x1'}`,
];
const agent = (events, success = true) => scope(MAYHEM, 1, scope(PUMP, 2, events.map(data)), success);
const tx = (logs = agent([trade()]), overrides = {}) => ({ signature, slot: 42,
  transaction: { signatures: [signature], message: {} }, meta: { err: null, logMessages: logs }, ...overrides });

// Inputs model canonical confirmed websocket envelopes, intentionally without blockTime.
test('confirmed Mayhem sell exposes exact known-prefix reserves and decimal amounts without blockTime', () => {
  const input = tx();
  const before = structuredClone(input);
  assert.deepEqual(agentSellEvents(input), [{ mint, index: 2, slot: 42, signature,
    solAmount: '9007199254740995', tokenAmount: '18446744073709551613', user, buy: false, reserves }]);
  assert.deepEqual(input, before);
  assert.deepEqual(agentSellEvents(tx(agent([trade({ length: 150 })])))[0].reserves, reserves);
  assert.equal(agentSellEvents(tx(undefined, { slot: 0 }))[0].slot, 0);
  assert.equal(agentSellEvents(tx(undefined, { slot: Number.MAX_SAFE_INTEGER }))[0].slot, Number.MAX_SAFE_INTEGER);
});

test('only Pump emissions beneath actual Mayhem ancestry qualify', () => {
  const cases = [
    scope(PUMP, 1, [data(trade())]),
    [...scope(MAYHEM, 1, []), ...scope(PUMP, 1, [data(trade())])],
    [...scope(PUMP, 1, [data(trade())]), ...scope(MAYHEM, 1, [])],
    scope(router, 1, [...scope(MAYHEM, 2, []), ...scope(PUMP, 2, [data(trade())])]),
    scope(MAYHEM, 1, [data(trade())]),
    scope(MAYHEM, 1, scope(router, 2, [data(trade())])),
    scope(PUMP, 1, scope(MAYHEM, 2, [data(trade())])),
    agent([trade({ buy: true })]),
  ];
  for (const logs of cases) assert.deepEqual(agentSellEvents(tx(logs)), []);
  const nested = scope(router, 1, scope(MAYHEM, 2, scope(router, 3,
    scope(PUMP, 4, [data(trade())]))));
  assert.equal(agentSellEvents(tx(nested))[0].index, 4);
});

test('failed Pump, Mayhem, or higher ancestors discard their events, not successful sibling scopes', () => {
  const failures = [
    scope(MAYHEM, 1, scope(PUMP, 2, [data(trade())], false)),
    agent([trade()], false),
    scope(router, 1, scope(MAYHEM, 2, scope(PUMP, 3, [data(trade())])), false),
  ];
  for (const logs of failures) assert.deepEqual(agentSellEvents(tx(logs)), []);
  const logs = [...agent([trade()]), ...agent([trade({ length: 97 })], false)];
  assert.equal(agentSellEvents(tx(logs))[0].index, 2);
  assert.deepEqual(agentSellEvents(tx(logs))[0].reserves, reserves);
  const caught = scope(MAYHEM, 1, [
    ...scope(PUMP, 2, [data(trade({ length: 97 }))], false),
    ...scope(PUMP, 2, [data(trade())]),
  ]);
  assert.equal(agentSellEvents(tx(caught))[0].index, 5);
});

test('selects last sell per mint in log order; later buys and unrelated sells do not supersede', () => {
  const logs = [...agent([
    trade(), trade({ mint: otherMint }), trade({ solAmount: '7' }), trade({ buy: true }),
  ]), ...scope(PUMP, 1, [data(trade({ length: 97 }))])];
  const events = agentSellEvents(tx(logs));
  assert.deepEqual(events.map(e => [e.mint, e.index, e.solAmount]), [
    [otherMint, 3, '9007199254740995'], [mint, 4, '7'],
  ]);
  assert.ok(events.every(e => e.buy === false && e.reserves !== null));
  const separate = [...agent([trade()]), ...agent([trade({ solAmount: '8' })])];
  assert.deepEqual(agentSellEvents(tx(separate)).map(e => [e.index, e.solAmount]), [[7, '8']]);
});

test('last short or invalid-reserve sell is retained as a null marker, never an earlier quote', () => {
  const invalid = [
    ...Array.from({ length: 32 }, (_, i) => trade({ length: 97 + i })),
    trade({ state: { ...reserves, virtualSol: '0' } }),
    trade({ state: { ...reserves, virtualTokens: '0' } }),
    trade({ state: { ...reserves, realSol: '9007199254740998' } }),
    trade({ state: { ...reserves, virtualTokens: '1' } }),
  ];
  for (const last of invalid) {
    const events = agentSellEvents(tx(agent([trade(), trade({ mint: otherMint }), last, trade({ buy: true })])));
    assert.equal(events.length, 2);
    assert.equal(events[0].mint, otherMint);
    assert.deepEqual(events[0].reserves, reserves);
    assert.equal(events[1].mint, mint);
    assert.equal(events[1].index, 4);
    assert.equal(events[1].reserves, null);
  }
  const zeroReal = { ...reserves, realSol: '0', realTokens: '0' };
  assert.deepEqual(agentSellEvents(tx(agent([trade({ state: zeroReal })])))[0].reserves, zeroReal);
  const equal = { virtualSol: '1', virtualTokens: '1', realSol: '1', realTokens: '1' };
  assert.deepEqual(agentSellEvents(tx(agent([trade({ state: equal })])))[0].reserves, equal);
});

test('invalid metadata and missing signatures fail closed without throwing', () => {
  const valid = tx();
  for (const input of [null, undefined, {}, { ...valid, meta: null }, { ...valid, meta: {} },
    { ...valid, meta: { err: { InstructionError: [0, 'failure'] }, logMessages: valid.meta.logMessages } },
    { ...valid, meta: { err: undefined, logMessages: valid.meta.logMessages } },
    { ...valid, meta: { err: null, logMessages: null } },
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '42', null].map(slot => ({ ...valid, slot })),
    ...[undefined, null, '', ' ', 123].map(value => ({ ...valid, signature: value })),
  ]) assert.deepEqual(agentSellEvents(input), []);
});

test('malformed nesting, mismatched closes, truncation and unfinished scopes invalidate the entire batch', () => {
  const good = agent([trade()]);
  const invalid = [
    good.slice(0, -1), good.slice(0, -2), good.slice(1),
    [`Program ${MAYHEM} invoke [0]`, ...good.slice(1)],
    [good[0], `Program ${PUMP} invoke [3]`, ...good.slice(2)],
    [good[0], `Program ${PUMP} invoke [1]`, ...good.slice(2)],
    [good[0], good[1], good[2], `Program ${MAYHEM} success`, good[4]],
    [...good, `Program ${PUMP} success`],
    [...good, `Program ${PUMP} invoke [1]`],
    [...good, `Program ${PUMP} invoke [x]`],
    [...good, `Program ${PUMP} invoke [1] trailing`],
    [...good, `Program ${PUMP} success trailing`],
    [...good, `Program ${PUMP} failed:`],
    [...good, `Program  ${PUMP} invoke [1]`],
    [...good, ` Program ${PUMP} invoke [1]`],
    [...good, 'Log truncated'], ['Log truncated', ...good],
    [...good.slice(0, 3), 'Log truncated', ...good.slice(3)],
    [...good, null], [...good, 123], [...good, data(trade())],
  ];
  for (const logs of invalid) assert.deepEqual(agentSellEvents(tx(logs)), [], JSON.stringify(logs));
});

test('malformed base64, truncated core and invalid boolean reject even an earlier good sell', () => {
  const malformed = [
    '', '!!!!', 'AAAA=', trade().toString('base64').slice(0, -1),
    `${trade().toString('base64')}=`, `${trade().toString('base64')} junk`,
    ...[0, 1, 7, 8, 40, 56, 57, 89, 96].map(length => trade({ length }).toString('base64')),
  ];
  // Correct padding but noncanonical pad bits must not be silently accepted by Buffer.from.
  const short = trade({ length: 97 }).toString('base64');
  malformed.push(`${short.slice(0, -3)}B==`);
  for (const encoded of malformed) {
    const logs = scope(MAYHEM, 1, scope(PUMP, 2, [data(trade()), `Program data: ${encoded}`]));
    assert.deepEqual(agentSellEvents(tx(logs)), [], encoded);
  }
  const badBool = trade(); badBool[56] = 2;
  assert.deepEqual(agentSellEvents(tx(agent([trade(), badBool]))), []);
  assert.deepEqual(agentSellEvents(tx(scope(MAYHEM, 1, scope(PUMP, 2, [data(trade()), 'Program data:'])))), []);
});

test('unknown complete events and ordinary runtime logs do not interfere with a valid sell', () => {
  const logs = scope(MAYHEM, 1, scope(PUMP, 2, [
    'Program log: Instruction: Sell', data(Buffer.alloc(16, 42)), data(trade()),
    `Program ${PUMP} consumed 123 of 200000 compute units`,
    `Program return: ${PUMP} AA==`,
  ]));
  assert.equal(agentSellEvents(tx(logs))[0].index, 4);
});

test('legacy short trade decoding and blockTime requirements remain unchanged', () => {
  const logs = agent([trade({ length: 97 }), trade({ buy: true, length: 97 })]);
  const legacy = decodeLogs(logs);
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy.map(e => [e.type, e.buy, e.timestamp]), [
    ['trade', false, 1700000000], ['trade', true, 1700000000],
  ]);
  assert.ok(legacy.every(e => !Object.hasOwn(e, 'reserves')));
  assert.throws(() => transactionEvents(tx(logs)), /block time/);
  assert.deepEqual(transactionEvents(tx(logs, { blockTime: 1700000000 })), legacy.map(e => ({ ...e, slot: 42 })));
  assert.equal(agentSellEvents(tx(logs))[0].reserves, null);
  assert.deepEqual(decodeLogs(agent([trade()]))[0], decodeLogs(agent([trade({ length: 97 })]))[0]);
});
