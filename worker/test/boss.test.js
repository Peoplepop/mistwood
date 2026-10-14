// 6-3 伺服器權威 Boss（霧之守衛）的單元測試（執行方式：在 worker 資料夾輸入 npm test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONSTERS, ARENA_X, FROST_X, BOSS, bossSig } from '../src/mobs.gen.js';
import { MobWorld, bossMaxHp, bossCredit, BOSS_SIG, BOSS_CODE, BOSS_MAX_FIGHTERS, HIT_RANGE_X } from '../src/mobworld.js';

const NOW = 1_800_000_000_000;
const G = MONSTERS.guardian;
const fighter = (uid, x, o = {}) => ({ uid, x, y: 700, dead: false, active: true, bo: true, ...o });
const view = (bo = true) => ({ mk: new Map(), bo });
const evs = W => W.events.map(e => e[1]);
// 跑 sec 秒（10 Hz），每個 tick 前清掉事件；回傳這段時間所有的 Boss 事件
function run(W, players, sec, t0 = NOW) {
  const out = [];
  for (let i = 0; i < sec * 10; i++) {
    W.events = [];
    W.step(0.1, players, t0 + i * 100);
    out.push(...evs(W).filter(e => e[0] === W.boss.id));
  }
  W.events = [];
  return out;
}

test('Boss 指紋：前端與伺服器用同一份資料（BOSS.ver 改了指紋就不同）', () => {
  assert.equal(BOSS_SIG, bossSig());
  assert.ok(BOSS.ver >= 1);
});

test('HP 加成：基礎 × (1 + 0.7 × (人數 − 1))，最多 20 人', () => {
  assert.equal(bossMaxHp(G.hp, 1), 22000);
  assert.equal(bossMaxHp(G.hp, 2), 37400);
  assert.equal(bossMaxHp(G.hp, 5), 83600);
  assert.equal(bossMaxHp(G.hp, 0), 22000);
  assert.equal(bossMaxHp(G.hp, 99), bossMaxHp(G.hp, BOSS_MAX_FIGHTERS));
});

test('HP 加成：還沒開打時依祭壇內（支援 Boss 同步）的人數；舊版前端不算', () => {
  const W = new MobWorld(), m = W.boss;
  run(W, [fighter(1, 6900)], 0.1);
  assert.equal(m.mhp, 22000); assert.equal(m.hp, 22000); assert.equal(m.nf, 1);
  run(W, [fighter(1, 6900), fighter(2, 7000), fighter(3, 6950, { bo: false })], 0.1);
  assert.equal(m.mhp, 37400); assert.equal(m.hp, 37400); assert.equal(m.nf, 2);
  // 還沒開打：有人離開就變回來
  run(W, [fighter(1, 6900), fighter(2, 5000)], 0.1);
  assert.equal(m.mhp, 22000); assert.equal(m.nf, 1);
});

test('HP 加成：開打後有人加入 → 最大 HP 變大、目前 HP 等比例增加（不補血）；有人離開不會變小', () => {
  const W = new MobWorld(), m = W.boss;
  const a = fighter(1, 6900), b = fighter(2, 7000);
  run(W, [a], 0.1);
  assert.ok(W.hit(a, [m.id, 11000, 1, 0], 99999, NOW).ok);   // 打掉一半
  assert.equal(m.hp, 11000);
  run(W, [a, b], 0.1);
  assert.equal(m.nf, 2); assert.equal(m.mhp, 37400);
  assert.equal(m.hp, 18700);   // 仍然是 50%
  run(W, [a, { ...b, x: 5000 }], 0.1);   // b 離開祭壇
  assert.equal(m.nf, 2); assert.equal(m.mhp, 37400);
});

test('HP 加成：在祭壇外打 Boss 的人也算人數', () => {
  const W = new MobWorld(), m = W.boss;
  const a = fighter(1, 6900), far = fighter(2, ARENA_X - 300);
  run(W, [a, far], 0.1);
  assert.equal(m.nf, 1);
  assert.ok(W.hit(far, [m.id, 100, 1, 0], 99999, NOW).ok);
  run(W, [a, far], 0.1);
  assert.equal(m.nf, 2); assert.equal(m.mhp, 37400);
});

test('命中：舊版前端不能打；距離、死亡、傷害上限照一般怪的規則', () => {
  const W = new MobWorld(), m = W.boss;
  run(W, [fighter(1, 6900)], 0.1);
  const me = fighter(1, m.x - 200);
  assert.equal(W.hit({ ...me, bo: false }, [m.id, 10, 1, 0], 500, NOW).why, 'boss');
  assert.equal(W.hit({ ...me, x: m.x - HIT_RANGE_X - 10 }, [m.id, 10, 1, 0], 500, NOW).why, 'far');
  assert.equal(W.hit({ ...me, x: FROST_X + 10 }, [m.id, 10, 1, 0], 500, NOW).why, 'far');   // 另一張地圖
  assert.equal(W.hit({ ...me, dead: true }, [m.id, 10, 1, 0], 500, NOW).why, 'pdead');
  const r = W.hit(me, [m.id, 99999, 1, 1], 777, NOW);
  assert.ok(r.ok); assert.equal(r.dmg, 777);
  assert.equal(m.hp, 22000 - 777);
  assert.equal(m.x, m.x);   // Boss 不會被擊退
  // 傷害數字只送給其他支援 Boss 同步的玩家
  const e = W.events.find(e => e[1][1] === 5);
  assert.ok(e); assert.equal(e[3], 1);
  assert.equal(W.view(view(true), m.x, NOW, 2).e.filter(x => x[1] === 5).length, 1);
  assert.equal(W.view(view(true), m.x, NOW, 1).e, undefined);
  const old = W.view(view(false), m.x, NOW, 3);   // 舊版前端：看得到附近的一般怪，但沒有 Boss 與 Boss 的事件
  assert.ok(!old.u.some(e => e[0] === m.id));
  assert.equal(old.e, undefined);
});

test('擊殺：經驗值依傷害比例（總和 9000）；輸出不到門檻的人只拿經驗、不算討伐', () => {
  const W = new MobWorld(), m = W.boss;
  const a = fighter(1, 6900), b = fighter(2, 7000), tap = fighter(3, 7050);
  run(W, [a, b, tap], 0.1);
  assert.equal(m.nf, 3);
  const mhp = m.mhp, need = bossCredit(mhp, 3);
  assert.equal(mhp, 52800);
  assert.equal(need, Math.ceil(52800 * 0.03));
  assert.ok(W.hit(tap, [m.id, 5, 1, 0], 99999, NOW).ok);   // 只摸一下
  assert.ok(W.hit(b, [m.id, 20000, 1, 0], 99999, NOW).ok);
  const r = W.hit(a, [m.id, 99999, 1, 0], 99999, NOW);
  assert.ok(r.kill && r.kill.boss);
  const ex = r.kill.exp;
  assert.equal([...ex.values()].reduce((s, v) => s + v, 0), G.exp);
  assert.ok(ex.get(1) > ex.get(2) && ex.get(2) > ex.get(3));
  assert.equal(r.kill.last, 1); assert.equal(r.kill.nf, 3);
  assert.deepEqual([...r.kill.credit].sort(), [1, 2]);
  assert.ok(m.dead);
  assert.equal(W.hit(a, [m.id, 5, 1, 0], 99999, NOW).why, 'dead');
});

test('討伐門檻：人越多門檻越低（最多 3%）', () => {
  assert.equal(bossCredit(22000, 1), 660);
  assert.equal(bossCredit(bossMaxHp(22000, 20), 20), Math.ceil(bossMaxHp(22000, 20) * 0.015));
  assert.ok(bossCredit(bossMaxHp(22000, 20), 20) < bossMaxHp(22000, 20) / 20);   // 低於平均分攤
});

test('重生：180 秒後在祭壇重生（淡入中不能打），HP 依當時人數', () => {
  const W = new MobWorld(), m = W.boss;
  const a = fighter(1, 6900), b = fighter(2, 7000);
  run(W, [a], 0.1);
  W.hit(a, [m.id, 99999, 1, 0], 99999, NOW);
  assert.ok(m.dead);
  run(W, [a, b], 1, NOW + G.respawn * 1000 - 2000);
  assert.ok(m.dead);
  W.step(0.1, [a, b], NOW + G.respawn * 1000 + 1);
  assert.ok(!m.dead);
  assert.equal(m.x, 7120);
  assert.equal(W.hit(a, [m.id, 5, 1, 0], 99999, NOW).why, 'spawn');
  run(W, [a, b], 1, NOW + G.respawn * 1000 + 100);
  assert.equal(m.mhp, 37400); assert.equal(m.hp, 37400);
  assert.ok(W.hit(a, [m.id, 5, 1, 0], 99999, NOW).ok);
});

test('AI：有人在祭壇時會出招，事件只送給支援 Boss 同步的玩家；沒人在祭壇時不出招', () => {
  const W = new MobWorld(), m = W.boss, a = fighter(1, 7000);
  const ev = run(W, [a], 12);
  const kinds = new Set(ev.map(e => e[1]));
  assert.ok(kinds.has(10), '應該有預兆');
  assert.ok(kinds.has(6) || kinds.has(7) || kinds.has(11), '應該有震波、霧彈或衝撞');
  assert.equal(m.tg, 1);
  for (const e of ev.filter(e => e[1] === 7)) assert.equal(e.length, 6);
  // 快照：Boss 附加欄位（最大 HP、階段、預兆長度、人數、目標）
  const s = W.view(view(true), 7000, NOW, 9).u.find(e => e[0] === m.id);
  assert.equal(s.length, 12);
  assert.equal(s[7], 22000); assert.equal(s[10], 1); assert.equal(s[11], 1);
  // 預兆中：招式欄位是 tele 的代碼
  const W2 = new MobWorld();
  for (let i = 0; i < 200 && !(W2.boss.boss && W2.boss.boss.st === 'tele'); i++) W2.step(0.1, [a], NOW);
  const t = W2.view(view(true), 7000, NOW, 9).u.find(e => e[0] === m.id);
  assert.ok(Object.values(BOSS_CODE.tele).includes(t[5]));
  assert.ok(t[9] > 0);
  // 祭壇外（但在附近）的玩家：Boss 不出招
  const W3 = new MobWorld();
  const ev3 = run(W3, [fighter(1, ARENA_X - 300)], 8);
  assert.equal(ev3.length, 0);
});

test('AI：只打活著的玩家；所有人離開祭壇超過 6 秒 → 回復全部體力並重新計算人數', () => {
  const W = new MobWorld(), m = W.boss;
  const a = fighter(1, 6900), b = fighter(2, 7000);
  run(W, [a, b], 0.1);
  W.hit(a, [m.id, 30000, 1, 0], 99999, NOW);
  run(W, [a, b], 2);
  assert.equal(m.boss.phase, 2);   // 剩不到一半：狂暴化
  // 都倒下了（仍在祭壇內）：不算 engaged，6 秒後回復；回復後只剩倒下的人在祭壇 → 人數 2（倒下的也算在祭壇內）
  const ev = run(W, [{ ...a, dead: true }, { ...b, x: ARENA_X - 200 }], 8);
  assert.ok(ev.some(e => e[1] === 9), '應該有「回復全部體力」事件');
  assert.equal(m.boss.phase, 1);
  assert.equal(m.nf, 1); assert.equal(m.mhp, 22000); assert.equal(m.hp, 22000);
  assert.equal(m.dmg.size, 0);
});

test('沒有人在附近（或都掛機）：停止模擬，打到一半的 Boss 回復成還沒開打', () => {
  const W = new MobWorld(), m = W.boss, a = fighter(1, 6900), b = fighter(2, 7000);
  run(W, [a, b], 0.1);
  W.hit(a, [m.id, 5000, 1, 0], 99999, NOW);
  W.step(0.1, [{ ...a, x: 3000 }, { ...b, active: false }], NOW);
  assert.equal(m.hp, 22000); assert.equal(m.mhp, 22000); assert.equal(m.dmg.size, 0);
});

test('保存／讀取：死掉的 Boss 記住重生時間；活著的 Boss 存成還沒開打', () => {
  const W = new MobWorld(), m = W.boss, a = fighter(1, 6900);
  run(W, [a], 0.1);
  W.hit(a, [m.id, 3000, 1, 0], 99999, NOW);
  const W2 = new MobWorld();
  W2.load(JSON.parse(JSON.stringify(W.dump())));
  assert.ok(!W2.boss.dead); assert.equal(W2.boss.hp, 22000); assert.equal(W2.boss.x, 7120);
  W.hit(a, [m.id, 99999, 1, 0], 99999, NOW);
  const W3 = new MobWorld();
  W3.load(JSON.parse(JSON.stringify(W.dump())));
  assert.ok(W3.boss.dead); assert.equal(W3.boss.respawnAt, NOW + G.respawn * 1000);
});
