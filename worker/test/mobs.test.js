// 6-2 伺服器權威怪物的單元測試（執行方式：在 worker 資料夾輸入 npm test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate, OUT } from '../scripts/gen-mobs.mjs';
import { SPAWNS, MONSTERS, FROST_X } from '../src/mobs.gen.js';
import { MobWorld, maxHit, splitExp, encodeMob, VIEW_R, HIT_RANGE_X, ACTIVE_MS } from '../src/mobworld.js';

const NOW = 1_800_000_000_000;
const idOf = (type, x) => SPAWNS.find(s => s.type === type && (x === undefined || s.x === x)).id;
const player = (uid, x, y = 700, o = {}) => ({ uid, x, y, dead: false, active: true, ...o });
const view = () => ({ mk: new Map() });

test('mobs.gen.js 和 index.html 的 <mobsim> 區塊一致（不一致請執行 npm run gen）', () => {
  assert.equal(readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), generate());
});

test('世界：Boss 不在伺服器上，其他出生點都在', () => {
  const W = new MobWorld();
  const boss = SPAWNS.filter(s => MONSTERS[s.type].boss);
  assert.equal(boss.length, 1);
  assert.equal(W.mobs.length, SPAWNS.length - 1);
  assert.ok(!W.byId.has(boss[0].id));
});

test('傷害上限：合法的最大傷害打得出來，明顯作弊的數字會被限制', () => {
  // Lv.1 新手：攻擊 12＋木劍，風刃斬 Lv.10 爆擊 ≈ 12+9 × 2.5 × 1.75 × 1.15 ≈ 106
  assert.ok(maxHit(1, 'novice') > 106);
  assert.ok(maxHit(1, 'novice') < 2000);
  // Lv.45 巫師的實際上限：基礎約 175 ＋ 職業／被動／最好的裝備約 225 ＝ 400，魔力湧泉 ×1.21，隕石術 ×7，爆擊 ×1.75，浮動 ×1.15 ≈ 6,800
  assert.ok(maxHit(45, 'wizard') > 6800);
  assert.ok(maxHit(45, 'wizard') < 20000);
  assert.ok(maxHit(30, 'knight') > maxHit(30, 'warrior'));
  assert.equal(maxHit(5, 'nope'), maxHit(5, 'novice'));
});

test('經驗分配：一個人拿全部；多人依傷害比例，最後一擊加 10%，總和不變', () => {
  assert.deepEqual([...splitExp(560, new Map([[7, 3200]]), 7)], [[7, 560]]);
  const two = splitExp(1000, new Map([[1, 750], [2, 250]]), 2);
  assert.equal(two.get(1), 675);            // 900 × 0.75
  assert.equal(two.get(2), 225 + 100);      // 900 × 0.25 ＋ 最後一擊 100
  const three = splitExp(1650, new Map([[1, 1], [2, 1], [3, 1]]), 3);
  assert.equal([...three.values()].reduce((a, b) => a + b, 0), 1650);
  assert.ok(three.get(3) > three.get(1));
  assert.equal(three.get(1), three.get(2));
});

test('命中：檢查怪物編號、格式、距離、地圖、死亡、傷害上限', () => {
  const W = new MobWorld();
  const id = idOf('golem', 3150), m = W.byId.get(id);
  const me = { uid: 1, x: m.x - 100, y: m.y, dead: false };
  assert.equal(W.hit(me, [9999, 10, 1, 0], 500, NOW).why, 'mob');
  assert.equal(W.hit(me, [id, 10], 500, NOW).why, 'format');
  assert.equal(W.hit(me, [id, -5, 1, 0], 500, NOW).why, 'dmg');
  assert.equal(W.hit(me, [id, 'x', 1, 0], 500, NOW).why, 'dmg');
  assert.equal(W.hit({ ...me, x: m.x - HIT_RANGE_X - 10 }, [id, 10, 1, 0], 500, NOW).why, 'far');
  assert.equal(W.hit({ ...me, dead: true }, [id, 10, 1, 0], 500, NOW).why, 'pdead');
  // 雪原的玩家打不到森林的怪（座標很近也一樣）
  const edge = W.byId.get(idOf('frostwolf', 8400));
  assert.equal(W.hit({ uid: 1, x: FROST_X - 20, y: 700, dead: false }, [edge.id, 10, 1, 0], 500, NOW).why, 'far');
  // 傷害超過上限：只算上限
  const r = W.hit(me, [id, 99999, 1, 0], 40, NOW);
  assert.ok(r.ok); assert.equal(r.dmg, 40);
  assert.equal(m.hp, MONSTERS.golem.hp - 40);
  assert.equal(m.aggro, 6); assert.equal(m.ag, 1);   // 仇恨：之後會追打牠的人
});

test('擊殺：只回報有出力的人與分到的經驗值，死掉的怪不能再打，時間到在出生點重生', () => {
  const W = new MobWorld();
  const id = idOf('wolf', 3880), m = W.byId.get(id), hp = MONSTERS.wolf.hp;
  const a = { uid: 1, x: 3800, y: 700, dead: false }, b = { uid: 2, x: 3900, y: 700, dead: false };
  assert.ok(W.hit(a, [id, hp - 10, 1, 0], 9999, NOW).ok);
  const r = W.hit(b, [id, 50, -1, 1], 9999, NOW);   // 打超過剩下的血：只算剩下的 10
  assert.ok(r.kill);
  assert.equal(r.kill.id, id); assert.equal(r.kill.last, 2);
  const exp = MONSTERS.wolf.exp, ea = r.kill.exp.get(1), eb = r.kill.exp.get(2);
  assert.equal(ea + eb, exp);
  assert.ok(ea > eb);
  assert.equal(r.kill.exp.size, 2);
  assert.ok(m.dead);
  assert.equal(W.hit(a, [id, 5, 1, 0], 9999, NOW).why, 'dead');
  m.x = 3700;
  W.step(0.1, [player(1, 3800)], NOW + MONSTERS.wolf.respawn * 1000 - 100);
  assert.ok(m.dead);
  W.step(0.1, [player(1, 3800)], NOW + MONSTERS.wolf.respawn * 1000 + 1);
  assert.ok(!m.dead); assert.equal(m.hp, hp); assert.equal(m.x, 3880);
  assert.equal(m.dmg.size, 0);
  assert.equal(W.hit(a, [id, 5, 1, 0], 9999, NOW).why, 'spawn');   // 剛重生（淡入中）不能打
});

test('模擬：只模擬活躍玩家附近的怪；掛機或沒人時怪物不動', () => {
  const W = new MobWorld();
  const golem = W.byId.get(idOf('golem', 3150)), far = W.byId.get(idOf('wolf', 4200));
  const g0 = golem.x, f0 = far.x;
  // 玩家站在石甲怪左邊 150：石甲怪會追過來；霧狼（遠在 1000 外但在 1700 內）照樣模擬，雪原的怪不模擬
  let n = 0;
  for (let i = 0; i < 20; i++) n = W.step(0.1, [player(1, g0 - 150)], NOW + i * 100);
  assert.ok(n > 0);
  assert.ok(golem.x < g0 - 20, '石甲怪應該往玩家移動');
  assert.ok(golem.chasing);
  const snow = W.mobs.filter(m => m.x >= FROST_X);
  const before = snow.map(m => m.x + ',' + m.y).join();
  W.step(1, [player(1, g0 - 150)], NOW);
  assert.equal(snow.map(m => m.x + ',' + m.y).join(), before);
  // 掛機（不活躍）的玩家不會讓怪物動
  const W2 = new MobWorld();
  assert.equal(W2.step(0.1, [player(1, 3000, 700, { active: false })], NOW), 0);
  void f0; void ACTIVE_MS;
});

test('模擬：怪物只追活著的玩家；暴雪雪人會丟雪球（事件帶目標位置）', () => {
  const W = new MobWorld();
  const golem = W.byId.get(idOf('golem', 3150)), g0 = golem.x;
  for (let i = 0; i < 20; i++) W.step(0.1, [player(1, g0 - 150, 700, { dead: true })], NOW);
  assert.ok(!golem.chasing);
  const yeti = W.byId.get(idOf('yeti', 9500));
  const me = player(5, yeti.x - 200, 700);
  let ev = null;
  for (let i = 0; i < 60 && !ev; i++) {
    W.events = [];
    W.step(0.1, [me], NOW + i * 100);
    ev = W.events.map(e => e[1]).find(e => e[0] === yeti.id && e[1] === 1);
  }
  assert.ok(ev, '6 秒內應該丟出雪球');
  assert.equal(ev[2], me.x); assert.equal(ev[3], me.y);
});

test('快照：只送左右 1500 內、同一張地圖的怪；沒變化不重送；離開範圍會通知', () => {
  const W = new MobWorld(), V = view(), x = 2000;
  const msg = W.view(V, x, NOW);
  assert.equal(msg.t, 'm');
  const ids = msg.u.map(e => e[0]);
  assert.ok(ids.length > 10);
  for (const id of ids) {
    const m = W.byId.get(id);
    assert.ok(Math.abs(m.x - x) <= VIEW_R && m.x < FROST_X);
  }
  assert.ok(!ids.includes(idOf('wolf', 4200)) || W.byId.get(idOf('wolf', 4200)).x - x <= VIEW_R);
  assert.equal(W.view(V, x, NOW), null);   // 沒有變化
  const m = W.byId.get(ids[0]);
  m.hp -= 3;
  const d = W.view(V, x, NOW);
  assert.deepEqual(d.u.map(e => e[0]), [m.id]);
  assert.equal(d.u[0][4], m.hp);
  // 走到雪原：森林的怪全部離開範圍
  const s = W.view(V, 9000, NOW);
  assert.deepEqual(new Set(s.g), new Set(ids));
  assert.ok(s.u.every(e => W.byId.get(e[0]).x >= FROST_X));
});

test('快照格式：旗標與招式', () => {
  const W = new MobWorld(), m = W.byId.get(idOf('frostwolf', 8400));
  Object.assign(m, { face: -1, onGround: true, chasing: true, aggro: 2, act: { k: 'dash', st: 'tele', t: 0.37 } });
  const e = encodeMob(m);
  assert.equal(e[0], m.id);
  assert.equal(e[3] & (1 | 2 | 4 | 16 | 64), 1 | 2 | 4 | 16);
  assert.equal(e[5], 1); assert.equal(e[6], 37);
  m.dead = true;
  assert.equal(encodeMob(m)[3] & 64, 64);
  assert.equal(encodeMob(m)[5], 0);
});

test('事件只送給附近的玩家', () => {
  const W = new MobWorld();
  W.events = [[9500, [1, 2]]];
  const near = W.view(view(), 9600, NOW), far = W.view(view(), 1000, NOW);
  assert.deepEqual(near.e, [[1, 2]]);
  assert.equal(far.e, undefined);
});

test('休眠保存與還原', () => {
  const W = new MobWorld();
  const a = W.byId.get(idOf('golem', 3150)), b = W.byId.get(idOf('moss', 650));
  a.hp = 77; a.x = a.minX + 5;
  b.dead = true; b.hp = 0; b.respawnAt = NOW + 5000;
  const W2 = new MobWorld();
  W2.load(JSON.parse(JSON.stringify(W.dump())));
  const a2 = W2.byId.get(a.id), b2 = W2.byId.get(b.id);
  assert.equal(a2.hp, 77); assert.equal(a2.x, a.x);
  assert.ok(b2.dead); assert.equal(b2.respawnAt, NOW + 5000);
  W2.load([[a.id, 'x', 1, 1, 0, 1], 'bad', [99999, 1, 1, 1, 0, 1]]);   // 壞資料直接略過
  assert.equal(a2.hp, 77);
});
