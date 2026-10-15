// 組隊中心（全域只有一個 Durable Object，idFromName('hub')；第七階段 7-0）
// 隊伍可以跨頻道，所以隊伍、成員與邀請由這裡統一管理；規則在 party.js（PartyBook，可單獨測試）。
//
// 頻道 → 這裡（RPC）：online(info)、offline(uid, conn)、loc(uid, conn, {z, lv, job})、sync(ch, [info...])、cmd(info, op, args)
//   info = { uid, name, lv, job, ch, z, conn }（頻道已經檢查過）
// 這裡 → 頻道（RPC）：Channel.partyPush([[uid, conn, 訊息], ...])，頻道只送給 conn 相同的連線
//
// 保存：隊伍 'p:<id>'、隊員資料 'u:<uid>' 存在 storage（休眠、回收、部署後都還在）；
//       在線狀態與邀請只放記憶體（重新啟動時全部當作離線，由頻道的 online／sync 恢復）。
// 內部維護：有隊伍時每天一次 alarm，刪除全隊 30 天都沒人上線的隊伍。
import { DurableObject } from 'cloudflare:workers';
import { PartyBook, OPS, cleanInfo } from './party.js';
import { NCH } from './config.js';

const CLEANUP_MS = 86_400_000;   // 每天檢查一次
export class PartyHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.book = new PartyBook();
    this.alarmOk = false;          // 已確認清理用的 alarm 存在（避免每次都讀 storage）
    ctx.blockConcurrencyWhile(async () => {
      const ps = await ctx.storage.list({ prefix: 'p:' });
      const us = await ctx.storage.list({ prefix: 'u:' });
      this.book.load([...ps.values()], [...us.values()]);
      const d = this.book.drain();   // 讀取時修正過的資料寫回去（正常情況下是空的）
      this.save(d);
    });
  }

  async online(info) {
    const i = cleanInfo(info);
    if (i) this.book.online(i, Date.now());
    await this.flush();
    return !!i;
  }

  async offline(uid, conn) {
    const r = this.book.offline(uid, conn, Date.now());
    await this.flush();
    return r;
  }

  async loc(uid, conn, d) {
    const r = d && typeof d === 'object' ? this.book.loc(uid, conn, { z: d.z === 1 ? 1 : 0, lv: Number.isInteger(d.lv) ? d.lv : undefined, job: typeof d.job === 'string' ? d.job.slice(0, 16) : undefined }) : false;
    await this.flush();
    return r;
  }

  async sync(ch, list) {
    if (!Number.isInteger(ch) || ch < 1 || ch > NCH || !Array.isArray(list)) return false;
    const clean = list.slice(0, 64).map(cleanInfo).filter(i => i && i.ch === ch);
    this.book.sync(ch, clean, Date.now());
    await this.flush();
    return true;
  }

  async cmd(info, op, args) {
    const i = cleanInfo(info);
    if (!i || !OPS.has(op)) return { ok: false, error: '指令格式錯誤' };
    const r = this.book.cmd(i, op, args || {}, Date.now());
    await this.flush();
    return r;
  }

  /** 測試／除錯用：目前的隊伍數與在線人數 */
  async stats() {
    let on = 0;
    for (const u of this.book.users.values()) if (u.on) on++;
    return { parties: this.book.parties.size, users: this.book.users.size, online: on, invites: this.book.invites.size };
  }

  save(d) {
    const puts = {}, dels = [];
    for (const [id, row] of d.parties) { if (row) puts['p:' + id] = row; else dels.push('p:' + id); }
    for (const [uid, row] of d.users) { if (row) puts['u:' + uid] = row; else dels.push('u:' + uid); }
    const keys = Object.keys(puts);
    for (let k = 0; k < keys.length; k += 100) {
      const part = {};
      for (const key of keys.slice(k, k + 100)) part[key] = puts[key];
      this.ctx.storage.put(part);
    }
    for (let k = 0; k < dels.length; k += 100) this.ctx.storage.delete(dels.slice(k, k + 100));
  }

  /** 寫入 storage、把訊息依頻道分組送出（不等頻道回覆） */
  async flush() {
    const d = this.book.drain();
    this.save(d);
    const by = new Map();
    for (const [ch, conn, uid, msg] of d.push) {
      if (!Number.isInteger(ch) || ch < 1 || ch > NCH) continue;
      if (!by.has(ch)) by.set(ch, []);
      by.get(ch).push([uid, conn, msg]);
    }
    for (const [ch, list] of by) {
      try {
        const stub = this.env.CHANNEL.get(this.env.CHANNEL.idFromName('ch-' + ch));
        stub.partyPush(list).catch(() => { /* 頻道暫時連不上：下一次快照會補上 */ });
      } catch (e) { /* 同上 */ }
    }
    if (this.book.parties.size && !this.alarmOk) {   // 有隊伍時確保每天的清理 alarm 存在
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
      this.alarmOk = true;
    }
  }

  async alarm() {
    this.alarmOk = false;
    this.book.cleanup(Date.now());
    await this.flush();
    if (this.book.parties.size && !this.alarmOk) { await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS); this.alarmOk = true; }
  }
}
