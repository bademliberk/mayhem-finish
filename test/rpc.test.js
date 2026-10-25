import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Rpc, MAX_RPC_QUEUE } from '../src/rpc.js';

const response = result => ({ ok: true, status: 200, json: async () => ({ result }) });
const setup = (options = {}) => {
  const usage = [];
  const rpc = new Rpc({ key: 'test', rpcInterval: 0, ...options }, { usage: (...args) => usage.push(args) });
  return { rpc, usage };
};
test('uncooperative fetch and body cannot block later work after the default deadline', async t => {
  for (const phase of ['fetch', 'body']) {
    const {rpc}=setup({requestTimeoutMs:30});let late,calls=0;
    t.mock.method(globalThis,'fetch',()=>{
      if (++calls>1) return Promise.resolve(response(9));
      const blocked=new Promise((resolve,reject)=>{late=()=>reject(new Error('secret URL'));});
      return phase==='fetch'?blocked:Promise.resolve({ok:true,status:200,json:()=>blocked});
    });
    await assert.rejects(rpc.transaction('first'),/deadline reached/);
    assert.equal(await rpc.transaction('next'),9);
    late();await sleep(5);assert.equal(calls,2);
    t.mock.restoreAll();
  }
});
test('caller cancellation releases a transport that ignores abort', async t => {
  const {rpc}=setup();let calls=0,late;
  t.mock.method(globalThis,'fetch',()=>++calls===1?new Promise(resolve=>{late=resolve;}):Promise.resolve(response(8)));
  const controller=new AbortController();
  const first=rpc.accounts(['first'],{signal:controller.signal});
  const rejected=assert.rejects(first,/canceled/);controller.abort();await rejected;
  assert.equal(await rpc.accounts(['next']),8);
  late(response(1));await sleep(5);assert.equal(calls,2);
});
test('earlier caller deadline wins and stalled error-body cancellation is best effort', async t => {
  const {rpc}=setup({requestTimeoutMs:1000});
  t.mock.method(globalThis,'fetch',()=>new Promise(()=>{}));
  await assert.rejects(rpc.accounts(['first'],{deadlineMs:Date.now()+20}),/deadline reached/);
  t.mock.method(globalThis,'fetch',async()=>({ok:false,status:403,body:{cancel:()=>new Promise(()=>{})}}));
  await assert.rejects(rpc.transaction('error'),/HTTP 403/);
  t.mock.method(globalThis,'fetch',async()=>response(7));
  assert.equal(await rpc.transaction('next'),7);
});
test('attempt timeout covers an uncooperative body and leaves retry sleep cancelable', async t => {
  const {rpc,usage}=setup({attemptTimeoutMs:10,requestTimeoutMs:40});
  t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,json:()=>new Promise(()=>{})}));
  await assert.rejects(rpc.transaction('body'),/deadline reached/);
  assert.ok(usage.some(u=>u[1]==='attempt_timeout'));
  t.mock.method(globalThis,'fetch',async()=>response(6));
  assert.equal(await rpc.transaction('next'),6);
});
test('stop rejects active and queued work without awaiting an uncooperative transport',async t=>{
  const {rpc}=setup();t.mock.method(globalThis,'fetch',()=>new Promise(()=>{}));
  const jobs=[rpc.transaction('active'),rpc.transaction('queued')];
  const rejected=Promise.all(jobs.map(job=>assert.rejects(job,/RPC stopped/)));
  rpc.stop();await rejected;await sleep(5);
  assert.equal(rpc.running,false);assert.equal(rpc.queue.length,0);
  await assert.rejects(rpc.transaction('later'),/RPC stopped/);
});

test('queued discovery requests receive the same finite default deadline',async t=>{
  const {rpc}=setup({requestTimeoutMs:25});
  t.mock.method(globalThis,'fetch',()=>new Promise(()=>{}));
  const first=rpc.transaction('first'),queued=rpc.signatures('address');
  await Promise.all([assert.rejects(first,/deadline reached/),assert.rejects(queued,/deadline reached/)]);
  assert.equal(rpc.queue.length,0);
  t.mock.method(globalThis,'fetch',async()=>response(5));
  assert.equal(await rpc.transaction('next'),5);
});

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
