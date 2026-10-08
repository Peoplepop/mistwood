-- 晨霧森林 後端資料表（SQLite）
-- app.py 第一次連線到資料庫時會自動執行這個檔案；
-- 全部使用 IF NOT EXISTS，所以重複執行也不會影響既有資料。

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
-- level / kills / gold / job 是伺服器從存檔 JSON 解析出來的排行榜數值。
CREATE TABLE IF NOT EXISTS saves (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT    NOT NULL,
  level      INTEGER NOT NULL DEFAULT 1,
  kills      INTEGER NOT NULL DEFAULT 0,
  gold       INTEGER NOT NULL DEFAULT 0,
  job        TEXT    NOT NULL DEFAULT 'novice',
  updated_at TEXT    NOT NULL    -- ISO 8601（UTC），例如 2026-10-08T03:12:45Z
);

-- 登入失敗紀錄（用來限制短時間內的猜密碼次數）
CREATE TABLE IF NOT EXISTS login_fails (
  username TEXT    NOT NULL COLLATE NOCASE,
  ts       INTEGER NOT NULL      -- Unix 時間（秒）
);

CREATE INDEX IF NOT EXISTS idx_login_fails ON login_fails (username, ts);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id);
