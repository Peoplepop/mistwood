// 組隊的純邏輯（第七階段 7-0）：隊伍、成員、邀請的規則。不依賴 Cloudflare，可直接用 node --test 測試；
// PartyHub（partyhub.js）只負責把結果存進 storage、把訊息送到各頻道。規則說明見 docs/PHASE7.md「隊伍規則」。
//
// 用法：每次呼叫 online／offline／loc／sync／cmd／cleanup 之後，用 drain() 取出
//   push：要送給玩家的訊息 [[頻道, conn, uid, 訊息], ...]（只會送給在線的玩家，conn 不符的連線由頻道丟掉）
//   parties／users：有變化、需要寫入（或刪除 = null）storage 的隊伍與成員
//
// 規則重點（使用者裁示，2026-10-15）
//   - 隊伍最多 4 人；任何隊員（或未組隊者）都能邀請
//   - 邀請不逾時：直到接受／拒絕、邀請者的隊伍已滿、邀請者已離隊、被邀請者離線、被邀請者已加入其他隊伍為止；
//     每位被邀請者同時只保留一筆，新的邀請取代舊的；邀請者離線不影響（接受時加入邀請者「當下」的隊伍）
//   - 離線不退隊、隊長離線不轉移：只會因自己退出或被隊長踢出而離隊；剩 1 人自動解散
//   - 內部維護：全隊 30 天都沒有人上線的隊伍整隊刪除（cleanup）

import { NCH } from './config.js';

export const PARTY_PROTO = 1;                    // welcome 的 party 欄位（前端版本相同才啟用組隊）
export const PARTY_MAX = 4;                      // 隊伍上限
export const INVITE_GAP_MS = 3000;               // 同一人兩次邀請至少間隔 3 秒
export const INVITE_PER_MIN = 10;                // 每分鐘最多 10 次邀請
export const KICK_COOLDOWN_MS = 60_000;          // 被踢者 60 秒內不能再被同隊邀請
export const PARTY_PURGE_MS = 30 * 86_400_000;   // 全隊 30 天沒人上線 → 刪除（內部維護規則）
export const SYNC_GRACE_MS = 5000;               // 剛上線不到 5 秒的玩家不會被 sync 判定為離線（RPC 先後順序不一定）
export const OPS = new Set(['inv', 'ans', 'leave', 'kick', 'lead']);

export const ERR = {
  STALE: '隊伍功能在另一處使用中',
  SELF: '不能邀請自己',
  RATE: '邀請太頻繁了，請稍等一下',
  OFFLINE: '對方不在線上，或遊戲版本不支援組隊',
  IN_PARTY: '對方已經在其他隊伍中',
  MATE: '對方已經是你的隊友',
  FULL: '隊伍已滿（最多 4 人）',
  KICKED: '對方剛被踢出隊伍，請稍後再邀請',
  NO_INVITE: '這個邀請已經失效',
  ALREADY: '你已經在隊伍中',
  NO_PARTY: '你不在隊伍中',
  NOT_LEAD: '只有隊長可以這麼做',
  KICK_SELF: '不能踢出自己（請用「退出隊伍」）',
  NOT_MEMBER: '對方不在你的隊伍中',
  LEAD_OFF: '對方不在線上，不能轉為隊長',
  LEAD_SELF: '你已經是隊長了',
  BAD: '指令格式錯誤',
};

const INFO_KEYS = ['name', 'lv', 'job', 'ch', 'z'];

const NAME_MAX = 32;

/** 頻道傳來的玩家資料（再檢查一次，避免壞資料寫進 storage） */
export function cleanInfo(i) {
  if (!i || typeof i !== 'object') return null;
  const uid = i.uid, ch = i.ch;
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(ch) || ch < 1 || ch > NCH) return null;
  if (typeof i.conn !== 'string' || !i.conn || i.conn.length > 40) return null;
  return {
    uid, ch, conn: i.conn,
    name: typeof i.name === 'string' && i.name ? i.name.slice(0, NAME_MAX) : '？',
    lv: Number.isInteger(i.lv) ? Math.min(Math.max(i.lv, 1), 200) : 1,
    job: typeof i.job === 'string' ? i.job.slice(0, 16) : 'novice',
    z: i.z === 1 ? 1 : 0,
  };
}


export class PartyBook {
  constructor(rand = Math.random) {
    this.parties = new Map();   // 隊伍 id → { id, v, lead, mem: [uid（加入順序）], kicked: { uid: 冷卻到期時間 } }
    this.users = new Map();     // uid → { uid, name, lv, job, ch, z, pid, on, conn, at: 上線時間, seen: 最後在線時間 }
    this.invites = new Map();   // 被邀請者 uid → { from: 邀請者 uid, ts }（只放記憶體）
    this.rate = new Map();      // 邀請者 uid → 最近一分鐘內的邀請時間
    this.rand = rand;
    this.out = [];
    this.dirtyP = new Set();
    this.dirtyU = new Set();
  }

  // ---------- 保存與讀取 ----------
  /** 從 storage 讀回隊伍與成員。Hub 重新啟動時不知道誰在線上：一律當作離線，再由 online／sync 恢復 */
  load(parties, users) {
    for (const p of parties) if (p && p.id && Array.isArray(p.mem)) this.parties.set(p.id, { kicked: {}, v: 0, ...p });
    for (const u of users) if (u && u.uid) this.users.set(u.uid, { ...u, on: false, conn: '', at: 0 });
    // 成員資料和隊伍對不上的（理論上不會發生）以隊伍為準
    for (const u of this.users.values()) if (u.pid && !this.parties.has(u.pid)) { u.pid = null; this.dirtyU.add(u.uid); }
    for (const p of this.parties.values()) {
      p.mem = p.mem.filter(id => { const u = this.users.get(id); return u && u.pid === p.id; });
      if (p.mem.length < 2) this.disband(p);
      else if (!p.mem.includes(p.lead)) { p.lead = p.mem[0]; this.dirtyP.add(p.id); }
    }
    this.out = [];
  }

  static partyRow(p) { return { id: p.id, v: p.v, lead: p.lead, mem: [...p.mem], kicked: { ...p.kicked } }; }
  static userRow(u) { return { uid: u.uid, name: u.name, lv: u.lv, job: u.job, ch: u.ch, z: u.z, pid: u.pid, seen: u.seen }; }

  /** 取出這段時間要送出的訊息與要寫入 storage 的資料 */
  drain() {
    const parties = [...this.dirtyP].map(id => { const p = this.parties.get(id); return [id, p ? PartyBook.partyRow(p) : null]; });
    const users = [...this.dirtyU].map(uid => { const u = this.users.get(uid); return [uid, u && u.pid ? PartyBook.userRow(u) : null]; });
    const push = this.out;
    this.out = []; this.dirtyP.clear(); this.dirtyU.clear();
    return { push, parties, users };
  }

  // ---------- 送訊息 ----------
  /** 送給在線的玩家（route 指定時送到那條連線，例如被取代的舊連線） */
  push(uid, msg, route = null) {
    if (route) { this.out.push([route.ch, route.conn, uid, msg]); return; }
    const u = this.users.get(uid);
    if (u && u.on && u.conn) this.out.push([u.ch, u.conn, uid, msg]);
  }

  snapshot(p) {
    return {
      id: p.id, v: p.v, lead: p.lead,
      mem: p.mem.map(id => {
        const u = this.users.get(id) || { name: '？', lv: 1, job: 'novice', ch: 0, z: 0, on: false };
        return { id, name: u.name, lv: u.lv, job: u.job, ch: u.ch, z: u.z, on: !!u.on };
      }),
    };
  }

  /** 隊伍有變化：版本 +1、存檔、把新快照送給所有在線隊員 */
  changed(p) {
    p.v++;
    this.dirtyP.add(p.id);
    const msg = { t: 'pu', p: this.snapshot(p) };
    for (const id of p.mem) this.push(id, msg);
  }

  /** 只送快照給一位玩家（不在隊伍 = null） */
  sendSnap(uid) {
    const u = this.users.get(uid), p = u && u.pid ? this.parties.get(u.pid) : null;
    this.push(uid, { t: 'pu', p: p ? this.snapshot(p) : null });
  }

  event(to, k, who, extra = {}) {
    const u = this.users.get(who);
    this.push(to, { t: 'pe', k, id: who, name: u ? u.name : '？', ...extra });
  }

  // ---------- 在線狀態 ----------
  /** 玩家連上頻道（hello）。以最後一個 online 為準：之前在別的連線上的 session 收到 stale */
  online(info, now) {
    const uid = info.uid;
    let u = this.users.get(uid);
    const prev = u && u.on && u.conn && u.conn !== info.conn ? { ch: u.ch, conn: u.conn } : null;
    if (!u) { u = { uid, pid: null, seen: now }; this.users.set(uid, u); }
    const was = u.on ? INFO_KEYS.map(k => u[k]).join('|') : null;
    for (const k of INFO_KEYS) u[k] = info[k];
    u.on = true; u.conn = info.conn; u.at = now; u.seen = now;
    if (prev) this.push(uid, { t: 'pe', k: 'stale', id: uid, name: u.name }, prev);
    const p = u.pid ? this.parties.get(u.pid) : null;
    if (p) {
      this.dirtyU.add(uid);
      if (was !== INFO_KEYS.map(k => u[k]).join('|')) this.changed(p);   // 上線（或位置不同）：隊友也要知道
      else this.sendSnap(uid);
    } else this.sendSnap(uid);
    const inv = this.invites.get(uid);   // 還有待處理的邀請（例如在另一處連線時收到的）：再送一次
    if (inv) this.sendInvite(uid, inv.from);
  }

  /** 玩家離開頻道。只接受目前這條連線的 offline（換頻道時舊連線的 offline 會比較晚到，直接忽略） */
  offline(uid, conn, now) {
    const u = this.users.get(uid);
    if (!u || !u.on || u.conn !== conn) return false;
    this.goOffline(u, now);
    this.prune();
    return true;
  }

  goOffline(u, now) {
    u.on = false; u.seen = now;
    const inv = this.invites.get(u.uid);
    if (inv) this.voidInvite(u.uid, 'off');   // 被邀請者離線：邀請作廢
    if (u.pid) {
      this.dirtyU.add(u.uid);
      const p = this.parties.get(u.pid);
      if (p) this.changed(p);
    }
  }

  /** 地圖／等級／職業有變化（只接受目前的連線） */
  loc(uid, conn, d) {
    const u = this.users.get(uid);
    if (!u || !u.on || u.conn !== conn) return false;
    let diff = false;
    for (const k of ['z', 'lv', 'job']) if (d[k] !== undefined && d[k] !== u[k]) { u[k] = d[k]; diff = true; }
    if (diff && u.pid) {
      this.dirtyU.add(uid);
      const p = this.parties.get(u.pid);
      if (p) this.changed(p);
    }
    return diff;
  }

  /** 頻道定期回報目前在線（支援組隊）的玩家：Hub 重啟後恢復在線狀態；頻道沒送 offline 就消失的玩家標為離線 */
  sync(ch, list, now) {
    const seen = new Map();
    for (const info of list) {
      seen.set(info.uid, info.conn);
      const u = this.users.get(info.uid);
      if (!u || !u.conn) this.online(info, now);                    // Hub 不知道這位玩家（剛重啟）：當作上線
      else if (u.on && u.conn === info.conn) this.loc(info.uid, info.conn, info);
      // 其他情況：這位玩家已經在別的連線上線（或這條連線已經 offline）→ 忽略
    }
    for (const u of this.users.values()) {
      if (u.on && u.ch === ch && seen.get(u.uid) !== u.conn && now - u.at > SYNC_GRACE_MS) this.goOffline(u, now);
    }
    this.prune();
  }

  /** 不在隊伍、離線、也沒有發出待處理邀請的玩家不用再記 */
  prune() {
    const from = new Set([...this.invites.values()].map(i => i.from));
    for (const [uid, u] of this.users) if (!u.on && !u.pid && !from.has(uid) && !this.invites.has(uid)) this.users.delete(uid);
  }

  // ---------- 邀請 ----------
  sendInvite(to, from) {
    const f = this.users.get(from);
    this.push(to, { t: 'pi', from, name: f ? f.name : '？', lv: f ? f.lv : 1, job: f ? f.job : 'novice', ch: f ? f.ch : 0 });
  }

  /** 邀請作廢：雙方都會收到 pe void（被邀請者已離線、或被新邀請取代時不用通知被邀請者） */
  voidInvite(to, why) {
    const inv = this.invites.get(to);
    if (!inv) return;
    this.invites.delete(to);
    if (why !== 'off' && why !== 'replaced') this.event(to, 'void', inv.from, { why });
    this.event(inv.from, 'void', to, { why });
  }

  /** 這些人發出的待處理邀請全部作廢（邀請者離隊、隊伍已滿） */
  voidFrom(uids, why) {
    const set = new Set(uids);
    for (const [to, inv] of [...this.invites]) if (set.has(inv.from)) this.voidInvite(to, why);
  }

  rateOk(uid, now) {
    const list = (this.rate.get(uid) || []).filter(t => now - t < 60_000);
    this.rate.set(uid, list);
    if (list.length && now - list[list.length - 1] < INVITE_GAP_MS) return false;
    return list.length < INVITE_PER_MIN;
  }

  // ---------- 指令 ----------
  /** 玩家的隊伍指令。info = 發出指令的玩家（含 conn）；回傳 { ok, error? } */
  cmd(info, op, args, now) {
    if (!OPS.has(op)) return { ok: false, error: ERR.BAD };
    let u = this.users.get(info.uid);
    if (u && u.conn && u.conn !== info.conn && u.on) return { ok: false, error: ERR.STALE };   // 別的連線才是目前的
    if (u && u.conn === info.conn && !u.on) return { ok: false, error: ERR.STALE };            // 這條連線已經 offline
    if (!u || !u.on) { this.online(info, now); u = this.users.get(info.uid); }               // Hub 剛重啟：先當作上線
    const id = args && Number.isInteger(args.id) && args.id > 0 ? args.id : 0;
    if (op !== 'leave' && !id) return { ok: false, error: ERR.BAD };
    switch (op) {
      case 'inv': return this.invite(u, id, now);
      case 'ans': return this.answer(u, id, !!(args && args.ok), now);
      case 'leave': return u.pid ? (this.remove(this.parties.get(u.pid), u.uid, 'leave'), { ok: true }) : { ok: false, error: ERR.NO_PARTY };
      case 'kick': return this.kick(u, id, now);
      case 'lead': return this.lead(u, id);
    }
    return { ok: false, error: ERR.BAD };
  }

  invite(u, id, now) {
    if (id === u.uid) return { ok: false, error: ERR.SELF };
    const t = this.users.get(id);
    if (!t || !t.on) return { ok: false, error: ERR.OFFLINE };
    const p = u.pid ? this.parties.get(u.pid) : null;
    if (t.pid) return { ok: false, error: p && t.pid === p.id ? ERR.MATE : ERR.IN_PARTY };
    if (p && p.mem.length >= PARTY_MAX) return { ok: false, error: ERR.FULL };
    if (p && (p.kicked[id] || 0) > now) return { ok: false, error: ERR.KICKED };
    if (!this.rateOk(u.uid, now)) return { ok: false, error: ERR.RATE };
    this.rate.get(u.uid).push(now);
    const old = this.invites.get(id);
    if (old && old.from !== u.uid) this.voidInvite(id, 'replaced');   // 新邀請取代舊的
    this.invites.set(id, { from: u.uid, ts: now });
    this.sendInvite(id, u.uid);
    return { ok: true };
  }

  answer(u, from, ok, now) {
    const inv = this.invites.get(u.uid);
    if (!inv || inv.from !== from) return { ok: false, error: ERR.NO_INVITE };
    this.invites.delete(u.uid);
    if (!ok) { this.event(from, 'decline', u.uid); return { ok: true }; }
    if (u.pid) return { ok: false, error: ERR.ALREADY };
    const f = this.users.get(from);
    if (!f) return { ok: false, error: ERR.NO_INVITE };
    let p = f.pid ? this.parties.get(f.pid) : null;
    if (p) {
      if (p.mem.length >= PARTY_MAX) return { ok: false, error: ERR.FULL };
      p.mem.push(u.uid);
    } else {   // 邀請者還沒有隊伍：建立新隊伍，邀請者是隊長
      p = { id: this.newId(now), v: 0, lead: from, mem: [from, u.uid], kicked: {} };
      this.parties.set(p.id, p);
      f.pid = p.id; this.dirtyU.add(from);
      if (this.invites.has(from)) this.voidInvite(from, 'party');   // 邀請者自己收到的邀請：已加入隊伍 → 作廢
    }
    u.pid = p.id; this.dirtyU.add(u.uid);
    for (const id of p.mem) if (id !== u.uid) this.event(id, 'join', u.uid);
    this.changed(p);
    if (p.mem.length >= PARTY_MAX) this.voidFrom(p.mem, 'full');
    return { ok: true };
  }

  kick(u, id, now) {
    const p = u.pid ? this.parties.get(u.pid) : null;
    if (!p) return { ok: false, error: ERR.NO_PARTY };
    if (p.lead !== u.uid) return { ok: false, error: ERR.NOT_LEAD };
    if (id === u.uid) return { ok: false, error: ERR.KICK_SELF };
    if (!p.mem.includes(id)) return { ok: false, error: ERR.NOT_MEMBER };
    for (const k of Object.keys(p.kicked)) if (p.kicked[k] <= now) delete p.kicked[k];
    p.kicked[id] = now + KICK_COOLDOWN_MS;
    this.remove(p, id, 'kick');
    return { ok: true };
  }

  lead(u, id) {
    const p = u.pid ? this.parties.get(u.pid) : null;
    if (!p) return { ok: false, error: ERR.NO_PARTY };
    if (p.lead !== u.uid) return { ok: false, error: ERR.NOT_LEAD };
    if (id === u.uid) return { ok: false, error: ERR.LEAD_SELF };
    if (!p.mem.includes(id)) return { ok: false, error: ERR.NOT_MEMBER };
    const t = this.users.get(id);
    if (!t || !t.on) return { ok: false, error: ERR.LEAD_OFF };
    p.lead = id;
    for (const m of p.mem) this.event(m, 'lead', id);
    this.changed(p);
    return { ok: true };
  }

  /** 成員離開隊伍（退出 leave／被踢 kick）；剩 1 人就解散 */
  remove(p, id, kind) {
    p.mem = p.mem.filter(m => m !== id);
    const t = this.users.get(id);
    if (t) { t.pid = null; this.dirtyU.add(id); }
    this.voidFrom([id], 'left');   // 邀請者已離隊：他發出的邀請作廢
    if (kind === 'kick') this.event(id, 'kick', id);
    this.push(id, { t: 'pu', p: null });
    if (p.mem.length < 2) { this.disband(p, id, kind); return; }
    for (const m of p.mem) this.event(m, kind, id);
    if (p.lead === id) {   // 隊長離開：最早加入的在線隊員接任（都不在線就給最早加入的）
      p.lead = (p.mem.find(m => { const x = this.users.get(m); return x && x.on; })) || p.mem[0];
      for (const m of p.mem) this.event(m, 'lead', p.lead);
    }
    this.changed(p);
    if (t && !t.on) this.prune();
  }

  disband(p, who = 0, kind = '') {
    this.parties.delete(p.id);
    this.dirtyP.add(p.id);
    for (const m of p.mem) {
      const u = this.users.get(m);
      if (u) { u.pid = null; this.dirtyU.add(m); }
      if (who) this.event(m, kind, who);
      this.event(m, 'disband', m);
      this.push(m, { t: 'pu', p: null });
    }
    this.prune();
  }

  newId(now) {
    let id;
    do { id = now.toString(36) + Math.floor(this.rand() * 36 ** 4).toString(36).padStart(4, '0'); } while (this.parties.has(id));
    return id;
  }

  // ---------- 內部維護 ----------
  /** 全隊所有成員都離線、而且最後一位上線超過 30 天的隊伍整隊刪除；回傳刪除的隊伍數 */
  cleanup(now) {
    let n = 0;
    for (const p of [...this.parties.values()]) {
      const mem = p.mem.map(id => this.users.get(id)).filter(Boolean);
      if (mem.some(u => u.on)) continue;
      const last = Math.max(0, ...mem.map(u => u.seen || 0));
      if (now - last < PARTY_PURGE_MS) continue;
      this.parties.delete(p.id); this.dirtyP.add(p.id);
      for (const u of mem) { u.pid = null; this.dirtyU.add(u.uid); }
      n++;
    }
    this.prune();
    return n;
  }
}
