// 聊天文字的清理與不雅字詞過濾（與 server/app.py 的 clean_chat／filter_profanity 規則相同）
// ※ PROFANITY 清單要和 server/app.py 的 PROFANITY 完全一樣（server/tests 有測試會比對兩邊）

export const CHAT_MAX_LEN = 60;          // 訊息最多幾個字（以 Unicode 字元計算）
export const CHAT_GAP_MS = 1500;         // 同一個玩家兩則訊息至少間隔 1.5 秒
export const CHAT_BURST = 5;             // CHAT_BURST_WINDOW_MS 內最多幾則
export const CHAT_BURST_WINDOW_MS = 20_000;

// 不雅字詞（中文＋英文常見字），比對時不分大小寫，命中的字元換成「＊」
// 注意：不要放太短、容易誤判的字（例如「操」會誤判「操作」、「三小」會誤判「三小時」）
export const PROFANITY = [
  "幹你娘", "幹您娘", "幹你", "幹妳", "幹恁", "幹拎", "姦你", "操你", "肏", "草你媽", "草泥馬",
  "他媽的", "他妈的", "靠北", "靠杯", "靠腰", "機掰", "雞掰", "機巴", "雞巴", "鸡巴",
  "屌", "婊子", "賤人", "贱人", "賤貨", "王八蛋", "白癡", "白痴", "智障", "腦殘", "脑残", "傻逼", "傻屄", "煞筆", "沙比",
  "去死", "垃圾人", "廢物", "低能", "北七",
  "motherfucker", "fucking", "fucker", "fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick", "pussy",
  "nigger", "nigga", "faggot", "slut", "whore", "retard", "wtf", "stfu",
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROFANITY_RE = new RegExp([...PROFANITY].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'giu');

const SPACE_RE = /^(?:\p{Z}|[\t\n\r])$/u;
// 控制字元、隱藏的格式字元（反轉文字方向、零寬字元）、代理字元、私用區、未指派、組合用的附加符號
const DROP_RE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Mn}\p{Me}]$/u;

/** 清理聊天文字：空白類字元換成一個半形空白、去掉看不見的字元，前後空白去掉 */
export function cleanChat(text) {
  const out = [];
  for (const c of text) {
    if (SPACE_RE.test(c)) out.push(' ');
    else if (!DROP_RE.test(c)) out.push(c);
  }
  return out.join('').replace(/ {2,}/g, ' ').trim();
}

/** 不雅字詞換成同樣字數的「＊」。比對時先把每個字元統一成半形（NFKC，例如「ｓｈｉｔ」→ shit），
 *  但只替換命中的位置，其他文字保持原樣 */
export function filterProfanity(text) {
  const chars = [...text];
  // fold 與 chars 一一對應（每個字元正規化後只有一個字元才採用，否則保留原字元）
  const fold = chars.map(c => { const n = c.normalize('NFKC'); return [...n].length === 1 ? n : c; });
  // 把 fold 字串的 UTF-16 位置對應回字元索引
  const unitToIdx = [];
  fold.forEach((c, i) => { for (let k = 0; k < c.length; k++) unitToIdx.push(i); });
  unitToIdx.push(fold.length);
  const foldStr = fold.join('');
  PROFANITY_RE.lastIndex = 0;
  let m;
  while ((m = PROFANITY_RE.exec(foldStr)) !== null) {
    const a = unitToIdx[m.index], b = unitToIdx[m.index + m[0].length];
    for (let i = a; i < b; i++) chars[i] = '＊';
  }
  return chars.join('');
}

/** 檢查並整理一則聊天訊息。回傳 { text } 或 { error } */
export function prepareChat(raw) {
  if (typeof raw !== 'string') return { error: '請輸入訊息' };
  if (raw.length > CHAT_MAX_LEN * 4) return { error: `訊息最多 ${CHAT_MAX_LEN} 個字` };
  const text = cleanChat(raw);
  if (!text) return { error: '訊息不能是空白' };
  if ([...text].length > CHAT_MAX_LEN) return { error: `訊息最多 ${CHAT_MAX_LEN} 個字` };
  return { text: filterProfanity(text) };
}
