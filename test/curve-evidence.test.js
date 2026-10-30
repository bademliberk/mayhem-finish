import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { curveLayoutEvidence, decodeCurve } from '../src/chain.js';
import { PUMP } from '../src/config.js';
import { Store } from '../src/store.js';
import { PaperStore, paperConfig } from '../src/paper-store.js';

const schema = JSON.parse(readFileSync(new URL('./fixtures/pump-curve-prefix.json', import.meta.url)));
const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg = { firstCheck: 30, recheck: 30, horizon: 86400, paperMode: true };
function synthetic(quote = schema.nativeSolQuote, size = 166) {
  // Built from the pinned prefix fields, not a captured on-chain account/version.
  const b = Buffer.alloc(size); Buffer.from(schema.discriminator).copy(b);
  const sizes = { u64: 8, bool: 1, pubkey: 32 };
  let offset = 8;
  for (const field of schema.prefixFields) {
    if (field.type === 'u64') b.writeBigUInt64LE(1000000000n, offset);
    if (field.name === 'is_mayhem_mode') b[offset] = 1;
    if (field.name === 'quote_mint') {
      assert.equal(offset, schema.quoteOffset);
      new PublicKey(quote).toBuffer().copy(b, offset);
    }
    offset += sizes[field.type];
  }
  return { owner: PUMP, data: [b.toString('base64'), 'base64'] };
}

test('pinned IDL prefix separates zero curve quote from wrapped-SOL instruction convention', () => {
  const native = synthetic();
  assert.equal(decodeCurve(native).mayhem, true);
  assert.deepEqual(curveLayoutEvidence(native), { curveDiscriminatorMatches: true,
    quoteLayout: 'documented_quote_prefix_83', quoteMintObserved: schema.nativeSolQuote });
  for (const quote of [schema.v3SolInstructionQuote, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']) {
    const account = synthetic(quote);
    assert.throws(() => decodeCurve(account), error => error.validation === 'unsupported_quote');
    assert.equal(curveLayoutEvidence(account).quoteMintObserved, quote);
  }
  // Sufficient prefix bytes give evidence, not an account-version assertion.
  assert.equal(curveLayoutEvidence(synthetic(schema.nativeSolQuote, 115)).quoteLayout, 'documented_quote_prefix_83');
});

test('quote evidence fails closed for malformed, wrong-owner, short and wrong-discriminator inputs', () => {
  const empty = { curveDiscriminatorMatches: null, quoteLayout: null, quoteMintObserved: null };
  for (const account of [null, { owner: PUMP, data: ['!secret', 'base64'] }, { ...synthetic(), owner: 'secret' },
    { owner: PUMP, data: ['AA==', 'base64'] }]) assert.deepEqual(curveLayoutEvidence(account), empty);
  const b = Buffer.from(synthetic().data[0], 'base64');
  assert.deepEqual(curveLayoutEvidence({ owner: PUMP, data: [b.subarray(0, 114).toString('base64'), 'base64'] }),
    { curveDiscriminatorMatches: true, quoteLayout: null, quoteMintObserved: null });
  b[0] ^= 1;
  assert.deepEqual(curveLayoutEvidence({ owner: PUMP, data: [b.toString('base64'), 'base64'] }),
    { curveDiscriminatorMatches: false, quoteLayout: null, quoteMintObserved: null });
});

test('bounded fault evidence persists public fields and old rows remain unknown through migration', () => {
  const store = new Store(':memory:', cfg);
  try {
    let paper = new PaperStore(store, paperConfig({}));
    paper.accountFault(mint, 1, synthetic(schema.v3SolInstructionQuote), 'invalid_curve', 100, 'unsupported_quote');
    let sample = paper.report(200).recentAccountFaults[0];
    assert.equal(sample.quoteMintObserved, schema.v3SolInstructionQuote);
    assert.equal(sample.curveDiscriminatorMatches, true);
    for (const column of ['curve_discriminator_matches', 'quote_layout', 'quote_mint_observed']) {
      store.db.exec(`ALTER TABLE paper_account_faults DROP COLUMN ${column}`);
    }
    // The read-only report path must not require a migration to read an older run.
    sample = paper.report(200).recentAccountFaults[0];
    assert.equal(sample.quoteMintObserved, null);
    assert.equal(sample.curveDiscriminatorMatches, null);
    paper = new PaperStore(store, paperConfig({}));
    sample = paper.report(200).recentAccountFaults[0];
    assert.equal(sample.quoteMintObserved, null);
    assert.equal(sample.subtype, 'unsupported_quote');
    assert.equal(store.get('SELECT COUNT(*) n FROM paper_account_faults').n, 1);
    for (let i = 0; i < 105; i++) paper.accountFault(mint, i + 2, synthetic(), 'invalid_curve', 300 + i, 'invalid_flags');
    assert.equal(paper.report(500).recentAccountFaults.length, 100);
    assert.ok(paper.report(500).recentAccountFaults.every(row => row.quoteMintObserved === schema.nativeSolQuote));
  } finally { store.close(); }
});
