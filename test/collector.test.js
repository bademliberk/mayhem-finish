import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { decodeLogs, transactionEvents, decodeCurve, classify, decodeCreationsBeforeTruncation, recoverableCreations } from '../src/chain.js';
import { Store } from '../src/store.js';
import { Collector } from '../src/collector.js';
import { report } from '../src/report.js';
import { PUMP, MAYHEM, MINT_AUTHORITY, addresses } from '../src/config.js';
import { discoveryParams, discoveryEvents, discoveryRecovery } from '../src/stream.js';

const mint = '9HzQCGsFEwLxZyHgf4XNzJSCi6EzCr1UHW1296SWpump';
const cfg = { firstCheck: 600, recheck: 600, horizon: 86400, activeAge: 20, staleAge: 1200,
  minCap: 0.04, maxCap: 0.5, minLiquidity: 0.005, historyPages: 2 };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const key = new PublicKey(mint).toBuffer();
const string = s => { const b = Buffer.alloc(4); b.writeUInt32LE(Buffer.byteLength(s)); return Buffer.concat([b, Buffer.from(s)]); };
function tradeBytes() {
  return Buffer.concat([Buffer.from([189,219,127,211,78,230,97,238]),key,u64(10),u64(20),Buffer.from([1]),key,u64(100)]);
}
function logs(mayhem = true) {
  return [...(mayhem ? [`Program ${MAYHEM} invoke [1]`] : []),
    `Program ${PUMP} invoke [${mayhem ? 2 : 1}]`, `Program data: ${tradeBytes().toString('base64')}`,
    `Program ${PUMP} success`, ...(mayhem ? [`Program ${MAYHEM} success`] : [])];
}
const event = { type: 'create', mint, timestamp: 100, name: 'test', symbol: 'T' };
function trade(timestamp = 110, index = 1) {
  return { type: 'trade', mint, timestamp, slot: timestamp, buy: true, solAmount: '10', tokenAmount: '20', index };
}

test('PDA matches independently queried live mint', () => {
  assert.equal(addresses(mint).state, '5Dy7NYU6V7HMB7oWYikn687m3bbE2YsKdfGZW2Q4rdRF');
});
test('only Mayhem ancestry trade events count; adjacent user trade does not', () => {
  assert.equal(decodeLogs(logs()).length, 1);
  assert.equal(decodeLogs(logs(false)).length, 0);
  assert.equal(decodeLogs([...logs(), ...logs(false)]).length, 1);
});
test('caught failed CPI discards its trade events even in successful transaction', () => {
  const failed = logs().map(line => line === `Program ${MAYHEM} success` ? `Program ${MAYHEM} failed: custom program error: 0x1` : line);
  assert.equal(decodeLogs(failed).length, 0);
});
test('failed transactions and truncated logs cannot qualify', () => {
  assert.deepEqual(transactionEvents({ slot: 99, meta: { err: { InstructionError: [1, 'error'] }, logMessages: logs() } }), []);
  assert.throws(() => transactionEvents({ slot: 99, meta: { err: null, logMessages: ['Log truncated'] }, blockTime: 100 }), /truncated/);
  const decoded = transactionEvents({ meta: { err: null, logMessages: logs() }, blockTime: 200, slot: 99 });
  assert.equal(decoded[0].timestamp, 100); // Preserve on-chain event Clock timestamp on both paths.
});
test('discovery matches reference AND filter and ignores trade-only notifications', () => {
  const [filter, options] = discoveryParams();
  assert.deepEqual(filter.accountRequired,[MAYHEM,MINT_AUTHORITY]);
  assert.equal(filter.failed,false);assert.equal(options.commitment,'confirmed');
  assert.deepEqual(discoveryEvents({signature:'trade',slot:1,transaction:{meta:{err:null,logMessages:logs()}}}),[]);
  assert.throws(()=>discoveryEvents({signature:'bad',slot:1,transaction:{meta:{err:null,logMessages:['Log truncated']}}}));
});
test('creation extension recognizes Mayhem and rejects truncated event', () => {
  const prefix = Buffer.concat([Buffer.from([27,114,169,77,222,235,99,118]), string('test'),string('T'),string('uri'),key,key,key,key,u64(100),Buffer.alloc(32)]);
  const wrap = b => [`Program ${PUMP} invoke [1]`, `Program data: ${b.toString('base64')}`, `Program ${PUMP} success`];
  assert.equal(decodeLogs(wrap(prefix)).length, 0);
  assert.equal(decodeLogs(wrap(Buffer.concat([prefix,key,Buffer.from([1])])))[0].mint, mint);
  assert.equal(decodeLogs(wrap(Buffer.concat([prefix,key,Buffer.from([0])]))).length, 0);
  const notify = flag => ({signature:'creation',slot:5,transaction:{meta:{err:null,logMessages:wrap(Buffer.concat([prefix,key,Buffer.from([flag])]))}}});
  assert.equal(discoveryEvents(notify(1))[0].type,'create');
  assert.deepEqual(discoveryEvents(notify(0)),[]);
  assert.throws(() => decodeLogs(wrap(prefix.subarray(0, 40))));
});
test('financial cap and liquidity boundaries without activity inputs', () => {
  const curve = { marketCap: 0.04, liquidity: 0.005001, complete: false };
  assert.equal(classify(curve,cfg).category,'candidate');
  assert.equal(classify(curve,cfg).age,null);
  assert.equal(classify({ ...curve,liquidity:0.005 },cfg).category,'unqualified');
  assert.equal(classify({ ...curve,marketCap:0.5 },cfg).category,'candidate');
  assert.equal(classify({ ...curve,marketCap:0.500001 },cfg).category,'unqualified');
  assert.equal(classify({ ...curve,marketCap:0.039999 },cfg).category,'unqualified');
  assert.equal(classify({ ...curve,complete:true },cfg).category,'graduated');
});
test('curve decoder uses real reserves for liquidity, virtual price for cap', () => {
  const b = Buffer.alloc(166); Buffer.from([23,183,248,55,96,216,172,96]).copy(b);
  u64(1000).copy(b,8);u64(10000000).copy(b,16);u64(6000000).copy(b,32);u64(5000).copy(b,40);b[81]=1;
  const decoded = decodeCurve({ owner:PUMP,data:[b.toString('base64'),'base64'] });
  assert.equal(decoded.marketCap,0.05); assert.equal(decoded.liquidity,0.006);
  b[83]=1; assert.throws(() => decodeCurve({owner:PUMP,data:[b.toString('base64'),'base64']}));
});
test('store deduplicates replay, catches out-of-order creation, bounds activity', () => {
  const s = new Store(':memory:',cfg);
  s.apply('trade',110,[trade()]); s.apply('create',100,[event]); s.apply('trade',110,[trade()]);
  assert.equal(s.get('SELECT trade_count FROM mayhem_activity').trade_count,1);
  assert.equal(s.get('SELECT next_check FROM mints').next_check,700);
  assert.equal(s.get('SELECT last_check_at FROM mints').last_check_at,100);
  s.apply('late',90000,[trade(90000)]);
  assert.equal(s.get('SELECT trade_count FROM mayhem_activity').trade_count,1);
  assert.equal(s.get('SELECT trading_span_seconds FROM activity_durations').trading_span_seconds,10);
  assert.equal(s.get('SELECT first_trade_at FROM mayhem_activity').first_trade_at,100);
  assert.equal(s.get('SELECT observed_first_trade_at FROM mayhem_activity').observed_first_trade_at,110);
  s.close();
});
test('candidates deduplicate and long-inactive history survives resumption', () => {
  const s = new Store(':memory:',cfg);s.addMint(event);s.apply('trade',110,[trade()]);
  const curve={marketCap:0.1,liquidity:0.01,complete:false};
  for(const t of [200,300]) s.evaluate(mint,t,1,'AA==',curve,classify(curve,cfg),110);
  assert.equal(s.get('SELECT COUNT(*) n FROM candidates').n,1);
  s.evaluate(mint,1400,1,'AA==',curve,{category:'long_inactive',age:1290,passes:true},110);
  s.apply('resume',1500,[trade(1500)]);
  assert.equal(s.get('SELECT recovered_at FROM long_inactive').recovered_at,null);
  assert.equal(s.get('SELECT status FROM mints').status,'qualified');
  s.completeHistory(mint);s.finish(mint,1600,'graduated');
  s.apply('after',1700,[trade(1700)]);
  assert.equal(s.get('SELECT last_trade_at FROM mayhem_activity').last_trade_at,1500);
  s.close();
});
test('scan retains checkpoint until successful processing and retries null transaction', async () => {
  const s = new Store(':memory:',cfg);let fail=true;
  const rpc={ signatures:async()=>[{signature:'a',slot:100,blockTime:100,err:null}],
    transaction:async()=>fail ? null : {slot:100,blockTime:100,meta:{err:null,logMessages:logs()}} };
  const c=new Collector(s,rpc,cfg);
  await assert.rejects(c.scan('address',0,true));
  assert.deepEqual(s.cursor('address'),{});
  fail=false;assert.equal(await c.scan('address',0,true),true);
  assert.equal(s.cursor('address').head,'a');
  s.close();
});
test('report includes full zero-candidate days but excludes partial days', () => {
  const s=new Store(':memory:',cfg);s.run("INSERT INTO metadata VALUES('monitoring_started_at','86400')");
  const id=s.coverage('session',86400,'test');s.run('UPDATE coverage SET ended_at=? WHERE id=?',259200,id);
  const r=report(s,259200+3600);
  assert.equal(r.average.days,2);assert.equal(r.average.mean,0);assert.equal(r.daily.length,3);
  assert.equal(r.daily.at(-1).fullObservedDay,false);s.close();
});

// Partial creation recovery: prefix proof rules.
const ROOT = '11111111111111111111111111111111';
const mint2 = PUMP; // any valid public key works as a second mint
const createData = (mintKey = key, mayhem = 1) => Buffer.concat([Buffer.from([27,114,169,77,222,235,99,118]),
  string('test'),string('T'),string('uri'),mintKey,mintKey,key,key,u64(100),Buffer.alloc(32),key,Buffer.from([mayhem])]);
const dataLine = b => `Program data: ${b.toString('base64')}`;
const MARK = 'Log truncated';
const prove = lines => decodeCreationsBeforeTruncation(lines);
test('prefix decoder recovers only creations whose invocation and all ancestors closed before the marker', () => {
  const closed = [`Program ${ROOT} invoke [1]`, `Program ${PUMP} invoke [2]`, dataLine(createData()),
    `Program ${PUMP} success`, `Program ${ROOT} success`, MARK];
  const ok = prove(closed);
  assert.equal(ok.ok, true); assert.equal(ok.events.length, 1); assert.equal(ok.events[0].mint, mint);
  assert.equal(ok.events[0].index, 2);
  // Emitting invocation still open at the marker.
  assert.deepEqual(prove([`Program ${PUMP} invoke [1]`, dataLine(createData()), MARK]).events, []);
  // Emitter closed but an ancestor is open at the marker.
  assert.deepEqual(prove(closed.filter(l => l !== `Program ${ROOT} success`)).events, []);
  // Failed emitter and failed ancestor.
  assert.deepEqual(prove([`Program ${PUMP} invoke [1]`, dataLine(createData()), `Program ${PUMP} failed: custom program error: 0x1`, MARK]).events, []);
  assert.deepEqual(prove(closed.map(l => l === `Program ${ROOT} success` ? `Program ${ROOT} failed: custom program error: 0x1` : l)).events, []);
  // Creations after the marker and non-Mayhem/non-Pump emitters are never recovered.
  assert.deepEqual(prove([MARK, ...closed]).events, []);
  assert.deepEqual(prove([`Program ${ROOT} invoke [1]`, dataLine(createData()), `Program ${ROOT} success`, MARK]).events, []);
  assert.deepEqual(prove([`Program ${PUMP} invoke [1]`, dataLine(createData(key, 0)), `Program ${PUMP} success`, MARK]).events, []);
  // Only the first marker counts: a second marker or later closed scopes add nothing.
  const first = prove([`Program ${PUMP} invoke [1]`, dataLine(createData()), `Program ${PUMP} success`, MARK, MARK]);
  assert.equal(first.events.length, 1);
  // Sibling invocations: a proven one is kept while a later open one is dropped.
  const sibling = prove([`Program ${PUMP} invoke [1]`, dataLine(createData()), `Program ${PUMP} success`,
    `Program ${PUMP} invoke [1]`, dataLine(createData(new PublicKey(mint2).toBuffer())), MARK]);
  assert.deepEqual(sibling.events.map(e => e.mint), [mint]);
});
test('prefix decoder rejects malformed nesting and events and never recovers trades', () => {
  for (const lines of [
    [`Program ${PUMP} invoke [1]`, dataLine(createData()), `Program ${ROOT} success`, MARK], // mismatched close
    [`Program ${PUMP} invoke [2]`, dataLine(createData()), `Program ${PUMP} success`, MARK], // wrong depth
    [`Program ${PUMP} success`, MARK], // close without open
    [`Program ${PUMP} invoke [1]`, `Program ${PUMP} invoke [3]`, MARK],
    [`Program ${PUMP} invoke [1]`, `Program ${ROOT} invoke [bad]`, dataLine(createData()), `Program ${PUMP} success`, MARK],
    [`Program ${PUMP} invoke [1]`, dataLine(createData()), `Program ${PUMP} success extra`, `Program ${PUMP} success`, MARK],
  ]) { const r = prove(lines); assert.equal(r.ok, false); assert.equal(r.reason, 'malformed_scope'); assert.deepEqual(r.events, []); }
  const good = [`Program ${PUMP} invoke [1]`, dataLine(createData()), `Program ${PUMP} success`];
  const bad = prove([...good, `Program ${PUMP} invoke [1]`, dataLine(createData().subarray(0, 60)), `Program ${PUMP} success`, MARK]);
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'malformed_event'); assert.deepEqual(bad.events, []);
  assert.equal(prove(good).reason, 'no_truncation_marker');
  assert.equal(prove([good[0], `${good[1]}!`, good[2], MARK]).reason, 'malformed_event');
  assert.deepEqual(prove([`Program ${MAYHEM} invoke [1]`, `Program ${PUMP} invoke [2]`, dataLine(tradeBytes()),
    `Program ${PUMP} success`, `Program ${MAYHEM} success`, MARK]).events, []);
});
test('recoverableCreations requires a successful transaction; discoveryEvents keeps throwing on truncation', () => {
  const lines = [`Program ${PUMP} invoke [1]`, dataLine(createData()), `Program ${PUMP} success`, MARK];
  const tx = { slot: 7, meta: { err: null, logMessages: lines } };
  assert.equal(recoverableCreations(tx)[0].slot, 7);
  assert.deepEqual(recoverableCreations({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, 'x'] } } }), []);
  assert.deepEqual(recoverableCreations({ ...tx, meta: { logMessages: lines } }), []);
  assert.deepEqual(recoverableCreations({ ...tx, slot: undefined }), []);
  assert.deepEqual(recoverableCreations({ slot: 7, meta: { err: null, logMessages: lines.slice(0, 3) } }), []);
  const note = { signature: 'sig', slot: 7, transaction: { meta: tx.meta } };
  assert.throws(() => discoveryEvents(note), /Truncated/);
  assert.equal(discoveryRecovery(note)[0].mint, mint);
  assert.deepEqual(discoveryRecovery({ ...note, signature: 5 }), []);
});
test('quarantinePartial stores creations atomically without processed; complete replay dedups and clears', () => {
  const s = new Store(':memory:', cfg);
  const ev = { type: 'create', mint, timestamp: 100, name: 'test', symbol: 'T', index: 2, slot: 7 };
  const result = s.quarantinePartial('sig', 7, 1000, [ev]);
  assert.deepEqual(result, { recovered: true, newMints: 1 });
  assert.equal(s.get('SELECT COUNT(*) n FROM mints').n, 1);
  assert.equal(s.get('SELECT history_complete FROM mints').history_complete, 0);
  assert.equal(s.get('SELECT COUNT(*) n FROM processed').n, 0);
  assert.equal(s.get('SELECT COUNT(*) n FROM quarantined_transactions').n, 1);
  assert.equal(s.get('SELECT new_mint FROM partial_creations').new_mint, 1);
  assert.equal(s.get("SELECT amount FROM usage WHERE method='partial_creations_new'").amount, 1);
  s.quarantinePartial('sig', 7, 1001, [ev]); // repeat is idempotent for rows
  assert.equal(s.get('SELECT COUNT(*) n FROM partial_creations').n, 1);
  assert.equal(s.get('SELECT COUNT(*) n FROM quarantined_transactions').n, 1);
  s.apply('sig', 7, [ev, trade(110, 3)]); // complete replay
  assert.equal(s.get('SELECT COUNT(*) n FROM mints').n, 1);
  assert.equal(s.get('SELECT COUNT(*) n FROM quarantined_transactions').n, 0);
  assert.equal(s.get('SELECT COUNT(*) n FROM processed').n, 1);
  assert.equal(s.get('SELECT trade_count FROM mayhem_activity').trade_count, 1);
  assert.notEqual(s.get('SELECT resolved_at FROM partial_creations').resolved_at, null);
  assert.deepEqual(s.quarantinePartial('sig', 7, 1002, [ev]), { recovered: false, newMints: 0 }); // processed wins
  s.close();
});
test('partial recovery rolls back creation and paper handoff if quarantine persistence fails', () => {
  const s = new Store(':memory:', { ...cfg, paperMode: true });
  s.enqueue('partial', 7, 1000);
  s.db.exec(`CREATE TRIGGER fail_quarantine BEFORE INSERT ON quarantined_transactions
    BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  assert.throws(() => s.quarantinePartial('partial', 7, 1000, [{ ...event, index: 2, slot: 7 }]), /test failure/);
  for (const table of ['mints', 'paper_discoveries', 'partial_creations', 'quarantined_transactions', 'processed']) {
    assert.equal(s.get(`SELECT COUNT(*) n FROM ${table}`).n, 0);
  }
  assert.equal(s.get('SELECT COUNT(*) n FROM queue').n, 1);
  s.db.exec('DROP TRIGGER fail_quarantine');
  s.quarantinePartial('partial', 7, 1000, [{ ...event, index: 2, slot: 7 }]);
  assert.equal(s.get('SELECT COUNT(*) n FROM paper_discoveries WHERE handled=0').n, 1);
  assert.equal(s.get('SELECT COUNT(*) n FROM queue').n, 0);
  s.close();
});
