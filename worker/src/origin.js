// 檢查 WebSocket 連線的來源網站（Origin）
import { ORIGINS, ORIGIN_RES } from './config.js';

export function originAllowed(origin, env) {
  if (!origin) return false;   // 瀏覽器一定會帶 Origin；沒有的就不是遊戲網頁
  if (ORIGINS.has(origin) || ORIGIN_RES.some(re => re.test(origin))) return true;
  const extra = (env && env.EXTRA_ORIGINS) || '';
  return extra.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean).includes(origin);
}
