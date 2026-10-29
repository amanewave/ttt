// Integration test of the real application event handlers, using a minimal DOM.
// This checks state transitions, not browser rendering or visual layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Network } from '../neural.js';

class Element {
  constructor(tagName='DIV') { this.tagName=tagName.toUpperCase();this.children=[];this.events={};this.attributes={};this.style={};this.dataset={};this.value='';this.className='';this._text='';this.hidden=false;this.disabled=false;this.checked=false;this.open=false;this.files=[]; }
  get textContent() { return this._text + this.children.map(x=>x.textContent || '').join(''); }
  set textContent(value) { this._text=String(value);this.children=[]; }
  set innerHTML(value) { this._text=value;this.children=[]; }
  get innerHTML() { return this._text; }
  get classList() { return { toggle:(key,yes) => { const classes=new Set(this.className.split(' ').filter(Boolean));yes?classes.add(key):classes.delete(key);this.className=[...classes].join(' '); } }; }
  addEventListener(type,handler) { (this.events[type]??=[]).push(handler); }
  async dispatch(type,extras={}) { for (const handler of this.events[type]||[]) await handler({target:this,preventDefault(){},...extras}); }
  click() { if(!this.disabled) return this.dispatch('click'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=[...children];this._text=''; }
  setAttribute(key,value) { this.attributes[key]=String(value); }
  add(option) { this.children.push(option); }
  showModal() { this.open=true; }
  close() { this.open=false; }
}

test('app supports human learning, frozen stages, disabling learning, training and reloading', async () => {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8'), elements=new Map();
  for (const match of html.matchAll(/<([a-z-]+)[^>]*\sid="([^"]+)"/g)) elements.set(match[2],new Element(match[1]));
  const el=id=>elements.get(id), storage=new Map(), listeners={};
  el('batch-size').value='1000';
  globalThis.document={
    getElementById:el,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),
    querySelectorAll:selector=>selector==='dialog'?[el('about-dialog'),el('reset-dialog')]:[],
    querySelector:()=>[el('about-dialog'),el('reset-dialog')].find(x=>x.open),
    addEventListener:(type,handler)=>listeners[type]=handler
  };
  globalThis.window={addEventListener(){}};
  globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
  globalThis.Option=class extends Element { constructor(text,value) { super('option');this.textContent=text;this.value=value; } };
  globalThis.Worker=class {
    static current;
    constructor(){ Worker.current=this;this.messages=[]; }
    postMessage(message){this.messages.push(message);}
    terminate(){this.terminated=true;}
  };
  const originalRandom=Math.random; Math.random=()=>0;
  const saved=()=>JSON.parse(storage.get('nolik-lab-v1'));
  const waitAI=()=>new Promise(resolve=>setTimeout(resolve,480));
  try {
    await import('../app.js');
    assert.equal(el('board').children.length,9);
    assert.equal(el('turn-badge').textContent,'Ваш ход');
    const initial=el('model-select').children.map(x=>x.value);
    assert.deepEqual(initial,['current','initial']);
    await el('board').children[0].click();await waitAI();
    await el('board').children[4].click();await waitAI();
    await el('board').children[8].click();
    assert.equal(saved().games,1);assert.equal(saved().stats.human,1);
    assert.notDeepEqual(saved().network,saved().snapshots[0].network);
    assert.ok(el('game-message').textContent.includes('Сеть обновила'));
    assert.ok(el('board').children.every(cell=>cell.disabled));

    await el('save-snapshot').click(); assert.equal(saved().snapshots.length,2);
    const frozen=structuredClone(saved().snapshots);
    el('model-select').value='initial';await el('model-select').dispatch('change');
    assert.equal(el('model-name').textContent,'Без обучения');
    el('auto-learn').checked=false;await el('auto-learn').dispatch('change');
    await el('board').children[0].click();await waitAI();
    await el('board').children[4].click();await waitAI();
    await el('board').children[8].click();
    assert.equal(saved().games,1);assert.equal(saved().stats.human,2);
    assert.deepEqual(saved().snapshots,frozen);

    await el('train').click();
    assert.equal(Worker.current.messages[0].type,'start');
    assert.equal(Worker.current.messages[0].games,1);
    assert.equal(el('training-overlay').hidden,false);
    assert.ok(el('board').children.every(cell=>cell.disabled));
    assert.equal(el('model-select').disabled,true);
    const worker=Worker.current;
    worker.onmessage({data:{type:'progress',completed:25,requested:1000}});
    assert.equal(el('progress').value,25);
    await el('stop-training').click();assert.deepEqual(worker.messages.at(-1),{type:'stop'});
    worker.onmessage({data:{type:'done',network:new Network().serialize(),games:26,completed:25,evaluation:{wins:60,draws:20,losses:40,count:120}}});
    assert.equal(saved().games,26);assert.equal(saved().snapshots.length,3);
    assert.equal(el('model-select').value,'current');assert.equal(el('training-overlay').hidden,true);
    assert.ok(worker.terminated);assert.equal(el('total-games').textContent,'26');
    assert.deepEqual(saved().snapshots.slice(0,2),frozen);

    const beforeReset=storage.get('nolik-lab-v1');
    el('starter-select').value='ai';await el('starter-select').dispatch('change');
    assert.equal(saved().settings.side,-1);
    assert.ok(el('human-mark').className.includes('circle'));
    assert.ok(el('board').children.every(cell=>cell.disabled));
    await waitAI();
    assert.ok(el('board').children[0].children[0].className.includes('cross'));
    assert.equal(el('turn-badge').textContent,'Ваш ход');

    el('starter-select').value='human';await el('starter-select').dispatch('change');
    assert.equal(saved().settings.side,1);
    assert.ok(el('board').children.every(cell=>!cell.disabled));
    el('starter-select').value='random';Math.random=()=>.99;
    await el('starter-select').dispatch('change');
    assert.equal(saved().settings.side,-1);
    Math.random=()=>0;await el('new-game').click();
    assert.equal(saved().settings.side,1);
    await waitAI();
    assert.ok(el('board').children.every(cell=>cell.children.length===0),'No delayed move from the abandoned round');
    assert.equal(saved().games,26);assert.equal(saved().stats.human,2);

    await el('train').click();const cancelledWorker=Worker.current;
    await el('reset').click();
    assert.ok(el('reset-dialog').open);assert.equal(saved().games,26);
    await el('confirm-reset').click();
    assert.equal(el('reset-dialog').open,false);
    assert.ok(cancelledWorker.terminated);
    assert.equal(saved().games,0);assert.deepEqual(saved().stats,{human:0,ai:0,draws:0});
    assert.equal(saved().snapshots.length,1);assert.equal(saved().history.length,0);
    assert.deepEqual(saved().network,saved().snapshots[0].network);
    assert.equal(saved().settings.starter,'random');
    assert.equal(el('training-overlay').hidden,true);
    assert.ok(el('board').children.every(cell=>!cell.disabled));
    cancelledWorker.onmessage({data:{type:'done',network:new Network().serialize(),games:1026,completed:1000,evaluation:{wins:60,draws:20,losses:40,count:120}}});
    assert.equal(saved().games,0,'Discard late messages from cancelled training');
    await waitAI();assert.ok(el('board').children.every(cell=>cell.children.length===0));

    // The stored export format must survive the real load validator.
    // Older saves without the starter preference migrate without losing training.
    const legacy=JSON.parse(beforeReset);delete legacy.settings.starter;
    storage.set('nolik-lab-v1',JSON.stringify(legacy));
    await import('../app.js?reload-test');
    assert.equal(el('total-games').textContent,'26');
    assert.equal(el('score-human').textContent,'2');
    assert.equal(el('model-select').children.length,4);
    assert.equal(el('auto-learn').checked,false);
    assert.equal(el('starter-select').value,'random');
    assert.equal(saved().settings.starter,'random');
  } finally { Math.random=originalRandom; }
});
