import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getTransactionDecoder } from '@solana/transactions';
import { projectTransaction } from '../src/paper-decode.js';
import { decodeFrame } from '../src/paper-wire.js';
import { paperConfig, PaperStore } from '../src/paper-store.js';
import { Store } from '../src/store.js';
import { buyExactInput } from '../src/paper-math.js';
import { LookupCache } from '../src/paper-lookups.js';
import { PublicKey, Keypair, TransactionMessage, TransactionInstruction, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import { PUMP } from '../src/config.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/paper-confirmed.json',import.meta.url)));
function wrap(row) {
  const wire=Buffer.from(row.wire,'base64'), tx=getTransactionDecoder().decode(wire);
  const header=Buffer.alloc(73);header[0]=1;header.writeBigUInt64LE(BigInt(row.slot),1);
  Buffer.from(Object.values(tx.signatures)[0]).copy(header,9);return Buffer.concat([header,wire]);
}
test('public confirmed legacy nonce/close and v1 sells decode and project (not historical fill replay)',()=>{
  for(const row of fixtures){
    const raw=wrap(row),frame=decodeFrame(raw);
    assert.equal(frame.signature,row.signature);assert.equal(frame.version,row.version);
    const ix=frame.instructions.find(ix=>ix.program===PUMP);
    assert.equal(ix.accounts[3],'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    const state={virtualTokens:1000000000000000n,virtualSol:100000000000n,realTokens:900000000000000n,realSol:90000000000n,supply:1000000000000000n,complete:false};
    const result=projectTransaction(raw,new Map([[ix.accounts[1],{state,slot:row.slot-1,at:Date.now()}]]),paperConfig({}));
    assert.equal(result.side,'sell');assert.ok(result.state.virtualSol<state.virtualSol);
    const truncated=raw.subarray(0,raw.length-1);assert.throws(()=>decodeFrame(truncated));
    assert.throws(()=>decodeFrame(Buffer.concat([raw,Buffer.from([0])])),/wire_version_or_layout/);
  }
});
test('exact-input rounding is bounded and does not invent partial fills',()=>{
  const state={virtualTokens:1000000000000n,virtualSol:1000000000n,realTokens:900000000000n,realSol:900000000n};
  for(const v3 of [false,true]){
    const q=buyExactInput(state,10000000n,200,v3);
    const net=(v3?10000000n:9999999n)*10000n/10200n;
    const input=v3?net-1n:net;
    assert.equal(q.tokens,input*state.virtualTokens/(state.virtualSol+input));
    assert.ok(q.cost<=10000000n);
    assert.throws(()=>buyExactInput({...state,realTokens:1n},10000000n,200,v3));
    assert.throws(()=>buyExactInput(state,1n,200,v3));
  }
});
test('v0 resolves writable then readonly ALT keys and skips cold or invalid indexes',()=>{
  const payer=Keypair.generate(), a=Keypair.generate().publicKey,b=Keypair.generate().publicKey;
  const table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,addresses:[a,b]}});
  const ix=new TransactionInstruction({programId:new PublicKey(PUMP),keys:[{pubkey:b,isSigner:false,isWritable:false},{pubkey:a,isSigner:false,isWritable:true}],data:Buffer.from([1])});
  const message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:PublicKey.default.toBase58(),instructions:[ix]}).compileToV0Message([table]);
  const tx=new VersionedTransaction(message);tx.sign([payer]);
  const h=Buffer.alloc(73);h[0]=1;h.writeBigUInt64LE(15n,1);Buffer.from(tx.signatures[0]).copy(h,9);const raw=Buffer.concat([h,tx.serialize()]);
  assert.throws(()=>decodeFrame(raw),/address_lookup_table/);
  assert.deepEqual(decodeFrame(raw,()=>[a.toBase58(),b.toBase58()]).instructions[0].accounts,[b.toBase58(),a.toBase58()]);
  assert.throws(()=>decodeFrame(raw,()=>[]),/lookup_index/);
});
function tableAccount(deactivated=false){
  const b=Buffer.alloc(120);b.writeUInt32LE(1);b.writeBigUInt64LE(deactivated?10n:18446744073709551615n,4);b.writeBigUInt64LE(10n,12);b[20]=1;
  Buffer.alloc(32,1).copy(b,56);Buffer.alloc(32,2).copy(b,88);
  return {owner:'AddressLookupTab1e1111111111111111111111111',data:[b.toString('base64'),'base64']};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('lookup cache bounds work, deduplicates RPC, checks snapshot slots and extension visibility',async()=>{
  let calls=0,now=100;const rpc={accounts:async()=>{calls++;return {context:{slot:10},value:[tableAccount()]};}};
  const cache=new LookupCache(rpc,()=>{},()=>now);
  assert.equal(cache.resolve('a',10,[0]),null);cache.resolve('a',10,[0]);await settle();assert.equal(calls,1);
  assert.ok(cache.resolve('a',10,[0]));assert.equal(cache.resolve('a',10,[1]),null);
  assert.ok(cache.resolve('a',11,[1]));assert.equal(cache.resolve('a',9,[0]),null);
  assert.equal(cache.resolve('a',11,[2]),null);
  now+=60001;assert.equal(cache.resolve('a',11,[0]),null);await settle();assert.equal(calls,2);
  cache.clear();assert.equal(cache.cache.size,0);await cache.stop();
});
test('rejection diagnostics retain only 100 bounded sanitized public metadata samples',()=>{
  const store=new Store(':memory:',{firstCheck:30,recheck:30,horizon:86400});
  const paper=new PaperStore(store,paperConfig({}));
  for(let i=0;i<130;i++)paper.rejection('token_program',{signature:'https://secret.test/?api-key=SECRET',slot:15,instructions:Array(20).fill({program:PUMP,discriminator:'abcdef',accounts:17,bytes:24})},i);
  assert.equal(store.get('SELECT COUNT(*) n FROM paper_rejections').n,100);
  assert.equal(store.get("SELECT count FROM paper_counters WHERE name='decode:token_program'").count,130);
  const report=paper.report();assert.equal(report.recentRejections.length,25);
  assert.equal(JSON.parse(report.recentRejections[0].detail).instructions.length,8);
  assert.ok(!JSON.stringify(report).includes('SECRET'));store.close();
});
test('invalid/deactivated lookup tables and gap/stop during RPC cannot populate usable cache',async()=>{
  for(const account of [tableAccount(true),{...tableAccount(),owner:PUMP}]){
    const cache=new LookupCache({accounts:async()=>({context:{slot:10},value:[account]})});
    cache.resolve('a',11,[0]);await settle();assert.equal(cache.resolve('a',11,[0]),null);await cache.stop();
  }
  const pending=[];const cache=new LookupCache({accounts:()=>new Promise(resolve=>pending.push(resolve))});
  for(let i=0;i<10;i++)cache.resolve(String(i),11,[0]);assert.equal(pending.length,2);
  cache.clear();const stopping=cache.stop();for(const resolve of pending)resolve({context:{slot:10},value:[tableAccount()]});
  await stopping;assert.equal(cache.cache.size,0);
});
