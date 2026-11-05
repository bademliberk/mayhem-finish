import test from 'node:test';
import assert from 'node:assert/strict';
import { entryQuality, exitQuote, fullSaleGross, sell, terminalExitQuote, writeOffQuote } from '../src/paper-math.js';

const state = { complete: false, virtualTokens: 100n, virtualSol: 100n,
  realTokens: 1000n, realSol: 20n, supply: 1000n };
const position = { tokens_raw: '100', entry_order_id: 17, entry_cost_lamports: '60' };
const cfg = { swapFeeBps: 100, networkFeeLamports: '2' };
function conservation(quote, original = position, reserves = state) {
  assert.equal(quote.tokens, original.tokens_raw);
  assert.equal(quote.originalTokens, original.tokens_raw);
  assert.equal(BigInt(quote.soldTokens) + BigInt(quote.burnedTokens), BigInt(original.tokens_raw));
  assert.equal(quote.remainingTokens, '0');
  assert.equal(quote.accountClosed, true);
  assert.equal(quote.entryOrderId, original.entry_order_id);
  assert.ok(BigInt(quote.gross) <= reserves.realSol);
  assert.equal(BigInt(quote.net), BigInt(quote.gross) - BigInt(quote.swapFee) - BigInt(quote.networkFee));
  for (const key of ['tokens', 'originalTokens', 'soldTokens', 'burnedTokens', 'remainingTokens',
    'gross', 'swapFee', 'networkFee', 'net']) assert.equal(typeof quote[key], 'string');
}

test('partial sale finds the largest floored-gross boundary, not the unfloored inverse', () => {
  const quote = terminalExitQuote(state, position, cfg);
  assert.deepEqual(quote, { tokens: '100', originalTokens: '100', soldTokens: '26', burnedTokens: '74',
    remainingTokens: '0', gross: '20', swapFee: '1', networkFee: '2', net: '17', accountClosed: true,
    entryOrderId: 17, terminalOutcome: 'partial_sale', model: 'hypothetical_terminal_liquidation',
    writeOffReason: null, reserveEvidence: { realSol: '20', realTokens: '1000', virtualSol: '100', virtualTokens: '100' },
    mc: 0.000001 });
  assert.equal(fullSaleGross(state, 26n), 20n);
  assert.equal(fullSaleGross(state, 27n), 21n);
  conservation(quote);
});

test('exactly supported and excess liquidity sell all tokens with one fee and no rent credit', () => {
  for (const realSol of [50n, 51n, 1000n]) {
    const reserves = { ...state, realSol };
    const quote = terminalExitQuote(reserves, position, cfg);
    assert.equal(quote.terminalOutcome, 'full_sale');
    assert.equal(quote.soldTokens, '100');
    assert.equal(quote.burnedTokens, '0');
    assert.equal(quote.gross, '50');
    assert.equal(quote.swapFee, '1');
    assert.equal(quote.net, '47');
    conservation(quote, position, reserves);
  }
});

test('zero liquidity, no supported token and floored-zero output all burn without sale proceeds', () => {
  for (const reserves of [{ ...state, realSol: 0n },
    { ...state, virtualTokens: 1n, virtualSol: 1000n, realSol: 1n },
    { ...state, virtualSol: 1n, realSol: 0n }]) {
    const quote = terminalExitQuote(reserves, position, { ...cfg, swapFeeBps: 0 });
    assert.equal(quote.terminalOutcome, 'write_off');
    assert.equal(quote.soldTokens, '0');
    assert.equal(quote.burnedTokens, '100');
    assert.equal(quote.gross, '0');
    assert.equal(quote.swapFee, '0');
    assert.equal(quote.net, '-2');
    assert.equal(quote.writeOffReason, 'insufficient_real_liquidity');
    conservation(quote, position, reserves);
  }
});

test('one-lamport gross is fee dust with any positive fee but a sale at zero swap fee', () => {
  const reserves = { ...state, realSol: 1n };
  for (const swapFeeBps of [1, 100, 10000]) {
    const quote = terminalExitQuote(reserves, position, { ...cfg, swapFeeBps });
    assert.equal(quote.terminalOutcome, 'write_off');
    assert.equal(quote.writeOffReason, 'fees_exceed_output');
    assert.equal(quote.swapFee, '0');
    assert.equal(quote.net, '-2');
    conservation(quote, position, reserves);
  }
  const quote = terminalExitQuote(reserves, position, { swapFeeBps: 0, networkFeeLamports: '0' });
  assert.equal(quote.soldTokens, '2');
  assert.equal(quote.gross, '1');
  assert.equal(quote.net, '1');
  assert.equal(quote.swapFee, '0');
  conservation(quote, position, reserves);
});

test('swap fee ceiling charges one lamport and a 100% fee writes off even substantial gross', () => {
  const quote = terminalExitQuote(state, position, { swapFeeBps: 1, networkFeeLamports: '1' });
  assert.equal(quote.swapFee, '1');
  assert.equal(quote.networkFee, '1');
  assert.equal(quote.net, '18');
  const dust = terminalExitQuote(state, position, { ...cfg, swapFeeBps: 10000 });
  assert.equal(dust.terminalOutcome, 'write_off');
  assert.equal(dust.gross, '0');
  assert.equal(dust.swapFee, '0');
  conservation(dust);
});

test('positive modeled sales remain sales with zero or negative net after the network fee', () => {
  for (const realSol of [20n, 50n]) {
    const reserves = { ...state, realSol };
    const proceeds = realSol - 1n;
    for (const extra of [0n, 1n, 100000000000000000000n]) {
      const quote = terminalExitQuote(reserves, position, { ...cfg, networkFeeLamports: (proceeds + extra).toString() });
      assert.equal(quote.terminalOutcome, realSol === 20n ? 'partial_sale' : 'full_sale');
      assert.equal(quote.net, (-extra).toString());
      assert.equal(quote.writeOffReason, null);
      conservation(quote, position, reserves);
    }
  }
});

test('zero-recovery write-offs require no reserves or swap fee and preserve position identity', () => {
  const quote = writeOffQuote(position, { networkFeeLamports: '7' }, 'graduated_no_amm_exit');
  assert.deepEqual(quote, { tokens: '100', originalTokens: '100', soldTokens: '0', burnedTokens: '100',
    remainingTokens: '0', gross: '0', swapFee: '0', networkFee: '7', net: '-7', accountClosed: true,
    entryOrderId: 17, terminalOutcome: 'write_off', model: 'hypothetical_zero_recovery_write_off',
    writeOffReason: 'graduated_no_amm_exit' });
  assert.equal(writeOffQuote(position, { networkFeeLamports: 0 }, 'missing_state').net, '0');
  conservation(quote);
});

test('huge BigInts retain exact maximal sizing and token conservation', () => {
  const reserves = { ...state, virtualTokens: 10n ** 90n, virtualSol: 10n ** 60n,
    realTokens: 10n ** 100n, realSol: 10n ** 40n, supply: 10n ** 100n };
  const held = { ...position, tokens_raw: (10n ** 100n).toString() };
  const quote = terminalExitQuote(reserves, held, cfg), sold = BigInt(quote.soldTokens);
  assert.ok(sold > BigInt(Number.MAX_SAFE_INTEGER));
  assert.ok(sold < BigInt(held.tokens_raw));
  assert.equal(BigInt(quote.gross), fullSaleGross(reserves, sold));
  assert.ok(fullSaleGross(reserves, sold + 1n) > reserves.realSol);
  assert.equal(quote.reserveEvidence.virtualTokens, reserves.virtualTokens.toString());
  conservation(quote, held, reserves);
});

test('small exhaustive cases match brute-force maximum, including nonmonotone fee dust', () => {
  for (const virtualTokens of [1n, 3n, 20n]) for (const virtualSol of [1n, 7n, 31n]) {
    for (let realSol = 0n; realSol <= virtualSol; realSol++) for (const swapFeeBps of [0, 1, 5000, 10000]) {
      const reserves = { ...state, virtualTokens, virtualSol, realSol };
      const held = { ...position, tokens_raw: '25' };
      let supported = 0n;
      for (let tokens = 1n; tokens <= 25n; tokens++) {
        if (fullSaleGross(reserves, tokens) <= realSol) supported = tokens;
      }
      const gross = supported ? fullSaleGross(reserves, supported) : 0n;
      const charges = (gross * BigInt(swapFeeBps) + 9999n) / 10000n;
      const quote = terminalExitQuote(reserves, held, { ...cfg, swapFeeBps });
      assert.equal(quote.soldTokens, (gross > charges ? supported : 0n).toString());
      assert.equal(quote.gross, (gross > charges ? gross : 0n).toString());
      conservation(quote, held, reserves);
    }
  }
});

test('invalid and completed reserve states throw instead of fabricating a terminal sale', () => {
  const invalid = [null, undefined, {}, { ...state, complete: true }, { ...state, complete: undefined }];
  for (const key of ['realSol', 'realTokens', 'virtualSol', 'virtualTokens']) {
    for (const value of [-1n, undefined, null, '100', 100, NaN]) invalid.push({ ...state, [key]: value });
  }
  invalid.push({ ...state, virtualSol: 0n }, { ...state, virtualTokens: 0n });
  for (const reserves of invalid) assert.throws(() => terminalExitQuote(reserves, position, cfg), /invalid_terminal_reserves/);
});

test('invalid quantities and fees are rejected and invalid cap metadata is omitted', () => {
  for (const tokens_raw of ['0', '-1', '', '1.5', '1e3', ' 1 ', undefined, null, 10]) {
    const held = { ...position, tokens_raw };
    assert.throws(() => terminalExitQuote(state, held, cfg), /invalid_terminal_position/);
    assert.throws(() => writeOffQuote(held, cfg, 'missing_state'), /invalid_terminal_position/);
  }
  for (const networkFeeLamports of [-1, '-1', '', null, undefined, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const config = { ...cfg, networkFeeLamports };
    assert.throws(() => terminalExitQuote(state, position, config), /invalid_terminal_network_fee/);
    assert.throws(() => writeOffQuote(position, config, 'missing_state'), /invalid_terminal_network_fee/);
  }
  for (const swapFeeBps of [-1, 10001, null, undefined, 0.5]) {
    assert.throws(() => terminalExitQuote(state, position, { ...cfg, swapFeeBps }), /invalid_terminal_swap_fee/);
  }
  for (const reason of ['', ' ', null, undefined, 1]) {
    assert.throws(() => writeOffQuote(position, cfg, reason), /invalid_write_off_reason/);
  }
  for (const supply of [undefined, null, -1n, 0n, 10n ** 400n]) {
    assert.equal(Object.hasOwn(terminalExitQuote({ ...state, supply }, position, cfg), 'mc'), false);
  }
});

test('terminal quotes do not mutate reserves, positions or configuration', () => {
  const frozenState = Object.freeze({ ...state }), frozenPosition = Object.freeze({ ...position });
  const frozenCfg = Object.freeze({ ...cfg });
  terminalExitQuote(frozenState, frozenPosition, frozenCfg);
  writeOffQuote(frozenPosition, frozenCfg, 'missing_state');
  assert.deepEqual(frozenState, state);
  assert.deepEqual(frozenPosition, position);
  assert.deepEqual(frozenCfg, cfg);
});

test('legacy exitQuote and sell still prohibit partial exits and nonpositive sale output', () => {
  assert.throws(() => sell(state, 100n, cfg.swapFeeBps), /insufficient_real_liquidity/);
  assert.throws(() => exitQuote(state, position, cfg), /insufficient_real_liquidity/);
  const reserves = { ...state, realSol: 50n };
  assert.deepEqual(exitQuote(reserves, position, cfg), { tokens: '100', gross: '50', net: '47', mc: 0.000001 });
  for (const networkFeeLamports of ['49', '50']) {
    assert.throws(() => exitQuote(reserves, position, { ...cfg, networkFeeLamports }), /fees_exceed_output/);
  }
  assert.throws(() => sell({ ...state, virtualSol: 1n }, 100n, 0), /insufficient_real_liquidity/);
  assert.throws(() => sell(reserves, 100n, 10000), /fees_exceed_output/);
});

test('entryQuality preserves strict full-round-trip and liquidity rejection behavior', () => {
  const reserves = { ...state, realSol: 1000n };
  const config = { strategy: 'agent-sell-liquidity', buyLamports: '10', networkFeeLamports: '0',
    swapFeeBps: 0, minEntryLiquidityMultiple: 2, maxRoundTripLossBps: 1000 };
  assert.deepEqual(entryQuality(reserves, config), { model: 'isolated_post_buy_round_trip',
    preBuyRealSolLamports: '1000', minimumRealSolLamports: '20', postBuyRealSolLamports: '1010',
    fullExitSupported: true, roundTripNetLamports: '9', roundTripLossLamports: '1', roundTripLossBps: 1000,
    residualRealSolLamports: '1001', buyImpactBps: 2087, rejection: null });
  assert.equal(entryQuality({ ...reserves, realSol: 0n }, config).rejection, 'entry_real_liquidity');
  assert.equal(entryQuality(reserves, { ...config, networkFeeLamports: '10' }).rejection, 'entry_exit_unavailable');
  assert.equal(entryQuality(reserves, { ...config, maxRoundTripLossBps: 999 }).rejection, 'entry_round_trip_loss');
  assert.equal(entryQuality({ ...reserves, realTokens: 9n }, config).rejection, 'entry_inventory_exhaustion');
});
