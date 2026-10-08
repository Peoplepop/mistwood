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
