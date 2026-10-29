import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { Network, Trainer, evaluate, seededRandom, outcome, legalMoves } from '../neural.js';

const positions = [];
const visited = new Set();
function visit(board, player) {
  const key = board.join(',');
  if (visited.has(key) || outcome(board)) return;
  visited.add(key);
  const moves = legalMoves(board);
  const winning = side => moves.filter(action => { const next = [...board]; next[action] = side; return outcome(next)?.winner === side; });
  const wins = winning(player), threats = winning(-player);
  if (wins.length) positions.push({ board, player, answers: wins, type: 'win' });
  else if (threats.length === 1) positions.push({ board, player, answers: threats, type: 'block' });
  for (const action of moves) { const next = [...board]; next[action] = player; visit(next, -player); }
}
visit(Array(9).fill(0), 1);

export function assessTactics(network) {
  const counts = { win: [0,0], block: [0,0] };
  for (const position of positions) {
    const q = network.predict(position.board, position.player);
    const chosen = legalMoves(position.board).reduce((a,b) => q[a] > q[b] ? a : b);
    const count = counts[position.type]; count[1]++;
    if (position.answers.includes(chosen)) count[0]++;
  }
  return { win: counts.win[0]/counts.win[1], block: counts.block[0]/counts.block[1] };
}

export function benchmark(TrainerClass = Trainer, { seeds = [42,1337,2026], milestones = [0,250,500,1000,2000] } = {}) {
  const runs = [];
  for (const seed of seeds) {
    const network = new Network(null, seededRandom(81));
    const trainer = new TrainerClass(network, 0, seededRandom(seed));
    let games = 0; const start = performance.now();
    for (const milestone of milestones) {
      while (games < milestone) { trainer.selfPlay(); games++; }
      const result = evaluate(network, 400, seededRandom(90210));
      runs.push({ seed, games, ...result, tactics: assessTactics(network), elapsedMs: Math.round(performance.now()-start) });
    }
  }
  const summary = milestones.map(games => {
    const rows = runs.filter(r => r.games === games), mean = fn => rows.reduce((sum,r) => sum+fn(r),0)/rows.length;
    return { games, wins: +(mean(r=>r.wins/r.count)*100).toFixed(1), losses: +(mean(r=>r.losses/r.count)*100).toFixed(1), takeWin: +(mean(r=>r.tactics.win)*100).toFixed(1), blockLoss: +(mean(r=>r.tactics.block)*100).toFixed(1), elapsedMs: Math.round(mean(r=>r.elapsedMs)) };
  });
  return { seeds, evaluationSeed: 90210, evaluationGames: 400, runs, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = benchmark();
  console.table(result.summary);
  const jsonIndex = process.argv.indexOf('--json');
  if (jsonIndex >= 0 && process.argv[jsonIndex+1]) await writeFile(process.argv[jsonIndex+1], JSON.stringify(result,null,2)+'\n');
}
