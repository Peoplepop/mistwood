// 玩家特效事件（技能、遠程攻擊、受傷）的檢查與興趣範圍（執行方式：在 worker 資料夾輸入 npm test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFx, psPlayersFor, skillFits, fxNear, FX_PER_MSG, FX_RANGE, DMG_MAX } from '../src/fx.js';
import { parseState } from '../src/state.js';
import { MobWorld } from '../src/mobworld.js';
import { SPAWNS, FROST_X } from '../src/mobs.gen.js';

test('特效：技能 id 要認得、職業要符合（二轉可用一轉技能，新手技能大家都能用）', () => {
  assert.ok(skillFits('wind', 'wizard'));
  assert.ok(skillFits('heavy', 'knight'));
  assert.ok(skillFits('kholy', 'knight'));
  assert.ok(!skillFits('kholy', 'warrior'));
  assert.ok(!skillFits('fire', 'archer'));
  assert.ok(!skillFits('vigor', 'novice'));       // 被動技能沒有特效
  assert.ok(!skillFits('toString', 'novice'));
  assert.ok(!skillFits('__proto__', 'novice'));
});

test('特效：事件格式檢查、數字夾到合法範圍', () => {
  const ev = parseFx([
    ['k', 'wmeteor', -1, 5000.4, 600.6, 5230, 640],
    ['k', 'fire', 1, 100, 100],              // 巫師可以用法師的火焰球
    ['k', 'kholy', 1, 100, 100],             // 職業不符：丟掉
    ['k', 'nope', 1, 100, 100],              // 不認得的技能：丟掉
    ['k', 'thunder', 7, -99, 99999, 'x', 1], // 方向不是 -1 一律當作 1；座標夾到地圖內；目標座標格式錯誤就不帶
    ['a', -1, 300, 500, 1],
    ['d', 1e12],
  ], 'wizard');
  assert.deepEqual(ev, [
    ['k', 'wmeteor', -1, 5000, 601, 5230, 640],
    ['k', 'fire', 1, 100, 100],
    ['k', 'thunder', 1, 0, 760],
    ['a', -1, 300, 500, 1],
    ['d', DMG_MAX],
  ]);
  assert.deepEqual(parseFx([['a', 1, 1, 1, 0]], 'warrior'), []);   // 近戰職業沒有遠程攻擊事件
  assert.deepEqual(parseFx([['d', -5], ['d', 'x'], ['z', 1], 'k', null, {}], 'novice'), []);
  assert.deepEqual(parseFx('nope', 'novice'), []);
  assert.equal(parseFx(Array(20).fill(['d', 3]), 'novice').length, FX_PER_MSG);
  const long = ['k', 'thunder', 1, 10, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];   // 太長的事件直接丟掉
  assert.deepEqual(parseFx([long], 'mage'), []);
});

test('狀態：HP 百分比夾到 0～100，舊版前端沒有回報時是 -1', () => {
  assert.equal(parseState({ x: 1, y: 1, lv: 1, hp: 150 }, 10).hp, 100);
  assert.equal(parseState({ x: 1, y: 1, lv: 1, hp: 37 }, 10).hp, 37);
  assert.equal(parseState({ x: 1, y: 1, lv: 1, hp: 3.5 }, 10).hp, -1);
  assert.equal(parseState({ x: 1, y: 1, lv: 1 }, 10).hp, -1);
});

test('特效：只送給同一張地圖、左右範圍內的其他玩家', () => {
  const s = x => ({ x, y: 700 });
  assert.ok(fxNear(s(1000), s(1000 + FX_RANGE)));
  assert.ok(!fxNear(s(1000), s(1001 + FX_RANGE)));
  assert.ok(!fxNear(s(FROST_X - 10), s(FROST_X + 10)));   // 不同地圖
  const items = [
    { uid: 1, s: s(1000), j: { id: 1 }, ev: [['d', 5]] },
    { uid: 2, s: s(1200), j: { id: 2 }, ev: [] },
    { uid: 3, s: s(9000), j: { id: 3 }, ev: [['k', 'wind', 1, 9000, 700]] },
  ];
  assert.deepEqual(psPlayersFor(items, { uid: 2, s: s(1200) }), [{ id: 1, e: [['d', 5]] }, { id: 2 }, { id: 3 }]);
  assert.equal(psPlayersFor(items, { uid: 1, s: s(1000) }), null);           // 自己的事件不送回去、別人都太遠
  assert.deepEqual(psPlayersFor(items, { uid: 4, s: s(8800) }), [{ id: 1 }, { id: 2 }, { id: 3, e: [['k', 'wind', 1, 9000, 700]] }]);
  assert.equal(psPlayersFor(items, { uid: 5, s: s(5000) }), null);
});

test('打怪的傷害數字：送給附近的其他玩家，不送給出手的人', () => {
  const W = new MobWorld();
  const sp = SPAWNS.find(q => q.type === 'moss');
  const m = W.byId.get(sp.id);
  const r = W.hit({ uid: 7, x: m.x + 50, y: m.y, dead: false }, [m.id, 3, 1, 1], 999, 0);
  assert.ok(r.ok);
  const other = W.view({ mk: new Map() }, m.x, 0, 8), me = W.view({ mk: new Map() }, m.x, 0, 7), far = W.view({ mk: new Map() }, m.x + 5000, 0, 9);
  assert.deepEqual(other.e, [[m.id, 5, 3, 1]]);
  assert.equal(me.e, undefined);
  assert.ok(!far || !far.e);
});
