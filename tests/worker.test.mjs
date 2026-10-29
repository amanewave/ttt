import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network, seededRandom, validNetwork } from '../neural.js';

test('training worker completes a batch and cooperatively stops with a usable checkpoint', async () => {
  let resolveDone, stopAtProgress = false;
  const messages = [];
  globalThis.self = {
    postMessage(message) {
      messages.push(message);
      if (stopAtProgress && message.type === 'progress') self.onmessage({ data: { type: 'stop' } });
      if (message.type === 'done') resolveDone(message);
    }
  };
  await import('../training-worker.js');
  const network = new Network(null,seededRandom(81)).serialize();
  const complete = new Promise(resolve => resolveDone = resolve);
  self.onmessage({data:{type:'start',network,games:0,count:100}});
  const first = await complete;
  assert.equal(first.games,100); assert.equal(first.completed,100);
  assert.ok(validNetwork(first.network)); assert.equal(first.evaluation.count,120);
  assert.deepEqual(messages.filter(m => m.type === 'progress').map(m => m.completed),[25,50,75,100]);
  stopAtProgress = true;
  const stopped = new Promise(resolve => resolveDone = resolve);
  self.onmessage({data:{type:'start',network:first.network,games:first.games,count:1000}});
  const second = await stopped;
  assert.equal(second.completed,25); assert.equal(second.games,125);
  assert.ok(validNetwork(second.network));
  assert.notDeepEqual(second.network,first.network);
  delete globalThis.self;
});
