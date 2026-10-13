// 即時連線票券驗證（票券由 PythonAnywhere 的 POST /api/rt-ticket 簽發，見 server/app.py 的 sign_rt_ticket）
// 格式：base64url(JSON 內容) + "." + base64url(HMAC-SHA256(密鑰, 前半段文字))

const enc = new TextEncoder();
const keyCache = new Map();   // 密鑰 → CryptoKey（同一個 isolate 內重複使用）

function b64urlToBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    keyCache.set(secret, k);
  }
  return k;
}

/**
 * 驗證票券。成功回傳內容 { uid, name, lv, lvmax, job, exp }，失敗回傳 null。
 * nowSec：目前的 Unix 時間（秒），測試時可以指定
 */
export async function verifyTicket(ticket, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof ticket !== 'string' || ticket.length > 2048) return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot !== ticket.lastIndexOf('.')) return null;
  const body = ticket.slice(0, dot);
  let data;
  try {
    const sig = b64urlToBytes(ticket.slice(dot + 1));
    // crypto.subtle.verify 用固定時間比較簽章，不會因為比對時間不同洩漏資訊
    if (!await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(body))) return null;
    data = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch (e) {
    return null;
  }
  if (!data || typeof data !== 'object' || data.v !== 1) return null;
  const { uid, name, lv, lvmax, job, exp } = data;
  if (!Number.isInteger(uid) || uid <= 0 || typeof name !== 'string' || !name || name.length > 32) return null;
  if (!Number.isInteger(exp) || exp < nowSec) return null;   // 過期
  return {
    uid, name, exp,
    lv: Number.isInteger(lv) ? Math.min(Math.max(lv, 1), 200) : 1,
    lvmax: Number.isInteger(lvmax) ? Math.min(Math.max(lvmax, 1), 200) : 10,
    job: typeof job === 'string' ? job : 'novice',
  };
}
