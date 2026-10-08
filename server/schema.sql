-- 晨霧森林 後端資料表（SQLite）
-- app.py 第一次連線到資料庫時會自動執行這個檔案；
-- 全部使用 IF NOT EXISTS，所以重複執行也不會影響既有資料。
-- 注意：舊版資料庫的 saves 表已經存在，CREATE TABLE IF NOT EXISTS 不會補新欄位，
--       新欄位由 app.py 的 migrate_db() 用 ALTER TABLE 自動補上（新欄位的索引也要放在那裡建）。

-- 玩家帳號：帳號名稱不分大小寫（COLLATE NOCASE），密碼只存雜湊值
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

-- 登入 token：只存 token 的雜湊值（資料庫外洩也無法直接拿來登入）
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,   -- Unix 時間（秒）
  expires_at INTEGER NOT NULL    -- Unix 時間（秒）
);

-- 雲端存檔：每個帳號一份。
-- level / kills / gold / job / boss_kills 是伺服器從存檔 JSON 解析出來的排行榜數值。
-- flagged = 1 表示存檔沒通過合理性檢查（資料照樣保存，但不列入排行榜），原因寫在 flag_reason。
CREATE TABLE IF NOT EXISTS saves (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        TEXT    NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1,
  kills       INTEGER NOT NULL DEFAULT 0,
  gold        INTEGER NOT NULL DEFAULT 0,
  job         TEXT    NOT NULL DEFAULT 'novice',
  updated_at  TEXT    NOT NULL,   -- ISO 8601（UTC），例如 2026-10-08T03:12:45Z
  boss_kills  INTEGER NOT NULL DEFAULT 0,   -- 第四階段新增
  flagged     INTEGER NOT NULL DEFAULT 0,   -- 第四階段新增
  flag_reason TEXT,                         -- 第四階段新增
  updated_ts  INTEGER NOT NULL DEFAULT 0,   -- 第四階段新增：Unix 時間（秒）
  -- 第四階段新增：最高合理進度（high-water mark），每一項記錄數值與達到的時間，用來計算進度速度
  hw_kills    INTEGER NOT NULL DEFAULT 0,
  hw_kills_ts INTEGER NOT NULL DEFAULT 0,
  hw_boss     INTEGER NOT NULL DEFAULT 0,
  hw_boss_ts  INTEGER NOT NULL DEFAULT 0,
  hw_exp      INTEGER NOT NULL DEFAULT 0,   -- 累積經驗值
  hw_exp_ts   INTEGER NOT NULL DEFAULT 0
);

-- 登入失敗紀錄（用來限制短時間內的猜密碼次數）
CREATE TABLE IF NOT EXISTS login_fails (
  username TEXT    NOT NULL COLLATE NOCASE,
  ts       INTEGER NOT NULL      -- Unix 時間（秒）
);

-- 註冊紀錄（用來限制同一個 IP 短時間內的註冊次數；過期紀錄會在註冊時自動清掉）
CREATE TABLE IF NOT EXISTS register_log (
  ip TEXT    NOT NULL,
  ts INTEGER NOT NULL,           -- Unix 時間（秒）
  ok INTEGER NOT NULL DEFAULT 0  -- 1 = 註冊成功
);

CREATE INDEX IF NOT EXISTS idx_login_fails ON login_fails (username, ts);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_register_log ON register_log (ip, ts);
CREATE INDEX IF NOT EXISTS idx_register_log_ts ON register_log (ts);

-- ==== LIVE ====
-- 以下是第五階段「多人同步」的即時資料表（在線狀態、聊天、頻率限制）。
-- 這些資料寫入非常頻繁、而且只是暫時性的，所以放在另一個資料庫檔案（預設是 mistwood-live.db，
-- 與主資料庫同一個資料夾），避免拖慢帳號／存檔資料庫；app.py 會把上面那一行標記之後的內容
-- 套用到即時資料庫，之前的內容套用到主資料庫。即時資料庫整個刪掉也沒關係（會自動重建）。

-- 在線玩家（每個帳號一列）：10 秒沒有回報就視為離線並刪除
CREATE TABLE IF NOT EXISTS presence (
  user_id   INTEGER PRIMARY KEY,      -- 對應主資料庫 users.id
  username  TEXT    NOT NULL,
  ch        INTEGER NOT NULL,         -- 頻道 1～CHANNELS
  x         REAL    NOT NULL,
  y         REAL    NOT NULL,
  f         INTEGER NOT NULL DEFAULT 1,     -- 面向：1 右、-1 左
  st        TEXT    NOT NULL DEFAULT 'idle',-- 動作狀態：idle/walk/jump/climb/prone/dead
  ak        TEXT    NOT NULL DEFAULT '',    -- 最近一次攻擊／施法的種類
  ad        REAL    NOT NULL DEFAULT 0,     -- 攻擊動作長度（秒）
  an        INTEGER NOT NULL DEFAULT 0,     -- 攻擊序號（變了代表又出手一次）
  job       TEXT    NOT NULL DEFAULT 'novice',
  lv        INTEGER NOT NULL DEFAULT 1,
  eq        TEXT    NOT NULL DEFAULT '{}',  -- 裝備摘要 JSON：{"weapon": ["isword", 2], ...}
  em        INTEGER NOT NULL DEFAULT -1,    -- 表情編號（-1 = 無）
  en        INTEGER NOT NULL DEFAULT 0,     -- 表情序號
  em_ms     INTEGER NOT NULL DEFAULT 0,     -- 表情開始的時間（毫秒）
  seen_ms   INTEGER NOT NULL,               -- 最後一次回報的時間（毫秒）
  joined_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presence_ch ON presence (ch, seen_ms);
CREATE INDEX IF NOT EXISTS idx_presence_seen ON presence (seen_ms);

-- 頻道聊天：只保留每個頻道最近 200 則、最多 10 分鐘
CREATE TABLE IF NOT EXISTS chat (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ch       INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  username TEXT    NOT NULL,
  text     TEXT    NOT NULL,          -- 已清理、已過濾不雅字詞
  ts_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_ch ON chat (ch, id);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat (user_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat (ts_ms);

-- 頻率限制（令牌桶）：key = "p:<帳號 id>"（在線回報）或 "g:<IP>"（訪客觀看）
CREATE TABLE IF NOT EXISTS rate_buckets (
  key    TEXT    PRIMARY KEY,
  tokens REAL    NOT NULL,
  ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_ms ON rate_buckets (ms);
