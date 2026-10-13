// 大廳（全域只有一個，idFromName('lobby')）：記錄各頻道人數，用來顯示頻道列表與幫剛上線的玩家挑頻道。
// 人數只是參考值（各頻道每 10 秒回報一次，加入／離開時也會立刻回報）；真正的額滿檢查在各頻道自己做。
import { DurableObject } from 'cloudflare:workers';
import { NCH, CAP, LOBBY_STALE_MS } from './config.js';

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.counts = new Map();   // 頻道 → { n: 人數, ts: 回報時間 }（只放記憶體，大廳被回收時各頻道會再回報）
  }

  list() {
    const now = Date.now(), out = [];
    for (let c = 1; c <= NCH; c++) {
      const e = this.counts.get(c);
      out.push(e && now - e.ts < LOBBY_STALE_MS ? e.n : 0);
    }
    return out;
  }

  /** 頻道回報自己的人數，回傳全部頻道的人數 */
  async report(ch, n) {
    if (Number.isInteger(ch) && ch >= 1 && ch <= NCH) this.counts.set(ch, { n: Math.max(0, n | 0), ts: Date.now() });
    return this.list();
  }

  /** 剛上線的玩家：想要的頻道有空位就用它，否則選人數未滿的最小頻道（全滿時回傳 want 或 1，讓頻道回覆「已滿」） */
  async pick(want) {
    const list = this.list();
    if (want >= 1 && want <= NCH && list[want - 1] < CAP) return want;
    for (let c = 1; c <= NCH; c++) if (list[c - 1] < CAP) return c;
    return want >= 1 && want <= NCH ? want : 1;
  }
}
