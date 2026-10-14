// ⚠ 自動產生的檔案，請勿手動修改。來源：index.html 的 <mobsim> 區塊；重新產生：在 worker 資料夾執行 npm run gen
/* eslint-disable */
// ---- <mobsim> 區塊 1 ----
const WORLD_W = 11200, WORLD_H = 760, GROUND_Y = 700, TOWN_X = 190, DEEP_X = 3600;
const RUIN_X = 4850, ARENA_X = 6700;   // 霧谷遺跡起點、Boss 祭壇（霧之守衛）起點
// 第六階段：霜月雪原（x ≥ FROST_X）是另一張地圖，和原本的森林（x < FROST_X）之間有牆隔開，只能用傳送門往返
// 兩張地圖共用同一個座標系，所以存檔、多人同步的位置格式都不用改（舊存檔的 x 一定 < FROST_X）
const FROST_X = 7400, ICE_X = 9300;    // 霜月雪原起點（＝原本的地圖寬度）、永凍冰原起點
const zoneL = x => x >= FROST_X ? FROST_X : 0;           // 所在地圖的左邊界
const zoneR = x => x >= FROST_X ? WORLD_W : FROST_X;     // 所在地圖的右邊界
const STEP = 1 / 120, GRAV = 2200;
const PHYS = { walk: 200, accel: 1900, airAccel: 900, jump: 760, climb: 140, maxFall: 1100 };

// ---- <mobsim> 區塊 2 ----
const MONSTERS = {
  moss:   { name: '綠苔蝸', lv: 1, hp: 28,  atk: 6,  def: 0, exp: 5,  speed: 28, w: 36, h: 28, ai: 'wander', coins: [2, 6],   drops: { hp: 0.06, mp: 0.04 }, respawn: 6,
            parts: ['#a6dc6e', '#6f9f40'], equip: [0.05, ['wsword', 'cap', 'shirt', 'sandal']] },
  shroom: { name: '跳跳菇', lv: 4, hp: 60,  atk: 11, def: 1, exp: 12, speed: 75, w: 32, h: 40, ai: 'hop', hopV: 470, coins: [5, 12], drops: { hp: 0.10, mp: 0.08 }, respawn: 8,
            parts: ['#e2643f', '#fff1d6'], equip: [0.06, ['cap', 'shirt', 'sandal', 'leather', 'boots', 'dew']], etc: ['spore', 0.5] },
  golem:  { name: '石甲怪', lv: 8, hp: 150, atk: 19, def: 4, exp: 30, speed: 40, chase: 95, aggro: 280, w: 46, h: 48, ai: 'chase', coins: [12, 26], drops: { hp: 0.18, mp: 0.14 }, respawn: 12,
            heavy: true, parts: ['#9aa0aa', '#6fa14a', '#d8d2c4'], equip: [0.08, ['leather', 'boots', 'isword', 'hbow', 'ostaff', 'dew', 'stoneh']], etc: ['shard', 0.45] },
  wolf:   { name: '霧狼', lv: 12, hp: 340, atk: 30, def: 6, exp: 62, speed: 70, chase: 165, aggro: 320, w: 50, h: 40, ai: 'chase', coins: [20, 42], drops: { hp: 0.2, mp: 0.16 }, respawn: 10,
            parts: ['#8a84a8', '#c9c4dc'], equip: [0.1, ['isword', 'hbow', 'ostaff', 'ihelm', 'hood', 'mhat', 'chain', 'ranger', 'robe', 'boots', 'stoneh']], etc: ['fang', 0.5] },
  treant: { name: '古樹精', lv: 15, hp: 720, atk: 40, def: 11, exp: 120, speed: 30, chase: 70, aggro: 240, w: 56, h: 70, ai: 'chase', coins: [35, 70], drops: { hp: 0.25, mp: 0.2 }, respawn: 14,
            heavy: true, parts: ['#7a5334', '#5aa262', '#c9ff8a'], equip: [0.14, ['ksword', 'ebow', 'sstaff', 'chain', 'ranger', 'robe', 'ihelm', 'hood', 'mhat', 'stoneh']] },
  // ---- 霧谷遺跡 ----
  sentry: { name: '遺跡石偶', lv: 18, hp: 950, atk: 58, def: 15, exp: 190, speed: 35, chase: 85, aggro: 260, w: 46, h: 60, ai: 'chase', coins: [50, 95], drops: { hp: 0.26, mp: 0.22 }, respawn: 12,
            heavy: true, parts: ['#8a8f9e', '#6ad1ff', '#c9ccd6'], equip: [0.12, ['bsword', 'rbow', 'rstaff', 'rboots', 'ksword', 'ebow', 'sstaff', 'stoneh']], etc: ['rune', 0.5] },
  wraith: { name: '霧魂', lv: 22, hp: 1400, atk: 72, def: 18, exp: 290, speed: 60, chase: 150, aggro: 340, w: 44, h: 56, ai: 'chase', float: true, coins: [70, 130], drops: { hp: 0.28, mp: 0.26 }, respawn: 11,
            parts: ['#c9b8ff', '#ffffff', '#8a7ad8'], equip: [0.13, ['rboots', 'khelm', 'hhood', 'what', 'bsword', 'rbow', 'rstaff']], etc: ['ecto', 0.5] },
  knightm:{ name: '亡靈騎士', lv: 26, hp: 2100, atk: 90, def: 24, exp: 420, speed: 45, chase: 120, aggro: 300, w: 46, h: 68, ai: 'chase', coins: [95, 170], drops: { hp: 0.3, mp: 0.26 }, respawn: 13,
            heavy: true, parts: ['#4a4f63', '#d8d2c4', '#ff5a5a'], equip: [0.15, ['khelm', 'hhood', 'what', 'plate', 'hcoat', 'wrobe', 'gsword', 'wbow', 'mstaff', 'rboots']] },
  // Boss：霧之守衛（ai = boss，行為見 updateBoss）
  guardian: { name: '霧之守衛', lv: 30, hp: 22000, atk: 105, def: 30, exp: 9000, speed: 70, w: 110, h: 150, ai: 'boss', boss: true, coins: [400, 700], drops: { hp: 1, mp: 1 }, respawn: 180,
            heavy: true, parts: ['#5a6378', '#9fe8ff', '#c9b8ff', '#ffffff'] },
  // ---- 第六階段：霜月雪原／永凍冰原（Lv.32～44）；skill = 追擊時的特殊招式（見 monsterSkill），出招前頭上會出現「!」 ----
  // ※ 經驗值／金幣若調高，要同步檢查 server/app.py 的 MAX_EXP_PER_KILL、COINS_PER_KILL_MAX
  snowimp:   { name: '雪妖精', lv: 32, hp: 3200, atk: 108, def: 28, exp: 560, speed: 90, w: 36, h: 42, ai: 'hop', hopV: 560, coins: [110, 190], drops: { hp: 0.3, mp: 0.28 }, respawn: 9,
               parts: ['#f4f9ff', '#8fd0ff', '#c9e8ff'], equip: [0.1, ['fboots', 'fhelm', 'fhood', 'fhat', 'khelm', 'hhood', 'what']] },
  frostwolf: { name: '霜牙狼', lv: 35, hp: 4300, atk: 122, def: 32, exp: 760, speed: 75, chase: 170, aggro: 340, w: 54, h: 42, ai: 'chase', skill: 'dash', dashV: 580, coins: [130, 220], drops: { hp: 0.3, mp: 0.28 }, respawn: 10,
               parts: ['#dfe9f5', '#9fb4cc', '#8fd0ff'], equip: [0.12, ['fboots', 'fsword', 'fbow', 'fstaff', 'fhelm', 'fhood', 'fhat']], etc: ['pelt', 0.5] },
  yeti:      { name: '暴雪雪人', lv: 38, hp: 5200, atk: 138, def: 36, exp: 1000, speed: 35, chase: 80, aggro: 460, keep: 210, w: 54, h: 66, ai: 'chase', skill: 'throw', coins: [150, 250], drops: { hp: 0.32, mp: 0.3 }, respawn: 12,
               heavy: true, parts: ['#eef3f8', '#9fb4cc', '#ffffff'], equip: [0.13, ['fsword', 'fbow', 'fstaff', 'fplate', 'fcoat', 'frobe', 'fboots']] },
  icebat:    { name: '冰晶蝙蝠', lv: 41, hp: 6000, atk: 150, def: 34, exp: 1200, speed: 70, chase: 150, aggro: 380, dive: 440, w: 50, h: 36, ai: 'fly', coins: [170, 280], drops: { hp: 0.32, mp: 0.3 }, respawn: 11,
               parts: ['#9fe8ff', '#cfefff', '#2b5a7a'], equip: [0.13, ['fhelm', 'fhood', 'fhat', 'fplate', 'fcoat', 'frobe', 'frostamu']] },
  icegolem:  { name: '永凍巨像', lv: 44, hp: 8600, atk: 172, def: 46, exp: 1650, speed: 30, chase: 70, aggro: 280, w: 64, h: 80, ai: 'chase', skill: 'slam', coins: [200, 330], drops: { hp: 0.35, mp: 0.32 }, respawn: 14,
               heavy: true, parts: ['#bfe6ff', '#8fc8ec', '#ffffff'], equip: [0.16, ['fsword', 'fbow', 'fstaff', 'fplate', 'fcoat', 'frobe', 'frostamu']] },
};
const PLATFORMS = [
  { x: 0, y: GROUND_Y, w: WORLD_W, ground: true },          // 0 地面
  { x: 500, y: 585, w: 360 }, { x: 1300, y: 585, w: 420 },   // 1,2 第一層
  { x: 2200, y: 585, w: 380 }, { x: 3000, y: 585, w: 360 },  // 3,4
  { x: 800, y: 470, w: 400 }, { x: 1750, y: 470, w: 440 },   // 5,6 第二層
  { x: 2650, y: 470, w: 400 },                               // 7
  { x: 1150, y: 355, w: 420 }, { x: 2150, y: 355, w: 420 },  // 8,9 第三層
  { x: 3100, y: 355, w: 380 },                               // 10
  { x: 3720, y: 585, w: 380 }, { x: 4280, y: 585, w: 400 },  // 11,12 霧林深處
  { x: 3950, y: 470, w: 420 }, { x: 4450, y: 355, w: 320 },  // 13,14
  // 霧谷遺跡（ruin = 石造平台）
  { x: 4950, y: 585, w: 340, ruin: true }, { x: 5480, y: 585, w: 380, ruin: true }, { x: 6050, y: 585, w: 400, ruin: true },   // 15,16,17
  { x: 5200, y: 470, w: 400, ruin: true }, { x: 5820, y: 470, w: 420, ruin: true },                                          // 18,19
  { x: 5450, y: 355, w: 380, ruin: true }, { x: 6150, y: 355, w: 320, ruin: true },                                          // 20,21
  { x: 6860, y: 585, w: 150, ruin: true }, { x: 7160, y: 585, w: 150, ruin: true },                                          // 22,23 Boss 祭壇（躲震波用）
  // 霜月雪原（snow = 積雪的冰岩平台）
  { x: 7900, y: 585, w: 380, snow: true }, { x: 8500, y: 585, w: 420, snow: true },                                          // 24,25
  { x: 8150, y: 470, w: 400, snow: true }, { x: 8800, y: 470, w: 380, snow: true }, { x: 8400, y: 355, w: 380, snow: true }, // 26,27,28
  // 永凍冰原
  { x: 9400, y: 585, w: 400, snow: true }, { x: 10050, y: 585, w: 420, snow: true },                                         // 29,30
  { x: 9700, y: 470, w: 440, snow: true }, { x: 10400, y: 470, w: 380, snow: true },                                         // 31,32
  { x: 9950, y: 355, w: 400, snow: true }, { x: 10650, y: 355, w: 300, snow: true },                                         // 33,34
];
const ROPES = [
  { x: 1000, top: 470, bottom: 700 }, { x: 1480, top: 355, bottom: 585 },
  { x: 1900, top: 470, bottom: 700 }, { x: 2400, top: 355, bottom: 585 },
  { x: 2900, top: 470, bottom: 700 }, { x: 3300, top: 355, bottom: 585 },
  { x: 3800, top: 585, bottom: 700 }, { x: 4050, top: 470, bottom: 585 },
  { x: 4620, top: 585, bottom: 700 }, { x: 4520, top: 355, bottom: 585 },
  { x: 5020, top: 585, bottom: 700 }, { x: 5260, top: 470, bottom: 585 }, { x: 5560, top: 355, bottom: 470 },
  { x: 5900, top: 470, bottom: 700 }, { x: 6200, top: 355, bottom: 470 }, { x: 6400, top: 585, bottom: 700 },
  // 霜月雪原／永凍冰原
  { x: 7980, top: 585, bottom: 700 }, { x: 8230, top: 470, bottom: 585 }, { x: 8600, top: 585, bottom: 700 },
  { x: 8480, top: 355, bottom: 470 }, { x: 8860, top: 470, bottom: 585 },
  { x: 9480, top: 585, bottom: 700 }, { x: 9760, top: 470, bottom: 585 }, { x: 10080, top: 355, bottom: 470 },
  { x: 10150, top: 585, bottom: 700 }, { x: 10440, top: 470, bottom: 585 }, { x: 10720, top: 355, bottom: 470 },
];
const SPAWNS = [
  ['moss', 650, 0], ['moss', 950, 0], ['moss', 1450, 0], ['shroom', 1700, 0], ['moss', 2050, 0], ['shroom', 2550, 0], ['golem', 3150, 0],
  ['moss', 680, 1], ['shroom', 1420, 2], ['moss', 1620, 2], ['shroom', 2300, 3], ['shroom', 2480, 3], ['golem', 3180, 4],
  ['shroom', 900, 5], ['shroom', 1100, 5], ['shroom', 1850, 6], ['golem', 2020, 6], ['golem', 2850, 7],
  ['golem', 1300, 8], ['shroom', 1500, 8], ['golem', 2280, 9], ['golem', 2480, 9], ['golem', 3250, 10], ['shroom', 3400, 10],
  ['wolf', 3880, 0], ['wolf', 4200, 0], ['treant', 4500, 0], ['wolf', 3880, 11], ['wolf', 4420, 12], ['treant', 4180, 13], ['wolf', 4000, 13], ['treant', 4620, 14],
  ['sentry', 5350, 0], ['sentry', 5700, 0], ['wraith', 6050, 0], ['knightm', 6400, 0],
  ['sentry', 5120, 15], ['wraith', 5650, 16], ['knightm', 6250, 17], ['sentry', 5350, 18], ['wraith', 5500, 18],
  ['wraith', 5950, 19], ['knightm', 6120, 19], ['knightm', 5640, 20], ['wraith', 6300, 21],
  ['guardian', 7120, 0],
  // 霜月雪原
  ['snowimp', 8000, 0], ['frostwolf', 8400, 0], ['snowimp', 8750, 0], ['frostwolf', 9050, 0],
  ['snowimp', 8050, 24], ['frostwolf', 8650, 25], ['snowimp', 8820, 25], ['snowimp', 8300, 26], ['yeti', 8450, 26],
  ['frostwolf', 8980, 27], ['yeti', 8560, 28], ['snowimp', 8700, 28],
  // 永凍冰原（冰晶蝙蝠會離開平台在空中飛行）
  ['yeti', 9500, 0], ['icegolem', 9900, 0], ['yeti', 10300, 0], ['icegolem', 10700, 0], ['icebat', 9350, 0], ['icebat', 10950, 0],
  ['yeti', 9620, 29], ['icegolem', 10250, 30], ['icebat', 9850, 31], ['icebat', 10050, 31], ['yeti', 10560, 32],
  ['icegolem', 10120, 33], ['icebat', 10250, 33], ['icebat', 10800, 34],
].map(([type, x, plat], id) => ({ id, type, x, plat }));   // id = 出生點編號（即時連線時前端與伺服器用它對應同一隻怪）

// ---- <mobsim> 區塊 3 ----
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, t, d) => v < t ? Math.min(v + d, t) : Math.max(v - d, t);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// ---- <mobsim> 區塊 4 ----
function makeMonster(sp) {
  const d = MONSTERS[sp.type], plat = PLATFORMS[sp.plat];
  let minX, maxX;
  if (d.boss) { minX = ARENA_X + 70; maxX = FROST_X - 70; }   // Boss 只在祭壇內活動
  else if (d.ai === 'fly') { minX = Math.max(zoneL(sp.x) + 320, sp.x - 480); maxX = Math.min(zoneR(sp.x) - 40, sp.x + 480); }   // 飛行怪：不受平台限制，在出生點左右各 480 內活動
  else if (plat.ground) {
    if (sp.x >= FROST_X) { minX = Math.max(FROST_X + 420, sp.x - 230); maxX = Math.min(WORLD_W - 90, sp.x + 230); }   // 雪原：避開傳送門與嚮導
    else { minX = Math.max(480, sp.x - 230); maxX = Math.min(sp.x < ARENA_X ? ARENA_X - 40 : FROST_X - 30, sp.x + 230); }
  }
  else { minX = plat.x + d.w / 2 + 2; maxX = plat.x + plat.w - d.w / 2 - 2; }
  return {
    sp, type: sp.type, d, x: sp.x, y: d.ai === 'fly' ? plat.y - FLY_H : plat.y, vx: 0, vy: 0, face: Math.random() < 0.5 ? -1 : 1, hp: d.hp,
    minX, maxX, onGround: d.ai !== 'fly', state: 'walk', t: rand(0.5, 3), flash: 0, stun: 0, barT: 0, aggro: 0, chasing: false,
    dead: false, dying: 0, dyMax: 0.6, respawnT: 0, spawnFx: 0.6, anim: Math.random() * 10, squash: 0, lastSwing: -1, stack: 0, stackT: 0,
    chill: 0, boss: null, act: null, skCD: rand(1, 2.5), fly: null,
  };
}
// 重生：回到出生點、補滿 HP（特效由呼叫端處理）
function resetMonster(m) {
  const plat = PLATFORMS[m.sp.plat];
  Object.assign(m, { x: m.sp.x, y: plat.y, vx: 0, vy: 0, hp: m.d.hp, dead: false, dying: 0, onGround: true, spawnFx: 0.6, flash: 0, stun: 0, barT: 0, aggro: 0, state: 'idle', t: 1, chill: 0, boss: null,
    act: null, skCD: rand(1, 2.5), fly: null });
  if (m.d.ai === 'fly') { m.y = flyHome(m); m.onGround = false; }
}
// 怪物資料的指紋：前端與伺服器不同（例如改了出生點但 Worker 還沒重新部署）時，前端不使用伺服器的怪物
function mobSig() {
  const t = JSON.stringify([SPAWNS, MONSTERS, PLATFORMS, MSKILL]);
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
// 落到平台上（玩家、怪物、掉落物共用）
function landOn(b, prevY, ignore) {
  if (b.vy < 0) return null;
  let best = null;
  for (const p of PLATFORMS) {
    if (p === ignore) continue;
    if (b.x < p.x - 3 || b.x > p.x + p.w + 3) continue;
    if (prevY <= p.y + 0.5 && b.y >= p.y && (!best || p.y < best.y)) best = p;
  }
  return best;
}
function wander(m, dt) {
  m.t -= dt;
  if (m.t <= 0) {
    if (m.state === 'walk') { m.state = 'idle'; m.t = rand(0.8, 2.2); }
    else { m.state = 'walk'; m.t = rand(1.8, 4); m.face = Math.random() < 0.5 ? -1 : 1; }
  }
  m.vx = m.state === 'walk' ? m.face * m.d.speed : 0;
}
// 活著的一般怪物前進 dt 秒（p = 目標玩家 { x, y, dead }）
function mobStep(m, dt, p, fx) {
  const d = m.d;
  m.anim += dt; m.aggro -= dt; m.chill = Math.max(0, m.chill - dt);
  m.spawnFx = Math.max(0, m.spawnFx - dt);
  m.chasing = false;
  if (d.ai === 'fly') { updateFlyer(m, dt, p, fx); return; }
  if (m.skCD > 0) m.skCD -= dt;
  if (m.stun > 0) { m.stun -= dt; m.vx = approach(m.vx, 0, 700 * dt); }
  else if (m.act) monsterAct(m, dt, p, fx);   // 特殊招式進行中（預備動作／衝撞／投擲／震地）
  else if (d.ai === 'wander') wander(m, dt);
  else if (d.ai === 'hop') {
    if (m.onGround) {
      m.vx = 0; m.t -= dt;
      if (m.t <= 0) {
        if (m.aggro > 0 && !p.dead && Math.abs(p.y - m.y) < 100) m.face = p.x < m.x ? -1 : 1;
        else if (Math.random() < 0.35) m.face *= -1;
        m.vy = -d.hopV * rand(0.85, 1.05); m.vx = m.face * d.speed; m.onGround = false; m.t = rand(0.5, 1.3);
      }
    }
  } else if (d.ai === 'chase') {
    const dx = p.x - m.x, dy = Math.abs(p.y - m.y);
    if (!p.dead && ((Math.abs(dx) < d.aggro && dy < 70) || (m.aggro > 0 && dy < 130)) && p.x > m.minX - 40 && p.x < m.maxX + 40) {
      m.chasing = true; m.face = dx < 0 ? -1 : 1;
      if (d.skill && m.skCD <= 0 && skillInRange(d.skill, Math.abs(dx), dy)) startAct(m);
      else m.vx = Math.abs(dx) > (d.keep || 8) ? m.face * d.chase : 0;   // keep：遠程怪保持距離
    } else wander(m, dt);
  }
  const prevY = m.y;
  if (!m.onGround) { m.vy = Math.min(m.vy + GRAV * dt, PHYS.maxFall); m.y += m.vy * dt; }
  m.x += m.vx * dt * (m.chill > 0 ? 0.45 : 1);   // 暴風雪緩速
  if (m.x < m.minX) { m.x = m.minX; if (!m.chasing) m.face = 1; if (d.ai === 'hop' && !m.onGround) m.vx = Math.abs(m.vx); }
  if (m.x > m.maxX) { m.x = m.maxX; if (!m.chasing) m.face = -1; if (d.ai === 'hop' && !m.onGround) m.vx = -Math.abs(m.vx); }
  if (!m.onGround) {
    const pl = landOn(m, prevY, null);
    if (pl) { m.y = pl.y; m.vy = 0; m.onGround = true; m.squash = 1; }
  }
  if (m.y > GROUND_Y) { m.y = GROUND_Y; m.onGround = true; }
}
// 被打中：擊退、硬直、仇恨（Boss 不會被擊退或硬直）；chill > 0 時緩速 chill 秒
function mobKnock(m, dirX, crit, chill) {
  const heavy = !!m.d.heavy;
  m.aggro = 6;
  if (!m.d.boss) {
    m.vx = dirX * (heavy ? (crit ? 120 : 50) : (crit ? 260 : 170));
    m.stun = heavy ? 0.12 : 0.28;
    if (heavy) m.face = -dirX;
  }
  if (chill > 0) m.chill = chill;
}

// ---- 雪原怪物的特殊招式：dash 衝撞（霜牙狼）、throw 丟雪球（暴雪雪人）、slam 震地（永凍巨像） ----
// 流程：tele 預備動作（頭上出現「!」）→ go 出招 → rec 收招；結束後冷卻 skCD 秒
const MSKILL = {
  dash:  { tele: 0.5, rec: 0.45, cd: [2.6, 4], near: 60, far: 320, dy: 30 },
  throw: { tele: 0.55, rec: 0.5, cd: [2.2, 3.4], near: 90, far: 480, dy: 220 },
  slam:  { tele: 0.75, rec: 0.8, cd: [4, 6], near: 0, far: 170, dy: 40 },
};
function skillInRange(k, adx, dy) { const S = MSKILL[k]; return adx >= S.near && adx <= S.far && dy <= S.dy; }
function startAct(m) { m.act = { k: m.d.skill, st: 'tele', t: MSKILL[m.d.skill].tele }; m.vx = 0; m.chasing = true; }
function monsterAct(m, dt, p, fx) {
  const A = m.act, d = m.d, S = MSKILL[A.k];
  m.chasing = true;
  A.t -= dt;
  if (A.st === 'tele') {
    m.vx = 0;
    if (A.t > S.tele * 0.4 && !p.dead) m.face = p.x < m.x ? -1 : 1;   // 預備動作前半段仍會轉向玩家
    if (A.t > 0) return;
    A.st = 'go';
    if (A.k === 'dash') { A.t = 0.55; fx(m, 'dash', p); }
    else if (A.k === 'throw') { A.t = 0.15; fx(m, 'throw', p); }
    else { A.t = 0.1; fx(m, 'slam', p); }
  } else if (A.st === 'go') {
    if (A.k === 'dash') {
      m.vx = m.face * d.dashV;
      fx(m, 'dashp', p);
      if ((m.face < 0 && m.x <= m.minX + 1) || (m.face > 0 && m.x >= m.maxX - 1)) A.t = 0;
    } else m.vx = 0;
    if (A.t <= 0) { A.st = 'rec'; A.t = S.rec; m.vx *= 0.2; }
  } else {
    m.vx = approach(m.vx, 0, 900 * dt);
    if (A.t <= 0) { m.act = null; m.skCD = rand(S.cd[0], S.cd[1]); }
  }
}

// ---- 飛行怪（冰晶蝙蝠）：在空中跟著玩家（停在身體高度、保持一點距離），每隔幾秒預備後朝玩家俯衝 ----
const FLY_H = 70;   // 沒發現玩家時，在出生平台上方多高的地方盤旋
const flyHome = m => PLATFORMS[m.sp.plat].y - FLY_H;
function updateFlyer(m, dt, p, fx) {
  const d = m.d;
  if (!m.fly) m.fly = { st: 'idle', t: 0, cd: rand(1.5, 3), wx: m.sp.x, wy: flyHome(m), tx: 0, ty: 0 };
  const F = m.fly, slow = m.chill > 0 ? 0.45 : 1;
  const steer = (tx, ty, spd) => {   // 平滑地往目標點移動
    const dx = tx - m.x, dy = ty - m.y, dist = Math.hypot(dx, dy) || 1, v = dist < 8 ? 0 : spd;
    m.vx = approach(m.vx, dx / dist * v, 700 * dt); m.vy = approach(m.vy, dy / dist * v, 700 * dt);
  };
  if (m.stun > 0) { m.stun -= dt; m.vx = approach(m.vx, 0, 700 * dt); m.vy = approach(m.vy, 0, 700 * dt); if (F.st !== 'idle') { F.st = 'idle'; F.cd = rand(1.5, 2.5); } }
  else if (F.st === 'tele') {
    m.vx = approach(m.vx, 0, 900 * dt); m.vy = approach(m.vy, -30, 900 * dt);
    F.t -= dt;
    if (F.t <= 0) {
      const a = Math.atan2(F.ty - m.y, F.tx - m.x);
      F.st = 'dive'; F.t = 0.65; m.vx = Math.cos(a) * d.dive; m.vy = Math.sin(a) * d.dive; m.face = m.vx < 0 ? -1 : 1;
      fx(m, 'dive', p);
    }
  } else if (F.st === 'dive') {
    F.t -= dt; m.chasing = true;
    fx(m, 'divep', p);
    if (F.t <= 0 || m.y >= GROUND_Y - 2) { F.st = 'idle'; F.cd = rand(2.4, 3.8); }
  } else {
    const dx = p.x - m.x, dy = p.y - m.y;
    const see = !p.dead && Math.abs(p.x - m.sp.x) < 520 && ((Math.abs(dx) < d.aggro && Math.abs(dy) < 240) || m.aggro > 0);
    if (see) {
      m.chasing = true; m.face = dx < 0 ? -1 : 1;
      F.cd -= dt;
      steer(p.x - m.face * 80, p.y - 18 + Math.sin(m.anim * 3) * 6, d.chase);   // 停在玩家側邊、大約身體的高度
      if (F.cd <= 0 && Math.abs(dx) < 300 && Math.abs(dy) < 200) { F.st = 'tele'; F.t = 0.4; F.tx = p.x + m.face * 40; F.ty = p.y - 20; }
    } else {   // 在出生點附近閒晃
      F.t -= dt;
      if (F.t <= 0) { F.t = rand(1.5, 3); F.wx = clamp(m.sp.x + rand(-170, 170), m.minX, m.maxX); F.wy = flyHome(m) + rand(-30, 30); }
      steer(F.wx, F.wy + Math.sin(m.anim * 2.4) * 10, d.speed);
      if (Math.abs(m.vx) > 5) m.face = m.vx < 0 ? -1 : 1;
    }
  }
  m.x += m.vx * dt * slow; m.y += m.vy * dt * slow;
  if (m.x < m.minX) { m.x = m.minX; m.vx = Math.max(0, m.vx); }
  if (m.x > m.maxX) { m.x = m.maxX; m.vx = Math.min(0, m.vx); }
  m.y = clamp(m.y, GROUND_Y - 430, GROUND_Y - 2);
  m.onGround = false;
}

export {
  WORLD_W, WORLD_H, GROUND_Y, TOWN_X, ARENA_X, FROST_X, ICE_X, zoneL, zoneR, GRAV, PHYS, rand, randi, clamp, approach, MONSTERS, PLATFORMS, SPAWNS, makeMonster, resetMonster, mobSig, landOn, mobStep, mobKnock, MSKILL, FLY_H,
};
