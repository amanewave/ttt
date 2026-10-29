import { Network, Trainer, evaluate } from './neural.js';
let trainer, requested = 0, completed = 0, stopped = false;
self.onmessage = ({data}) => {
  if (data.type === 'stop') { stopped = true; return; }
  if (data.type !== 'start') return;
  trainer = new Trainer(new Network(data.network), data.games);
  requested = data.count; completed = 0; stopped = false;
  runChunk();
};
function runChunk() {
  const end = Math.min(requested, completed + 25);
  while (completed < end && !stopped) { trainer.selfPlay(); completed++; }
  self.postMessage({ type: 'progress', completed, requested, games: trainer.games });
  if (completed >= requested || stopped) {
    self.postMessage({ type: 'done', network: trainer.network.serialize(), games: trainer.games, evaluation: evaluate(trainer.network), loss: trainer.loss, completed });
  } else setTimeout(runChunk, 0);
}
