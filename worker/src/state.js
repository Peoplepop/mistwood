// 玩家回報狀態的檢查（與 server/app.py 的 parse_presence 規則相同）

export const WORLD_W = 11200, WORLD_H = 760;   // 地圖大小（與前端 index.html 相同）
export const LEVEL_MAX = 200;
// 職業 → 需要的最低等級（一轉 Lv.10、二轉 Lv.30）
export const JOB_MIN_LEVEL = {
  novice: 1,
  warrior: 10, archer: 10, mage: 10,
  knight: 30, hunter: 30, wizard: 30,
};
const HERO_STATES = new Set(['idle', 'walk', 'jump', 'climb', 'prone', 'dead']);
const ACT_KINDS = new Set(['melee', 'stab', 'shot', 'pshot', 'skill', 'heavy', 'spin', 'thrust', 'cast']);
const EQUIP_SLOTS = ['weapon', 'hat', 'top', 'shoes', 'acc'];
const ITEM_ID_RE = /^[a-z0-9]{1,16}$/;
const RARITY_MAX = 3;
export const EMOTES = 6;
const SEQ_MAX = 2 ** 31 - 1;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = v => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const seq = v => { const n = int(v); return n === null || n < 0 ? 0 : n % (SEQ_MAX + 1); };

/**
 * 檢查並整理前端回報的狀態。明顯不合理（位置在地圖外很遠、等級不是 1～200 的整數）回傳 null；
 * 其他欄位一律夾到合法範圍或換成預設值。lvmax = 票券上的顯示等級上限
 */
export function parseState(d, lvmax) {
  if (!d || typeof d !== 'object') return null;
  const x = num(d.x), y = num(d.y);
  if (x === null || y === null) return null;
  if (x < -50 || x > WORLD_W + 50 || y < -400 || y > WORLD_H + 100) return null;
  let lv = int(d.lv);
  if (lv === null || lv < 1 || lv > LEVEL_MAX) return null;
  lv = Math.min(lv, lvmax);
  let job = d.job;
  if (typeof job !== 'string' || !Object.hasOwn(JOB_MIN_LEVEL, job) || lv < JOB_MIN_LEVEL[job]) job = 'novice';
  const eq = {};
  if (d.eq && typeof d.eq === 'object' && !Array.isArray(d.eq)) {
    for (const slot of EQUIP_SLOTS) {
      const v = d.eq[slot];
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && ITEM_ID_RE.test(v[0])) {
        const r = int(v[1]);
        if (r !== null && r >= 0 && r <= RARITY_MAX) eq[slot] = [v[0], r];
      }
    }
  }
  const em = d.em === undefined ? -1 : int(d.em);
  return {
    x: round(clamp(x, 0, WORLD_W), 1), y: round(clamp(y, 0, WORLD_H), 1),
    f: d.f === -1 ? -1 : 1,
    st: HERO_STATES.has(d.st) ? d.st : 'idle',
    ak: ACT_KINDS.has(d.ak) ? d.ak : '',
    ad: round(clamp(num(d.ad) || 0, 0, 1.5), 3),
    an: seq(d.an),
    job, lv, eq,
    em: em !== null && em >= -1 && em < EMOTES ? em : -1,
    en: seq(d.en),
  };
}
