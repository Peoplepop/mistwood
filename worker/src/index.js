// 晨霧森林 即時連線伺服器（Cloudflare Worker 入口）
//   GET /         健康檢查 {ok, nch, cap, ready}
//   GET /ws?ch=N  WebSocket 連線，轉給頻道 N 的 Durable Object（ch 不帶或 0 = 由大廳挑一個有空位的頻道；
//                 加上 auto=1 代表「想要頻道 N，但滿了可以換別的」）
// 部署方式見 README.md
import { NCH } from './config.js';
import { originAllowed } from './origin.js';

export { Channel } from './channel.js';
export { Lobby } from './lobby.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, name: 'mistwood-rt', nch: NCH, ready: !!env.RT_SECRET });
    }
    if (url.pathname !== '/ws') return json({ error: '找不到這個網址' }, 404);
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: '需要 WebSocket 連線' }, 426);
    if (!originAllowed(request.headers.get('Origin') || '', env)) return json({ error: '不允許的來源網站' }, 403);
    if (!env.RT_SECRET) return json({ error: '伺服器尚未設定 RT_SECRET' }, 503);

    let ch = parseInt(url.searchParams.get('ch') || '0', 10);
    if (!(ch >= 1 && ch <= NCH) || url.searchParams.get('auto') === '1') {
      try {
        ch = await env.LOBBY.get(env.LOBBY.idFromName('lobby')).pick(ch >= 1 && ch <= NCH ? ch : 0);
      } catch (e) {
        if (!(ch >= 1 && ch <= NCH)) ch = 1;
      }
    }
    const headers = new Headers(request.headers);
    headers.set('X-Mistwood-Ch', String(ch));
    const stub = env.CHANNEL.get(env.CHANNEL.idFromName('ch-' + ch));
    return stub.fetch(new Request(request.url, { method: 'GET', headers }));
  },
};
