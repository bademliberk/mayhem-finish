import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionMessage, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { PUMP, addresses } from '../src/config.js';
import { projectTransaction } from '../src/paper-decode.js';
import { paperConfig } from '../src/paper-store.js';
import { buyTokens, sell } from '../src/paper-math.js';

const cfg = paperConfig({});
const mint = Keypair.generate().publicKey.toBase58();
const token = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCxEpPxuEb';
const spl = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const state = { virtualTokens: 1000000000000n, virtualSol: 1000000000n,
  realTokens: 900000000000n, realSol: 900000000n, supply: 1000000000000n, complete: false };
const states = new Map([[mint, { state }]]);
const discriminators = {
  buy: [102,6,61,18,1,218,235,234], sell: [51,230,133,164,1,127,131,173],
  buy_v3: [7,5,29,196,245,23,101,80], sell_v3: [28,146,222,119,38,196,105,213],
};
function instruction(kind = 'sell', change = () => {}) {
  const v3 = kind.endsWith('v3'), buy = kind.startsWith('buy');
  const accounts = Array.from({ length: v3 ? 17 : buy ? 16 : 14 }, () => Keypair.generate().publicKey.toBase58());
  accounts[v3 ? 1 : 2] = mint; accounts[v3 ? 5 : 3] = addresses(mint).curve;
  accounts[v3 ? 16 : 11] = PUMP; accounts[v3 ? 14 : 7] = PublicKey.default.toBase58();
  accounts[v3 ? 3 : buy ? 8 : 9] = token;
  if (v3) { accounts[2] = 'So11111111111111111111111111111111111111112'; accounts[4] = spl; }
  const data = Buffer.alloc(buy ? v3 ? 25 : 26 : 24);
  Buffer.from(discriminators[kind]).copy(data);
  data.writeBigUInt64LE(100000000000n, 8); data.writeBigUInt64LE(buy ? 1000000000n : 0n, 16);
  change(accounts, data);
  return new TransactionInstruction({ programId: new PublicKey(PUMP),
    keys: accounts.map(key => ({ pubkey: new PublicKey(key), isSigner: false, isWritable: true })), data });
}
function frame(instructions, legacy = false) {
  const payer = Keypair.generate();
  const builder = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions });
  const tx = new VersionedTransaction(legacy ? builder.compileToLegacyMessage() : builder.compileToV0Message());
  tx.sign([payer]);
  const header = Buffer.alloc(73); header[0] = 1; header.writeBigUInt64LE(15n, 1);
  Buffer.from(tx.signatures[0]).copy(header, 9);
  return Buffer.concat([header, tx.serialize()]);
}
const project = ix => projectTransaction(frame(Array.isArray(ix) ? ix : [ix]), states, cfg);

test('direct legacy/v3 exact-token buys and sells project isolated BigInt reserve states', () => {
  for (const kind of Object.keys(discriminators)) {
    const before = { ...state }, buy = kind.startsWith('buy');
    const expected = (buy ? buyTokens : sell)(state, 100000000000n, cfg.swapFeeBps);
    for (const legacy of [false, true]) {
      const result = projectTransaction(frame([instruction(kind)], legacy), states, cfg);
      assert.equal(result.mint, mint); assert.equal(result.slot, 15);
      assert.equal(result.side, buy ? 'buy' : 'sell');
      assert.deepEqual(result.state, expected.state);
      assert.deepEqual(state, before);
    }
  }
});
test('instruction slippage limits, zero amounts and real-liquidity shortages are rejected', () => {
  assert.throws(() => project(instruction('buy', (_, data) => data.writeBigUInt64LE(1n, 16))), /modeled_instruction_slippage/);
  assert.throws(() => project(instruction('sell', (_, data) => data.writeBigUInt64LE(999999999n, 16))), /modeled_instruction_slippage/);
  assert.throws(() => project(instruction('sell', (_, data) => data.writeBigUInt64LE(0n, 8))), /reserve_or_amount_limit/);
  const thin = new Map([[mint, { state: { ...state, realSol: 1n } }]]);
  assert.throws(() => projectTransaction(frame([instruction()]), thin, cfg), /reserve_or_amount_limit/);
});
test('unknown variants, partial fills, malformed flags and account layouts fail closed', () => {
  assert.throws(() => project(instruction('buy', (_, data) => { data[0] = 255; })), /instruction_variant/);
  for (const kind of ['buy', 'buy_v3']) {
    assert.throws(() => project(instruction(kind, (_, data) => { data[data.length - 1] = 1; })), /partial_fill/);
    assert.throws(() => project(instruction(kind, (_, data) => { data[24] = 2; })), /partial_fill/);
  }
  const ix = instruction(); ix.data = ix.data.subarray(0, 23);
  assert.throws(() => project(ix), /instruction_layout/);
  assert.throws(() => project(instruction('sell', keys => keys.pop())), /instruction_layout/);
});
test('mint/curve pairing, program and native quote are validated', () => {
  assert.throws(() => project(instruction('sell', keys => { keys[3] = mint; })), /curve_accounts/);
  assert.throws(() => project(instruction('sell', keys => { keys[9] = mint; })), /token_program/);
  assert.throws(() => project(instruction('sell_v3', keys => { keys[2] = mint; })), /non_sol_quote/);
  assert.throws(() => projectTransaction(frame([instruction()]), new Map(), cfg), /unwatched_mint/);
  assert.throws(() => projectTransaction(frame([instruction('sell_v3')]), new Map([[mint, { state: { ...state, cashback: true } }]]), cfg), /v3_cashback/);
});
test('multiple swaps, router/CPI and other account effects are rejected', () => {
  assert.throws(() => project([instruction(), instruction('buy')]), /cpi_or_multi_swap/);
  const router = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
  assert.throws(() => project(router), /cpi_or_multi_swap/);
  assert.throws(() => project([instruction(), router]), /other_instruction_effects/);
  const compute = new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([2,0,0,1,0]) });
  assert.equal(project([compute, instruction()]).side, 'sell');
});
