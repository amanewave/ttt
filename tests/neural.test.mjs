import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network, Trainer, chooseMove, chooseStartingSide, outcome, legalMoves, evaluate, seededRandom, validNetwork, LINES } from '../neural.js';
import { assessTactics } from '../scripts/benchmark-training.mjs';

test('randomly assigns crosses to either starter with equal probability, honoring forced starts', () => {
  assert.equal(chooseStartingSide('random',()=>0),1);
  assert.equal(chooseStartingSide('random',()=>0.4999),1);
  assert.equal(chooseStartingSide('random',()=>0.5),-1);
  assert.equal(chooseStartingSide('random',()=>0.9999),-1);
  const noRandom=()=>{throw Error('Forced start should not use randomness');};
  assert.equal(chooseStartingSide('human',noRandom),1);
  assert.equal(chooseStartingSide('ai',noRandom),-1);
  const random=seededRandom(100);
  let humanStarts=0;
  for(let i=0;i<10000;i++) if(chooseStartingSide('random',random)===1) humanStarts++;
  assert.ok(humanStarts>4800&&humanStarts<5200,`${humanStarts} human starts in 10,000 rounds`);
});

test('detects all eight winning lines for either side, draws and unfinished games', () => {
  for (const line of LINES) for (const side of [1,-1]) {
    const board = Array(9).fill(0); line.forEach(i => board[i] = side);
    assert.deepEqual(outcome(board), { winner: side, line });
  }
  assert.deepEqual(outcome([1,-1,1,1,-1,-1,-1,1,1]), { winner: 0, line: [] });
  assert.equal(outcome(Array(9).fill(0)), null);
});

test('every reachable unfinished board produces only legal moves and normalized probabilities', () => {
  const network = new Network(null, seededRandom(81));
  const visited = new Set();
  function walk(board, player) {
    const key = board.join(','); if (visited.has(key) || outcome(board)) return; visited.add(key);
    for (const confidence of [0,85,100]) {
      const choice = chooseMove(network, board, player, confidence, () => .99999);
      assert.equal(board[choice.action], 0);
      assert.ok(Math.abs(choice.probabilities.reduce((a,b) => a+b,0) - 1) < 1e-10);
      board.forEach((v,i) => { if (v) assert.equal(choice.probabilities[i], 0); });
    }
    for (const action of legalMoves(board)) { const next = [...board]; next[action] = player; walk(next,-player); }
  }
  walk(Array(9).fill(0),1);
  assert.ok(visited.size > 4000);
  assert.equal(chooseMove(network,[1,1,1,0,0,0,0,0,0],-1),null);
});

test('backpropagation reduces prediction error without mutating a frozen checkpoint', () => {
  const network = new Network(null,seededRandom(3)), checkpoint = network.clone();
  const board = [1,1,0,-1,-1,0,0,0,0], original = checkpoint.serialize();
  const before = Math.abs(network.predict(board,1)[2] - 1);
  for (let i=0;i<100;i++) network.update(board,1,2,1);
  assert.ok(Math.abs(network.predict(board,1)[2]-1) < before * .1);
  assert.deepEqual(checkpoint.serialize(),original);
  assert.deepEqual(new Network(network.serialize()).predict(board,1),network.predict(board,1));
});

test('confidence controls selection entropy while retaining the same learned weights', () => {
  const network = new Network(null,seededRandom(12)), board=Array(9).fill(0), before=network.serialize();
  const entropy = p => -p.reduce((sum,v) => sum+(v ? v*Math.log(v) : 0),0);
  const low=chooseMove(network,board,1,0), high=chooseMove(network,board,1,100);
  assert.ok(entropy(high.probabilities) < entropy(low.probabilities));
  assert.deepEqual(network.serialize(),before);
});

test('human-game training changes weights only when explicitly absorbed', () => {
  const network = new Network(null,seededRandom(20)), trainer = new Trainer(network,0,seededRandom(30));
  const before=network.serialize(), board=Array(9).fill(0), trajectory=[];
  let player=1;
  for (const action of [0,3,1,4,2]) {
    const previous=[...board]; board[action]=player; const end=outcome(board);
    trajectory.push({board:previous,next:[...board],player,action,reward:end?.winner===player?1:0,done:!!end}); player=-player;
  }
  const originalTrajectory=structuredClone(trajectory);
  trainer.absorb(trajectory,240);
  assert.equal(trainer.games,1); assert.notDeepEqual(network.serialize(),before); assert.ok(validNetwork(network.serialize()));
  assert.deepEqual(trajectory,originalTrajectory,'Training must not modify the recorded game');
  const losingMove=trainer.replay.find(item=>item.player===-1 && item.action===4);
  assert.equal(losingMove.done,true);
  assert.equal(losingMove.reward,-.97);
  assert.deepEqual(losingMove.next,board);
  assert.equal(trainer.outcomes.length,2,'Both the winning and the losing decision receive direct feedback');
});

test('exploration decreases early while leaving room to discover new moves', () => {
  const network=new Network(null,seededRandom(81));
  assert.equal(new Trainer(network,0).exploration,.5);
  assert.ok(new Trainer(network,1000).exploration<.19);
  assert.equal(new Trainer(network,10000).exploration,.08);
});

test('learning improves within 1,000–2,000 games across three training seeds', () => {
  const early=[],later=[],tactics=[];
  for(const seed of [42,1337,2026]) {
    const network=new Network(null,seededRandom(81)),trainer=new Trainer(network,0,seededRandom(seed));
    for(let i=0;i<1000;i++) trainer.selfPlay();
    early.push(evaluate(network,400,seededRandom(90210)));
    for(let i=0;i<1000;i++) trainer.selfPlay();
    later.push(evaluate(network,400,seededRandom(90210)));tactics.push(assessTactics(network));
    assert.equal(trainer.games,2000);assert.ok(validNetwork(network.serialize()));
  }
  const mean=(rows,fn)=>rows.reduce((sum,row)=>sum+fn(row),0)/rows.length;
  assert.ok(mean(early,r=>r.wins/r.count)>.8,JSON.stringify(early));
  assert.ok(mean(early,r=>r.losses/r.count)<.16,JSON.stringify(early));
  assert.ok(mean(later,r=>r.losses/r.count)<.08,JSON.stringify(later));
  assert.ok(mean(tactics,r=>r.win)>.96,JSON.stringify(tactics));
  assert.ok(mean(tactics,r=>r.block)>.6,JSON.stringify(tactics));
});

test('rejects corrupted model files, NaN and incorrect layer dimensions', () => {
  const model=new Network().serialize(); assert.equal(validNetwork(model),true);
  assert.equal(validNetwork(null),false);
  assert.equal(validNetwork({...model,w1:[0]}),false);
  assert.equal(validNetwork({...model,b2:[NaN,...model.b2.slice(1)]}),false);
  assert.equal(validNetwork({...model,b2:[Infinity,...model.b2.slice(1)]}),false);
});
