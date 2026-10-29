// A small zero-sum Deep Q Network. No game tree or scripted moves are used.
export const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
export function outcome(board) {
  for (const line of LINES) if (board[line[0]] && line.every(i => board[i] === board[line[0]])) return { winner: board[line[0]], line };
  return board.every(Boolean) ? { winner: 0, line: [] } : null;
}
export const legalMoves = board => board.flatMap((v, i) => v === 0 ? [i] : []);
// Crosses always start; the first player receives crosses for this round.
export function chooseStartingSide(starter = 'random', random = Math.random) {
  if (starter === 'human') return 1;
  if (starter === 'ai') return -1;
  return random() < 0.5 ? 1 : -1;
}
export function seededRandom(seed = 42) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const INPUT = 27, HIDDEN = 48, OUTPUT = 9;
function encode(board, player) {
  const input = new Float64Array(INPUT);
  for (let i = 0; i < 9; i++) input[i * 3 + (board[i] === 0 ? 0 : board[i] === player ? 1 : 2)] = 1;
  return input;
}
export class Network {
  constructor(data, random = Math.random) {
    this.w1 = data ? Float64Array.from(data.w1) : Float64Array.from({length: INPUT * HIDDEN}, () => (random() * 2 - 1) * Math.sqrt(6 / (INPUT + HIDDEN)));
    this.b1 = data ? Float64Array.from(data.b1) : new Float64Array(HIDDEN);
    this.w2 = data ? Float64Array.from(data.w2) : Float64Array.from({length: HIDDEN * OUTPUT}, () => (random() * 2 - 1) * Math.sqrt(6 / (HIDDEN + OUTPUT)));
    this.b2 = data ? Float64Array.from(data.b2) : new Float64Array(OUTPUT);
  }
  forward(board, player) {
    const input = encode(board, player), hidden = new Float64Array(HIDDEN), q = new Float64Array(OUTPUT);
    for (let h = 0; h < HIDDEN; h++) {
      let sum = this.b1[h];
      for (let i = 0; i < INPUT; i++) sum += this.w1[h * INPUT + i] * input[i];
      hidden[h] = Math.tanh(sum);
    }
    for (let a = 0; a < OUTPUT; a++) {
      let sum = this.b2[a];
      for (let h = 0; h < HIDDEN; h++) sum += this.w2[a * HIDDEN + h] * hidden[h];
      q[a] = sum;
    }
    return { input, hidden, q };
  }
  predict(board, player) { return this.forward(board, player).q; }
  update(board, player, action, target, rate = 0.006) {
    const { input, hidden, q } = this.forward(board, player);
    const error = Math.max(-1, Math.min(1, q[action] - target));
    for (let h = 0; h < HIDDEN; h++) {
      const gradient = error * this.w2[action * HIDDEN + h] * (1 - hidden[h] * hidden[h]);
      for (let i = 0; i < INPUT; i++) if (input[i]) this.w1[h * INPUT + i] -= rate * gradient;
      this.b1[h] -= rate * gradient;
      this.w2[action * HIDDEN + h] -= rate * error * hidden[h];
    }
    this.b2[action] -= rate * error;
    return error * error;
  }
  serialize() { return Object.fromEntries(['w1','b1','w2','b2'].map(key => [key, Array.from(this[key])])); }
  clone() { return new Network(this.serialize()); }
}
export function chooseMove(network, board, player, confidence = 85, random = Math.random) {
  const moves = legalMoves(board);
  if (!moves.length || outcome(board)) return null;
  const q = network.predict(board, player);
  const temperature = 0.025 + (1 - confidence / 100) ** 2 * 1.4;
  const max = Math.max(...moves.map(i => q[i]));
  const weights = moves.map(i => Math.exp((q[i] - max) / temperature));
  const total = weights.reduce((a,b) => a+b, 0);
  const probabilities = Array(9).fill(0);
  moves.forEach((a,i) => probabilities[a] = weights[i] / total);
  let sample = random() * total, action = moves.at(-1);
  for (let i = 0; i < moves.length; i++) { sample -= weights[i]; if (sample <= 0) { action = moves[i]; break; } }
  return { action, probabilities, q: Array.from(q) };
}
const TRANSFORMS = Array.from({length: 8}, (_, n) => Array.from({length: 9}, (_, i) => {
  let x = i % 3, y = Math.floor(i / 3);
  if (n >= 4) x = 2 - x;
  for (let j = 0; j < n % 4; j++) [x, y] = [2 - y, x];
  return y * 3 + x;
}));
const DISCOUNT = 0.97;
export class Trainer {
  constructor(network, games = 0, random = Math.random) {
    this.network = network; this.target = network.clone(); this.games = games; this.random = random;
    this.replay = []; this.cursor = 0; this.updates = 0; this.loss = 0;
    this.outcomes = []; this.outcomeCursor = 0;
  }
  get exploration() { return Math.max(0.08, 0.5 * Math.exp(-this.games / 1000)); }
  remember(item) {
    if (item.done) {
      if (this.outcomes.length < 2000) this.outcomes.push(item);
      else { this.outcomes[this.outcomeCursor] = item; this.outcomeCursor = (this.outcomeCursor + 1) % 2000; }
    }
    if (this.replay.length < 16000) this.replay.push(item);
    else { this.replay[this.cursor] = item; this.cursor = (this.cursor + 1) % 16000; }
  }
  learn(steps = 32) {
    for (let k = 0; k < steps && this.replay.length; k++) {
      // Reserve half the samples for known outcomes, including the losing move.
      const pool = this.outcomes.length && this.random() < 0.5 ? this.outcomes : this.replay;
      const item = pool[Math.floor(this.random() * pool.length)];
      const map = TRANSFORMS[Math.floor(this.random() * 8)];
      const board = Array(9).fill(0), next = Array(9).fill(0);
      for (let i = 0; i < 9; i++) { board[map[i]] = item.board[i]; next[map[i]] = item.next[i]; }
      let target = item.reward;
      if (!item.done) {
        const moves = legalMoves(next), online = this.network.predict(next, -item.player);
        const best = moves.reduce((a,b) => online[a] > online[b] ? a : b);
        target -= DISCOUNT * this.target.predict(next, -item.player)[best];
      }
      const loss = this.network.update(board, item.player, map[item.action], target);
      this.loss = this.loss * 0.99 + loss * 0.01;
      if (++this.updates % 240 === 0) this.target = this.network.clone();
    }
  }
  absorb(trajectory, steps = 160) {
    const last = trajectory.at(-1);
    // The move immediately before a winning reply also has a known result.
    // Record it directly, rather than waiting for bootstrapping to discover it.
    if (last?.done && last.reward === 1 && trajectory.length > 1) {
      const previous = trajectory.at(-2);
      trajectory = trajectory.map(item => item === previous ? { ...item, next: last.next, done: true, reward: -DISCOUNT } : item);
    }
    trajectory.forEach(item => this.remember(item));
    // Revisit this game's final decisions in each orientation while still fresh.
    for (const item of trajectory.filter(item => item.done)) for (const map of TRANSFORMS) {
      const board = Array(9).fill(0);
      for (let i = 0; i < 9; i++) board[map[i]] = item.board[i];
      this.network.update(board, item.player, map[item.action], item.reward);
    }
    this.learn(steps); this.games++;
  }
  selfPlay() {
    const board = Array(9).fill(0); let player = 1;
    const trajectory = [], epsilon = this.exploration;
    while (!outcome(board)) {
      const moves = legalMoves(board), q = this.network.predict(board, player);
      const action = this.random() < epsilon ? moves[Math.floor(this.random() * moves.length)] : moves.reduce((a,b) => q[a] > q[b] ? a : b);
      const before = [...board]; board[action] = player;
      const end = outcome(board);
      trajectory.push({ board: before, next: [...board], player, action, reward: end?.winner === player ? 1 : 0, done: !!end });
      player = -player;
    }
    this.absorb(trajectory, 96);
  }
}
export function evaluate(network, count = 120, random = seededRandom(2026)) {
  let wins = 0, draws = 0, losses = 0;
  for (let g = 0; g < count; g++) {
    const board = Array(9).fill(0), side = g % 2 ? -1 : 1; let player = 1;
    while (!outcome(board)) {
      const moves = legalMoves(board);
      const q = player === side ? network.predict(board, player) : null;
      const action = q ? moves.reduce((a,b) => q[a] > q[b] ? a : b) : moves[Math.floor(random() * moves.length)];
      board[action] = player; player = -player;
    }
    const winner = outcome(board).winner;
    if (winner === side) wins++; else if (!winner) draws++; else losses++;
  }
  return { wins, draws, losses, count };
}
export function validNetwork(data) {
  return !!data && [['w1',1296],['b1',48],['w2',432],['b2',9]].every(([key,size]) => Array.isArray(data[key]) && data[key].length === size && data[key].every(v => Number.isFinite(v) && Math.abs(v) < 100));
}
