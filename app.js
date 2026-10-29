import { Network, Trainer, chooseMove, chooseStartingSide, outcome, evaluate, validNetwork, seededRandom } from './neural.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'nolik-lab-v1';
const fmt = n => n.toLocaleString('ru-RU');
const tier = games => games === 0 ? 'Без обучения' : games < 250 ? 'Начальный этап' : games < 2000 ? 'Базовый этап' : games < 10000 ? 'Продолженное обучение' : 'Длительное обучение';
let toastTimer, storageWarned = false;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function freshState() {
  const network = new Network(null, seededRandom(81)).serialize();
  return { version: 1, network, games: 0, snapshots: [{ id: 'initial', label: 'Без обучения', games: 0, network }], history: [], stats: { human: 0, ai: 0, draws: 0 }, settings: { confidence: 85, side: 1, starter: 'random', autoLearn: true, probabilities: false } };
}
function validEvaluation(e) { return e && ['wins','draws','losses','count'].every(k => Number.isSafeInteger(e[k]) && e[k] >= 0) && e.count > 0 && e.wins + e.draws + e.losses === e.count; }
function validState(s) {
  return s?.version === 1 && validNetwork(s.network) && Number.isSafeInteger(s.games) && s.games >= 0 && s.games <= 1e9 &&
    Array.isArray(s.snapshots) && s.snapshots.length > 0 && s.snapshots.length <= 8 && new Set(s.snapshots.map(x => x?.id)).size === s.snapshots.length &&
    s.snapshots.every(x => x && typeof x.id === 'string' && x.id.length < 100 && x.id !== 'current' && typeof x.label === 'string' && x.label.length <= 100 && Number.isSafeInteger(x.games) && x.games >= 0 && x.games <= s.games && validNetwork(x.network)) &&
    Array.isArray(s.history) && s.history.length <= 60 && s.history.every((x,i) => Number.isSafeInteger(x.games) && x.games >= 0 && x.games <= s.games && (!i || x.games >= s.history[i-1].games) && validEvaluation(x.evaluation)) &&
    s.stats && ['human','ai','draws'].every(k => Number.isSafeInteger(s.stats[k]) && s.stats[k] >= 0) &&
    s.settings && Number.isFinite(s.settings.confidence) && s.settings.confidence >= 0 && s.settings.confidence <= 100 && [1,-1].includes(s.settings.side) && (s.settings.starter === undefined || ['random','human','ai'].includes(s.settings.starter)) && typeof s.settings.autoLearn === 'boolean' && typeof s.settings.probabilities === 'boolean';
}
let state;
try { const stored = localStorage.getItem(STORAGE_KEY); state = stored ? JSON.parse(stored) : freshState(); if (!validState(state)) throw Error('Invalid state'); }
catch { state = freshState(); setTimeout(() => toast('Не удалось прочитать сохранение. Можно восстановить обучение через импорт.'), 300); }
state.settings.starter ??= 'random';
let network = new Network(state.network), trainer = new Trainer(network, state.games);
let board = Array(9).fill(0), player = 1, trajectory = [], busy = false, thinking = false, finished = false;
let gameToken = 0, aiTimer, worker, selectedModel = 'current', matchNetwork = network.clone(), lastMove = -1;

for (let i = 0; i < 9; i++) {
  const button = document.createElement('button');
  button.className = 'cell'; button.dataset.cell = i; button.setAttribute('aria-label', `Клетка ${i+1}, пустая`);
  button.addEventListener('click', () => humanMove(i)); $('board').append(button);
}
function persist() {
  state.network = network.serialize(); state.games = trainer.games;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { $('snapshot-summary').textContent = 'Автосохранение недоступно — используйте экспорт'; if (!storageWarned) { toast('Не хватает места для автосохранения. Экспортируйте прогресс в файл.'); storageWarned = true; } }
}
function activeSnapshot() { return state.snapshots.find(s => s.id === selectedModel); }
function activeGames() { return selectedModel === 'current' ? state.games : (activeSnapshot()?.games || 0); }
function syncControls() {
  $('confidence').value = state.settings.confidence; $('confidence-value').textContent = `${state.settings.confidence}%`;
  $('confidence').style.background = `linear-gradient(to right,var(--primary) ${state.settings.confidence}%,var(--line) ${state.settings.confidence}%)`;
  $('auto-learn').checked = state.settings.autoLearn; $('show-probs').checked = state.settings.probabilities;
  $('starter-select').value = state.settings.starter;
  $('human-mark').className = `mini-mark ${state.settings.side === 1 ? 'cross' : 'circle'}`;
  $('ai-mark').className = `mini-mark ${state.settings.side === 1 ? 'circle' : 'cross'}`;
  $('human-subtitle').textContent = state.settings.side === 1 ? 'Крестики · первый ход' : 'Нолики · второй ход';
}
function syncModels() {
  const select = $('model-select'); select.replaceChildren();
  select.add(new Option(`Текущая сеть · ${fmt(state.games)} партий`, 'current'));
  state.snapshots.forEach(s => select.add(new Option(`${s.label} · ${fmt(s.games)} партий`, s.id)));
  if (selectedModel !== 'current' && !activeSnapshot()) selectedModel = 'current';
  select.value = selectedModel;
  const games = activeGames();
  $('model-name').textContent = tier(games); $('opponent-caption').textContent = tier(games);
  $('model-description').textContent = games === 0 ? 'Без обучения. Начальные случайные веса.' : selectedModel === 'current' ? `Обучена на ${fmt(games)} партиях. Обновляется после игр.` : `Копия после ${fmt(games)} партий. Веса зафиксированы.`;
}
function renderBoard() {
  const end = outcome(board);
  const prediction = state.settings.probabilities && !end && !busy ? chooseMove(matchNetwork, board, -state.settings.side, state.settings.confidence, () => 0) : null;
  const best = prediction ? prediction.probabilities.indexOf(Math.max(...prediction.probabilities)) : -1;
  [...$('board').children].forEach((cell,i) => {
    cell.replaceChildren();
    cell.className = `cell${end?.line.includes(i) ? ' winning' : ''}${lastMove === i ? ' latest' : ''}${prediction && i === best ? ' best' : ''}`;
    cell.disabled = !!board[i] || thinking || busy || finished || player !== state.settings.side;
    const value = board[i] === 1 ? 'крестик' : board[i] === -1 ? 'нолик' : 'пустая';
    cell.setAttribute('aria-label', `Клетка ${i+1}, ${value}${prediction && !board[i] ? `, вероятность выбора сетью ${Math.round(prediction.probabilities[i] * 100)} процентов` : ''}`);
    if (board[i]) { const mark = document.createElement('span'); mark.className = `mark ${board[i] === 1 ? 'cross' : 'circle'}`; mark.setAttribute('aria-hidden','true'); cell.append(mark); }
    else if (prediction) { const prob = document.createElement('span'); prob.className = 'probability'; prob.textContent = `${Math.round(prediction.probabilities[i] * 100)}%`; cell.append(prob); }
  });
  const badge = $('turn-badge');
  badge.className = `pill${thinking || busy ? ' thinking' : finished ? ' finished' : ''}`;
  const label = busy ? 'Тренировка' : thinking ? 'Нолик думает' : finished ? 'Партия окончена' : 'Ваш ход';
  const dot = document.createElement('i'); badge.replaceChildren(dot, document.createTextNode(label));
  $('training-overlay').hidden = !busy;
}
function syncStats() { for (const key of ['human','ai','draws']) $(`score-${key}`).textContent = fmt(state.stats[key]); }
function renderJourney() {
  $('total-games').textContent = fmt(state.games);
  $('experience-caption').textContent = `Сохранено этапов: ${state.snapshots.length} из 8`;
  const history = state.history;
  if (!history.length) {
    $('chart').innerHTML = '<div class="empty-chart"><span>Нет результатов проверки</span><small>Запустите обучение или завершите партию</small></div>';
    $('eval-value').textContent = '—'; $('chart-end').textContent = '0 партий'; return;
  }
  const last = history.at(-1), rate = e => e.wins / e.count * 100;
  $('eval-value').textContent = `${Math.round(rate(last.evaluation))}%`;
  $('eval-value').title = `Из ${last.evaluation.count} игр: ${last.evaluation.wins} побед, ${last.evaluation.draws} ничьих, ${last.evaluation.losses} поражений`;
  $('chart-end').textContent = `${fmt(last.games)} партий`;
  const width = 560, height = 90, maxGames = Math.max(1,last.games), points = history.map(p => [8 + p.games / maxGames * (width-16), 8 + (100-rate(p.evaluation)) / 100 * (height-16)]);
  const path = points.map(([x,y],i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const dots = points.map(([x,y],i) => `<circle cx="${x}" cy="${y}" r="${i === points.length-1 ? 3.5 : 2.5}" fill="var(--primary)" stroke="white" stroke-width="1.5"><title>${fmt(history[i].games)} партий: ${Math.round(rate(history[i].evaluation))}% побед, ${history[i].evaluation.count} тестовых игр</title></circle>`).join('');
  $('chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="История доли побед против случайного соперника: сейчас ${Math.round(rate(last.evaluation))} процентов"><path d="${path} L${points.at(-1)[0]},${height} L${points[0][0]},${height} Z" fill="var(--primary-light)"/><path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2" vector-effect="non-scaling-stroke"/>${dots}</svg>`;
}
function setBusy(value) {
  busy = value;
  for (const id of ['train','batch-size','model-select','starter-select','new-game','save-snapshot','import-data','auto-learn']) $(id).disabled = value;
  $('import-label').style.pointerEvents = value ? 'none' : '';
  $('import-label').setAttribute('aria-disabled', value);
  $('training-progress').hidden = !value;
  $('train-hint').textContent = value ? 'Обучение идёт локально. Этап сохранится автоматически.' : 'После тренировки новый этап сохранится автоматически.';
  renderBoard();
}
function resetGame(message) {
  gameToken++; clearTimeout(aiTimer); thinking = false; finished = false;
  board = Array(9).fill(0); trajectory = []; player = 1; lastMove = -1;
  if (!busy) state.settings.side = chooseStartingSide(state.settings.starter);
  syncControls();
  matchNetwork = selectedModel === 'current' ? network.clone() : new Network(activeSnapshot().network);
  $('game-message').textContent = message || (state.settings.side === 1 ? 'Вы начинаете. Ваши — крестики.' : 'Соперник начинает. Ваши — нолики.');
  persist();
  renderBoard();
  if (!busy && player !== state.settings.side) scheduleAI();
}
function addHistory(evaluation) {
  if (state.history.at(-1)?.games === state.games) state.history.pop();
  state.history.push({ games: state.games, evaluation });
  if (state.history.length > 60) state.history.splice(1, state.history.length-60);
}
function addSnapshot(automatic = false) {
  if (state.snapshots.some(s => s.games === state.games && s.id !== 'initial') || state.games === 0) { if (!automatic) toast('Этот этап уже сохранён. Сыграйте или обучите сеть дальше.'); return; }
  state.snapshots.push({ id: crypto.randomUUID(), label: tier(state.games), games: state.games, network: network.serialize() });
  if (state.snapshots.length > 8) {
    const removed = state.snapshots.splice(1, state.snapshots.length - 8);
    if (removed.some(s => s.id === selectedModel)) selectedModel = 'current';
  }
  persist(); syncModels(); renderJourney();
  if (!automatic) toast(`Этап после ${fmt(state.games)} партий сохранён. Он доступен в выборе соперника.`);
}
function move(action) {
  const before = [...board], mover = player;
  board[action] = mover; lastMove = action;
  const end = outcome(board);
  trajectory.push({ board: before, next: [...board], player: mover, action, reward: end?.winner === mover ? 1 : 0, done: !!end });
  player = -player;
  if (end) finishGame(end);
  renderBoard();
}
function finishGame(end) {
  finished = true; thinking = false;
  const key = end.winner === 0 ? 'draws' : end.winner === state.settings.side ? 'human' : 'ai';
  state.stats[key]++;
  let message = key === 'draws' ? 'Ничья.' : key === 'human' ? 'Вы победили.' : 'Победил соперник.';
  if (state.settings.autoLearn) {
    if (!state.history.length) addHistory(evaluate(network));
    trainer.absorb(trajectory, 240); state.games = trainer.games;
    if (state.games % 10 === 0) addHistory(evaluate(network));
    message += ' Сеть обновила свои веса.';
  }
  $('game-message').textContent = message;
  persist(); syncModels(); syncStats(); renderJourney();
}
function humanMove(action) {
  if (busy || thinking || finished || board[action] || player !== state.settings.side) return;
  move(action); if (!finished) scheduleAI();
}
function scheduleAI() {
  thinking = true; const token = gameToken;
  $('game-message').textContent = 'Нолик выбирает ход…'; renderBoard();
  aiTimer = setTimeout(() => {
    if (token !== gameToken || busy || finished) return;
    const choice = chooseMove(matchNetwork, board, player, state.settings.confidence);
    thinking = false;
    if (!choice) { renderBoard(); return; }
    move(choice.action);
    if (!finished) $('game-message').textContent = 'Ваш ход. Клавиши 1–9 тоже работают.';
    renderBoard();
  }, 440);
}
function train() {
  if (busy) return;
  try { worker = new Worker(new URL('./training-worker.js', import.meta.url), { type: 'module' }); }
  catch { toast('Браузер не запустил тренировку. Откройте страницу через локальный сервер.'); return; }
  const count = Number($('batch-size').value);
  if (!state.history.length) addHistory(evaluate(network));
  setBusy(true); resetGame('Идёт обучение. Можно дождаться результата или остановить его.');
  $('progress').max = count; $('progress').value = 0; $('training-status').textContent = `0 / ${fmt(count)} партий`; $('stop-training').disabled = false;
  const trainingWorker = worker;
  worker.onmessage = ({data}) => {
    if (worker !== trainingWorker || !busy) return;
    if (data.type === 'progress') { $('progress').value = data.completed; $('training-status').textContent = `${fmt(data.completed)} / ${fmt(data.requested)} партий`; }
    if (data.type === 'done') {
      network = new Network(data.network); trainer = new Trainer(network, data.games); state.games = data.games;
      addHistory(data.evaluation); addSnapshot(true); persist();
      worker.terminate(); worker = null; selectedModel = 'current'; setBusy(false); syncModels(); renderJourney();
      resetGame(`Обучение завершено: +${fmt(data.completed)} партий. Проверим в деле?`);
      toast(`Получен опыт ${fmt(data.completed)} партий. Новый этап сохранён.`);
    }
  };
  worker.onerror = () => {
    if (worker !== trainingWorker || !busy) return;
    worker.terminate(); worker = null; setBusy(false); resetGame();
    toast('Тренировка прервалась. Предыдущий прогресс сохранён. Попробуйте меньшую серию.');
  };
  worker.postMessage({ type: 'start', network: network.serialize(), games: state.games, count });
}
$('train').addEventListener('click', train);
$('stop-training').addEventListener('click', () => { worker?.postMessage({ type: 'stop' }); $('stop-training').disabled = true; $('training-status').textContent = 'Завершаем текущие партии…'; });
$('new-game').addEventListener('click', () => resetGame());
$('model-select').addEventListener('change', e => { selectedModel = e.target.value; syncModels(); resetGame(); });
$('starter-select').addEventListener('change', e => { state.settings.starter = e.target.value; resetGame(); });
$('confidence').addEventListener('input', e => { state.settings.confidence = Number(e.target.value); syncControls(); renderBoard(); });
$('confidence').addEventListener('change', persist);
$('show-probs').addEventListener('change', e => { state.settings.probabilities = e.target.checked; renderBoard(); persist(); });
$('auto-learn').addEventListener('change', e => { state.settings.autoLearn = e.target.checked; persist(); });
$('save-snapshot').addEventListener('click', () => addSnapshot());
$('about-open').addEventListener('click', () => $('about-dialog').showModal());
$('reset').addEventListener('click', () => $('reset-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }));
$('confirm-reset').addEventListener('click', () => {
  worker?.terminate(); worker = null; setBusy(false);
  state = freshState(); network = new Network(state.network); trainer = new Trainer(network); selectedModel = 'current';
  storageWarned = false; $('snapshot-summary').innerHTML = '<i></i> Прогресс сохраняется в этом браузере';
  persist(); syncControls(); syncModels(); syncStats(); renderJourney(); resetGame(); $('reset-dialog').close(); toast('Сессия сброшена. Счёт и обучение обнулены.');
});
$('export-data').addEventListener('click', () => {
  persist(); const blob = new Blob([JSON.stringify(state)], { type: 'application/json' }), url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `nolik-${state.games}-games.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Копия прогресса готова к скачиванию.');
});
$('import-label').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); $('import-data').click(); } });
$('import-data').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file || busy) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw Error('size');
    const imported = JSON.parse(await file.text());
    if (!validState(imported)) throw Error('format');
    state = imported; network = new Network(state.network); trainer = new Trainer(network, state.games); selectedModel = 'current';
    state.settings.starter ??= 'random';
    persist(); syncControls(); syncModels(); syncStats(); renderJourney(); resetGame(); toast(`Восстановлен прогресс: ${fmt(state.games)} партий.`);
  } catch { toast('Файл не подходит. Выберите JSON, сохранённый через «Экспорт» Нолика.'); }
  e.target.value = '';
});
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (/^[1-9]$/.test(e.key)) humanMove(Number(e.key)-1);
});
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
syncControls(); syncModels(); syncStats(); renderJourney(); resetGame();
