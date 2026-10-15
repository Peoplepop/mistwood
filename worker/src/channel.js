// 頻道（每個頻道一個 Durable Object，idFromName('ch-N')，N = 1～10）
// 6-1：玩家位置／動作／表情廣播、頻道聊天。
// 6-2：伺服器權威的一般怪物（見下方「怪物」與 mobworld.js）：有活躍玩家時 10 Hz 模擬，沒人時停止、休眠。
// 6-3：伺服器權威的 Boss（霧之守衛）：同一個 tick，全頻道共鬥、HP 依人數加成（規則見 mobworld.js 開頭）。
//
// 使用 WebSocket Hibernation API（ctx.acceptWebSocket）：一段時間沒有訊息時物件會休眠、不計費，
// 連線不會中斷；醒來時建構子會依每條連線的 attachment 重建玩家清單。
//
// 訊息格式（JSON 文字；另有純文字 'ping' → 'pong' 由平台自動回覆、不會喚醒物件）
//   前端 → 伺服器
//     {t:'hello', ticket, s:{狀態}, ms?, bs?}  連上後第一則：票券＋自己的狀態；ms／bs = 前端的怪物／Boss 資料指紋
//                                         （6-3：兩個都和伺服器相同才使用伺服器的 Boss；舊版前端沒有，照舊打本機 Boss）
//     {t:'s', x, y, f, st, ak, ad, an, job, lv, eq, em, en, hp?, e?}   狀態有變化時回報（每秒最多約 10 次）
//                                         hp = HP 百分比、e = 技能／攻擊／受傷的特效事件（格式見 fx.js；舊版前端沒有這兩個欄位）
//     {t:'chat', q, text}                 聊天（q = 前端自訂的請求編號，回覆時帶回）
//     {t:'h', h:[[怪物 id, 傷害, 方向, 爆擊?1:0, 緩速秒數?], ...]}   打中伺服器的怪物（6-2）／Boss（6-3）
//     {t:'p', q, op, id?, ok?}            隊伍指令（第七階段；hello 帶 pty:1 的前端才能用）：
//                                         inv 邀請／ans 回覆邀請（ok 1/0）／leave 退出／kick 踢人／lead 轉移隊長
//   伺服器 → 前端
//     {t:'welcome', ch, nch, cap, me, name, lv, online, total, chans, players, chat, now, mobs, msig, boss, bsig, party}
//                                         party = 組隊協定版本（0 = 不支援，前端隱藏組隊功能；第七階段）
//                                         mobs = 怪物同步的協定版本（0 = 不支援，前端用本機怪物）、msig = 怪物資料指紋
//                                         boss = Boss 同步的協定版本（0 = 不支援，前端用本機 Boss）、bsig = Boss 資料指紋
//     {t:'m', n, u, g?, e?}               怪物快照（只送有變化、左右約 1500 內的怪；格式見 mobworld.js／index.html 的 MN；
//                                         e 裡也有別人打怪的傷害數字 [id, 5, 傷害, 爆擊]，不會送給出手的人自己）
//     {t:'k', id, x, l, c?, n?}           擊殺結算：只送給有出力的人，x = 分到的經驗值，l = 1 代表最後一擊
//                                         Boss 另有 c = 1 算討伐（擊殺數、任務、掉寶）／0 只拿經驗值、n = 參戰人數
//     {t:'ps', now, players}              有變化的玩家（格式同 HTTP 版 /api/presence 的 players，另有 hp；
//                                         附近玩家的特效事件放在 players[i].e，只送給同一張地圖左右 1500 內的人）
//     {t:'leave', id}                     玩家離開頻道
//     {t:'chat', msg:{id, uid, name, text, ts}}
//     {t:'chans', chans, online, total}   各頻道人數有變化
//     {t:'r', q, ok, msg?, error?}        回覆聊天請求／隊伍指令
//     {t:'pu', p} {t:'pi', ...} {t:'pe', ...}   隊伍快照／收到邀請／隊伍事件（由 PartyHub 經 partyPush 送來，格式見 party.js 與 docs/PHASE7.md）
//     {t:'err', code, msg}                錯誤（之後伺服器會關閉連線，關閉代碼見 config.js 的 CLOSE）
import { DurableObject } from 'cloudflare:workers';
import {
  NCH, CAP, FLUSH_MS, LOBBY_REPORT_MS, HELLO_TIMEOUT_MS, CHAT_HISTORY, CHAT_KEEP, CHAT_KEEP_MS,
  STATE_RATE, MSG_MAX, CLOSE,
} from './config.js';
import { verifyTicket } from './ticket.js';
import { parseState } from './state.js';
import { prepareChat, CHAT_GAP_MS, CHAT_BURST, CHAT_BURST_WINDOW_MS } from './chat.js';
import { MobWorld, MOB_PROTO, MOB_SIG, BOSS_PROTO, BOSS_SIG, ACTIVE_MS, maxHit } from './mobworld.js';
import { parseFx, psPlayersFor, FX_QUEUE, FX_RATE } from './fx.js';
import { PARTY_PROTO, OPS as PARTY_OPS } from './party.js';
import { FROST_X } from './mobs.gen.js';

// ---- 怪物（6-2） ----
const MOB_SYNC = true;         // false = 不提供伺服器怪物（welcome 的 mobs = 0，前端照舊用本機怪物）
const BOSS_SYNC = true;        // false = 不提供伺服器 Boss（welcome 的 boss = 0，前端照舊在本機打 Boss；6-3）
const TICK_MS = 100;           // 怪物模擬與快照的間隔（10 Hz）
const IDLE_STOP_MS = 5000;     // 沒有活躍玩家（附近沒有需要模擬的怪）超過這個時間就停止 tick，讓物件可以休眠
const HIT_RATE = [48, 24];     // 命中的令牌桶（每位玩家）：最多連續 48 次，每秒補 24 次（超過的命中直接丟掉）
const HITS_PER_MSG = 24;       // 一則訊息最多幾次命中

// ---- 組隊（第七階段） ----
const PARTY_SYNC = true;       // false = 不提供組隊（welcome 的 party = 0，前端隱藏組隊功能；已在隊伍中的資料保留在 PartyHub）
const PARTY_RATE = [6, 1];     // 隊伍指令的令牌桶（每位玩家）：最多連續 6 次，每秒補 1 次
const PARTY_SYNC_EVERY = 3;    // 每幾次定時工作（10 秒一次）向 PartyHub 回報一次在線的組隊玩家（= 30 秒）
const zoneOf = x => (x >= FROST_X ? 1 : 0);
const newConn = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

const fxFields = () => ({ ev: [], etok: FX_RATE[0], etMs: Date.now() });
const partyFields = () => ({ ptok: PARTY_RATE[0], ptMs: Date.now() });
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
    // 6-2：怪物（第一次需要時才建立；休眠前把狀態存到 storage，醒來時接著用）
    this.world = null;
    this.mobSave = null;
    this.tickTimer = null;
    this.lastTick = 0;
    this.idleMs = 0;
    this.partyOn = PARTY_SYNC && !!env.PARTY;   // wrangler.toml 沒有 PARTY binding（例如舊設定）時自動關閉
    this.syncN = 0;

    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.ch = (await ctx.storage.get('ch')) || 0;
      this.chat = (await ctx.storage.get('chat')) || [];
      this.lastId = (await ctx.storage.get('lastId')) || 0;
      this.mobSave = (await ctx.storage.get('mobs')) || null;
    });
    // 從休眠醒來：依每條連線的 attachment 重建玩家清單
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.uid) this.players.set(a.uid, { ...a, ws, chatTs: [], tok: STATE_RATE[0], tokMs: Date.now(), ...this.mobFields(a.bo), ...fxFields(), ...partyFields() });
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
    else if (d.t === 'h') this.onHits(P, d);
    else if (d.t === 'chat') this.onChat(P, d);
    else if (d.t === 'p') await this.onParty(P, d);
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
    if (P.pty) this.hubCall(h => h.offline(P.uid, P.conn));
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
    const bo = !!(MOB_SYNC && BOSS_SYNC && d.ms === MOB_SIG && d.bs === BOSS_SIG);   // 這位玩家使用伺服器的 Boss
    const pty = this.partyOn && d.pty === 1;   // 前端支援組隊（舊版前端沒有 pty：不能組隊、不會被邀請）
    const P = { ws, uid: tk.uid, name: tk.name, lvmax: tk.lvmax, s, emMs: s.em >= 0 ? now : 0, ts: now, bo,
      pty, conn: pty ? newConn() : '', pid: null, pm: [],
      chatTs: [], tok: STATE_RATE[0], tokMs: now, ...this.mobFields(bo), ...fxFields(), ...partyFields() };
    this.players.set(P.uid, P);
    this.persist(P);
    const others = [];
    for (const Q of this.players.values()) if (Q !== P) others.push(this.playerJson(Q, now));
    await this.reportLobby(true);
    send(ws, {
      t: 'welcome', ch: this.ch, nch: NCH, cap: CAP, me: P.uid, name: P.name, lv: s.lv,
      online: this.players.size, total: this.total(), chans: this.chanList(),
      players: others, chat: this.recentChat(now), now: Date.now(),
      mobs: MOB_SYNC ? MOB_PROTO : 0, msig: MOB_SYNC ? MOB_SIG : '',
      boss: MOB_SYNC && BOSS_SYNC ? BOSS_PROTO : 0, bsig: MOB_SYNC && BOSS_SYNC ? BOSS_SIG : '',
      party: this.partyOn ? PARTY_PROTO : 0,
    });
    if (pty) this.hubCall(h => h.online(this.partyInfo(P)));   // welcome 之後才送（隊伍快照一定比 welcome 晚到）
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
    const old = P.s;
    P.s = s; P.ts = now;
    if (P.pty && (zoneOf(old.x) !== zoneOf(s.x) || old.lv !== s.lv || old.job !== s.job)) {   // 隊友的隊伍視窗要更新
      this.hubCall(h => h.loc(P.uid, P.conn, { z: zoneOf(s.x), lv: s.lv, job: s.job }));
    }
    this.onFx(P, d.e, now);
    this.persist(P);
    this.markDirty(P.uid);
    this.startTick();   // 有人在動：怪物要開始（繼續）模擬
  }

  /** 休眠前需要保留的資料放在連線的 attachment（上限 2KB） */
  persist(P) {
    P.ws.serializeAttachment({ uid: P.uid, name: P.name, lvmax: P.lvmax, s: P.s, emMs: P.emMs, ts: P.ts, bo: P.bo,
      pty: P.pty, conn: P.conn, pid: P.pid, pm: P.pm });
  }

  playerJson(P, now) {
    const s = P.s;
    const j = {
      id: P.uid, name: P.name, x: s.x, y: s.y, f: s.f, st: s.st, ak: s.ak, ad: s.ad, an: s.an, job: s.job, lv: s.lv,
      eq: s.eq, em: s.em, en: s.en, ea: s.em >= 0 ? Math.max(0, now - P.emMs) : null, ts: P.ts,
    };
    if (s.hp >= 0) j.hp = s.hp;
    return j;
  }

  /** 技能／攻擊／受傷的特效事件：檢查、限制頻率後先存起來，下一次廣播時送給附近的玩家（純裝飾） */
  onFx(P, list, now) {
    if (!Array.isArray(list) || !list.length) return;
    P.etok = Math.min(FX_RATE[0], P.etok + (now - P.etMs) / 1000 * FX_RATE[1]);
    P.etMs = now;
    for (const e of parseFx(list, P.s.job)) {
      if (P.etok < 1 || P.ev.length >= FX_QUEUE) break;   // 太頻繁：之後的事件丟掉
      P.etok -= 1;
      P.ev.push(e);
    }
  }

  markDirty(uid) {
    this.dirty.add(uid);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** 把這段時間內有變化的玩家合併成一則訊息廣播給整個頻道 */
  flush() {
    this.flushTimer = null;
    if (!this.dirty.size) return;
    const now = Date.now(), items = [];
    for (const uid of this.dirty) {
      const P = this.players.get(uid);
      if (P) { items.push({ uid, s: P.s, j: this.playerJson(P, now), ev: P.ev }); P.ev = []; }
    }
    this.dirty.clear();
    if (!items.length) return;
    const players = items.map(it => it.j);
    if (!items.some(it => it.ev.length)) { this.broadcast({ t: 'ps', now, players }); return; }
    // 有特效事件：只有附近的玩家收到事件，其他人收到一樣的位置廣播
    const plain = JSON.stringify({ t: 'ps', now, players });
    for (const Q of this.players.values()) {
      const list = psPlayersFor(items, Q);
      send(Q.ws, list ? { t: 'ps', now, players: list } : plain);
    }
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
    if (++this.syncN % PARTY_SYNC_EVERY === 0) this.partySync();
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + LOBBY_REPORT_MS);
  }

  // ---------- 怪物（6-2） ----------
  // 有活躍玩家時每 TICK_MS 模擬一次：只模擬活躍玩家附近的怪，然後依每位玩家左右約 1500px 的範圍送出有變化的怪物。
  // 沒有活躍玩家超過 IDLE_STOP_MS（或最後一位離開）就停止 tick 並保存怪物狀態，讓物件可以休眠；有人動了再繼續。
  mobFields(bo) {
    return { mv: { mk: new Map(), bo: !!bo }, htok: HIT_RATE[0], htMs: Date.now() };
  }

  ensureWorld() {
    if (!this.world) {
      this.world = new MobWorld();
      if (this.mobSave) this.world.load(this.mobSave);
      this.mobSave = null;
    }
    return this.world;
  }

  startTick() {
    if (!MOB_SYNC || this.tickTimer || !this.players.size) return;
    this.ensureWorld();
    this.lastTick = Date.now(); this.idleMs = 0;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  stopTick() {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer); this.tickTimer = null;
    if (this.world) this.ctx.storage.put('mobs', this.world.dump()).catch(() => {});
  }

  mobPlayers(now) {
    const list = [];
    for (const P of this.players.values()) {
      list.push({ uid: P.uid, x: P.s.x, y: P.s.y, dead: P.s.st === 'dead', active: now - P.ts < ACTIVE_MS, bo: !!P.bo });
    }
    return list;
  }

  tick() {
    const now = Date.now(), dt = Math.min(0.25, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    const W = this.ensureWorld();
    const n = W.step(dt, this.mobPlayers(now), now);
    for (const P of this.players.values()) {
      const msg = W.view(P.mv, P.s.x, now, P.uid);
      if (msg) send(P.ws, msg);
    }
    W.events = [];
    this.idleMs = n > 0 ? 0 : this.idleMs + dt * 1000;
    if (this.idleMs > IDLE_STOP_MS || !this.players.size) this.stopTick();
  }

  /** 打中怪物：檢查（怪還活著、距離、傷害上限、出手頻率）後扣血；打死時把經驗值分給每位有出力的人 */
  onHits(P, d) {
    if (!MOB_SYNC || !Array.isArray(d.h)) return;
    const now = Date.now(), W = this.ensureWorld();
    this.startTick();
    P.htok = Math.min(HIT_RATE[0], P.htok + (now - P.htMs) / 1000 * HIT_RATE[1]);
    P.htMs = now;
    const pl = { uid: P.uid, x: P.s.x, y: P.s.y, dead: P.s.st === 'dead', bo: !!P.bo };
    const cap = maxHit(P.s.lv, P.s.job);
    for (const h of d.h.slice(0, HITS_PER_MSG)) {
      if (P.htok < 1) break;   // 太頻繁：之後的命中丟掉
      P.htok -= 1;
      const r = W.hit(pl, h, cap, now);
      if (!r.kill) continue;
      const K = r.kill;
      for (const [uid, x] of K.exp) {
        const Q = this.players.get(uid);
        if (!Q) continue;
        const msg = { t: 'k', id: K.id, x, l: uid === K.last ? 1 : 0 };
        if (K.boss) { msg.c = K.credit.has(uid) ? 1 : 0; msg.n = K.nf; }
        send(Q.ws, msg);
      }
    }
  }

  // ---------- 組隊（第七階段） ----------
  // 隊伍狀態在 PartyHub（全域一個）；這裡只轉送指令、在線狀態，並把 Hub 送來的訊息交給玩家。
  // Hub 連不上時指令回「隊伍伺服器忙碌」，打怪、聊天、Boss 都不受影響。
  hub() { return this.env.PARTY.get(this.env.PARTY.idFromName('hub')); }

  /** 呼叫 Hub、不等結果（online／offline／loc／sync） */
  hubCall(fn) {
    if (!this.partyOn) return;
    try { Promise.resolve(fn(this.hub())).catch(() => {}); } catch (e) { /* Hub 暫時連不上 */ }
  }

  partyInfo(P) {
    return { uid: P.uid, name: P.name, lv: P.s.lv, job: P.s.job, ch: this.ch, z: zoneOf(P.s.x), conn: P.conn };
  }

  /** 每 30 秒回報目前在線的組隊玩家（Hub 重啟後靠這個恢復；也讓 Hub 清掉沒送 offline 就消失的玩家） */
  partySync() {
    if (!this.partyOn || !this.ch) return;
    const list = [];
    for (const P of this.players.values()) if (P.pty) list.push(this.partyInfo(P));
    if (list.length) this.hubCall(h => h.sync(this.ch, list));
  }

  async onParty(P, d) {
    const q = Number.isInteger(d.q) ? d.q : 0;
    const reply = o => send(P.ws, { t: 'r', q, ...o });
    if (!this.partyOn || !P.pty) { reply({ ok: false, error: '組隊功能尚未開放' }); return; }
    const now = Date.now();
    P.ptok = Math.min(PARTY_RATE[0], P.ptok + (now - P.ptMs) / 1000 * PARTY_RATE[1]);
    P.ptMs = now;
    if (P.ptok < 1) { reply({ ok: false, error: '操作太頻繁了，請稍等一下' }); return; }
    P.ptok -= 1;
    const op = d.op, id = Number.isInteger(d.id) && d.id > 0 ? d.id : 0;
    if (!PARTY_OPS.has(op) || (op !== 'leave' && !id)) { reply({ ok: false, error: '指令格式錯誤' }); return; }
    if (op === 'inv') {   // 同頻道的舊版前端：直接告訴邀請者原因
      const T = this.players.get(id);
      if (T && !T.pty) { reply({ ok: false, error: '對方的遊戲版本較舊，無法組隊（請對方重新整理網頁）' }); return; }
    }
    let r;
    try { r = await this.hub().cmd(this.partyInfo(P), op, { id, ok: d.ok === 1 || d.ok === true }); } catch (e) { r = null; }
    if (!r || typeof r !== 'object') reply({ ok: false, error: '隊伍伺服器忙碌，請稍後再試' });
    else reply(r.ok ? { ok: true } : { ok: false, error: String(r.error || '操作失敗') });
  }

  /** Hub 送來的訊息：[[uid, conn, 訊息], ...]，只送給 conn 相同的連線；隊伍快照順便記在 attachment（7-2 經驗共享用） */
  async partyPush(list) {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const item of list) {
      if (!Array.isArray(item)) continue;
      const [uid, conn, msg] = item;
      const P = this.players.get(uid);
      if (!P || !P.pty || (conn && P.conn !== conn) || !msg || typeof msg !== 'object') continue;
      if (msg.t === 'pu') {
        P.pid = msg.p ? msg.p.id : null;
        P.pm = msg.p && Array.isArray(msg.p.mem) ? msg.p.mem.map(m => m.id) : [];
        this.persist(P);
      }
      send(P.ws, msg);
      n++;
    }
    return n;
  }
}
