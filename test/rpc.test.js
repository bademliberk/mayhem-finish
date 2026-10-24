import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Rpc, MAX_RPC_QUEUE } from '../src/rpc.js';

const response = result => ({ ok: true, status: 200, json: async () => ({ result }) });
const setup = () => {
  const usage = [];
  const rpc = new Rpc({ key: 'test', rpcInterval: 0 }, { usage: (...args) => usage.push(args) });
  return { rpc, usage };
};
test('queue is bounded and canceled waiting requests free capacity without RPC usage', async t => {
  const { rpc, usage } = setup();let release;
  t.mock.method(globalThis, 'fetch', async () => new Promise(resolve => { release = () => resolve(response(1)); }));
  const first = rpc.accounts(['first']);
  const controller = new AbortController();
  const queued = Array.from({ length: MAX_RPC_QUEUE }, () => rpc.accounts(['queued'], { signal: controller.signal }));
  const settled = Promise.allSettled(queued);
  assert.equal(rpc.queue.length,100);
  await assert.rejects(rpc.accounts(['overflow']),/queue full/);
  controller.abort();await settled;
  assert.equal(rpc.queue.length,0);assert.equal(usage.filter(u=>u[0]==='rpc').length,1);
  release();await first;
});
test('queued deadlines expire promptly and later requests still run', async t => {
  const { rpc, usage } = setup();let release,calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    if(++calls===1) return new Promise(resolve=>{release=()=>resolve(response(1));});
    return response(2);
  });
  const first=rpc.accounts(['first']);
  await assert.rejects(rpc.accounts(['expired'],{deadlineMs:Date.now()+20}),/deadline reached/);
  assert.equal(rpc.queue.length,0);assert.equal(calls,1);
  const later=rpc.accounts(['later']);release();await first;assert.equal(await later,2);
  assert.equal(usage.filter(u=>u[0]==='rpc').length,2);
});
test('active cancellation aborts fetch and releases the serialized worker', async t => {
  const {rpc}=setup();let aborted=false,calls=0;
  t.mock.method(globalThis,'fetch',async(url,{signal})=>{
    if(++calls>1) return response(2);
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('secret URL'));},{once:true}));
  });
  const controller=new AbortController();
  const first=rpc.accounts(['first'],{signal:controller.signal});
  const failure=assert.rejects(first,/canceled/);controller.abort();await failure;
  assert.equal(await rpc.accounts(['next']),2);assert.equal(aborted,true);
});
test('active deadline aborts fetch without exposing transport details', async t => {
  const {rpc}=setup();let signal;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    signal=options.signal;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('secret URL')),{once:true}));
  });
  await assert.rejects(rpc.accounts(['deadline'],{deadlineMs:Date.now()+20}),/deadline reached/);
  assert.equal(signal.aborted,true);
  t.mock.method(globalThis,'fetch',async()=>response(4));
  assert.equal(await rpc.accounts(['next']),4);
});
test('active deadline and canceled retry sleep do not hold subsequent work', async t => {
  const {rpc}=setup();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('secret URL');});
  const first=rpc.accounts(['deadline'],{deadlineMs:Date.now()+20});
  await assert.rejects(first,/deadline reached/);
  t.mock.method(globalThis,'fetch',async()=>response(3));
  assert.equal(await rpc.accounts(['next']),3);assert.equal(calls,1);
  await sleep(5);
});
