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

存檔合理性檢查（第四階段）：
    存檔數值明顯超出遊戲可能範圍（例如超過等級上限、型別錯誤）→ 直接回 400，不儲存。
    看起來「不太可能」但不是絕對不可能（例如擊殺數太少卻等級很高、短時間內進度暴增）
    → 存檔照樣儲存（絕不弄丟玩家資料），但標記為 flagged，不列入排行榜，回應中 ranked = false。
    被標記後，之後的正常存檔不會自動解除；除非玩家重新開始（等級 ≤ UNFLAG_LEVEL）且存檔合理。

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
from datetime import datetime, timezone

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ================= 設定（可用環境變數覆寫） =================
# MISTWOOD_SECRET：用來雜湊 token 的密鑰，正式環境一定要改成一長串隨機字串
# MISTWOOD_DB：SQLite 資料庫檔案路徑
# MISTWOOD_EXTRA_ORIGINS：額外允許的前端網址（逗號分隔），例如 https://example.com
DEFAULT_SECRET = "dev-secret-請在正式環境修改"

app = Flask(__name__)
app.config["SECRET"] = os.environ.get("MISTWOOD_SECRET", DEFAULT_SECRET)
app.config["DB_PATH"] = os.environ.get("MISTWOOD_DB", os.path.join(BASE_DIR, "mistwood.db"))
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
MAX_EXP_PER_KILL = 600          # 單隻怪最多給的經驗值（目前最高 120 的 5 倍，預留給新怪物）
BOSS_EXP_MAX = 10_000           # 擊敗一次 Boss 最多給的經驗值
FREE_EXP_LEVEL = 20             # 升到這個等級所需的經驗值不要求擊殺數
                                # （任務獎勵，以及第三階段之前的舊存檔沒有記錄擊殺數）
COINS_FREE = 100_000            # 金幣上限 = COINS_FREE + 擊殺數 × COINS_PER_KILL_MAX + Boss 擊殺數 × COINS_PER_BOSS_MAX
COINS_PER_KILL_MAX = 2_000      # 含掉落裝備拿去商店賣的收入
COINS_PER_BOSS_MAX = 50_000
# 和上一次存檔比較的進度速度（用伺服器收到兩次存檔的時間差計算）
KILLS_PER_SEC_MAX = 5           # 每秒最多擊殺數
KILLS_SLACK = 300
BOSS_INTERVAL_SEC = 60          # 平均每 60 秒最多擊敗 1 次 Boss
BOSS_SLACK = 3
EXP_PER_SEC_MAX = KILLS_PER_SEC_MAX * MAX_EXP_PER_KILL + BOSS_EXP_MAX // BOSS_INTERVAL_SEC
LEVEL_EXP_SLACK = 30_000        # 升級所需經驗值的寬限
UNFLAG_LEVEL = 5                # 被標記的帳號，要重新開始（等級 ≤ 5）且存檔合理才解除標記

# ---- 註冊頻率限制（依 IP） ----
REGISTER_OK_MAX = 3             # REGISTER_OK_WINDOW 秒內最多成功註冊幾個帳號
REGISTER_OK_WINDOW = 60 * 60
REGISTER_TRY_MAX = 10           # REGISTER_TRY_WINDOW 秒內最多嘗試註冊幾次（含失敗）
REGISTER_TRY_WINDOW = 10 * 60

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
    ("updated_ts", "INTEGER NOT NULL DEFAULT 0"),   # Unix 時間（秒），用來計算進度速度
]


def migrate_db(db):
    """把舊版資料庫升級成最新結構（只新增欄位、不動既有資料；重複執行也沒關係）"""
    have = {row["name"] for row in db.execute("PRAGMA table_info(saves)")}
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
            with open(os.path.join(BASE_DIR, "schema.sql"), encoding="utf-8") as f:
                g.db.executescript(f.read())
            migrate_db(g.db)
            _ready_db_paths.add(path)
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
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
    回傳 (level, kills, gold, job, boss_kills)"""
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
    return level, kills, gold, job, boss_kills


def min_kills_for_level(level, boss_kills):
    """升到 level 至少需要的擊殺數（非常寬鬆的下限）"""
    exp = CUM_EXP[level] - CUM_EXP[FREE_EXP_LEVEL] - boss_kills * BOSS_EXP_MAX
    return max(0, -(-exp // MAX_EXP_PER_KILL))   # 無條件進位


def plausibility_problem(level, kills, gold, job, boss_kills, prev, now):
    """檢查存檔是否合理：合理回傳 None，否則回傳簡短原因（存進 flag_reason）。
    prev 是這個帳號上一次的存檔資料列（沒有就是 None），now 是伺服器目前時間（秒）"""
    # ---- 只看這份存檔本身 ----
    if level < JOB_MIN_LEVEL[job]:
        return f"職業與等級不符（{job} 需要 Lv.{JOB_MIN_LEVEL[job]}）"
    if boss_kills > kills:
        return "Boss 擊殺數大於總擊殺數"
    if kills < min_kills_for_level(level, boss_kills):
        return "等級與擊殺數不符"
    if gold > COINS_FREE + kills * COINS_PER_KILL_MAX + boss_kills * COINS_PER_BOSS_MAX:
        return "金幣與擊殺數不符"

    # ---- 和上一次存檔比較進度速度（數值變少＝玩家重新開始，允許） ----
    if prev is not None:
        elapsed = max(0, now - (prev["updated_ts"] or 0))
        if kills - prev["kills"] > KILLS_PER_SEC_MAX * elapsed + KILLS_SLACK:
            return "擊殺數增加過快"
        if boss_kills - prev["boss_kills"] > elapsed // BOSS_INTERVAL_SEC + BOSS_SLACK:
            return "Boss 擊殺數增加過快"
        prev_level = min(max(prev["level"], 1), LEVEL_MAX)
        if level > prev_level and CUM_EXP[level] - CUM_EXP[prev_level] > EXP_PER_SEC_MAX * elapsed + LEVEL_EXP_SLACK:
            return "等級提升過快"
    return None


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
        level, kills, gold, job, boss_kills = extract_scores(save)
    except ValueError as e:
        return error(str(e), 400)

    db = get_db()
    now = now_ts()
    prev = db.execute(
        "SELECT level, kills, boss_kills, flagged, flag_reason, updated_ts FROM saves WHERE user_id = ?",
        (user["id"],),
    ).fetchone()

    # 合理性檢查：不合理也照樣存檔（不弄丟玩家資料），只是標記起來、不列入排行榜
    problem = plausibility_problem(level, kills, gold, job, boss_kills, prev, now)
    if problem:
        flagged, reason = 1, problem
    elif prev is not None and prev["flagged"] and level > UNFLAG_LEVEL:
        flagged, reason = 1, prev["flag_reason"]   # 之前被標記過：除非重新開始，否則維持標記
    else:
        flagged, reason = 0, None
    if problem and not (prev is not None and prev["flagged"] and prev["flag_reason"] == problem):
        app.logger.warning("存檔被標記 user=%s reason=%s lv=%s kills=%s boss=%s gold=%s",
                           user["username"], problem, level, kills, boss_kills, gold)

    updated_at = now_iso()
    # 有就更新、沒有就新增（SQLite 的 UPSERT 語法）
    db.execute(
        "INSERT INTO saves (user_id, data, level, kills, gold, job, boss_kills, flagged, flag_reason, "
        "updated_at, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, level = excluded.level, kills = excluded.kills, "
        "gold = excluded.gold, job = excluded.job, boss_kills = excluded.boss_kills, flagged = excluded.flagged, "
        "flag_reason = excluded.flag_reason, updated_at = excluded.updated_at, updated_ts = excluded.updated_ts",
        (user["id"], text, level, kills, gold, job, boss_kills, flagged, reason, updated_at, now),
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


if __name__ == "__main__":
    if app.config["SECRET"] == DEFAULT_SECRET:
        print("提醒：目前使用預設的 MISTWOOD_SECRET，正式環境請設定環境變數。")
    print("資料庫位置：", app.config["DB_PATH"])
    app.run(host="127.0.0.1", port=5000, debug=os.environ.get("FLASK_DEBUG") == "1")
