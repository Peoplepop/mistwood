// 組隊規則（PartyBook，第七階段 7-0）的單元測試（執行方式：在 worker 資料夾輸入 npm test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PartyBook, ERR, PARTY_MAX, KICK_COOLDOWN_MS, PARTY_PURGE_MS, SYNC_GRACE_MS, GHOST_MS, INVITE_GAP_MS, INVITE_PER_MIN } from '../src/party.js';
import { cleanInfo } from '../src/party.js';

const T0 = 1_800_000_000_000;
const info = (uid, ch = 1, extra = {}) => ({ uid, name: 'P' + uid, lv: 10 + uid, job: 'novice', ch, z: 0, conn: 'c' + uid, ...extra });

/** 測試用：記錄每位玩家收到的訊息 */
function setup(n = 0) {
  const B = new PartyBook(() => 0.5);
  B.now = T0;
  B.inbox = new Map();
  B.flushT = () => {
    const d = B.drain();
    B.last = d;
    for (const [ch, conn, uid, msg] of d.push) {
      if (!B.inbox.has(uid)) B.inbox.set(uid, []);
      B.inbox.get(uid).push({ ch, conn, ...msg });
    }
    return d;
  };
  B.take = uid => { const l = B.inbox.get(uid) || []; B.inbox.set(uid, []); return l; };
  B.on = (uid, ch = 1, extra) => { B.online(info(uid, ch, extra), B.now); B.flushT(); };
  B.do = (uid, op, args = {}, conn) => {
    B.now += INVITE_GAP_MS;   // 預設每個指令間隔 3 秒，不會撞到邀請頻率限制
    for (const x of B.users.values()) if (x.on) B.syncAt.set(x.uid, B.now);   // 模擬頻道每 30 秒的 sync（在線的人一直有被確認）
    const u = B.users.get(uid);
    const r = B.cmd({ ...info(uid, u ? u.ch : 1), ...(u ? { name: u.name, lv: u.lv, job: u.job, z: u.z } : {}), conn: conn || (u && u.conn) || 'c' + uid }, op, args, B.now);
    B.flushT();
    return r;
  };
  B.party = uid => { const u = B.users.get(uid); return u && u.pid ? B.parties.get(u.pid) : null; };
  for (let i = 1; i <= n; i++) B.on(i);
  B.inbox.clear();
  return B;
}
const lastPu = msgs => msgs.filter(m => m.t === 'pu').pop();
const events = msgs => msgs.filter(m => m.t === 'pe').map(m => m.k + ':' + m.id + (m.why ? ':' + m.why : ''));

test('組隊：邀請→接受建立隊伍，邀請者是隊長；快照送給雙方', () => {
  const B = setup(2);
  assert.deepEqual(B.do(1, 'inv', { id: 2 }), { ok: true });
  const pi = B.take(2).find(m => m.t === 'pi');
  assert.equal(pi.from, 1); assert.equal(pi.name, 'P1'); assert.equal(pi.ttl, undefined);   // 邀請不逾時，沒有 ttl
  assert.deepEqual(B.do(2, 'ans', { id: 1, ok: 1 }), { ok: true });
  const p = B.party(1);
  assert.equal(p.lead, 1); assert.deepEqual(p.mem, [1, 2]);
  const pu1 = lastPu(B.take(1)), pu2 = lastPu(B.take(2));
  assert.deepEqual(pu1.p, pu2.p);
  assert.deepEqual(pu1.p.mem.map(m => [m.id, m.name, m.on]), [[1, 'P1', true], [2, 'P2', true]]);
  assert.equal(B.invites.size, 0);
});

test('組隊：任何隊員都能邀請，滿 4 人後第 5 人被拒', () => {
  const B = setup(6);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  assert.deepEqual(B.do(2, 'inv', { id: 3 }), { ok: true });   // 不是隊長也能邀請
  B.do(3, 'ans', { id: 2, ok: 1 });
  B.do(3, 'inv', { id: 4 }); B.do(4, 'ans', { id: 3, ok: 1 });
  assert.equal(B.party(1).mem.length, PARTY_MAX);
  assert.equal(B.party(1).lead, 1);
  assert.deepEqual(B.do(4, 'inv', { id: 5 }), { ok: false, error: ERR.FULL });
  assert.deepEqual(B.do(1, 'inv', { id: 1 }), { ok: false, error: ERR.SELF });
  assert.deepEqual(B.do(1, 'inv', { id: 2 }), { ok: false, error: ERR.MATE });
  assert.deepEqual(B.do(5, 'inv', { id: 2 }), { ok: false, error: ERR.IN_PARTY });
  assert.deepEqual(B.do(5, 'inv', { id: 99 }), { ok: false, error: ERR.OFFLINE });
});

test('邀請：不逾時（很久以後仍可接受）；拒絕會通知邀請者', () => {
  const B = setup(3);
  B.do(1, 'inv', { id: 2 });
  B.now += 3 * 86_400_000;   // 3 天後
  assert.deepEqual(B.do(2, 'ans', { id: 1, ok: 1 }), { ok: true });
  B.do(1, 'inv', { id: 3 }); B.take(1);
  assert.deepEqual(B.do(3, 'ans', { id: 1, ok: 0 }), { ok: true });
  assert.deepEqual(events(B.take(1)), ['decline:3']);
  assert.deepEqual(B.do(3, 'ans', { id: 1, ok: 1 }), { ok: false, error: ERR.NO_INVITE });   // 已經拒絕過
});

test('邀請：每位被邀請者只保留一筆，新邀請取代舊的（舊邀請者收到 void replaced）', () => {
  const B = setup(3);
  B.do(1, 'inv', { id: 3 });
  B.do(2, 'inv', { id: 3 });
  assert.equal(B.invites.get(3).from, 2);
  assert.deepEqual(events(B.take(1)), ['void:3:replaced']);
  assert.deepEqual(B.take(3).filter(m => m.t === 'pi').map(m => m.from), [1, 2]);
  assert.deepEqual(B.do(3, 'ans', { id: 1, ok: 1 }), { ok: false, error: ERR.NO_INVITE });
  assert.deepEqual(B.do(3, 'ans', { id: 2, ok: 1 }), { ok: true });
  assert.deepEqual(B.party(3).mem, [2, 3]);
});

test('邀請：隊伍滿了，以這個隊伍名義的其他邀請作廢（雙方都收到 void full）', () => {
  const B = setup(5);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.do(1, 'inv', { id: 3 }); B.do(2, 'inv', { id: 4 }); B.do(1, 'inv', { id: 5 });
  B.do(3, 'ans', { id: 1, ok: 1 });
  B.take(4); B.take(5); B.take(1);
  B.do(4, 'ans', { id: 2, ok: 1 });   // 第 4 人加入 → 滿
  assert.equal(B.party(1).mem.length, 4);
  assert.equal(B.invites.size, 0);
  assert.deepEqual(events(B.take(5)), ['void:1:full']);
  assert.ok(events(B.take(1)).includes('void:5:full'));
});

test('邀請：邀請者離隊 → 他發出的邀請作廢；被邀請者離線 → 作廢', () => {
  const B = setup(4);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.do(2, 'inv', { id: 3 }); B.take(3);
  B.do(2, 'leave');
  assert.equal(B.invites.has(3), false);
  assert.deepEqual(events(B.take(3)), ['void:2:left']);
  B.do(4, 'inv', { id: 3 }); B.take(4);
  B.offline(3, 'c3', B.now); B.flushT();
  assert.equal(B.invites.has(3), false);
  assert.deepEqual(events(B.take(4)), ['void:3:off']);
});

test('邀請：邀請者離線不影響，被邀請者仍可接受（加入邀請者當下的隊伍／新建隊伍）', () => {
  const B = setup(2);
  B.do(1, 'inv', { id: 2 });
  B.offline(1, 'c1', B.now); B.flushT();
  assert.equal(B.invites.get(2).from, 1);
  assert.ok(B.users.has(1));   // 有待處理邀請：離線也保留資料
  assert.deepEqual(B.do(2, 'ans', { id: 1, ok: 1 }), { ok: true });
  const p = B.party(2);
  assert.equal(p.lead, 1);
  assert.deepEqual(lastPu(B.take(2)).p.mem.map(m => [m.id, m.on]), [[1, false], [2, true]]);
});

test('邀請：被邀請者自己先組了隊 → 他收到的邀請作廢（why party）', () => {
  const B = setup(3);
  B.do(1, 'inv', { id: 2 });   // 1 → 2（待處理）
  B.do(2, 'inv', { id: 3 }); B.do(3, 'ans', { id: 2, ok: 1 });   // 2 和 3 組隊
  assert.equal(B.invites.has(2), false);
  assert.ok(events(B.take(1)).includes('void:2:party'));
  assert.deepEqual(B.do(2, 'ans', { id: 1, ok: 1 }), { ok: false, error: ERR.NO_INVITE });
});

test('邀請：頻率限制（3 秒 1 次、每分鐘 10 次）', () => {
  const B = setup(13);
  assert.equal(B.invite(B.users.get(1), 2, T0).ok, true);
  assert.deepEqual(B.invite(B.users.get(1), 3, T0 + 1000), { ok: false, error: ERR.RATE });
  let ok = 1;
  for (let i = 3; i <= 13; i++) if (B.invite(B.users.get(1), i, T0 + (i - 2) * INVITE_GAP_MS).ok) ok++;
  assert.equal(ok, INVITE_PER_MIN);
});

test('退出：隊長退出由最早加入的在線隊員接任；剩 1 人解散', () => {
  const B = setup(4);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.do(1, 'inv', { id: 3 }); B.do(3, 'ans', { id: 1, ok: 1 });
  B.do(1, 'inv', { id: 4 }); B.do(4, 'ans', { id: 1, ok: 1 });
  B.offline(2, 'c2', B.now); B.flushT();   // 2 離線：跳過
  B.inbox.clear();
  B.do(1, 'leave');
  const p = B.party(3);
  assert.equal(p.lead, 3); assert.deepEqual(p.mem, [2, 3, 4]);
  assert.equal(B.party(1), null);
  assert.equal(lastPu(B.take(1)).p, null);
  assert.deepEqual(events(B.take(3)), ['leave:1', 'lead:3']);
  B.do(3, 'leave'); B.do(4, 'leave');   // 剩 2（離線）一個人 → 解散
  assert.equal(B.parties.size, 0);
  assert.equal(B.users.get(2), undefined);   // 離線又不在隊伍：不用再記
  assert.deepEqual(B.do(4, 'leave'), { ok: false, error: ERR.NO_PARTY });
});

test('退出：兩人隊有人退出 → 解散，剩下的人收到 disband 與空快照', () => {
  const B = setup(2);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.inbox.clear();
  B.do(2, 'leave');
  assert.equal(B.parties.size, 0);
  const m1 = B.take(1);
  assert.deepEqual(events(m1), ['leave:2', 'disband:1']);
  assert.equal(lastPu(m1).p, null);
  const d = B.drain();
  assert.deepEqual(d.parties, []);
});

test('踢人：只有隊長；可以踢離線的隊員；被踢者 60 秒內不能再被同隊邀請', () => {
  const B = setup(3);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.do(1, 'inv', { id: 3 }); B.do(3, 'ans', { id: 1, ok: 1 });
  assert.deepEqual(B.do(2, 'kick', { id: 3 }), { ok: false, error: ERR.NOT_LEAD });
  assert.deepEqual(B.do(1, 'kick', { id: 1 }), { ok: false, error: ERR.KICK_SELF });
  B.offline(3, 'c3', B.now); B.flushT();
  B.inbox.clear();
  assert.deepEqual(B.do(1, 'kick', { id: 3 }), { ok: true });
  assert.deepEqual(B.party(1).mem, [1, 2]);
  assert.deepEqual(events(B.take(2)), ['kick:3']);
  B.on(3); B.take(3);
  assert.equal(B.users.get(3).pid, null);
  assert.deepEqual(B.do(2, 'inv', { id: 3 }), { ok: false, error: ERR.KICKED });
  B.now += KICK_COOLDOWN_MS;
  assert.deepEqual(B.do(2, 'inv', { id: 3 }), { ok: true });
  // 在線被踢：自己收到 kick 事件與空快照
  B.do(3, 'ans', { id: 2, ok: 1 }); B.inbox.clear();
  B.do(1, 'kick', { id: 3 });
  const m3 = B.take(3);
  assert.deepEqual(events(m3), ['kick:3']);
  assert.equal(lastPu(m3).p, null);
});

test('轉移隊長：只有隊長、對象必須在線', () => {
  const B = setup(3);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.do(1, 'inv', { id: 3 }); B.do(3, 'ans', { id: 1, ok: 1 });
  assert.deepEqual(B.do(2, 'lead', { id: 3 }), { ok: false, error: ERR.NOT_LEAD });
  assert.deepEqual(B.do(1, 'lead', { id: 1 }), { ok: false, error: ERR.LEAD_SELF });
  B.offline(3, 'c3', B.now); B.flushT();
  assert.deepEqual(B.do(1, 'lead', { id: 3 }), { ok: false, error: ERR.LEAD_OFF });
  B.inbox.clear();
  assert.deepEqual(B.do(1, 'lead', { id: 2 }), { ok: true });
  assert.equal(B.party(1).lead, 2);
  const m1 = B.take(1);
  assert.deepEqual(events(m1), ['lead:2']);
  assert.equal(lastPu(m1).p.lead, 2);
  assert.deepEqual(B.do(1, 'kick', { id: 2 }), { ok: false, error: ERR.NOT_LEAD });
});

test('離線不退隊：隊長離線很久也不轉移；隊員仍可退出與邀請', () => {
  const B = setup(4);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.do(1, 'inv', { id: 3 }); B.do(3, 'ans', { id: 1, ok: 1 });
  B.offline(1, 'c1', B.now); B.flushT();
  B.now += 10 * 86_400_000;
  B.cleanup(B.now);
  assert.equal(B.party(2).lead, 1);
  assert.deepEqual(B.party(2).mem, [1, 2, 3]);
  assert.equal(lastPu(B.take(2)).p.mem[0].on, false);
  assert.deepEqual(B.do(2, 'inv', { id: 4 }), { ok: true });
  assert.deepEqual(B.do(2, 'kick', { id: 3 }), { ok: false, error: ERR.NOT_LEAD });
  assert.deepEqual(B.do(3, 'leave'), { ok: true });
  // 隊長回來：仍是隊長
  B.on(1);
  assert.equal(lastPu(B.take(1)).p.lead, 1);
});

test('conn：換頻道時新連線先 online、舊連線後 offline → 忽略，隊伍不閃斷', () => {
  const B = setup(2);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.inbox.clear();
  B.online(info(2, 5, { conn: 'c2b' }), B.now); B.flushT();
  assert.equal(B.offline(2, 'c2', B.now), false);
  B.flushT();
  const u = B.users.get(2);
  assert.equal(u.on, true); assert.equal(u.ch, 5);
  const pu = lastPu(B.take(1));
  assert.deepEqual(pu.p.mem.find(m => m.id === 2), { id: 2, name: 'P2', lv: 12, job: 'novice', ch: 5, z: 0, on: true });
  // 舊連線（頻道 1）收到 stale：前端正在關掉它（或下一個 welcome 會清掉 stale 狀態），不影響新連線
  const st = B.take(2).filter(m => m.k === 'stale');
  assert.deepEqual(st.map(m => [m.ch, m.conn]), [[1, 'c2']]);
});

test('conn：兩處同時連線 → 最後 online 為準，舊連線收到 stale、指令回 stale', () => {
  const B = setup(2);
  B.online(info(1, 3, { conn: 'c1b' }), B.now); B.flushT();
  const st = B.take(1).find(m => m.k === 'stale');
  assert.equal(st.conn, 'c1'); assert.equal(st.ch, 1);   // 送到舊的那條連線
  assert.deepEqual(B.do(1, 'inv', { id: 2 }, 'c1'), { ok: false, error: ERR.STALE });
  assert.deepEqual(B.do(1, 'inv', { id: 2 }, 'c1b'), { ok: true });
  B.offline(1, 'c1b', B.now); B.flushT();
  assert.deepEqual(B.do(1, 'inv', { id: 2 }, 'c1b'), { ok: false, error: ERR.STALE });   // 已經 offline 的連線
});

test('斷線重連：仍在隊伍、快照恢復在線；pu 只送給目前的連線', () => {
  const B = setup(2);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.offline(2, 'c2', B.now); B.flushT();
  assert.equal(lastPu(B.take(1)).p.mem[1].on, false);
  B.online(info(2, 1, { conn: 'c2x' }), B.now); B.flushT();
  const m2 = B.take(2);
  assert.equal(lastPu(m2).conn, 'c2x');
  assert.equal(lastPu(m2).p.mem[1].on, true);
  assert.equal(lastPu(B.take(1)).p.mem[1].on, true);
});

test('loc：地圖／等級變了才推送新快照', () => {
  const B = setup(2);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.inbox.clear();
  assert.equal(B.loc(2, 'c2', { z: 0, lv: 12, job: 'novice' }), false);
  assert.equal(B.loc(2, 'c2', { z: 1, lv: 13, job: 'novice' }), true);
  assert.equal(B.loc(2, 'old', { z: 0 }), false);
  B.flushT();
  const m = lastPu(B.take(1)).p.mem[1];
  assert.equal(m.z, 1); assert.equal(m.lv, 13);
});

/** 模擬 Hub 被回收後重新啟動：把 drain 寫進的 storage 讀回來 */
function storeOf(B) {
  const db = new Map();
  B.applyTo = d => {
    for (const [id, r] of d.parties) { if (r) db.set('p:' + id, r); else db.delete('p:' + id); }
    for (const [uid, r] of d.users) { if (r) db.set('u:' + uid, r); else db.delete('u:' + uid); }
    for (const [to, r] of d.invites) { if (r) db.set('i:' + to, r); else db.delete('i:' + to); }
  };
  return db;
}
function reboot(db, now) {
  const C = setup();
  const rows = k => [...db.entries()].filter(([key]) => key.startsWith(k)).map(([, v]) => JSON.parse(JSON.stringify(v)));
  C.load(rows('p:'), rows('u:'), rows('i:'), now);
  C.now = now;
  return C;
}

test('保存：Hub 被回收後重新啟動，隊伍、在線狀態、待處理邀請都還在', () => {
  const B = setup();
  const db = storeOf(B);
  const orig = B.flushT;
  B.flushT = () => { const d = orig(); B.applyTo(d); return d; };
  for (let i = 1; i <= 3; i++) B.on(i);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.do(1, 'inv', { id: 3 });   // 待處理邀請
  const C = reboot(db, B.now + 1000);
  assert.equal(C.users.get(1).on, true); assert.equal(C.users.get(1).conn, 'c1');
  assert.equal(C.invites.get(3).from, 1);
  assert.deepEqual(C.do(3, 'ans', { id: 1, ok: 1 }), { ok: true });   // 重啟後仍可接受
  assert.deepEqual(C.party(1).mem, [1, 2, 3]);
  // 只有邀請、沒有隊伍的離線玩家：邀請結束後 storage 也刪掉
  const D = setup();
  const db2 = storeOf(D);
  const o2 = D.flushT;
  D.flushT = () => { const d = o2(); D.applyTo(d); return d; };
  D.on(5); D.on(6);
  D.do(5, 'inv', { id: 6 });
  D.offline(5, 'c5', D.now); D.flushT();
  assert.ok(db2.has('u:5') && db2.has('i:6'));
  D.do(6, 'ans', { id: 5, ok: 0 });
  assert.equal(db2.has('i:6'), false);
  assert.equal(db2.has('u:5'), false);
  D.offline(6, 'c6', D.now); D.flushT();
  assert.equal(db2.size, 0);
});

test('sync：重啟後頻道回報恢復；頻道沒回報的玩家（超過寬限）標為離線；2 分鐘沒人確認的「在線」玩家視為離線', () => {
  const B = setup(3);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  // Hub 不知道的玩家（例如資料遺失）：sync 時當作上線
  const C = setup();
  C.sync(1, [info(7)], C.now); C.flushT();
  assert.equal(C.users.get(7).on, true);
  // 頻道 1 下一次回報沒有 3（頻道意外重啟，沒送 offline）
  B.now += SYNC_GRACE_MS + 1;
  B.sync(1, [info(1), info(2)], B.now); B.flushT();
  assert.equal(B.users.has(3), false);
  // 舊連線（conn 不同）的回報不會蓋掉目前的連線
  B.online(info(1, 2, { conn: 'new' }), B.now);
  B.sync(1, [info(2), info(1)], B.now + SYNC_GRACE_MS + 1);
  assert.equal(B.users.get(1).conn, 'new'); assert.equal(B.users.get(1).ch, 2);
  // 頻道 2 從此沒有再回報（例如部署後沒有重連）：2 分鐘後 1 視為離線，隊友收到新快照
  B.flushT(); B.inbox.clear();
  B.sync(1, [info(2)], B.now + GHOST_MS + 10); B.flushT();
  assert.equal(B.users.get(1).on, false);
  assert.equal(B.users.get(1).reaped, true);
  assert.equal(lastPu(B.take(2)).p.mem.find(m => m.id === 1).on, false);
  // 被誤判的玩家其實還在：頻道下一次回報（或發出指令）就恢復
  B.sync(2, [info(1, 2, { conn: 'new' })], B.now + GHOST_MS + 20); B.flushT();
  assert.equal(B.users.get(1).on, true);
  // 真的 offline 過的連線，晚到的 sync 不會讓它復活
  B.offline(2, 'c2', B.now + GHOST_MS + 30);
  B.sync(1, [info(2)], B.now + GHOST_MS + 40);
  assert.equal(B.users.get(2).on, false);
});

test('保存：drain 給出要寫入／刪除的資料，讀回來一致', () => {
  const B = setup(3);
  B.do(1, 'inv', { id: 2 });
  let d = B.last;
  assert.deepEqual(d.parties, []);
  assert.deepEqual(d.invites, [[2, { to: 2, from: 1, ts: B.now }]]);
  B.do(2, 'ans', { id: 1, ok: 1 });
  d = B.last;
  assert.equal(d.parties.length, 1);
  assert.deepEqual(d.invites, [[2, null]]);
  const row = d.parties[0][1];
  assert.deepEqual(row.mem, [1, 2]); assert.equal(row.lead, 1);
  assert.deepEqual(d.users.map(([uid, r]) => [uid, r.pid === row.id, r.on]).sort(), [[1, true, true], [2, true, true]]);
  const C = setup();
  C.load(d.parties.map(x => x[1]), d.users.map(x => x[1]), [], B.now);
  assert.deepEqual(C.snapshot(C.parties.get(row.id)).mem.map(m => [m.id, m.name, m.on]), [[1, 'P1', true], [2, 'P2', true]]);
  B.do(2, 'leave');
  d = B.last;
  assert.deepEqual(d.parties, [[row.id, null]]);
  assert.deepEqual(d.users.map(x => !!x[1]), [true, true]);   // 兩人都還在線：保留在線資料
  B.offline(1, 'c1', B.now); B.offline(2, 'c2', B.now); B.flushT();
  assert.deepEqual(B.last.users.map(x => x[1]), [null, null]);
});

test('保存：讀回壞資料時修正（成員對不上、剩 1 人就解散）', () => {
  const B = setup();
  B.load([{ id: 'a', v: 1, lead: 9, mem: [1, 2, 9] }, { id: 'b', v: 1, lead: 3, mem: [3, 4] }],
    [{ uid: 1, name: 'x', pid: 'a' }, { uid: 2, name: 'y', pid: 'a' }, { uid: 3, name: 'z', pid: 'b' }]);
  assert.deepEqual(B.parties.get('a').mem, [1, 2]);
  assert.equal(B.parties.get('a').lead, 1);
  assert.equal(B.parties.has('b'), false);
  assert.equal(B.users.has(3), false);
  const d = B.drain();
  assert.ok(d.parties.some(([id, r]) => id === 'b' && r === null));
});

test('清理：全隊 30 天沒人上線才刪除（內部維護）', () => {
  const B = setup(2);
  B.do(1, 'inv', { id: 2 }); B.do(2, 'ans', { id: 1, ok: 1 });
  B.offline(1, 'c1', B.now); B.offline(2, 'c2', B.now + 1000); B.flushT();
  assert.equal(B.cleanup(B.now + PARTY_PURGE_MS - 1), 0);
  assert.equal(B.parties.size, 1);
  assert.equal(B.cleanup(B.now + 1000 + PARTY_PURGE_MS), 1);
  assert.equal(B.parties.size, 0);
  assert.equal(B.users.size, 0);
  const d = B.drain();
  assert.equal(d.parties[0][1], null);
  // 有人在線就不刪
  const C = setup(2);
  C.do(1, 'inv', { id: 2 }); C.do(2, 'ans', { id: 1, ok: 1 });
  C.offline(1, 'c1', C.now);
  assert.equal(C.cleanup(C.now + 2 * PARTY_PURGE_MS), 0);
});

test('指令與資料檢查', () => {
  const B = setup(1);
  assert.deepEqual(B.do(1, 'bad', { id: 2 }), { ok: false, error: ERR.BAD });
  assert.deepEqual(B.do(1, 'inv', {}), { ok: false, error: ERR.BAD });
  assert.deepEqual(B.do(1, 'ans', { id: 5, ok: 1 }), { ok: false, error: ERR.NO_INVITE });
  assert.deepEqual(B.do(1, 'kick', { id: 5 }), { ok: false, error: ERR.NO_PARTY });
  // Hub 不認識的玩家發指令：當作上線
  assert.deepEqual(B.do(7, 'leave'), { ok: false, error: ERR.NO_PARTY });
  assert.equal(B.users.get(7).on, true);
  assert.equal(cleanInfo({ uid: 1, ch: 11, conn: 'x' }), null);
  assert.equal(cleanInfo({ uid: 0, ch: 1, conn: 'x' }), null);
  assert.equal(cleanInfo({ uid: 1, ch: 1, conn: '' }), null);
  assert.deepEqual(cleanInfo({ uid: 1, ch: 2, conn: 'x', name: 'n'.repeat(40), lv: 999, job: 'knight', z: 1 }),
    { uid: 1, ch: 2, conn: 'x', name: 'n'.repeat(32), lv: 200, job: 'knight', z: 1 });
});
