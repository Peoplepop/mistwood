"""晨霧森林 後端第四階段測試：舊資料庫升級、Boss 排行榜、存檔合理性檢查、註冊頻率限制"""
import sqlite3

from werkzeug.security import generate_password_hash

import app as app_module
from app import app as flask_app
from test_app import auth, make_save


def put(client, token, save):
    return client.put("/api/save", json={"save": save}, headers=auth(token))


def board(client, by="level", token=None):
    return client.get(f"/api/leaderboard?by={by}", headers=auth(token) if token else {}).get_json()


def ranked_and_reason(client, token, save):
    """上傳存檔並回傳 (ranked, flag_reason)"""
    res = put(client, token, save)
    assert res.status_code == 200, res.get_json()
    body = res.get_json()
    return body["ranked"], body["flag_reason"]


# ---------- 舊版資料庫自動升級 ----------
OLD_SCHEMA = """
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    pw_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE saves (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL,
                    level INTEGER NOT NULL DEFAULT 1, kills INTEGER NOT NULL DEFAULT 0, gold INTEGER NOT NULL DEFAULT 0,
                    job TEXT NOT NULL DEFAULT 'novice', updated_at TEXT NOT NULL);
CREATE TABLE login_fails (username TEXT NOT NULL COLLATE NOCASE, ts INTEGER NOT NULL);
"""


def test_old_database_is_migrated_in_place(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript(OLD_SCHEMA)
    db.execute("INSERT INTO users (username, pw_hash, created_at) VALUES ('veteran', ?, '2026-10-08T00:00:00Z')",
               (generate_password_hash("secret123"),))
    db.execute("INSERT INTO saves (user_id, data, level, kills, gold, job, updated_at) "
               "VALUES (1, ?, 15, 0, 300, 'warrior', '2026-10-08T03:12:45Z')", ('{"player":{"lv":15}}',))
    db.commit()
    db.close()

    flask_app.config["TESTING"] = True
    flask_app.config["DB_PATH"] = str(path)
    with flask_app.test_client() as client:
        data = board(client)
        assert data["total"] == 1   # 舊資料保留，而且照樣上榜
        entry = data["entries"][0]
        assert entry["username"] == "veteran" and entry["level"] == 15 and entry["bossKills"] == 0

        # 舊帳號可以照常登入、讀取並上傳存檔
        token = client.post("/api/login", json={"username": "veteran", "password": "secret123"}).get_json()["token"]
        assert client.get("/api/save", headers=auth(token)).get_json()["save"] == {"player": {"lv": 15}}
        res = put(client, token, make_save(lv=16, coins=500, kills=30, job="warrior", boss=1))
        assert res.status_code == 200 and res.get_json()["ranked"] is True
        assert board(client, "boss")["entries"][0]["bossKills"] == 1

    db = sqlite3.connect(path)
    cols = {r[1] for r in db.execute("PRAGMA table_info(saves)")}
    assert {"boss_kills", "flagged", "flag_reason", "updated_ts", "hw_kills", "hw_exp_ts"} <= cols
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "register_log" in tables
    db.close()


def test_migration_backfills_timestamp_and_is_idempotent(tmp_path):
    db = sqlite3.connect(tmp_path / "m.db")
    db.row_factory = sqlite3.Row
    db.executescript(OLD_SCHEMA)
    db.execute("INSERT INTO users (username, pw_hash, created_at) VALUES ('a', 'x', 'now')")
    db.execute("INSERT INTO saves (user_id, data, level, kills, updated_at) "
               "VALUES (1, '{}', 25, 700, '2026-10-08T03:12:45Z')")
    app_module.migrate_db(db)
    app_module.migrate_db(db)   # 重複執行不會出錯
    row = db.execute("SELECT * FROM saves").fetchone()
    ts = 1791429165             # 2026-10-08T03:12:45Z 的 Unix 時間
    assert row["updated_ts"] == ts
    assert row["flagged"] == 0 and row["boss_kills"] == 0 and row["flag_reason"] is None
    # 最高合理進度從目前的數值開始
    assert (row["hw_kills"], row["hw_boss"], row["hw_exp"]) == (700, 0, app_module.CUM_EXP[25])
    assert row["hw_kills_ts"] == row["hw_boss_ts"] == row["hw_exp_ts"] == ts
    db.close()


# ---------- Boss 排行榜 ----------
def test_leaderboard_by_boss(client, register):
    saves = {
        "slayer": make_save(lv=32, kills=3000, job="knight", boss=12),
        "hunter1": make_save(lv=31, kills=2500, job="hunter", boss=5),
        "newbie": make_save(lv=3, kills=10),            # 舊版前端的存檔沒有 bossKills → 當作 0
    }
    for name, save in saves.items():
        assert put(client, register(name), save).get_json()["ranked"] is True

    data = board(client, "boss")
    assert data["by"] == "boss"
    assert [e["username"] for e in data["entries"]] == ["slayer", "hunter1", "newbie"]
    assert [e["value"] for e in data["entries"]] == [12, 5, 0]
    for by in ["level", "kills", "gold", "boss"]:   # 每種排行榜的每一列都有 bossKills
        for e in board(client, by)["entries"]:
            assert e["bossKills"] == saves[e["username"]]["player"]["stats"].get("bossKills", 0)


def test_boss_kills_bad_values_rejected(client, register):
    token = register("bad")
    for boss in ["3", -1, 1.5, True, 10 ** 9]:
        res = put(client, token, make_save(lv=1, kills=5, boss=boss))
        assert res.status_code == 400, boss
        assert "Boss" in res.get_json()["error"]


# ---------- 合理性檢查（單一存檔） ----------
def test_job_must_match_level(client, register):
    cases = [
        (make_save(lv=9, kills=50, job="warrior"), False),
        (make_save(lv=10, kills=50, job="warrior"), True),
        (make_save(lv=10, kills=50, job="mage"), True),
        (make_save(lv=29, kills=500, job="knight"), False),
        (make_save(lv=30, kills=500, job="knight"), True),
        (make_save(lv=30, kills=500, job="wizard"), True),
        (make_save(lv=30, kills=500, job="hunter"), True),
        (make_save(lv=1, kills=0, job="novice"), True),
        (make_save(lv=40, kills=1000, job="novice"), True),       # 不轉職也可以
        (make_save(lv=1, kills=0, job="dragon"), True),           # 不認識的職業當作 novice
    ]
    for i, (save, ok) in enumerate(cases):
        ranked, reason = ranked_and_reason(client, register(f"job{i}"), save)
        assert ranked is ok, (save, reason)
        if not ok:
            assert "職業" in reason


def test_level_requires_minimum_kills(client, register):
    assert app_module.min_kills_for_level(20, 0) == 0     # Lv.20 以前不要求擊殺數（任務獎勵、舊存檔）
    assert app_module.min_kills_for_level(25, 0) == 0     # Lv.20 之後的任務經驗值也扣掉
    assert app_module.min_kills_for_level(30, 0) == 32
    assert app_module.min_kills_for_level(30, 1) == 15    # Boss 給的經驗值也算進去
    assert ranked_and_reason(client, register("a1"), make_save(lv=20, kills=0, job="mage")) == (True, None)
    assert ranked_and_reason(client, register("a2"), make_save(lv=30, kills=32, job="mage")) == (True, None)
    assert ranked_and_reason(client, register("a3"), make_save(lv=30, kills=31, job="mage")) == (False, "等級與擊殺數不符")
    assert ranked_and_reason(client, register("a4"), make_save(lv=200, kills=0)) == (False, "等級與擊殺數不符")


def test_boss_kills_cannot_exceed_kills(client, register):
    ranked, reason = ranked_and_reason(client, register("b1"), make_save(lv=5, kills=3, boss=4))
    assert ranked is False and "Boss" in reason


def test_coins_upper_bound(client, register):
    assert ranked_and_reason(client, register("c1"), make_save(lv=5, kills=0, coins=100_000))[0] is True
    assert ranked_and_reason(client, register("c2"), make_save(lv=5, kills=0, coins=100_001)) == (False, "金幣與擊殺數不符")
    assert ranked_and_reason(client, register("c3"), make_save(lv=5, kills=10, coins=120_000))[0] is True


def test_hard_limits_still_return_400(client, register):
    token = register("hard")
    assert put(client, token, make_save(lv=201)).status_code == 400
    assert put(client, token, make_save(kills=-1)).status_code == 400
    assert client.get("/api/save", headers=auth(token)).get_json()["save"] is None   # 400 的存檔不會被儲存


# ---------- 被標記的存檔：照樣保存，但不上排行榜 ----------
def test_flagged_save_is_kept_but_hidden_from_leaderboard(client, register):
    honest = register("honest")
    cheat = register("cheat")
    put(client, honest, make_save(lv=12, kills=300, coins=800, job="archer"))
    cheat_save = make_save(lv=150, kills=5, coins=999, job="wizard", boss=2)
    res = put(client, cheat, cheat_save)
    assert res.status_code == 200
    assert res.get_json()["ranked"] is False and res.get_json()["flag_reason"]

    # 資料沒有遺失
    data = client.get("/api/save", headers=auth(cheat)).get_json()
    assert data["save"] == cheat_save and data["ranked"] is False
    assert client.get("/api/save", headers=auth(honest)).get_json()["ranked"] is True

    for by in ["level", "kills", "gold", "boss"]:
        data = board(client, by, token=cheat)
        assert [e["username"] for e in data["entries"]] == ["honest"]
        assert data["total"] == 1
        assert data["me"]["rank"] is None and data["me"]["ranked"] is False
    assert board(client, "level", token=cheat)["me"]["value"] == 150
    assert board(client, "level", token=honest)["me"] == {"username": "honest", "rank": 1, "value": 12, "ranked": True}


def test_flag_stays_until_progress_reset(client, register, clock):
    token = register("flagme")
    assert ranked_and_reason(client, token, make_save(lv=200, kills=0)) == (False, "等級與擊殺數不符")
    clock.advance(3600)
    # 之後的存檔就算合理也維持標記（保留第一次的原因）
    assert ranked_and_reason(client, token, make_save(lv=10, kills=100)) == (False, "等級與擊殺數不符")
    clock.advance(3600)
    # 重新開始（等級 ≤ 5）而且存檔合理 → 解除標記
    assert ranked_and_reason(client, token, make_save(lv=5, kills=0)) == (True, None)
    assert [e["username"] for e in board(client)["entries"]] == ["flagme"]


# ---------- 合理性檢查（和上一次存檔比較進度速度） ----------
def test_kills_rate_limit(client, register, clock):
    token = register("fast")
    assert ranked_and_reason(client, token, make_save(lv=1, kills=0))[0] is True
    clock.advance(10)
    assert ranked_and_reason(client, token, make_save(lv=1, kills=350))[0] is True      # 5 × 10 秒 + 300 寬限
    clock.advance(10)
    assert ranked_and_reason(client, token, make_save(lv=1, kills=701)) == (False, "擊殺數增加過快")


def test_boss_kills_rate_limit(client, register, clock):
    token = register("bossy")
    assert ranked_and_reason(client, token, make_save(lv=1, kills=1000, boss=0))[0] is True
    clock.advance(60)
    assert ranked_and_reason(client, token, make_save(lv=1, kills=1000, boss=4))[0] is True   # 60 秒 1 次 + 3 寬限
    clock.advance(1)
    assert ranked_and_reason(client, token, make_save(lv=1, kills=1000, boss=8)) == (False, "Boss 擊殺數增加過快")


def test_level_rate_limit(client, register, clock):
    slow, quick = register("slow"), register("quick")
    for token in (slow, quick):
        assert ranked_and_reason(client, token, make_save(lv=20, kills=2000, job="warrior"))[0] is True
    clock.advance(1)
    # Lv.20 → Lv.35 需要約 13.8 萬經驗值，1 秒內不可能（寬限 3166 × 秒數 ＋ 7 萬）
    assert ranked_and_reason(client, quick, make_save(lv=35, kills=2000, job="knight")) == (False, "等級提升過快")
    clock.advance(29)
    assert ranked_and_reason(client, slow, make_save(lv=35, kills=2000, job="knight"))[0] is True


def test_realistic_level30_player_is_ranked(client, register, clock):
    # 實際玩法：約 60 隻怪、打倒 1 次 Boss、交完全部任務就到 Lv.30 並二轉
    token = register("real30")
    assert ranked_and_reason(client, token, make_save(lv=1, kills=0))[0] is True
    clock.advance(600)
    assert ranked_and_reason(client, token, make_save(lv=22, kills=40, coins=9000, job="archer"))[0] is True
    clock.advance(30)   # 一次交了好幾個任務，經驗值一口氣增加
    save = make_save(lv=30, kills=60, coins=25000, job="hunter", boss=1)
    save["player"]["exp"] = 500
    assert ranked_and_reason(client, token, save) == (True, None)


# ---------- 多裝置：和最高合理進度（high-water mark）比較 ----------
def hw_row(username):
    db = sqlite3.connect(flask_app.config["DB_PATH"])
    db.row_factory = sqlite3.Row
    row = db.execute("SELECT saves.* FROM saves JOIN users ON users.id = saves.user_id WHERE username = ?",
                     (username,)).fetchone()
    db.close()
    return row


def test_multi_device_older_save_does_not_cause_false_flag(client, register, clock):
    token = register("twodev")
    # 裝置 A 正常遊玩並上傳
    assert ranked_and_reason(client, token, make_save(lv=30, kills=2000, job="knight", boss=2))[0] is True
    clock.advance(600)
    # 裝置 B 上傳較舊、較低的進度：允許（照樣存檔、照樣上榜），但不會拉低基準
    assert ranked_and_reason(client, token, make_save(lv=25, kills=1200, job="warrior", boss=1))[0] is True
    row = hw_row("twodev")
    assert row["level"] == 25 and row["kills"] == 1200   # 存的是最新上傳的資料
    assert (row["hw_kills"], row["hw_boss"], row["hw_exp"]) == (2000, 2, app_module.CUM_EXP[30])
    clock.advance(10)
    # 裝置 A 以正常速度繼續（距離 A 上次上傳 610 秒）→ 不會被誤判
    # （若和上一份存檔比較，10 秒內擊殺 +3800、Boss +4、Lv.25→31 都會被判定過快）
    assert ranked_and_reason(client, token, make_save(lv=31, kills=5000, job="knight", boss=5)) == (True, None)
    row = hw_row("twodev")
    assert (row["hw_kills"], row["hw_boss"]) == (5000, 5)
    clock.advance(1)
    # 真的在 1 秒內暴增，和基準比較還是會被抓到
    assert ranked_and_reason(client, token, make_save(lv=31, kills=5400, job="knight", boss=5)) == (False, "擊殺數增加過快")


def test_flagged_save_does_not_advance_high_water(client, register, clock):
    token = register("nohw")
    assert ranked_and_reason(client, token, make_save(lv=1, kills=100))[0] is True
    clock.advance(1)
    assert ranked_and_reason(client, token, make_save(lv=1, kills=5000))[0] is False
    assert hw_row("nohw")["hw_kills"] == 100
    clock.advance(10)
    # 重新開始 → 解除標記，基準重設成這份存檔
    assert ranked_and_reason(client, token, make_save(lv=1, kills=3))[0] is True
    row = hw_row("nohw")
    assert row["hw_kills"] == 3 and row["hw_kills_ts"] == clock.now


def test_constants_cover_frontend_values():
    # 前端（index.html）目前的數值：一般怪最高 420 經驗、Boss 9000 經驗、Lv.20 之後任務共 33,500 經驗
    assert app_module.MAX_EXP_PER_KILL >= 420
    assert app_module.BOSS_EXP_MAX >= 9000
    assert app_module.QUEST_EXP_ABOVE_FREE >= 2500 + 6000 + 12000 + 10000 + 3000
    # Boss：5 堆金幣（每堆最多 700）＋ 2 件裝備（最貴 6000 × 0.25 × 傳說 8 倍）
    assert app_module.COINS_PER_BOSS_MAX >= 5 * 700 + 2 * 6000 * 0.25 * 8


def test_progress_decrease_is_allowed(client, register, clock):
    token = register("reset")
    assert ranked_and_reason(client, token, make_save(lv=35, kills=5000, job="hunter", boss=20))[0] is True
    clock.advance(1)
    assert ranked_and_reason(client, token, make_save(lv=1, kills=0))[0] is True


def test_old_frontend_save_response(client, register):
    token = register("oldfe")
    res = put(client, token, make_save(lv=12, kills=200, coins=3000, job="archer"))
    assert res.status_code == 200
    body = res.get_json()
    assert body["ok"] is True and body["ranked"] is True and body["updated_at"].endswith("Z")


# ---------- 註冊頻率限制（依 IP） ----------
def reg(client, name, ip=None, headers=None, password="secret123"):
    headers = dict(headers or {})
    if ip:
        headers["X-Real-IP"] = ip
    return client.post("/api/register", json={"username": name, "password": password}, headers=headers)


def test_register_limit_successes_per_ip(client, clock):
    for i in range(3):
        assert reg(client, f"u{i}", ip="1.2.3.4").status_code == 201
    res = reg(client, "u3", ip="1.2.3.4")
    assert res.status_code == 429
    assert "帳號太多" in res.get_json()["error"]
    assert reg(client, "other", ip="5.6.7.8").status_code == 201   # 其他 IP 不受影響
    clock.advance(3601)
    assert reg(client, "u3", ip="1.2.3.4").status_code == 201        # 1 小時後恢復


def test_register_limit_attempts_per_ip(client, clock):
    for _ in range(10):
        assert reg(client, "x", ip="9.9.9.9", password="123").status_code == 400   # 帳號太短
    res = reg(client, "goodname", ip="9.9.9.9")
    assert res.status_code == 429
    assert "嘗試次數過多" in res.get_json()["error"]
    clock.advance(601)
    assert reg(client, "goodname", ip="9.9.9.9").status_code == 201   # 10 分鐘後恢復


def test_register_ip_header_priority(client, clock):
    for i in range(3):   # 沒有 X-Real-IP 時取 X-Forwarded-For 的第一個 IP
        assert reg(client, f"f{i}", headers={"X-Forwarded-For": "7.7.7.7, 10.0.0.1"}).status_code == 201
    assert reg(client, "f3", headers={"X-Forwarded-For": "7.7.7.7"}).status_code == 429
    # 有 X-Real-IP 時以它為準
    assert reg(client, "f4", headers={"X-Real-IP": "8.8.8.8", "X-Forwarded-For": "7.7.7.7"}).status_code == 201


def test_register_log_is_pruned(client, clock):
    assert reg(client, "p1", ip="3.3.3.3").status_code == 201
    clock.advance(3601)
    assert reg(client, "p2", ip="4.4.4.4").status_code == 201
    db = sqlite3.connect(flask_app.config["DB_PATH"])
    ips = [r[0] for r in db.execute("SELECT ip FROM register_log")]
    db.close()
    assert ips == ["4.4.4.4"]   # 超過 1 小時的紀錄已經清掉


def test_register_limits_are_configurable(client, clock, monkeypatch):
    monkeypatch.setattr(app_module, "REGISTER_OK_MAX", 1)
    assert reg(client, "c1", ip="2.2.2.2").status_code == 201
    assert reg(client, "c2", ip="2.2.2.2").status_code == 429
