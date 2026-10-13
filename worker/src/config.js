// 即時連線伺服器的共用設定

export const NCH = 10;                 // 頻道數（與 server/app.py 的 CHANNELS 相同）
export const CAP = 20;                 // 每個頻道最多幾人（與 server/app.py 的 CHANNEL_CAP 相同）
export const FLUSH_MS = 100;           // 玩家位置廣播的間隔（每秒最多 10 次，同一段時間內有變化的玩家合併成一則訊息）
export const LOBBY_REPORT_MS = 10_000; // 每個頻道多久向大廳回報一次人數（有人在時）
export const LOBBY_STALE_MS = 25_000;  // 大廳超過這個時間沒收到某頻道的回報，就當作 0 人
export const HELLO_TIMEOUT_MS = 10_000;// 連上後多久內沒有送出票券就斷線
export const CHAT_HISTORY = 20;        // 剛進入頻道時回傳最近幾則聊天
export const CHAT_KEEP = 50;           // 每個頻道保留最近幾則聊天
export const CHAT_KEEP_MS = 10 * 60 * 1000;
export const STATE_RATE = [20, 15];    // 位置回報的令牌桶（每位玩家）：最多連續 20 則，每秒補 15 則（超過的直接丟掉）
export const MSG_MAX = 4096;           // 單一訊息最大長度（字元）

// 允許連線的網頁來源（Origin）。另外可用環境變數 EXTRA_ORIGINS（逗號分隔）增加
export const ORIGINS = new Set(['https://peoplepop.github.io']);
export const ORIGIN_RES = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/,          // 本機開發
  /^https:\/\/([a-z0-9-]+\.)*claude\.ai$/,                             // Claude Artifact
  /^https:\/\/([a-z0-9-]+\.)*claudeusercontent\.com$/,                 // Claude Artifact 的內容網域
];

// WebSocket 關閉代碼（前端依代碼決定要不要重連）
export const CLOSE = {
  BAD: 4000,        // 訊息格式錯誤
  REPLACED: 4001,   // 同一個帳號在別的地方連進同一個頻道
  TICKET: 4002,     // 票券無效或過期 → 前端重新取票券再連
  FULL: 4003,       // 頻道已滿
  TIMEOUT: 4004,    // 連上後太久沒送票券
};
