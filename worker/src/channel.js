// 頻道（每個頻道一個 Durable Object，idFromName('ch-N')，N = 1～10）
// 6-1：玩家位置／動作／表情廣播、頻道聊天。6-2 起會在這裡加上伺服器權威的怪物（見下方「怪物（6-2 預留）」）。
//
// 使用 WebSocket Hibernation API（ctx.acceptWebSocket）：一段時間沒有訊息時物件會休眠、不計費，
// 連線不會中斷；醒來時建構子會依每條連線的 attachment 重建玩家清單。
//
// 訊息格式（JSON 文字；另有純文字 'ping' → 'pong' 由平台自動回覆、不會喚醒物件）
//   前端 → 伺服器
//     {t:'hello', ticket, s:{狀態}}       連上後第一則：票券＋自己的狀態
//     {t:'s', x, y, f, st, ak, ad, an, job, lv, eq, em, en}   狀態有變化時回報（每秒最多約 10 次）
//     {t:'chat', q, text}                 聊天（q = 前端自訂的請求編號，回覆時帶回）
//   伺服器 → 前端
//     {t:'welcome', ch, nch, cap, me, name, lv, online, total, chans, players, chat, now}
//     {t:'ps', now, players}              有變化的玩家（格式同 HTTP 版 /api/presence 的 players）
//     {t:'leave', id}                     玩家離開頻道
//     {t:'chat', msg:{id, uid, name, text, ts}}
//     {t:'chans', chans, online, total}   各頻道人數有變化
//     {t:'r', q, ok, msg?, error?}        回覆聊天請求
//     {t:'err', code, msg}                錯誤（之後伺服器會關閉連線，關閉代碼見 config.js 的 CLOSE）
import { DurableObject } from 'cloudflare:workers';
import {
  NCH, CAP, FLUSH_MS, LOBBY_REPORT_MS, HELLO_TIMEOUT_MS, CHAT_HISTORY, CHAT_KEEP, CHAT_KEEP_MS,
  STATE_RATE, MSG_MAX, CLOSE,
} from './config.js';
import { verifyTicket } from './ticket.js';
import { parseState } from './state.js';
import { prepareChat, CHAT_GAP_MS, CHAT_BURST, CHAT_BURST_WINDOW_MS } from './chat.js';

// ---- 怪物（6-2 預留） ----
const MOB_SYNC = false;        // 6-2 實作伺服器權威怪物後改成 true
const TICK_MS = 100;           // 怪物模擬的間隔（10 Hz）

const send = (ws, obj) => { try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (e) { /* 連線已關閉 */ } };

export class Channel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ch = 0;                 // 頻道編號（第一次連線時由 Worker 傳入，存在 storage）
    this.players = new Map();    // uid → 玩家 { ws, uid, name, lvmax, s: 狀態, emMs, ts, chatTs: [], tok, tokMs }
    this.dirty = new Set();      // 等待廣播的玩家 uid
    this.flushTimer = null;
    this.chat = [];              // 最近的聊天（也存在 storage，休眠醒來後還在）
    this.lastId = 0;             // 聊天訊息編號（每個頻道遞增；用毫秒時間當起點，頻道之間幾乎不會重複）
    this.chans = [];             // 大廳回報的各頻道人數
    this.chansSent = '';         // 上一次廣播給玩家的頻道人數（有變化才再廣播）
    // 6-2 預留：怪物狀態與 tick
    this.mobs = new Map();       // 怪物 id → { kind, x, y, hp, ... }
    this.tickTimer = null;
    this.lastTick = 0;

    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.ch = (await ctx.storage.get('ch')) || 0;
      this.chat = (await ctx.storage.get('chat')) || [];
      this.lastId = (await ctx.storage.get('lastId')) || 0;
    });
    // 從休眠醒來：依每條連線的 attachment 重建玩家清單
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.uid) this.players.set(a.uid, { ...a, ws, chatTs: [], tok: STATE_RATE[0], tokMs: Date.now() });
    }
  }

  // ---------- 連線 ----------
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('需要 WebSocket', { status: 426 });
    const ch = parseInt(request.headers.get('X-Mistwood-Ch') || '0', 10);
    if (ch >= 1 && ch <= NCH && ch !== this.ch) { this.ch = ch; await this.ctx.storage.put('ch', ch); }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pending: true, at: Date.now() });
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MSG_MAX) return;
    let d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || typeof d !== 'object') return;
    const a = ws.deserializeAttachment() || {};
    if (!a.uid) {   // 還沒驗證：第一則一定要是 hello
      if (d.t === 'hello') await this.onHello(ws, d);
      else this.reject(ws, CLOSE.BAD, 'bad', '請先送出連線票券');
      return;
    }
    const P = this.players.get(a.uid);
    if (!P || P.ws !== ws) { this.reject(ws, CLOSE.REPLACED, 'replaced', '這個帳號已在其他地方連線'); return; }
    if (d.t === 's') this.onState(P, d);
    else if (d.t === 'chat') this.onChat(P, d);
  }

  async webSocketClose(ws, code) {
    this.drop(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* 已經關閉 */ }
  }

  async webSocketError(ws) { this.drop(ws); }

  reject(ws, code, kind, msg) {
    send(ws, { t: 'err', code: kind, msg });
    try { ws.close(code, kind); } catch (e) { /* 已經關閉 */ }
    this.drop(ws);
  }

  drop(ws) {
    const a = ws.deserializeAttachment();
    if (!a || !a.uid) return;
    const P = this.players.get(a.uid);
    if (!P || P.ws !== ws) return;
    this.players.delete(a.uid);
    this.dirty.delete(a.uid);
    this.broadcast({ t: 'leave', id: a.uid });
    this.reportLobby();
    if (!this.players.size) this.stopTick();
  }

  // ---------- 加入頻道 ----------
  async onHello(ws, d) {
    const tk = await verifyTicket(d.ticket, this.env.RT_SECRET);
    if (!tk) { this.reject(ws, CLOSE.TICKET, 'ticket', '連線票券無效或已過期'); return; }
    const s = parseState(d.s, tk.lvmax);
    if (!s) { this.reject(ws, CLOSE.BAD, 'bad', '角色狀態格式錯誤'); return; }
    const old = this.players.get(tk.uid);
    if (!old && this.players.size >= CAP) {
      this.reject(ws, CLOSE.FULL, 'full', `頻道 ${this.ch} 已滿（${CAP} 人），請選擇其他頻道`);
      return;
    }
    if (old) {   // 同一個帳號重新連進來（例如斷線重連、開了第二個分頁）：舊的連線踢掉
      this.players.delete(tk.uid);
      this.reject(old.ws, CLOSE.REPLACED, 'replaced', '這個帳號已在其他地方連線');
    }
    const now = Date.now();
    const P = { ws, uid: tk.uid, name: tk.name, lvmax: tk.lvmax, s, emMs: s.em >= 0 ? now : 0, ts: now,
      chatTs: [], tok: STATE_RATE[0], tokMs: now };
    this.players.set(P.uid, P);
    this.persist(P);
    const others = [];
    for (const Q of this.players.values()) if (Q !== P) others.push(this.playerJson(Q, now));
    await this.reportLobby(true);
    send(ws, {
      t: 'welcome', ch: this.ch, nch: NCH, cap: CAP, me: P.uid, name: P.name, lv: s.lv,
      online: this.players.size, total: this.total(), chans: this.chanList(),
      players: others, chat: this.recentChat(now), now: Date.now(),
    });
    this.broadcastChans(P);  // 其他玩家：頻道人數 +1
    this.markDirty(P.uid);   // 其他玩家會在下一次廣播看到新玩家
    this.startTick();
  }

  // ---------- 玩家狀態 ----------
  onState(P, d) {
    const now = Date.now();
    P.tok = Math.min(STATE_RATE[0], P.tok + (now - P.tokMs) / 1000 * STATE_RATE[1]);
    P.tokMs = now;
    if (P.tok < 1) return;   // 太頻繁：丟掉
    P.tok -= 1;
    const s = parseState(d, P.lvmax);
    if (!s) return;
    if (s.en !== P.s.en) P.emMs = s.em >= 0 ? now : 0;   // 表情序號有變才更新開始時間
    P.s = s; P.ts = now;
    this.persist(P);
    this.markDirty(P.uid);
  }

  /** 休眠前需要保留的資料放在連線的 attachment（上限 2KB） */
  persist(P) {
    P.ws.serializeAttachment({ uid: P.uid, name: P.name, lvmax: P.lvmax, s: P.s, emMs: P.emMs, ts: P.ts });
  }

  playerJson(P, now) {
    const s = P.s;
    return {
      id: P.uid, name: P.name, x: s.x, y: s.y, f: s.f, st: s.st, ak: s.ak, ad: s.ad, an: s.an, job: s.job, lv: s.lv,
      eq: s.eq, em: s.em, en: s.en, ea: s.em >= 0 ? Math.max(0, now - P.emMs) : null, ts: P.ts,
    };
  }

  markDirty(uid) {
    this.dirty.add(uid);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** 把這段時間內有變化的玩家合併成一則訊息廣播給整個頻道 */
  flush() {
    this.flushTimer = null;
    if (!this.dirty.size) return;
    const now = Date.now(), players = [];
    for (const uid of this.dirty) { const P = this.players.get(uid); if (P) players.push(this.playerJson(P, now)); }
    this.dirty.clear();
    if (players.length) this.broadcast({ t: 'ps', now, players });
  }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const P of this.players.values()) send(P.ws, text);
  }

  // ---------- 聊天 ----------
  onChat(P, d) {
    const q = Number.isInteger(d.q) ? d.q : 0;
    const reply = o => send(P.ws, { t: 'r', q, ...o });
    const now = Date.now();
    const c = prepareChat(d.text);
    if (c.error) { reply({ ok: false, error: c.error }); return; }
    P.chatTs = P.chatTs.filter(t => now - t < CHAT_BURST_WINDOW_MS);
    if (P.chatTs.length && now - P.chatTs[P.chatTs.length - 1] < CHAT_GAP_MS) { reply({ ok: false, error: '說話太快了，請稍等一下' }); return; }
    if (P.chatTs.length >= CHAT_BURST) { reply({ ok: false, error: `訊息太多了，請 ${CHAT_BURST_WINDOW_MS / 1000} 秒後再說` }); return; }
    P.chatTs.push(now);
    this.lastId = Math.max(this.lastId + 1, now);
    const msg = { id: this.lastId, uid: P.uid, name: P.name, text: c.text, ts: now };
    this.chat.push(msg);
    this.chat = this.chat.filter(m => now - m.ts < CHAT_KEEP_MS).slice(-CHAT_KEEP);
    this.ctx.storage.put({ chat: this.chat, lastId: this.lastId });
    reply({ ok: true, msg });
    this.broadcast({ t: 'chat', msg });
  }

  recentChat(now) {
    return this.chat.filter(m => now - m.ts < CHAT_KEEP_MS).slice(-CHAT_HISTORY);
  }

  // ---------- 頻道人數（大廳） ----------
  total() { return this.chanList().reduce((a, b) => a + b, 0); }

  chanList() {
    const list = [];
    for (let c = 1; c <= NCH; c++) list.push(c === this.ch ? this.players.size : (this.chans[c - 1] || 0));
    return list;
  }

  /** 向大廳回報人數並取回全部頻道的人數；有變化就廣播給頻道內的玩家（quiet = 不廣播） */
  async reportLobby(quiet = false) {
    if (!this.ch) return;
    if (!quiet) this.broadcastChans();   // 自己頻道的人數先廣播，不用等大廳回覆
    try {
      const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
      const list = await lobby.report(this.ch, this.players.size);
      if (Array.isArray(list)) this.chans = list;
    } catch (e) { /* 大廳暫時連不上：沿用舊的人數 */ }
    if (!quiet) this.broadcastChans();
  }

  /** 頻道人數和上次廣播的不同才廣播（skip = 不用送給這位玩家，例如剛在 welcome 拿到人數的新玩家） */
  broadcastChans(skip = null) {
    const list = this.chanList(), key = list.join();
    if (key === this.chansSent) return;
    this.chansSent = key;
    const text = JSON.stringify({ t: 'chans', chans: list, online: this.players.size, total: this.total() });
    for (const P of this.players.values()) if (P !== skip) send(P.ws, text);
  }

  // ---------- 定時工作（每 10 秒；沒有任何連線時停止） ----------
  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LOBBY_REPORT_MS);
  }

  async alarm() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {   // 連上後太久沒送票券
      const a = ws.deserializeAttachment();
      if (a && a.pending && now - a.at > HELLO_TIMEOUT_MS) this.reject(ws, CLOSE.TIMEOUT, 'timeout', '連線逾時');
    }
    await this.reportLobby();
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + LOBBY_REPORT_MS);
  }

  // ---------- 怪物（6-2 預留） ----------
  // 6-2 規劃：第一位玩家加入時開始 tick（TICK_MS），只模擬有玩家所在區域的怪；最後一位離開時停止，讓物件可以休眠。
  // 每次 tick：更新怪物 AI／重生 → 依每位玩家左右約 1500px 的興趣範圍送出怪物快照 {t:'mobs', ...}。
  // 命中訊息 {t:'hit', ...} 會在 webSocketMessage 加一個分支，依票券的等級／職業檢查傷害上限。
  startTick() {
    if (!MOB_SYNC || this.tickTimer) return;
    this.lastTick = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  stopTick() {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  tick() {
    const now = Date.now(), dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    void dt;   // 6-2：在這裡更新 this.mobs 並廣播快照
  }
}
