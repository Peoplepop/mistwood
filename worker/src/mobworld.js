// 伺服器權威的一般怪物（第六階段 6-2）：每個頻道一份 MobWorld，由 channel.js 的 tick 驅動。
// 怪物資料與 AI 來自 mobs.gen.js（從 index.html 的 <mobsim> 區塊自動產生），和單機版完全相同。
// 這個檔案不依賴 Cloudflare 的 API，可以直接用 node --test 測試。
//
// 規則（2026-10-13 使用者確認）：
//   - 經驗值依傷害比例分配，最後一擊另加 10%（只有一個人打時就是全部）；任務擊殺數給每位有出力的人
//   - 掉寶是個人的：伺服器只通知「誰有出力、分到多少經驗」，掉落由各自的前端擲骰
//
// Boss（霧之守衛，6-3）：同一份 MobWorld，AI 用 index.html 共用區塊的 bossStep。
//   - 只有支援 Boss 同步的前端（hello 帶的 ms／bs 指紋都相同，pl.bo = true）看得到、打得到伺服器的 Boss，也只有他們算人數；
//     舊版前端照舊在本機打自己的 Boss。
//   - HP 依人數加成：最大 HP = 基礎 × (1 + 0.7 × (人數 − 1))，人數 = 祭壇內（支援 Boss 同步）的玩家 ∪ 這場有出力的玩家，最多 20。
//     還沒被打過時人數可增可減；開打後有人加入：最大 HP 跟著變大、目前 HP 等比例增加（血量百分比不變，不會補血），
//     有人離開不會變小（避免進出祭壇改變 HP）。回復全部體力（所有人離開祭壇 6 秒、或附近沒有活躍玩家）時重新計算。
//   - 擊殺：經驗值（9000）依傷害比例分給所有有出力的人（最後一擊 +10%，和一般怪相同）。
//     輸出達到門檻（bossCredit：最大 HP × min(3%, 30% ÷ 人數)）的人才算「討伐」：Boss 擊殺數、任務擊殺數、個人 Boss 掉寶；
//     只摸一下的人只拿到很少的經驗值（避免排行榜的 Boss 擊殺數靠蹭一刀累積）。
import {
  SPAWNS, MONSTERS, makeMonster, resetMonster, mobStep, mobKnock, mobSig, zoneL, clamp, rand,
  ARENA_X, FROST_X, bossStep, bossInit, bossSig, inArena,
} from './mobs.gen.js';

export const MOB_PROTO = 1;          // 協定版本（welcome 的 mobs 欄位；前端版本相同才使用伺服器的怪物）
export const MOB_SIG = mobSig();     // 怪物資料指紋（welcome 的 msig；前端資料不同時不使用伺服器的怪物）
export const BOSS_PROTO = 1;         // Boss 同步的協定版本（welcome 的 boss 欄位）
export const BOSS_SIG = bossSig();   // Boss 資料指紋（welcome 的 bsig）
export const BOSS_SCALE = 0.7;       // 每多一位玩家，Boss 最大 HP 增加基礎值的 70%
export const BOSS_MAX_FIGHTERS = 20; // 人數加成的上限（＝每頻道人數上限）
export const BOSS_CODE = { tele: { charge: 12, slam: 13, volley: 14 }, charge: 15, recover: 16, roar: 17 };   // Boss 狀態 → 快照的招式欄位
export const VIEW_R = 1500;          // 興趣範圍：每位玩家只收左右這個距離內（同一張地圖）的怪物
export const VIEW_KEEP = 150;        // 已經送過的怪物，超出 VIEW_R + VIEW_KEEP 才算離開（避免在邊界來回）
export const SIM_R = 1700;           // 模擬範圍：只模擬「活躍玩家」左右這個距離內的怪物，其他的停在原地
export const ACTIVE_MS = 120_000;    // 玩家超過這個時間沒有任何動作（沒送狀態）就不算活躍（掛機不讓頻道一直醒著）
export const TARGET_R = 1200;        // 怪物找目標的最遠距離
export const SUB_DT = 0.025;         // 每個 tick 再切成小步模擬（和前端 1/120 秒差不多的手感，跳躍落地不會穿過平台）
export const HIT_RANGE_X = 900;      // 命中檢查：怪物和玩家（最後回報位置）的最大水平距離（穿透箭射程 680 + 移動與延遲的寬限）
export const HIT_RANGE_Y = 450;
export const LAST_HIT_BONUS = 0.1;   // 最後一擊額外分到的經驗值比例（多人時）
export const DMG_EVENTS_MAX = 30;    // 每個 tick 最多記錄幾個「別人打怪的傷害數字」事件（前端一次最多處理 40 個事件，留空間給怪物招式）
export const ACT_CODE = { dash: { tele: 1, go: 2, rec: 3 }, throw: { tele: 4, go: 5, rec: 6 }, slam: { tele: 7, go: 8, rec: 9 } };
export const FLY_CODE = { tele: 10, dive: 11 };
const NO_TARGET = Object.freeze({ x: -1e9, y: -1e9, dead: true });

// 職業 → 單次攻擊的最高技能倍率（新手：風刃斬 Lv.10；一轉：重斬／穿透箭／火焰球 Lv.10；二轉：天劍降臨／爆裂箭／隕石術 Lv.10）
const JOB_MULT = { novice: 2.5, warrior: 3.5, archer: 3.4, mage: 3.2, knight: 5.9, hunter: 4.8, wizard: 7 };
/**
 * 單次命中的傷害上限（刻意放寬，只擋明顯作弊）：
 * (基礎攻擊 + 裝備／被動／職業加成上限) × 增益 1.5 × 技能倍率 × 爆擊 1.75 × 浮動 1.15 × 再寬限 1.1
 * 基礎攻擊每級最多 4.7（獵人）；裝備等加成以 40 + 7×等級估計（Lv.35 約 285，實際最好的裝備約 240），上限 450
 */
export function maxHit(lv, job) {
  lv = clamp(Math.floor(lv) || 1, 1, 200);
  const atk = 12 + 4.7 * (lv - 1) + Math.min(450, 40 + 7 * lv);
  return Math.ceil(atk * 1.5 * (JOB_MULT[job] || JOB_MULT.novice) * 1.75 * 1.15 * 1.1);
}

/**
 * 經驗值分配：dmg = Map(uid → 造成的傷害)，last = 最後一擊的 uid。回傳 Map(uid → 經驗值)，總和一定等於 exp。
 * 只有一個人時全部給他；多人時 90% 依傷害比例（無條件捨去），10% ＋ 捨去的零頭給最後一擊。
 */
export function splitExp(exp, dmg, last) {
  const out = new Map();
  let total = 0;
  for (const v of dmg.values()) if (v > 0) total += v;
  if (total <= 0) { if (last) out.set(last, exp); return out; }
  const bonus = dmg.size > 1 ? Math.round(exp * LAST_HIT_BONUS) : 0, pool = exp - bonus;
  let given = 0;
  for (const [uid, v] of dmg) {
    if (v <= 0) continue;
    const n = Math.floor(pool * v / total);
    out.set(uid, n); given += n;
  }
  const lastUid = out.has(last) ? last : [...out.keys()][0];
  out.set(lastUid, out.get(lastUid) + exp - given);
  return out;
}

/** Boss 在 n 位玩家時的最大 HP */
export function bossMaxHp(base, n) {
  return Math.round(base * (1 + BOSS_SCALE * (clamp(Math.floor(n) || 1, 1, BOSS_MAX_FIGHTERS) - 1)));
}

/** 算「討伐」（Boss 擊殺數、任務、掉寶）需要的最低傷害：最大 HP × min(3%, 30% ÷ 人數) */
export function bossCredit(mhp, n) {
  return Math.ceil(mhp * Math.min(0.03, 0.3 / Math.max(1, n)));
}

/**
 * 怪物 → 快照的一筆 [id, x, y, 旗標, hp, 招式, 招式剩餘(1/100 秒)]（格式見 index.html 的 MN 說明）
 * Boss 另外附加 [最大 HP, 階段 1/2, 預兆總長(1/100 秒), 人數, 目標玩家 uid]
 */
export function encodeMob(m) {
  if (m.d.boss) return encodeBoss(m);
  let fl = 0, ac = 0, at = 0;
  if (m.face < 0) fl |= 1;
  if (m.onGround) fl |= 2;
  if (m.chasing) fl |= 4;
  if (m.state === 'walk') fl |= 8;
  if (m.aggro > 0) fl |= 16;
  if (m.chill > 0) fl |= 32;
  if (m.dead) fl |= 64;
  if (m.spawnFx > 0) fl |= 128;
  if (!m.dead) {
    if (m.act && ACT_CODE[m.act.k]) { ac = ACT_CODE[m.act.k][m.act.st] || 0; at = m.act.t; }
    else if (m.fly && FLY_CODE[m.fly.st]) { ac = FLY_CODE[m.fly.st]; at = m.fly.t; }
  }
  return [m.id, Math.round(m.x), Math.round(m.y), fl, Math.max(0, Math.round(m.hp)), ac, Math.max(0, Math.round(at * 100))];
}
function encodeBoss(m) {
  const B = m.boss;
  let fl = 2, ac = 0, at = 0;
  if (m.face < 0) fl |= 1;
  if (Math.abs(m.vx) > 1) fl |= 8;
  if (m.dead) fl |= 64;
  if (m.spawnFx > 0) fl |= 128;
  if (!m.dead && B) {
    ac = B.st === 'tele' ? BOSS_CODE.tele[B.tele] || 0 : BOSS_CODE[B.st] || 0;
    at = ac ? B.t : 0;
  }
  return [m.id, Math.round(m.x), Math.round(m.y), fl, Math.max(0, Math.round(m.hp)), ac, Math.max(0, Math.round(at * 100)),
    Math.round(m.mhp), B && B.phase === 2 ? 2 : 1, B && B.st === 'tele' ? Math.round(B.teleMax * 100) : 0, m.nf, m.dead ? 0 : m.tg || 0];
}
// 比較用：位置、旗標、HP、招式有變才重送（招式剩餘時間前端自己倒數）；Boss 另外比較附加的欄位
const keyOf = e => e[1] + ',' + e[2] + ',' + e[3] + ',' + e[4] + ',' + e[5] + (e.length > 7 ? ',' + e.slice(7).join() : '');

export class MobWorld {
  constructor() {
    this.mobs = [];
    this.byId = new Map();
    this.boss = null;
    for (const sp of SPAWNS) {
      const m = makeMonster(sp);
      Object.assign(m, { id: sp.id, spawnFx: 0, dmg: new Map(), ag: 0, respawnAt: 0 });
      if (m.d.boss) { Object.assign(m, { nf: 1, tg: 0, tgUntil: 0 }); this.boss = m; }
      this.mobs.push(m); this.byId.set(m.id, m);
    }
    // 這次 tick 發生的事件：[發生位置 x, [id, 事件, ...], 不用送給的玩家 uid?, Boss 的事件?]（Boss 的事件只送給支援 Boss 同步的玩家）
    this.events = [];
    // bossStep 的特效／招式 → 事件：6 震波 [x, 狂暴?1:0]、7 霧彈 [x, y, vx, vy]、8 狂暴化、9 回復全部體力、10 開始預兆、11 開始衝撞、12 衝撞結束
    this.bfx = (m, k, e) => {
      const ev = k === 'wave' ? [m.id, 6, Math.round(m.x), e.ph2 ? 1 : 0]
        : k === 'orb' ? [m.id, 7, Math.round(e.ox), Math.round(e.oy), Math.round(Math.cos(e.a) * e.spd), Math.round(Math.sin(e.a) * e.spd)]
        : k === 'enrage' ? [m.id, 8] : k === 'reset' ? [m.id, 9] : k === 'warn' ? [m.id, 10] : k === 'charge' ? [m.id, 11] : k === 'chargeEnd' ? [m.id, 12] : null;
      if (ev) this.events.push([m.x, ev, undefined, 1]);
      if (k === 'reset') { m.dmg.clear(); m.nf = 0; }   // 下一次 tick 依目前人數重新計算 HP
    };
    this.fx = (m, k, p) => {   // mobStep 的特效／音效 → 送給附近玩家的事件
      if (k === 'throw') {
        const tx = p === NO_TARGET ? m.x + m.face * 250 : p.x, ty = p === NO_TARGET ? m.y : p.y;
        this.events.push([m.x, [m.id, 1, Math.round(tx), Math.round(ty)]]);
      } else if (k === 'slam') this.events.push([m.x, [m.id, 2]]);
      else if (k === 'dash') this.events.push([m.x, [m.id, 3]]);
      else if (k === 'dive') this.events.push([m.x, [m.id, 4]]);
    };
  }

  /** 找目標：被打時優先追打牠的人（仇恨），否則找同一張地圖裡最近的活著的玩家 */
  target(m, live) {
    const z = zoneL(m.x);
    if (m.aggro > 0 && m.ag) {
      const p = live.find(q => q.uid === m.ag);
      if (p && zoneL(p.x) === z) return p;
    }
    let best = NO_TARGET, bd = TARGET_R * TARGET_R;
    for (const p of live) {
      if (zoneL(p.x) !== z) continue;
      const dx = p.x - m.x, dy = (p.y - m.y) * 2, d = dx * dx + dy * dy;   // 高度差加權：優先找同一層平台的玩家
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /**
   * 前進 dt 秒。players = [{ uid, x, y, dead, active }]。回傳這次有模擬的怪物數量（0 = 附近沒有活躍玩家）。
   * 死掉的怪到時間就重生（不論附近有沒有人）；活著的怪只有在活躍玩家附近才模擬。
   */
  step(dt, players, now) {
    const act = players.filter(p => p.active), live = players.filter(p => !p.dead);
    let n = 0;
    for (const m of this.mobs) {
      if (m === this.boss) { n += this.stepBoss(m, dt, players, now); continue; }
      if (m.dead) {
        if (now >= m.respawnAt) { resetMonster(m); m.dmg.clear(); m.ag = 0; }
        continue;
      }
      const z = zoneL(m.x);
      if (!act.some(p => zoneL(p.x) === z && Math.abs(p.x - m.x) <= SIM_R)) continue;
      n++;
      const tgt = this.target(m, live);
      for (let left = dt; left > 1e-6; left -= SUB_DT) mobStep(m, Math.min(SUB_DT, left), tgt, this.fx);
    }
    return n;
  }

  // ---------- Boss ----------
  /** Boss 前進 dt 秒；回傳 1 = 有模擬（附近有活躍、支援 Boss 同步的玩家），0 = 沒有 */
  stepBoss(m, dt, players, now) {
    if (m.dead) {
      if (now >= m.respawnAt) { resetMonster(m); this.resetBoss(m); }
      return 0;
    }
    const cap = players.filter(p => p.bo), z = zoneL(m.x);
    if (!cap.some(p => p.active && zoneL(p.x) === z && Math.abs(p.x - m.x) <= SIM_R)) {
      // 附近沒有人：戰鬥中斷就回復全部體力、回到原位（和單機版「離開祭壇 6 秒」相同的結果）
      if (m.hp < m.mhp || m.mhp !== m.d.hp || (m.boss && m.boss.phase > 1)) { Object.assign(m, { x: m.sp.x, vx: 0 }); this.resetBoss(m); }
      return 0;
    }
    // 人數：祭壇內的玩家（倒下的也算）＋這場有出力的玩家
    const ids = new Set(m.dmg.keys());
    for (const p of cap) if (p.x > ARENA_X - 30 && p.x < FROST_X) ids.add(p.uid);
    this.scaleBoss(m, ids.size);
    const arena = cap.filter(inArena), eng = arena.length > 0;
    const tgt = eng ? this.bossTarget(m, arena, now) : NO_TARGET;
    if (!eng) m.tg = 0;
    for (let left = dt; left > 1e-6; left -= SUB_DT) {
      bossStep(m, Math.min(SUB_DT, left), tgt, eng, this.bfx);
      if (!m.nf) this.scaleBoss(m, ids.size);   // 剛回復全部體力：依目前人數重新計算
    }
    return 1;
  }

  /** 回到「還沒開打」的狀態：HP、人數、傷害紀錄、目標重設（位置不變） */
  resetBoss(m) {
    bossInit(m);
    m.hp = m.mhp = m.d.hp; m.nf = 1; m.dmg.clear(); m.tg = 0; m.tgUntil = 0; m.chill = 0;
  }

  /** 依人數調整最大 HP：還沒開打時直接用目前人數；開打後只會變大（目前 HP 等比例增加） */
  scaleBoss(m, count) {
    const n = clamp(count, 1, BOSS_MAX_FIGHTERS);
    const fresh = !m.nf || (m.hp >= m.mhp && !m.dmg.size && (!m.boss || m.boss.phase === 1));
    if (fresh) { m.nf = n; m.mhp = m.hp = bossMaxHp(m.d.hp, n); return; }
    if (n > m.nf) {
      const mhp = bossMaxHp(m.d.hp, n);
      m.hp = Math.max(1, Math.round(m.hp * mhp / m.mhp)); m.mhp = mhp; m.nf = n;
    }
  }

  /** Boss 的目標：祭壇內活著的玩家。目前的目標還在就維持，閒置時每 4～7 秒重新挑一次（60% 最近的、40% 隨機） */
  bossTarget(m, arena, now) {
    let p = m.tg ? arena.find(q => q.uid === m.tg) : null;
    if (!p || (now >= m.tgUntil && (!m.boss || m.boss.st === 'idle'))) {
      if (Math.random() < 0.6) {
        p = arena[0];
        for (const q of arena) if (Math.abs(q.x - m.x) < Math.abs(p.x - m.x)) p = q;
      } else p = arena[Math.floor(Math.random() * arena.length)];
      m.tg = p.uid; m.tgUntil = now + rand(4000, 7000);
    }
    return p;
  }

  /**
   * 套用一次命中。pl = { uid, x, y, dead }，h = [id, 傷害, 方向, 爆擊, 緩速秒數?]，cap = 傷害上限。
   * 回傳 { ok:false, why } 或 { ok:true, dmg, kill? }；kill = { id, exp: Map(uid → 經驗值), last }
   */
  hit(pl, h, cap, now) {
    if (!Array.isArray(h) || h.length < 4) return { ok: false, why: 'format' };
    const m = Number.isInteger(h[0]) ? this.byId.get(h[0]) : undefined;
    if (!m) return { ok: false, why: 'mob' };
    if (m === this.boss && !pl.bo) return { ok: false, why: 'boss' };   // 舊版前端（本機 Boss）不能打伺服器的 Boss
    if (m.dead) return { ok: false, why: 'dead' };
    if (m.spawnFx > 0.05) return { ok: false, why: 'spawn' };
    if (pl.dead) return { ok: false, why: 'pdead' };
    if (zoneL(pl.x) !== zoneL(m.x) || Math.abs(pl.x - m.x) > HIT_RANGE_X || Math.abs(pl.y - m.y) > HIT_RANGE_Y) return { ok: false, why: 'far' };
    const raw = h[1];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return { ok: false, why: 'dmg' };
    const dmg = Math.min(Math.round(raw), cap);
    const dir = h[2] < 0 ? -1 : 1, crit = h[3] === 1;
    const chill = typeof h[4] === 'number' && Number.isFinite(h[4]) ? clamp(h[4], 0, 3) : 0;
    const real = Math.min(dmg, m.hp);
    m.hp -= dmg;
    m.dmg.set(pl.uid, (m.dmg.get(pl.uid) || 0) + real);
    m.ag = pl.uid;
    mobKnock(m, dir, crit, chill);
    // 傷害數字給附近的其他玩家看（出手的人自己已經先顯示了）
    if (this.events.length < DMG_EVENTS_MAX) this.events.push([m.x, [m.id, 5, dmg, crit ? 1 : 0], pl.uid, m === this.boss ? 1 : 0]);
    if (m.hp > 0) return { ok: true, dmg };
    // 死亡：經驗值依傷害比例分配，之後依怪物的重生時間在出生點重生
    m.dead = true; m.hp = 0; m.act = null; m.fly = null; m.vx = 0; m.vy = 0;
    m.respawnAt = now + m.d.respawn * 1000;
    const exp = splitExp(m.d.exp, m.dmg, pl.uid);
    const kill = { id: m.id, exp, last: pl.uid };
    if (m === this.boss) {   // Boss：輸出達到門檻的人才算討伐（擊殺數、任務、掉寶）
      const need = bossCredit(m.mhp, m.nf);
      kill.boss = true; kill.nf = m.nf;
      kill.credit = new Set([...m.dmg].filter(([, v]) => v >= need).map(([uid]) => uid));
      if (m.boss) m.boss.q = [];
      m.tg = 0;
    }
    m.dmg = new Map();
    return { ok: true, dmg, kill };
  }

  /**
   * 給某位玩家的快照（只送有變化的怪物）。V = 這位玩家的 { mk: Map(id → 上次送出的內容) }，x = 玩家位置，
   * uid = 這位玩家（自己打出的傷害數字不再送回去）。
   * 沒有任何變化回傳 null。
   */
  view(V, x, now, uid) {
    const u = [], g = [], z = zoneL(x);
    for (const m of this.mobs) {
      if (m === this.boss && !V.bo) continue;   // 不支援 Boss 同步的玩家：在本機打自己的 Boss
      const had = V.mk.has(m.id), dx = Math.abs(m.x - x);
      if (zoneL(m.x) !== z || dx > VIEW_R + (had ? VIEW_KEEP : 0)) {
        if (had) { V.mk.delete(m.id); g.push(m.id); }
        continue;
      }
      const e = encodeMob(m), key = keyOf(e);
      if (V.mk.get(m.id) !== key) { V.mk.set(m.id, key); u.push(e); }
    }
    const ev = [];
    for (const [ex, e, skip, b] of this.events) {
      if ((skip === undefined || skip !== uid) && (!b || V.bo) && zoneL(ex) === z && Math.abs(ex - x) <= VIEW_R + VIEW_KEEP) ev.push(e);
    }
    if (!u.length && !g.length && !ev.length) return null;
    const msg = { t: 'm', n: now, u };
    if (g.length) msg.g = g;
    if (ev.length) msg.e = ev;
    return msg;
  }

  /** 休眠前保存（物件被移出記憶體後，下次醒來時接著用；傷害紀錄不保存。活著的 Boss 只會在沒人時休眠，存成「還沒開打」） */
  dump() {
    return this.mobs.map(m => m === this.boss && !m.dead ? [m.id, m.sp.x, Math.round(m.y), m.d.hp, 0, 1]
      : [m.id, Math.round(m.x), Math.round(m.y), Math.max(0, Math.round(m.hp)), m.dead ? m.respawnAt : 0, m.onGround ? 1 : 0]);
  }

  load(list) {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      if (!Array.isArray(r) || r.length < 6) continue;
      const m = this.byId.get(r[0]);
      if (!m || ![r[1], r[2], r[3], r[4]].every(Number.isFinite)) continue;
      if (r[4] > 0) { m.dead = true; m.hp = 0; m.respawnAt = r[4]; continue; }
      if (m === this.boss) continue;   // 活著的 Boss：維持剛建立時的狀態（滿血、在原位）
      m.x = clamp(r[1], m.minX, m.maxX); m.y = clamp(r[2], 0, 760);
      m.hp = clamp(r[3], 1, m.d.hp); m.onGround = m.d.ai !== 'fly' && r[5] === 1;
    }
  }
}
