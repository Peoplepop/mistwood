// 玩家的戰鬥特效事件（技能、遠程普通攻擊、受到傷害）：讓同一張地圖附近的玩家看得到別人放技能、被打掉血。
// 純裝飾：收到的前端只播放特效與傷害數字，不會對任何東西造成傷害。
//
// 前端把事件附在狀態回報裡（不另外送訊息，省 Durable Object 請求數）：
//   {t:'s', ..., hp: HP 百分比 0～100, e: [事件, ...]}
//   事件：['k', 技能 id, 方向, x, y, 目標座標...]   施放技能（目標座標 = 雷擊落點、隕石落點，x／y 交錯，最多 4 組）
//         ['a', 方向, x, y, 趴下?1:0]               遠程職業的普通攻擊（近戰的揮砍動作靠狀態裡的攻擊序號就看得到）
//         ['d', 傷害]                               受到傷害（顯示在頭上的紫色數字）
// 伺服器檢查後放進下一次的 ps 廣播，只送給同一張地圖、左右 FX_RANGE 內的其他玩家（players[i].e）。
import { zoneL } from './mobs.gen.js';
import { WORLD_W, WORLD_H } from './state.js';

export const FX_RANGE = 1500;      // 興趣範圍（和怪物快照相同）
export const FX_PER_MSG = 6;       // 一則狀態回報最多採用幾個事件
export const FX_QUEUE = 12;        // 每位玩家在一次廣播之間最多累積幾個事件
export const FX_RATE = [16, 8];    // 事件的令牌桶（每位玩家）：最多連續 16 個，每秒補 8 個（技能都有冷卻，正常玩不會超過）
export const DMG_MAX = 999999;
const PTS_MAX = 8;                 // 技能目標座標最多幾個數字（4 組 x, y）

// 會產生特效的技能 → 所屬職業（被動技能不會出現；新手技能每個職業都能用，二轉可以用一轉的技能）
export const FX_SKILLS = {
  wind: 'novice',
  heavy: 'warrior', roar: 'warrior', spin: 'warrior',
  double: 'archer', focus: 'archer', pierce: 'archer',
  fire: 'mage', shield: 'mage', thunder: 'mage',
  kbless: 'knight', kcharge: 'knight', kholy: 'knight',
  hhawk: 'hunter', harrow: 'hunter', hbomb: 'hunter',
  wmana: 'wizard', wblizz: 'wizard', wmeteor: 'wizard',
};
const JOB_BASE = { knight: 'warrior', hunter: 'archer', wizard: 'mage' };
const RANGED = new Set(['archer', 'mage', 'hunter', 'wizard']);

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const cx = v => Math.round(clamp(v, 0, WORLD_W));
const cy = v => Math.round(clamp(v, -400, WORLD_H));

/** 這個職業能不能用這個技能 */
export function skillFits(id, job) {
  const sj = Object.hasOwn(FX_SKILLS, id) ? FX_SKILLS[id] : null;
  return !!sj && (sj === 'novice' || sj === job || sj === JOB_BASE[job]);
}

/**
 * 檢查並整理一則狀態回報裡的事件（job = 已檢查過的職業）。格式不對、技能不認得或職業不符的事件直接丟掉，
 * 數字一律夾到合法範圍並取整數。最多回傳 FX_PER_MSG 個。
 */
export function parseFx(list, job) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const e of list.slice(0, FX_PER_MSG * 2)) {
    if (out.length >= FX_PER_MSG) break;
    if (!Array.isArray(e) || e.length > 4 + PTS_MAX + 1) continue;
    const k = e[0];
    if (k === 'k') {
      const x = num(e[3]), y = num(e[4]);
      if (typeof e[1] !== 'string' || !skillFits(e[1], job) || x === null || y === null) continue;
      const ev = ['k', e[1], e[2] === -1 ? -1 : 1, cx(x), cy(y)];
      const pts = e.slice(5, 5 + PTS_MAX);
      if (pts.length % 2 || !pts.every(v => num(v) !== null)) { out.push(ev); continue; }
      pts.forEach((v, i) => ev.push(i % 2 ? cy(v) : cx(v)));
      out.push(ev);
    } else if (k === 'a') {
      const x = num(e[2]), y = num(e[3]);
      if (!RANGED.has(job) || x === null || y === null) continue;
      out.push(['a', e[1] === -1 ? -1 : 1, cx(x), cy(y), e[4] === 1 ? 1 : 0]);
    } else if (k === 'd') {
      const v = num(e[1]);
      if (v === null || v < 0) continue;
      out.push(['d', Math.round(Math.min(v, DMG_MAX))]);
    }
  }
  return out;
}

/** 兩個位置是否在彼此的興趣範圍內（同一張地圖、左右 FX_RANGE 內） */
export function fxNear(a, b) {
  return zoneL(a.x) === zoneL(b.x) && Math.abs(a.x - b.x) <= FX_RANGE;
}

/**
 * 給某位玩家的 ps 廣播內容。items = 這次有變化的玩家 [{ uid, s: 狀態, j: 公開資料, ev: 事件 }]，
 * me = 收到的人 { uid, s }。附近其他玩家的事件放進 players[i].e；沒有任何事件時回傳 null（直接用共用的廣播內容）。
 */
export function psPlayersFor(items, me) {
  let any = false;
  const list = items.map(it => {
    if (!it.ev.length || it.uid === me.uid || !fxNear(it.s, me.s)) return it.j;
    any = true;
    return { ...it.j, e: it.ev };
  });
  return any ? list : null;
}
