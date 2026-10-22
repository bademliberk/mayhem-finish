import { setTimeout as sleep } from 'node:timers/promises';

// A single non-overlapping async worker; no timer per mint and no busy waiting.
export async function checkLoop(collector, isStopping, wait = sleep) {
  while (!isStopping()) {
    await collector.checkDue();
    if (!isStopping()) await wait(1500);
  }
}
