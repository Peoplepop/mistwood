"""
晨霧森林 後端：雲端存檔 ＋ 排行榜（Flask + SQLite）

本機執行：
    python app.py              # 啟動在 http://127.0.0.1:5000

PythonAnywhere 的 WSGI 設定檔：
    from app import app as application

API 一覽（全部使用 JSON，錯誤一律回傳 {"error": "訊息"}）：
    GET  /api/health                     健康檢查
    POST /api/register                   註冊   {"username", "password"} → {"token", "username"}
    POST /api/login                      登入   {"username", "password"} → {"token", "username"}
    POST /api/logout                     登出（需要 token）
    GET  /api/save                       讀取雲端存檔（需要 token）
    PUT  /api/save                       上傳雲端存檔（需要 token） {"save": {...}} → {"ok", "updated_at", "ranked", "flag_reason"}
    GET  /api/leaderboard?by=level|kills|gold|boss&limit=20   排行榜
    POST /api/presence                   多人同步：回報自己的狀態，同時取得同頻道的其他玩家與新聊天（需要 token）
    GET  /api/presence?ch=1&after=0      訪客觀看：只讀取某個頻道的玩家與聊天（不會出現在別人畫面上）
    POST /api/chat                       頻道聊天（需要 token） {"text": "..."} → {"ok", "msg"}

存檔合理性檢查（第四階段）：
    存檔數值明顯超出遊戲可能範圍（例如超過等級上限、型別錯誤）→ 直接回 400，不儲存。
    看起來「不太可能」但不是絕對不可能（例如擊殺數太少卻等級很高、短時間內進度暴增）
    → 存檔照樣儲存（絕不弄丟玩家資料），但標記為 flagged，不列入排行榜，回應中 ranked = false。
    被標記後，之後的正常存檔不會自動解除；除非玩家重新開始（等級 ≤ UNFLAG_LEVEL）且存檔合理。
    進度速度是和「最高合理進度」（high-water mark）比較，不是和上一次存檔比較，
    所以多裝置輪流上傳（其中一台進度較舊）不會被誤判。

多人同步（第五階段）：
    PythonAnywhere 不支援 WebSocket，而且會開多個 worker 行程（彼此不共用記憶體），
    所以在線狀態與聊天都存在 SQLite（另一個「即時資料庫」檔案，見 schema.sql 的 LIVE 區段），前端用 HTTP 輪詢。
    每次回報都在一個很短的 BEGIN IMMEDIATE 交易內完成（頻率限制 → 分配頻道 → 寫入 → 讀取其他玩家與聊天）。

需要登入的 API，前端要在標頭帶上：Authorization: Bearer <token>
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ================= 設定（可用環境變數覆寫） =================
# MISTWOOD_SECRET：用來雜湊 token 的密鑰，正式環境一定要改成一長串隨機字串
# MISTWOOD_DB：SQLite 資料庫檔案路徑
# MISTWOOD_EXTRA_ORIGINS：額外允許的前端網址（逗號分隔），例如 https://example.com
# MISTWOOD_LIVE_DB：多人同步用的即時資料庫路徑（預設與 MISTWOOD_DB 同資料夾的 <檔名>-live.db）
DEFAULT_SECRET = "dev-secret-請在正式環境修改"

app = Flask(__name__)
app.config["SECRET"] = os.environ.get("MISTWOOD_SECRET", DEFAULT_SECRET)
app.config["DB_PATH"] = os.environ.get("MISTWOOD_DB", os.path.join(BASE_DIR, "mistwood.db"))
app.config["LIVE_DB_PATH"] = os.environ.get("MISTWOOD_LIVE_DB") or None
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024   # 整個請求最大 256KB（超過直接回 413）
app.json.ensure_ascii = False                    # JSON 裡的中文直接輸出，不轉成 \uXXXX

TOKEN_DAYS = 30                 # token 有效天數
MAX_SAVE_BYTES = 200 * 1024     # 單份存檔上限 200KB
LOGIN_MAX_FAILS = 5             # 在 LOGIN_LOCK_SECONDS 秒內最多失敗幾次
LOGIN_LOCK_SECONDS = 10 * 60
LEADERBOARD_DEFAULT = 20
LEADERBOARD_MAX = 50

# 排行榜的合理性檢查上限（與前端的設定一致：等級上限 200）
LEVEL_MAX = 200
GOLD_MAX = 999_999_999
KILLS_MAX = 10_000_000
# 職業 → 需要的最低等級（一轉 Lv.10、二轉 Lv.30）；不在表內的職業一律當作 novice
JOB_MIN_LEVEL = {
    "novice": 1,
    "warrior": 10, "archer": 10, "mage": 10,      # 一轉
    "knight": 30, "hunter": 30, "wizard": 30,     # 二轉（劍士→騎士、弓箭手→獵人、法師→巫師）
}
JOBS = set(JOB_MIN_LEVEL)

# ---- 存檔合理性檢查的門檻（刻意放寬：寧可放過，也不要誤判正常玩家） ----
# 經驗值曲線（與前端 index.html 的 EXP_TABLE / expToNext 相同）
EXP_TABLE = [0, 15, 34, 57, 92, 135, 186, 250, 330, 420, 530, 660, 810, 980, 1170, 1380, 1620, 1890, 2190, 2520, 2900]
EXP_GROWTH = 1.15
MAX_EXP_PER_KILL = 600          # 單隻一般怪最多給的經驗值（前端目前最高：亡靈騎士 420）
BOSS_EXP_MAX = 10_000           # 擊敗一次 Boss 最多給的經驗值（前端目前：霧之守衛 9000）
FREE_EXP_LEVEL = 20             # 升到這個等級所需的經驗值不要求擊殺數
                                # （前期任務 q1～q6 的獎勵，以及第三階段之前的舊存檔沒有記錄擊殺數）
QUEST_EXP_ABOVE_FREE = 40_000   # Lv.20 之後任務給的經驗值總和（前端 q7～q11 共 33,500，再加一點寬限）
                                # ※ 前端新增或調整任務獎勵時，這個數字要跟著更新
COINS_FREE = 100_000            # 金幣上限 = COINS_FREE + 擊殺數 × COINS_PER_KILL_MAX + Boss 擊殺數 × COINS_PER_BOSS_MAX
                                # （任務金幣共約 1.8 萬＋任務獎勵裝備賣掉約 1 萬，都在 COINS_FREE 內）
COINS_PER_KILL_MAX = 2_000      # 平均每隻怪：金幣最多 170 ＋ 掉落裝備賣出的期望值約 220（單件最高 6,000）
COINS_PER_BOSS_MAX = 50_000     # 每次 Boss：金幣 5 × 700 ＋ 2 件裝備（傳說最高賣 12,000）＝ 最多約 27,500
# 進度速度：和「最高合理進度」（high-water mark，見 put_save）比較，用伺服器時間計算
KILLS_PER_SEC_MAX = 5           # 每秒最多擊殺數
KILLS_SLACK = 300
BOSS_INTERVAL_SEC = 60          # 平均每 60 秒最多擊敗 1 次 Boss（前端 Boss 重生 180 秒）
BOSS_SLACK = 3
EXP_PER_SEC_MAX = KILLS_PER_SEC_MAX * MAX_EXP_PER_KILL + BOSS_EXP_MAX // BOSS_INTERVAL_SEC
LEVEL_EXP_SLACK = 30_000 + QUEST_EXP_ABOVE_FREE   # 經驗值增加的寬限（含一次交多個任務）
UNFLAG_LEVEL = 5                # 被標記的帳號，要重新開始（等級 ≤ 5）且存檔合理才解除標記

# ---- 註冊頻率限制（依 IP） ----
REGISTER_OK_MAX = 3             # REGISTER_OK_WINDOW 秒內最多成功註冊幾個帳號
REGISTER_OK_WINDOW = 60 * 60
REGISTER_TRY_MAX = 10           # REGISTER_TRY_WINDOW 秒內最多嘗試註冊幾次（含失敗）
REGISTER_TRY_WINDOW = 10 * 60

# ---- 第五階段：多人同步（在線狀態、頻道、聊天） ----
CHANNELS = 10                   # 頻道數
CHANNEL_CAP = 20                # 每個頻道最多幾人
ONLINE_TIMEOUT_MS = 10_000      # 超過 10 秒沒有回報就視為離線
PRESENCE_RATE = (5, 5.0)        # 在線回報的令牌桶（每個帳號）：最多連續 5 次，每秒補 5 次 → 超過回 429
GUEST_RATE = (6, 3.0)           # 訪客觀看的令牌桶（每個 IP）
WORLD_W, WORLD_H = 7400, 760    # 地圖大小（與前端 index.html 的 WORLD_W / WORLD_H 相同）
PRESENCE_LV_SLACK = 5           # 顯示的等級最多比雲端存檔高幾級（存檔每 30 秒才上傳一次）
NO_SAVE_LV_MAX = 10             # 還沒有雲端存檔的帳號，顯示的等級上限
HERO_STATES = {"idle", "walk", "jump", "climb", "prone", "dead"}
ACT_KINDS = {"melee", "stab", "shot", "pshot", "skill", "heavy", "spin", "thrust", "cast"}
EQUIP_SLOTS = ("weapon", "hat", "top", "shoes", "acc")
ITEM_ID_RE = re.compile(r"^[a-z0-9]{1,16}$")
RARITY_MAX = 3
EMOTES = 6                      # 表情數量（編號 0～5）
SEQ_MAX = 2**31 - 1
CHAT_MAX_LEN = 60               # 聊天訊息最多幾個字
CHAT_GAP_MS = 1500              # 同一個帳號兩則訊息至少間隔 1.5 秒
CHAT_BURST = 5                  # CHAT_BURST_WINDOW_MS 內最多幾則
CHAT_BURST_WINDOW_MS = 20_000
CHAT_KEEP = 200                 # 每個頻道保留最近幾則
CHAT_KEEP_MS = 10 * 60 * 1000   # 最多保留 10 分鐘
CHAT_HISTORY = 20               # 剛進入頻道時回傳最近幾則
CHAT_BATCH = 50                 # 每次輪詢最多回傳幾則新訊息
# 不雅字詞（中文＋英文常見字），比對時不分大小寫，命中的字元換成「＊」
PROFANITY = [   # 注意：不要放太短、容易誤判的字（例如「操」會誤判「操作」、「三小」會誤判「三小時」）
    "幹你娘", "幹您娘", "幹你", "幹妳", "幹恁", "幹拎", "姦你", "操你", "肏", "草你媽", "草泥馬",
    "他媽的", "他妈的", "靠北", "靠杯", "靠腰", "機掰", "雞掰", "機巴", "雞巴", "鸡巴",
    "屌", "婊子", "賤人", "贱人", "賤貨", "王八蛋", "白癡", "白痴", "智障", "腦殘", "脑残", "傻逼", "傻屄", "煞筆", "沙比",
    "去死", "垃圾人", "廢物", "低能", "北七",
    "motherfucker", "fucking", "fucker", "fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick", "pussy",
    "nigger", "nigga", "faggot", "slut", "whore", "retard", "wtf", "stfu",
]
_PROFANITY_RE = re.compile("|".join(map(re.escape, sorted(PROFANITY, key=len, reverse=True))), re.IGNORECASE)

# 帳號：2～12 個字，只能用英文字母、數字、底線或中文
USERNAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fff]{2,12}$")
PASSWORD_MIN = 6
PASSWORD_MAX = 64

# 允許跨網域呼叫的前端網址（CORS）
ALLOWED_ORIGINS = {"https://peoplepop.github.io"}
ALLOWED_ORIGINS |= {o.strip().rstrip("/") for o in os.environ.get("MISTWOOD_EXTRA_ORIGINS", "").split(",") if o.strip()}
LOCAL_ORIGIN_RE = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d{1,5})?$")

# 排行榜可以排序的欄位（白名單，避免把使用者輸入直接放進 SQL）
LEADERBOARD_COLUMNS = {"level": "level", "kills": "kills", "gold": "gold", "boss": "boss_kills"}

# 帳號不存在時也做一次密碼比對，讓回應時間差不多，避免被用來猜哪些帳號存在
DUMMY_HASH = generate_password_hash("mistwood-dummy-password")


# ================= 小工具 =================
def now_ts():
    """目前的 Unix 時間（秒）"""
    return int(time.time())


def now_ms():
    """目前的 Unix 時間（毫秒）：多人同步的時間戳記與頻率限制用"""
    return int(time.time() * 1000)


def now_iso():
    """目前的 UTC 時間字串，例如 2026-10-08T03:12:45Z（和 now_ts 用同一個時鐘，方便測試）"""
    return datetime.fromtimestamp(now_ts(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def error(message, status):
    """統一的錯誤回應格式：{"error": "..."}"""
    return jsonify(error=message), status


def hash_token(token):
    """用密鑰把 token 雜湊後再存進資料庫"""
    return hmac.new(app.config["SECRET"].encode(), token.encode(), hashlib.sha256).hexdigest()


def as_int(value):
    """把 JSON 數字轉成整數；不是整數（或是 true/false）就回傳 None"""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def read_json():
    """讀取請求的 JSON 內容，必須是物件（dict），否則回傳 None"""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


def client_ip():
    """玩家的真實 IP。PythonAnywhere 的前端代理會放在 X-Real-IP；
    沒有的話改用 X-Forwarded-For 的第一個，再沒有才用連線位址"""
    ip = request.headers.get("X-Real-IP", "").strip()
    if not ip:
        ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not ip:
        ip = request.remote_addr or "unknown"
    return ip[:64]


def _build_cum_exp():
    """CUM_EXP[lv] = 從 Lv.1 升到 Lv.lv 總共需要的經驗值"""
    cum = [0, 0]
    for lv in range(1, LEVEL_MAX):
        if lv < len(EXP_TABLE):
            need = EXP_TABLE[lv]
        else:   # 和前端 Math.round(EXP_TABLE 最後一項 × 1.15^n) 相同
            need = int(EXP_TABLE[-1] * EXP_GROWTH ** (lv - len(EXP_TABLE) + 1) + 0.5)
        cum.append(cum[-1] + need)
    return cum


CUM_EXP = _build_cum_exp()


# ================= 資料庫 =================
_ready_db_paths = set()   # 已經建立過資料表的資料庫路徑

# 舊版資料庫缺少的欄位：啟動後第一次連線時自動補上（ALTER TABLE ... ADD COLUMN）
SAVES_NEW_COLUMNS = [
    ("boss_kills", "INTEGER NOT NULL DEFAULT 0"),
    ("flagged", "INTEGER NOT NULL DEFAULT 0"),
    ("flag_reason", "TEXT"),
    ("updated_ts", "INTEGER NOT NULL DEFAULT 0"),   # Unix 時間（秒）
    # 最高合理進度（high-water mark）：每一項各自記錄「數值」與「達到這個數值的時間」，用來計算進度速度
    ("hw_kills", "INTEGER NOT NULL DEFAULT 0"),
    ("hw_kills_ts", "INTEGER NOT NULL DEFAULT 0"),
    ("hw_boss", "INTEGER NOT NULL DEFAULT 0"),
    ("hw_boss_ts", "INTEGER NOT NULL DEFAULT 0"),
    ("hw_exp", "INTEGER NOT NULL DEFAULT 0"),       # 累積經驗值
    ("hw_exp_ts", "INTEGER NOT NULL DEFAULT 0"),
]


def migrate_db(db):
    """把舊版資料庫升級成最新結構（只新增欄位、不動既有資料；重複執行也沒關係）"""
    have = {row[1] for row in db.execute("PRAGMA table_info(saves)")}   # row[1] = 欄位名稱
    for name, decl in SAVES_NEW_COLUMNS:
        if name in have:
            continue
        try:
            db.execute(f"ALTER TABLE saves ADD COLUMN {name} {decl}")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):   # 另一個行程剛好同時補上了，忽略即可
                raise
        if name == "updated_ts":   # 用原本的 updated_at 字串換算成 Unix 時間
            db.execute(
                "UPDATE saves SET updated_ts = COALESCE(CAST(strftime('%s', updated_at) AS INTEGER), 0) "
                "WHERE updated_ts = 0"
            )
        if name == "hw_exp_ts":   # 最高合理進度：用目前存的數值與最後更新時間當起點
            db.execute(
                "UPDATE saves SET hw_kills = kills, hw_kills_ts = updated_ts, hw_boss = boss_kills, "
                "hw_boss_ts = updated_ts, hw_exp_ts = updated_ts"
            )
            for user_id, level in db.execute("SELECT user_id, level FROM saves").fetchall():
                db.execute("UPDATE saves SET hw_exp = ? WHERE user_id = ?",
                           (CUM_EXP[min(max(level, 1), LEVEL_MAX)], user_id))
    db.commit()


def get_db():
    """取得這次請求使用的資料庫連線（同一個請求內共用一條）"""
    if "db" not in g:
        path = app.config["DB_PATH"]
        folder = os.path.dirname(path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        g.db = sqlite3.connect(path, timeout=10)
        g.db.row_factory = sqlite3.Row          # 讓查詢結果可以用欄位名稱取值
        g.db.execute("PRAGMA foreign_keys = ON")
        if path not in _ready_db_paths:         # 第一次連到這個資料庫：建立資料表
            g.db.executescript(schema_part(main=True))
            migrate_db(g.db)
            _ready_db_paths.add(path)
    return g.db


LIVE_MARK = "-- ==== LIVE ===="


def schema_part(main):
    """schema.sql 以 LIVE 標記分成兩段：前段給主資料庫、後段給即時資料庫"""
    with open(os.path.join(BASE_DIR, "schema.sql"), encoding="utf-8") as f:
        text = f.read()
    head, _, tail = text.partition(LIVE_MARK)
    return head if main else tail


def live_db_path():
    """即時資料庫路徑：沒有特別設定時，放在主資料庫旁邊（mistwood.db → mistwood-live.db）"""
    path = app.config.get("LIVE_DB_PATH")
    if path:
        return path
    root, ext = os.path.splitext(app.config["DB_PATH"])
    return root + "-live" + (ext or ".db")


def get_live_db():
    """多人同步用的即時資料庫連線（同一個請求內共用一條）。
    這些資料寫入頻繁又是暫時性的：synchronous = OFF（不等硬碟寫入完成，行程當掉也不會壞，只有整台主機斷電才可能遺失），
    isolation_level = None（自己用 BEGIN IMMEDIATE 控制交易，見 live_tx）"""
    if "live" not in g:
        path = live_db_path()
        folder = os.path.dirname(path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        g.live = sqlite3.connect(path, timeout=10, isolation_level=None)
        g.live.row_factory = sqlite3.Row
        g.live.execute("PRAGMA synchronous = OFF")
        if path not in _ready_db_paths:
            g.live.executescript(schema_part(main=False))
            _ready_db_paths.add(path)
    return g.live


@contextmanager
def live_tx():
    """即時資料庫的短交易：BEGIN IMMEDIATE 會先取得寫入鎖，多個 worker 同時回報時會排隊（最多等 10 秒），
    所以「數人數 → 分配頻道 → 寫入」不會因為同時進行而超過頻道上限"""
    db = get_live_db()
    db.execute("BEGIN IMMEDIATE")
    try:
        yield db
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")


@app.teardown_appcontext
def close_db(exc):
    for key in ("db", "live"):
        db = g.pop(key, None)
        if db is not None:
            db.close()


def current_user():
    """依照 Authorization: Bearer <token> 找出目前登入的玩家；沒登入回傳 None"""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[len("Bearer "):].strip()
    if not token or len(token) > 200:
        return None
    return get_db().execute(
        "SELECT users.id, users.username FROM tokens JOIN users ON users.id = tokens.user_id "
        "WHERE tokens.token_hash = ? AND tokens.expires_at > ?",
        (hash_token(token), now_ts()),
    ).fetchone()


def new_token(user_id):
    """發一個新的登入 token（回傳原始字串給前端，資料庫只存雜湊值）"""
    token = secrets.token_urlsafe(32)
    now = now_ts()
    db = get_db()
    db.execute("DELETE FROM tokens WHERE expires_at <= ?", (now,))   # 順手清掉過期的 token
    db.execute(
        "INSERT INTO tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (hash_token(token), user_id, now, now + TOKEN_DAYS * 86400),
    )
    db.commit()
    return token


# ================= CORS（允許哪些網頁呼叫這個 API） =================
def origin_allowed(origin):
    return origin in ALLOWED_ORIGINS or bool(LOCAL_ORIGIN_RE.match(origin))


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin", "")
    if origin and origin_allowed(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Max-Age"] = "600"
    response.headers["Vary"] = "Origin"
    return response


# ================= 錯誤處理（全部回傳 JSON） =================
HTTP_MESSAGES = {
    400: "請求格式錯誤",
    401: "請先登入",
    404: "找不到這個 API",
    405: "不支援這個請求方法",
    413: "資料太大",
    429: "請求太頻繁，請稍後再試",
    500: "伺服器發生錯誤",
}


@app.errorhandler(HTTPException)
def handle_http_error(e):
    return error(HTTP_MESSAGES.get(e.code, "請求失敗"), e.code)


@app.errorhandler(Exception)
def handle_unexpected_error(e):
    app.logger.exception("未預期的錯誤")   # 詳細內容會寫進 error log
    return error("伺服器發生錯誤", 500)


# ================= 帳號驗證 =================
def check_credentials(data):
    """檢查帳號密碼格式，回傳 (username, password, 錯誤訊息)"""
    if data is None:
        return None, None, "請求內容必須是 JSON 物件"
    username = data.get("username")
    password = data.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        return None, None, "請輸入帳號與密碼"
    username = username.strip()
    if not USERNAME_RE.match(username):
        return None, None, "帳號需為 2～12 個字，只能使用英文字母、數字、底線或中文"
    if len(password) < PASSWORD_MIN:
        return None, None, f"密碼至少需要 {PASSWORD_MIN} 個字元"
    if len(password) > PASSWORD_MAX:
        return None, None, f"密碼最多 {PASSWORD_MAX} 個字元"
    return username, password, None


def login_locked(username):
    """最近 LOGIN_LOCK_SECONDS 秒內失敗太多次就暫時鎖住"""
    count = get_db().execute(
        "SELECT COUNT(*) FROM login_fails WHERE username = ? AND ts > ?",
        (username, now_ts() - LOGIN_LOCK_SECONDS),
    ).fetchone()[0]
    return count >= LOGIN_MAX_FAILS


def record_login_fail(username):
    db = get_db()
    db.execute("DELETE FROM login_fails WHERE ts <= ?", (now_ts() - LOGIN_LOCK_SECONDS,))   # 清掉舊紀錄
    db.execute("INSERT INTO login_fails (username, ts) VALUES (?, ?)", (username, now_ts()))
    db.commit()


def register_limited():
    """這個 IP 註冊太頻繁就回傳錯誤訊息，否則回傳 None（順便清掉過期的紀錄）"""
    db = get_db()
    now = now_ts()
    db.execute("DELETE FROM register_log WHERE ts <= ?", (now - max(REGISTER_OK_WINDOW, REGISTER_TRY_WINDOW),))
    db.commit()
    ip = client_ip()
    tries = db.execute(
        "SELECT COUNT(*) FROM register_log WHERE ip = ? AND ts > ?", (ip, now - REGISTER_TRY_WINDOW)
    ).fetchone()[0]
    if tries >= REGISTER_TRY_MAX:
        return f"註冊嘗試次數過多，請 {REGISTER_TRY_WINDOW // 60} 分鐘後再試"
    oks = db.execute(
        "SELECT COUNT(*) FROM register_log WHERE ip = ? AND ok = 1 AND ts > ?", (ip, now - REGISTER_OK_WINDOW)
    ).fetchone()[0]
    if oks >= REGISTER_OK_MAX:
        return f"同一個網路註冊的帳號太多，請 {REGISTER_OK_WINDOW // 60} 分鐘後再試"
    return None


def record_register(ok):
    """記錄一次註冊嘗試（ok = 是否成功）"""
    db = get_db()
    db.execute("INSERT INTO register_log (ip, ts, ok) VALUES (?, ?, ?)", (client_ip(), now_ts(), 1 if ok else 0))
    db.commit()


# ================= 存檔解析（排行榜數值由伺服器自己算） =================
def extract_scores(save):
    """從存檔 JSON 取出排行榜數值。格式或數值不合理時丟出 ValueError（訊息會回給前端）
    回傳 (level, kills, gold, job, boss_kills, total_exp)"""
    player = save.get("player")
    if not isinstance(player, dict):
        raise ValueError("存檔格式錯誤：缺少角色資料")

    level = as_int(player.get("lv", 1))
    if level is None or not 1 <= level <= LEVEL_MAX:
        raise ValueError("存檔數值異常：等級不合理")

    gold = as_int(player.get("coins", 0))
    if gold is None or not 0 <= gold <= GOLD_MAX:
        raise ValueError("存檔數值異常：金幣不合理")

    stats = player.get("stats")
    if not isinstance(stats, dict):
        stats = {}   # 舊存檔沒有 stats 欄位，擊殺數當作 0
    kills = as_int(stats.get("kills", 0))
    if kills is None or not 0 <= kills <= KILLS_MAX:
        raise ValueError("存檔數值異常：擊殺數不合理")
    boss_kills = as_int(stats.get("bossKills", 0))   # 第四階段之前的存檔沒有這個欄位，當作 0
    if boss_kills is None or not 0 <= boss_kills <= KILLS_MAX:
        raise ValueError("存檔數值異常：Boss 擊殺數不合理")

    job = player.get("job")
    if job not in JOBS:
        job = "novice"

    # 累積經驗值 = 升到目前等級的經驗值 ＋ 目前等級內的經驗值（exp 格式不對就當作 0，不擋存檔）
    total_exp = CUM_EXP[level]
    exp = player.get("exp", 0)
    if level < LEVEL_MAX and isinstance(exp, (int, float)) and not isinstance(exp, bool) and exp > 0:
        total_exp += int(min(exp, CUM_EXP[level + 1] - CUM_EXP[level]))
    return level, kills, gold, job, boss_kills, total_exp


def min_kills_for_level(level, boss_kills):
    """升到 level 至少需要的擊殺數（非常寬鬆的下限）"""
    exp = CUM_EXP[level] - CUM_EXP[FREE_EXP_LEVEL] - QUEST_EXP_ABOVE_FREE - boss_kills * BOSS_EXP_MAX
    return max(0, -(-exp // MAX_EXP_PER_KILL))   # 無條件進位


def plausibility_problem(level, kills, gold, job, boss_kills, total_exp, hw, now):
    """檢查存檔是否合理：合理回傳 None，否則回傳簡短原因（存進 flag_reason）。
    hw 是這個帳號的存檔資料列（用其中的最高合理進度 hw_*；沒有存檔就是 None），now 是伺服器目前時間（秒）"""
    # ---- 只看這份存檔本身 ----
    if level < JOB_MIN_LEVEL[job]:
        return f"職業與等級不符（{job} 需要 Lv.{JOB_MIN_LEVEL[job]}）"
    if boss_kills > kills:
        return "Boss 擊殺數大於總擊殺數"
    if kills < min_kills_for_level(level, boss_kills):
        return "等級與擊殺數不符"
    if gold > COINS_FREE + kills * COINS_PER_KILL_MAX + boss_kills * COINS_PER_BOSS_MAX:
        return "金幣與擊殺數不符"

    # ---- 和最高合理進度比較進度速度 ----
    # 比較對象不是「上一次存檔」：多裝置時，另一台裝置上傳較舊、較低的進度不會拉低基準，
    # 所以之後原本那台繼續正常上傳，也不會被誤判成「短時間內暴增」。數值比基準低一律允許。
    if hw is not None:
        def too_fast(value, base, base_ts, per_sec, slack):
            elapsed = max(0, now - (base_ts or 0))
            return value - base > per_sec * elapsed + slack
        if too_fast(kills, hw["hw_kills"], hw["hw_kills_ts"], KILLS_PER_SEC_MAX, KILLS_SLACK):
            return "擊殺數增加過快"
        if too_fast(boss_kills, hw["hw_boss"], hw["hw_boss_ts"], 1 / BOSS_INTERVAL_SEC, BOSS_SLACK):
            return "Boss 擊殺數增加過快"
        if too_fast(total_exp, hw["hw_exp"], hw["hw_exp_ts"], EXP_PER_SEC_MAX, LEVEL_EXP_SLACK):
            return "等級提升過快"
    return None


def next_high_water(row, kills, boss_kills, total_exp, plausible, reset, now):
    """算出新的最高合理進度（hw_kills, hw_kills_ts, hw_boss, hw_boss_ts, hw_exp, hw_exp_ts）
    - 存檔合理時：每一項各自取較大值，有變大的那一項才更新時間（較低的舊存檔不會拉低基準）
    - 存檔不合理時：維持原本的基準
    - 被標記的帳號重新開始（reset）時：基準重設成這份存檔"""
    if row is None or reset:
        if not plausible:   # 第一份存檔就不合理：基準從 0 開始（之後要重新開始才會解除標記）
            return 0, now, 0, now, 0, now
        return kills, now, boss_kills, now, total_exp, now
    out = []
    for value, key in ((kills, "hw_kills"), (boss_kills, "hw_boss"), (total_exp, "hw_exp")):
        base, base_ts = row[key], row[key + "_ts"]
        if plausible and value > base:
            out += [value, now]
        else:
            out += [base, base_ts]
    return tuple(out)


# ================= API =================
@app.get("/api/health")
def health():
    return jsonify(ok=True, time=now_iso())


@app.post("/api/register")
def register():
    # 同一個 IP 短時間內註冊太多次就先擋下（避免被大量灌帳號）
    limited = register_limited()
    if limited:
        return error(limited, 429)
    username, password, msg = check_credentials(read_json())
    if msg:
        record_register(False)
        return error(msg, 400)
    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)",
            (username, generate_password_hash(password), now_iso()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        record_register(False)
        return error("這個帳號名稱已經有人使用", 409)
    record_register(True)
    return jsonify(token=new_token(cur.lastrowid), username=username), 201


@app.post("/api/login")
def login():
    data = read_json()
    if data is None or not isinstance(data.get("username"), str) or not isinstance(data.get("password"), str):
        return error("請輸入帳號與密碼", 400)
    username = data["username"].strip()
    password = data["password"]
    if not username or len(username) > 32 or len(password) > PASSWORD_MAX:
        return error("帳號或密碼錯誤", 401)

    # 失敗太多次：就算這次密碼正確也先擋下（避免被暴力猜密碼）
    if login_locked(username):
        return error(f"登入失敗次數過多，請 {LOGIN_LOCK_SECONDS // 60} 分鐘後再試", 429)

    user = get_db().execute("SELECT id, username, pw_hash FROM users WHERE username = ?", (username,)).fetchone()
    if user is None:
        check_password_hash(DUMMY_HASH, password)   # 讓「帳號不存在」與「密碼錯誤」花的時間差不多
        record_login_fail(username)
        return error("帳號或密碼錯誤", 401)
    if not check_password_hash(user["pw_hash"], password):
        record_login_fail(username)
        return error("帳號或密碼錯誤", 401)

    db = get_db()
    db.execute("DELETE FROM login_fails WHERE username = ?", (username,))   # 登入成功就清掉失敗紀錄
    db.commit()
    return jsonify(token=new_token(user["id"]), username=user["username"])


@app.post("/api/logout")
def logout():
    user = current_user()
    if user is None:
        return error("請先登入", 401)
    token = request.headers["Authorization"][len("Bearer "):].strip()
    db = get_db()
    db.execute("DELETE FROM tokens WHERE token_hash = ?", (hash_token(token),))
    db.commit()
    get_live_db().execute("DELETE FROM presence WHERE user_id = ?", (user["id"],))   # 登出後立刻從其他玩家畫面上消失
    return jsonify(ok=True)


@app.get("/api/save")
def get_save():
    user = current_user()
    if user is None:
        return error("請先登入", 401)
    row = get_db().execute("SELECT data, updated_at, flagged FROM saves WHERE user_id = ?", (user["id"],)).fetchone()
    if row is None:
        return jsonify(username=user["username"], save=None, updated_at=None, ranked=None)
    return jsonify(username=user["username"], save=json.loads(row["data"]), updated_at=row["updated_at"],
                   ranked=not row["flagged"])


@app.put("/api/save")
def put_save():
    user = current_user()
    if user is None:
        return error("請先登入", 401)
    data = read_json()
    if data is None or not isinstance(data.get("save"), dict):
        return error("請求內容必須是 {\"save\": {...}}", 400)
    save = data["save"]

    text = json.dumps(save, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) > MAX_SAVE_BYTES:
        return error(f"存檔太大（上限 {MAX_SAVE_BYTES // 1024}KB）", 413)

    try:
        level, kills, gold, job, boss_kills, total_exp = extract_scores(save)
    except ValueError as e:
        return error(str(e), 400)

    db = get_db()
    now = now_ts()
    prev = db.execute(
        "SELECT flagged, flag_reason, hw_kills, hw_kills_ts, hw_boss, hw_boss_ts, hw_exp, hw_exp_ts "
        "FROM saves WHERE user_id = ?",
        (user["id"],),
    ).fetchone()

    # 合理性檢查：不合理也照樣存檔（不弄丟玩家資料），只是標記起來、不列入排行榜
    problem = plausibility_problem(level, kills, gold, job, boss_kills, total_exp, prev, now)
    reset = False
    if problem:
        flagged, reason = 1, problem
    elif prev is not None and prev["flagged"] and level > UNFLAG_LEVEL:
        flagged, reason = 1, prev["flag_reason"]   # 之前被標記過：除非重新開始，否則維持標記
    else:
        flagged, reason = 0, None
        reset = prev is not None and bool(prev["flagged"])   # 被標記的帳號重新開始：解除標記並重設基準
    hw = next_high_water(prev, kills, boss_kills, total_exp, problem is None, reset, now)
    if problem and not (prev is not None and prev["flagged"] and prev["flag_reason"] == problem):
        app.logger.warning("存檔被標記 user=%s reason=%s lv=%s kills=%s boss=%s gold=%s",
                           user["username"], problem, level, kills, boss_kills, gold)

    updated_at = now_iso()
    # 有就更新、沒有就新增（SQLite 的 UPSERT 語法）
    db.execute(
        "INSERT INTO saves (user_id, data, level, kills, gold, job, boss_kills, flagged, flag_reason, "
        "updated_at, updated_ts, hw_kills, hw_kills_ts, hw_boss, hw_boss_ts, hw_exp, hw_exp_ts) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, level = excluded.level, kills = excluded.kills, "
        "gold = excluded.gold, job = excluded.job, boss_kills = excluded.boss_kills, flagged = excluded.flagged, "
        "flag_reason = excluded.flag_reason, updated_at = excluded.updated_at, updated_ts = excluded.updated_ts, "
        "hw_kills = excluded.hw_kills, hw_kills_ts = excluded.hw_kills_ts, hw_boss = excluded.hw_boss, "
        "hw_boss_ts = excluded.hw_boss_ts, hw_exp = excluded.hw_exp, hw_exp_ts = excluded.hw_exp_ts",
        (user["id"], text, level, kills, gold, job, boss_kills, flagged, reason, updated_at, now, *hw),
    )
    db.commit()
    return jsonify(ok=True, updated_at=updated_at, ranked=not flagged, flag_reason=reason)


@app.get("/api/leaderboard")
def leaderboard():
    by = request.args.get("by", "level")
    column = LEADERBOARD_COLUMNS.get(by)
    if column is None:
        return error("排行榜類型只能是 level、kills、gold 或 boss", 400)
    try:
        limit = int(request.args.get("limit", LEADERBOARD_DEFAULT))
    except ValueError:
        return error("limit 必須是數字", 400)
    limit = max(1, min(limit, LEADERBOARD_MAX))

    db = get_db()
    # 被標記（flagged）的存檔不列入排行榜
    rows = db.execute(
        f"SELECT users.username, saves.level, saves.kills, saves.gold, saves.job, saves.boss_kills, "
        f"saves.{column} AS value "
        f"FROM saves JOIN users ON users.id = saves.user_id WHERE saves.flagged = 0 "
        f"ORDER BY saves.{column} DESC, saves.updated_at ASC, users.username ASC LIMIT ?",
        (limit,),
    ).fetchall()

    # 名次：數值相同的玩家名次相同（例如 1, 2, 2, 4）
    entries = []
    rank = 0
    prev_value = None
    for i, row in enumerate(rows):
        if row["value"] != prev_value:
            rank = i + 1
            prev_value = row["value"]
        entries.append({
            "rank": rank, "username": row["username"], "level": row["level"],
            "kills": row["kills"], "gold": row["gold"], "job": row["job"], "bossKills": row["boss_kills"],
            "value": row["value"],
        })

    # 有帶 token 的話，額外回傳自己的名次（就算不在前 N 名也看得到；被標記的存檔沒有名次）
    me = None
    user = current_user()
    if user is not None:
        mine = db.execute(f"SELECT {column} AS value, flagged FROM saves WHERE user_id = ?", (user["id"],)).fetchone()
        if mine is None:
            me = {"username": user["username"], "rank": None, "value": None, "ranked": False}
        elif mine["flagged"]:
            me = {"username": user["username"], "rank": None, "value": mine["value"], "ranked": False}
        else:
            higher = db.execute(
                f"SELECT COUNT(*) FROM saves WHERE flagged = 0 AND {column} > ?", (mine["value"],)
            ).fetchone()[0]
            me = {"username": user["username"], "rank": higher + 1, "value": mine["value"], "ranked": True}

    total = db.execute("SELECT COUNT(*) FROM saves WHERE flagged = 0").fetchone()[0]
    return jsonify(by=by, entries=entries, me=me, total=total)


# ================= 第五階段：多人同步（在線狀態、頻道、聊天） =================
def as_num(value):
    """JSON 數字（整數或有限小數）→ float；其他型別（含 true/false、NaN）回傳 None"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if value == value and abs(value) != float("inf") else None


def as_seq(value):
    """序號：非負整數，超過上限就繞回來（前端一直累加也不會溢位）"""
    n = as_int(value)
    return 0 if n is None or n < 0 else n % (SEQ_MAX + 1)


def take_token(db, key, cap, per_sec, now):
    """令牌桶頻率限制：還有額度就扣一次並回傳 True，沒有就回傳 False（必須在 live_tx 交易內呼叫）"""
    row = db.execute("SELECT tokens, ms FROM rate_buckets WHERE key = ?", (key,)).fetchone()
    tokens = cap if row is None else min(cap, row["tokens"] + max(0, now - row["ms"]) / 1000 * per_sec)
    ok = tokens >= 1
    if ok:
        tokens -= 1
    db.execute("INSERT INTO rate_buckets (key, tokens, ms) VALUES (?, ?, ?) "
               "ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, ms = excluded.ms", (key, tokens, now))
    return ok


def prune_live(db, now):
    """清掉離線的玩家與過期的頻率限制紀錄"""
    db.execute("DELETE FROM presence WHERE seen_ms < ?", (now - ONLINE_TIMEOUT_MS,))
    db.execute("DELETE FROM rate_buckets WHERE ms < ?", (now - 60_000,))


def channel_counts(db, exclude=None):
    """各頻道目前的人數 {頻道: 人數}（exclude = 不算這個帳號）"""
    rows = db.execute("SELECT ch, COUNT(*) AS n FROM presence WHERE user_id != ? GROUP BY ch",
                      (exclude if exclude is not None else -1,)).fetchall()
    return {row["ch"]: row["n"] for row in rows}


def parse_presence(data, max_level):
    """檢查並整理前端回報的狀態。明顯不合理（位置在地圖外很遠、等級不是 1～200 的整數）就丟出 ValueError；
    其他欄位一律夾到合法範圍或換成預設值。max_level = 依雲端存檔推算的等級上限"""
    x, y = as_num(data.get("x")), as_num(data.get("y"))
    if x is None or y is None:
        raise ValueError("位置格式錯誤")
    if not -50 <= x <= WORLD_W + 50 or not -400 <= y <= WORLD_H + 100:
        raise ValueError("位置不合理")
    lv = as_int(data.get("lv"))
    if lv is None or not 1 <= lv <= LEVEL_MAX:
        raise ValueError("等級不合理")
    lv = min(lv, max_level)
    job = data.get("job")
    if job not in JOBS or lv < JOB_MIN_LEVEL[job]:
        job = "novice"
    ad = as_num(data.get("ad"))
    em = as_int(data.get("em", -1))
    eq = {}
    raw = data.get("eq")
    if isinstance(raw, dict):
        for slot in EQUIP_SLOTS:
            v = raw.get(slot)
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and ITEM_ID_RE.match(v[0]):
                r = as_int(v[1])
                if r is not None and 0 <= r <= RARITY_MAX:
                    eq[slot] = [v[0], r]
    st, ak = data.get("st"), data.get("ak")
    return {
        "x": round(min(max(x, 0), WORLD_W), 1), "y": round(min(max(y, 0), WORLD_H), 1),
        "f": -1 if data.get("f") == -1 else 1,
        "st": st if isinstance(st, str) and st in HERO_STATES else "idle",
        "ak": ak if isinstance(ak, str) and ak in ACT_KINDS else "",
        "ad": round(min(max(ad or 0, 0), 1.5), 3),
        "an": as_seq(data.get("an")),
        "job": job, "lv": lv,
        "eq": json.dumps(eq, separators=(",", ":")),
        "em": em if em is not None and -1 <= em < EMOTES else -1,
        "en": as_seq(data.get("en")),
    }


def player_json(row, now):
    """其他玩家的公開資料（只回傳畫面需要的欄位）"""
    return {
        "id": row["user_id"], "name": row["username"], "x": row["x"], "y": row["y"], "f": row["f"],
        "st": row["st"], "ak": row["ak"], "ad": row["ad"], "an": row["an"], "job": row["job"], "lv": row["lv"],
        "eq": json.loads(row["eq"] or "{}"), "em": row["em"], "en": row["en"],
        "ea": max(0, now - row["em_ms"]) if row["em"] >= 0 else None,   # 表情已經顯示多久（毫秒）
        "ts": row["seen_ms"],
    }


def fetch_chat(db, ch, after, now):
    """頻道聊天：after <= 0（剛進入頻道）回傳最近幾則歷史訊息，否則回傳 id > after 的新訊息。
    回傳 (訊息列表, 新的游標)；游標是目前全部訊息的最大 id，下次輪詢帶回來就只會拿到更新的訊息"""
    top = db.execute("SELECT COALESCE(MAX(id), 0) FROM chat").fetchone()[0]
    if after <= 0:
        rows = db.execute("SELECT id, user_id, username, text, ts_ms FROM chat WHERE ch = ? AND ts_ms >= ? "
                          "ORDER BY id DESC LIMIT ?", (ch, now - CHAT_KEEP_MS, CHAT_HISTORY)).fetchall()
    else:
        rows = db.execute("SELECT id, user_id, username, text, ts_ms FROM chat WHERE ch = ? AND id > ? "
                          "ORDER BY id DESC LIMIT ?", (ch, after, CHAT_BATCH)).fetchall()
    msgs = [{"id": r["id"], "uid": r["user_id"], "name": r["username"], "text": r["text"], "ts": r["ts_ms"]}
            for r in reversed(rows)]
    return msgs, top


def live_snapshot(db, ch, me, after, now):
    """回應內容：頻道人數、同頻道的其他玩家、新的聊天訊息"""
    counts = channel_counts(db)
    others = db.execute("SELECT * FROM presence WHERE ch = ? AND user_id != ? ORDER BY user_id",
                        (ch, me if me is not None else -1)).fetchall()
    msgs, cursor = fetch_chat(db, ch, after, now)
    return {
        "ch": ch, "nch": CHANNELS, "cap": CHANNEL_CAP, "online": counts.get(ch, 0), "total": sum(counts.values()),
        "chans": [counts.get(c, 0) for c in range(1, CHANNELS + 1)],
        "players": [player_json(r, now) for r in others],
        "chat": msgs, "cursor": cursor, "hist": after <= 0, "now": now,
    }


def presence_level_cap(user_id):
    """顯示等級的上限：雲端存檔的等級再寬限幾級（避免改前端就顯示 Lv.200）"""
    row = get_db().execute("SELECT level FROM saves WHERE user_id = ?", (user_id,)).fetchone()
    return min(LEVEL_MAX, (row["level"] + PRESENCE_LV_SLACK) if row else NO_SAVE_LV_MAX)


@app.post("/api/presence")
def post_presence():
    """回報自己的狀態（約每 0.4 秒一次），同時拿到同頻道的其他玩家與新聊天（一次來回）。
    body：{ch: 想要的頻道（0 = 自動）, sw: 是否要求換頻道, x, y, f, st, ak, ad, an, job, lv, eq, em, en, after: 聊天游標}"""
    user = current_user()
    if user is None:
        return error("請先登入", 401)
    data = read_json()
    if data is None:
        return error("請求內容必須是 JSON 物件", 400)
    try:
        state = parse_presence(data, presence_level_cap(user["id"]))
    except ValueError as e:
        return error(str(e), 400)
    want = as_int(data.get("ch", 0))
    want = want if want is not None and 1 <= want <= CHANNELS else 0
    switch = data.get("sw") is True
    after = as_int(data.get("after", 0))
    after = after if after is not None and after > 0 else 0

    uid, now = user["id"], now_ms()
    with live_tx() as db:
        if not take_token(db, f"p:{uid}", *PRESENCE_RATE, now):
            return error("請求太頻繁，請稍後再試", 429)
        prune_live(db, now)
        mine = db.execute("SELECT ch, en, em_ms FROM presence WHERE user_id = ?", (uid,)).fetchone()
        counts = channel_counts(db, exclude=uid)

        def has_room(c):
            return counts.get(c, 0) < CHANNEL_CAP

        sw_err = None
        if mine is not None and not (switch and want and want != mine["ch"]):
            ch = mine["ch"]                                      # 已在線：留在原本的頻道
        elif mine is not None:                                   # 要求換頻道
            if has_room(want):
                ch = want
            else:
                ch, sw_err = mine["ch"], f"頻道 {want} 已滿（{CHANNEL_CAP} 人），請選擇其他頻道"
        else:                                                    # 剛上線：優先回到原本的頻道，否則選人數未滿的最小頻道
            ch = want if want and has_room(want) else next((c for c in range(1, CHANNELS + 1) if has_room(c)), None)
            if ch is None:
                return error("所有頻道都已滿，請稍後再試", 503)
        # 表情序號有變才更新開始時間（同一個表情重複回報不會一直重新顯示）
        if mine is not None and mine["en"] == state["en"]:
            em_ms = mine["em_ms"]
        else:
            em_ms = now if state["em"] >= 0 else 0
        db.execute(
            "INSERT INTO presence (user_id, username, ch, x, y, f, st, ak, ad, an, job, lv, eq, em, en, em_ms, "
            "seen_ms, joined_ms) VALUES (:uid, :name, :ch, :x, :y, :f, :st, :ak, :ad, :an, :job, :lv, :eq, :em, :en, "
            ":em_ms, :now, :now) "
            "ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, ch = excluded.ch, x = excluded.x, "
            "y = excluded.y, f = excluded.f, st = excluded.st, ak = excluded.ak, ad = excluded.ad, an = excluded.an, "
            "job = excluded.job, lv = excluded.lv, eq = excluded.eq, em = excluded.em, en = excluded.en, "
            "em_ms = excluded.em_ms, seen_ms = excluded.seen_ms",
            dict(state, uid=uid, name=user["username"], ch=ch, em_ms=em_ms, now=now),
        )
        if mine is not None and mine["ch"] != ch:
            after = 0   # 換了頻道：改成回傳新頻道最近的聊天
        out = live_snapshot(db, ch, uid, after, now)
    out.update(me=uid, name=user["username"], lv=state["lv"], sw_err=sw_err)
    return jsonify(out)


@app.get("/api/presence")
def get_presence():
    """訪客（或還沒登入的玩家）觀看某個頻道：只讀取，不會出現在別人的畫面上，也不能聊天。
    ch 不帶或 0 = 人最多的頻道"""
    try:
        ch = int(request.args.get("ch", 0))
        after = max(0, int(request.args.get("after", 0)))
    except ValueError:
        return error("ch 與 after 必須是數字", 400)
    now = now_ms()
    with live_tx() as db:
        if not take_token(db, "g:" + client_ip(), *GUEST_RATE, now):
            return error("請求太頻繁，請稍後再試", 429)
        prune_live(db, now)
        if not 1 <= ch <= CHANNELS:
            counts = channel_counts(db)
            ch = max(range(1, CHANNELS + 1), key=lambda c: (counts.get(c, 0), -c))
        out = live_snapshot(db, ch, None, after, now)
    out.update(guest=True)
    return jsonify(out)


def clean_chat(text):
    """清理聊天文字：去掉控制字元與隱藏的格式字元（例如反轉文字方向、零寬字元）、組合用的附加符號；
    空白類字元一律換成一個半形空白（中文的全形標點保持原樣）"""
    out = []
    for c in text:
        cat = unicodedata.category(c)
        if cat[0] == "Z" or c in "\t\n\r":
            out.append(" ")
        elif cat in ("Cc", "Cf", "Cs", "Co", "Cn", "Mn", "Me"):
            continue
        else:
            out.append(c)
    return re.sub(r" {2,}", " ", "".join(out)).strip()


def filter_profanity(text):
    """不雅字詞換成同樣長度的「＊」。比對時先把每個字元統一成半形（NFKC，例如「ｓｈｉｔ」→ shit），
    但只替換命中的位置，其他文字（例如中文全形標點）保持原樣"""
    fold = "".join(n if len(n := unicodedata.normalize("NFKC", c)) == 1 else c for c in text)
    out = list(text)
    for m in _PROFANITY_RE.finditer(fold):
        out[m.start():m.end()] = "＊" * (m.end() - m.start())
    return "".join(out)


@app.post("/api/chat")
def post_chat():
    """在目前的頻道說話（必須在線上，也就是 10 秒內回報過 POST /api/presence）"""
    user = current_user()
    if user is None:
        return error("登入後才能聊天", 401)
    data = read_json()
    text = data.get("text") if data is not None else None
    if not isinstance(text, str):
        return error("請輸入訊息", 400)
    if len(text) > CHAT_MAX_LEN * 4:
        return error(f"訊息最多 {CHAT_MAX_LEN} 個字", 400)
    text = clean_chat(text)
    if not text:
        return error("訊息不能是空白", 400)
    if len(text) > CHAT_MAX_LEN:
        return error(f"訊息最多 {CHAT_MAX_LEN} 個字", 400)
    text = filter_profanity(text)

    uid, now = user["id"], now_ms()
    with live_tx() as db:
        me = db.execute("SELECT ch FROM presence WHERE user_id = ? AND seen_ms >= ?",
                        (uid, now - ONLINE_TIMEOUT_MS)).fetchone()
        if me is None:
            return error("目前不在任何頻道（請回到遊戲畫面再試）", 409)
        last = db.execute("SELECT MAX(ts_ms) FROM chat WHERE user_id = ?", (uid,)).fetchone()[0]
        if last is not None and now - last < CHAT_GAP_MS:
            return error("說話太快了，請稍等一下", 429)
        recent = db.execute("SELECT COUNT(*) FROM chat WHERE user_id = ? AND ts_ms > ?",
                            (uid, now - CHAT_BURST_WINDOW_MS)).fetchone()[0]
        if recent >= CHAT_BURST:
            return error(f"訊息太多了，請 {CHAT_BURST_WINDOW_MS // 1000} 秒後再說", 429)
        ch = me["ch"]
        cur = db.execute("INSERT INTO chat (ch, user_id, username, text, ts_ms) VALUES (?, ?, ?, ?, ?)",
                         (ch, uid, user["username"], text, now))
        msg_id = cur.lastrowid
        # 自動清理：超過 10 分鐘的訊息，以及每個頻道最近 CHAT_KEEP 則以外的訊息
        db.execute("DELETE FROM chat WHERE ts_ms < ?", (now - CHAT_KEEP_MS,))
        db.execute("DELETE FROM chat WHERE ch = ? AND id <= (SELECT id FROM chat WHERE ch = ? ORDER BY id DESC "
                   "LIMIT 1 OFFSET ?)", (ch, ch, CHAT_KEEP))
    return jsonify(ok=True, ch=ch, msg={"id": msg_id, "uid": uid, "name": user["username"], "text": text, "ts": now})


if __name__ == "__main__":
    if app.config["SECRET"] == DEFAULT_SECRET:
        print("提醒：目前使用預設的 MISTWOOD_SECRET，正式環境請設定環境變數。")
    print("資料庫位置：", app.config["DB_PATH"])
    app.run(host="127.0.0.1", port=5000, debug=os.environ.get("FLASK_DEBUG") == "1")
