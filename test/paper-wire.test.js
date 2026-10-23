import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionMessage, TransactionInstruction, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { decodeFrame } from '../src/paper-wire.js';
import { PUMP } from '../src/config.js';

export function frame({ version=0, instructions, lookup=false }={}) {
  const payer=Keypair.generate();
  const builder=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:PublicKey.default.toBase58(),instructions:instructions??[
    new TransactionInstruction({programId:new PublicKey(PUMP),keys:[],data:Buffer.from([1,2,3])}),
  ]});
  const message=version==='legacy'?builder.compileToLegacyMessage():builder.compileToV0Message();
  if(lookup) message.addressTableLookups=[{accountKey:PublicKey.default,writableIndexes:[0],readonlyIndexes:[]}];
  const tx=new VersionedTransaction(message);tx.sign([payer]);
  const header=Buffer.alloc(73);header[0]=1;header.writeBigUInt64LE(15n,1);Buffer.from(tx.signatures[0]).copy(header,9);
  return Buffer.concat([header,tx.serialize()]);
}
test('Helius binary frame decodes legacy and v0 wire, preserving slot and signature',()=>{
  for(const version of ['legacy',0]) {
    const decoded=decodeFrame(frame({version}));assert.equal(decoded.slot,15);assert.equal(decoded.instructions[0].program,PUMP);
    assert.match(decoded.signature,/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    assert.deepEqual(decoded.instructions[0].data,Buffer.from([1,2,3]));
  }
});
test('bad framing, invalid wire, mismatched signature and unresolved ALT fail closed',()=>{
  assert.throws(()=>decodeFrame(Buffer.alloc(10)),/frame_layout/);
  const version=frame();version[0]=2;assert.throws(()=>decodeFrame(version),/frame_layout/);
  const mismatch=frame();mismatch[10]^=1;assert.throws(()=>decodeFrame(mismatch),/signature_mismatch/);
  const slot=frame();slot.writeBigUInt64LE(2n**63n,1);assert.throws(()=>decodeFrame(slot),/slot_overflow/);
  assert.throws(()=>decodeFrame(frame({lookup:true})),/address_lookup_table/);
  const invalid=frame();invalid.fill(255,73);assert.throws(()=>decodeFrame(invalid),/wire_version_or_layout/);
});
