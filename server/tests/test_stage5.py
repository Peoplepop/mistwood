"""晨霧森林 後端第五階段測試：多人同步（在線狀態、頻道、聊天、表情、頻率限制、訪客觀看）"""
import sqlite3

import pytest

import app as app_module
from app import app as flask_app
from test_app import auth, make_save


def state(**kw):
    """前端回報的狀態（預設在村子裡站著）"""
    body = {"x": 200, "y": 700, "f": 1, "st": "idle", "ak": "", "ad": 0, "an": 0, "job": "novice", "lv": 1,
            "eq": {}, "em": -1, "en": 0, "ch": 0, "after": 0}
    body.update(kw)
    return body


def report(client, token, **kw):
    return client.post("/api/presence", json=state(**kw), headers=auth(token))


def ok(res):
    assert res.status_code == 200, res.get_json()
    return res.get_json()


def say(client, token, text):
    return client.post("/api/chat", json={"text": text}, headers=auth(token))


@pytest.fixture
def small(monkeypatch):
    """把頻道縮小（2 個頻道、每個 2 人），方便測試額滿"""
    monkeypatch.setattr(app_module, "CHANNELS", 2)
    monkeypatch.setattr(app_module, "CHANNEL_CAP", 2)


# ---------- 登入限制 ----------
def test_presence_and_chat_require_login(client):
    assert client.post("/api/presence", json=state()).status_code == 401
    assert client.post("/api/presence", json=state(), headers=auth("not-a-token")).status_code == 401
    assert client.post("/api/chat", json={"text": "hi"}).status_code == 401


# ---------- 加入頻道、看見彼此 ----------
def test_join_and_see_each_other(client, register, clock):
    a, b = register("alice"), register("bob")
    ra = ok(report(client, a, x=300, eq={"weapon": ["wsword", 1]}))
    assert ra["ch"] == 1 and ra["online"] == 1 and ra["players"] == [] and ra["name"] == "alice"
    clock.advance(0.4)
    rb = ok(report(client, b, x=500, f=-1, st="walk"))
    assert rb["ch"] == 1 and rb["online"] == 2 and rb["total"] == 2 and rb["chans"][0] == 2
    (pa,) = rb["players"]
    assert pa["name"] == "alice" and pa["x"] == 300 and pa["eq"] == {"weapon": ["wsword", 1]}
    clock.advance(0.4)
    (pb,) = ok(report(client, a, x=310))["players"]   # 自己不會出現在列表裡
    assert pb["name"] == "bob" and pb["f"] == -1 and pb["st"] == "walk" and pb["ts"] == clock.ms() - 400


def test_stays_in_channel_and_rejoins_preferred(client, register, clock, small):
    a, b, c = register("alice"), register("bob"), register("carol")
    assert ok(report(client, a))["ch"] == 1
    assert ok(report(client, b))["ch"] == 1
    assert ok(report(client, c))["ch"] == 2           # 頻道 1 已滿 → 自動分配到人數未滿的最小頻道
    assert ok(report(client, c, ch=1))["ch"] == 2     # 沒有要求換頻道（sw）時，留在原本的頻道
    # 離線超過 10 秒後重新上線：優先回到原本的頻道（如果還有空位）
    clock.advance(11)
    assert ok(report(client, c, ch=2))["ch"] == 2
    assert ok(report(client, a, ch=2))["ch"] == 2     # alice 已經離線過，重新上線時想去頻道 2
    assert ok(report(client, b, ch=2))["ch"] == 1     # 頻道 2 滿了（carol、alice）→ 改分配到頻道 1


def test_channel_switch(client, register, clock, small):
    a, b, c = register("alice"), register("bob"), register("carol")
    ok(report(client, a)); ok(report(client, b))
    r = ok(report(client, a, ch=2, sw=True))
    assert r["ch"] == 2 and r["sw_err"] is None and r["online"] == 1 and r["chans"] == [1, 1]
    ok(report(client, c, ch=2, sw=True))              # carol 剛上線，直接進頻道 2
    clock.advance(0.5)
    r = ok(report(client, b, ch=2, sw=True))          # 頻道 2 已滿：換頻道失敗，留在原頻道並回傳原因
    assert r["ch"] == 1 and "已滿" in r["sw_err"]


def test_all_channels_full(client, register, small):
    tokens = [register(f"user{i}") for i in range(5)]
    for t in tokens[:4]:
        ok(report(client, t))
    res = report(client, tokens[4])
    assert res.status_code == 503 and "已滿" in res.get_json()["error"]


def test_concurrent_capacity_is_never_exceeded(client, register, clock, small):
    """模擬很多人同時上線：每個頻道都不會超過上限"""
    tokens = [register(f"user{i}") for i in range(6)]
    results = [report(client, t) for t in tokens]
    chans = [r.get_json()["ch"] for r in results if r.status_code == 200]
    assert sorted(chans) == [1, 1, 2, 2] and sum(r.status_code == 503 for r in results) == 2


# ---------- 離線清除 ----------
def test_stale_players_are_pruned(client, register, clock):
    a, b = register("alice"), register("bob")
    ok(report(client, a)); ok(report(client, b))
    clock.advance(9.9)
    assert len(ok(report(client, a))["players"]) == 1   # 9.9 秒：bob 還算在線
    clock.advance(0.5)                                    # bob 已經 10.4 秒沒有回報
    r = ok(report(client, a))
    assert r["players"] == [] and r["online"] == 1 and r["total"] == 1
    db = sqlite3.connect(app_module.live_db_path())
    assert db.execute("SELECT COUNT(*) FROM presence").fetchone()[0] == 1   # 資料列真的被刪掉
    db.close()


def test_logout_removes_presence(client, register):
    a, b = register("alice"), register("bob")
    ok(report(client, a)); ok(report(client, b))
    assert client.post("/api/logout", headers=auth(b)).status_code == 200
    assert ok(report(client, a))["players"] == []


# ---------- 欄位檢查 ----------
def test_rejects_absurd_values(client, register, clock):
    a = register("alice")
    for bad in ({"x": "100"}, {"x": None}, {"x": 99999}, {"y": -5000}, {"x": float("nan")},
                {"lv": 0}, {"lv": 201}, {"lv": 3.5}, {"lv": "5"}, {"lv": True}):
        clock.advance(1)
        res = report(client, a, **bad)
        assert res.status_code == 400, bad
    assert client.post("/api/presence", data="nope", headers=auth(a)).status_code == 400


def test_clamps_and_sanitizes_fields(client, register, clock):
    a, b = register("alice"), register("bob")
    ok(report(client, a, x=-20, y=780, f=5, st="<script>", ak="hack", ad=99, an=-3, job="god", lv=7, em=42, en=-1,
              eq={"weapon": ["isword", 9], "hat": ["<b>", 1], "top": ["shirt", 2], "pet": ["cat", 1], "acc": "dew"}))
    (p,) = ok(report(client, b))["players"]
    assert (p["x"], p["y"], p["f"], p["st"], p["ak"], p["ad"], p["an"]) == (0, 760, 1, "idle", "", 1.5, 0)
    assert (p["job"], p["lv"], p["em"], p["en"]) == ("novice", 7, -1, 0)
    assert p["eq"] == {"top": ["shirt", 2]}


def test_level_and_job_capped_by_cloud_save(client, register, clock):
    a, b = register("alice"), register("bob")
    ok(report(client, a, lv=150, job="wizard"))       # 還沒有雲端存檔：最多顯示 Lv.10，職業不符就當新手
    (p,) = ok(report(client, b))["players"]
    assert p["lv"] == app_module.NO_SAVE_LV_MAX and p["job"] == "novice"
    assert client.put("/api/save", json={"save": make_save(lv=30, kills=2000, coins=1000, job="knight", boss=0)},
                      headers=auth(a)).status_code == 200
    clock.advance(1)
    ok(report(client, a, lv=150, job="knight"))
    clock.advance(1)
    (p,) = ok(report(client, b))["players"]
    assert p["lv"] == 30 + app_module.PRESENCE_LV_SLACK and p["job"] == "knight"


# ---------- 頻率限制 ----------
def test_presence_rate_limit(client, register, clock):
    a = register("alice")
    for _ in range(5):
        ok(report(client, a))
    res = report(client, a)
    assert res.status_code == 429
    clock.advance(0.2)                                 # 每秒補 5 次 → 0.2 秒後可以再回報一次
    ok(report(client, a))
    assert report(client, a).status_code == 429


def test_guest_view_is_read_only_and_rate_limited(client, register, clock):
    a = register("alice")
    ok(report(client, a, x=900, ch=0))
    ok(report(client, a, ch=3, sw=True))
    ok(say(client, a, "大家好"))
    g = client.get("/api/presence", headers={"X-Real-IP": "9.9.9.9"}).get_json()   # 不帶頻道：人最多的頻道
    assert g["guest"] is True and g["ch"] == 3 and g["players"][0]["name"] == "alice"
    assert [m["text"] for m in g["chat"]] == ["大家好"] and g["hist"] is True
    g1 = client.get("/api/presence?ch=1", headers={"X-Real-IP": "9.9.9.9"}).get_json()
    assert g1["ch"] == 1 and g1["players"] == [] and g1["total"] == 1
    # 訪客不會被算進人數
    assert ok(report(client, a))["online"] == 1
    assert client.get("/api/presence?ch=x").status_code == 400
    codes = [client.get("/api/presence?ch=1", headers={"X-Real-IP": "8.8.8.8"}).status_code for _ in range(8)]
    assert codes[:6] == [200] * 6 and codes[-1] == 429
    clock.advance(1)
    assert client.get("/api/presence?ch=1", headers={"X-Real-IP": "8.8.8.8"}).status_code == 200


# ---------- 聊天 ----------
def test_chat_send_and_receive(client, register, clock):
    a, b = register("alice"), register("bob")
    ra = ok(report(client, a))
    r = ok(say(client, a, "  哈囉   大家  "))
    assert r["msg"]["text"] == "哈囉 大家" and r["msg"]["name"] == "alice" and r["ch"] == 1
    rb = ok(report(client, b))                          # 剛上線：拿到最近的歷史訊息
    assert rb["hist"] is True and [m["text"] for m in rb["chat"]] == ["哈囉 大家"] and rb["cursor"] == r["msg"]["id"]
    clock.advance(2)
    ok(say(client, a, "第二句"))
    clock.advance(0.4)
    got = ok(report(client, b, after=rb["cursor"]))
    assert [(m["name"], m["text"]) for m in got["chat"]] == [("alice", "第二句")] and got["hist"] is False
    clock.advance(0.4)
    again = ok(report(client, b, after=got["cursor"]))
    assert again["chat"] == []                          # 游標之後沒有新訊息
    clock.advance(0.4)
    assert ok(report(client, a, after=ra["cursor"] or 1))["chat"][-1]["uid"] == ra["me"]


def test_chat_is_channel_scoped_and_history_on_join(client, register, clock):
    a, b, c = register("alice"), register("bob"), register("carol")
    ok(report(client, a)); ok(report(client, b, ch=2, sw=True))
    ok(say(client, a, "頻道一"))
    clock.advance(2)
    ok(say(client, b, "頻道二"))
    rb = ok(report(client, b))
    assert [m["text"] for m in rb["chat"]] == ["頻道二"]          # 只看得到自己頻道的訊息
    r = ok(report(client, c))                                      # 新上線：拿到頻道 1 最近的歷史訊息
    assert r["hist"] is True and [m["text"] for m in r["chat"]] == ["頻道一"]
    clock.advance(1)
    r = ok(report(client, b, ch=1, sw=True, after=rb["cursor"]))   # 換到頻道 1：改回傳頻道 1 的歷史
    assert r["ch"] == 1 and r["hist"] is True and [m["text"] for m in r["chat"]] == ["頻道一"]


def test_chat_validation_and_filter(client, register, clock):
    a = register("alice")
    ok(report(client, a))
    assert say(client, a, "").status_code == 400
    assert say(client, a, "   \n\t ").status_code == 400
    assert say(client, a, "​‮").status_code == 400         # 只有隱藏字元也算空白
    assert client.post("/api/chat", json={"text": 123}, headers=auth(a)).status_code == 400
    assert say(client, a, "字" * 61).status_code == 400
    r = ok(say(client, a, "字" * 60))
    assert len(r["msg"]["text"]) == 60
    clock.advance(2)
    r = ok(say(client, a, "你這個白癡，FUCK you ｓｈｉｔ"))
    assert r["msg"]["text"] == "你這個＊＊，＊＊＊＊ you ＊＊＊＊"
    clock.advance(2)
    r = ok(say(client, a, "<img src=x onerror=alert(1)>‮gnp.exe"))   # 原樣保留成文字（前端只用 textContent／畫布顯示）
    assert r["msg"]["text"] == "<img src=x onerror=alert(1)>gnp.exe"
    clock.advance(2)
    assert ok(say(client, a, "操作說明在設定裡，三小時後見"))["msg"]["text"] == "操作說明在設定裡，三小時後見"   # 不誤判


def test_chat_rate_limits(client, register, clock):
    a = register("alice")
    ok(report(client, a))
    ok(say(client, a, "1"))
    clock.advance(1)
    res = say(client, a, "2")
    assert res.status_code == 429 and "太快" in res.get_json()["error"]
    for i in range(4):                                  # 間隔 1.5 秒：20 秒內最多 5 則
        clock.advance(1.6)
        ok(report(client, a))
        ok(say(client, a, f"msg{i}"))
    clock.advance(1.6)
    res = say(client, a, "too many")
    assert res.status_code == 429 and "太多" in res.get_json()["error"]
    clock.advance(20)
    ok(report(client, a))
    ok(say(client, a, "ok again"))


def test_chat_requires_being_online(client, register, clock):
    a = register("alice")
    assert say(client, a, "hi").status_code == 409     # 還沒回報在線狀態
    ok(report(client, a))
    clock.advance(11)
    assert say(client, a, "hi").status_code == 409     # 已經離線


def test_chat_auto_prune(client, register, clock, monkeypatch):
    monkeypatch.setattr(app_module, "CHAT_KEEP", 3)
    monkeypatch.setattr(app_module, "CHAT_GAP_MS", 0)
    monkeypatch.setattr(app_module, "CHAT_BURST", 100)
    a = register("alice")
    ok(report(client, a))
    for i in range(5):
        ok(say(client, a, f"m{i}"))
    db = sqlite3.connect(app_module.live_db_path())
    assert [r[0] for r in db.execute("SELECT text FROM chat ORDER BY id")] == ["m2", "m3", "m4"]
    clock.advance(9)
    ok(report(client, a))
    clock.advance(9)
    ok(report(client, a))
    ok(say(client, a, "new"))                           # 18 秒後說話；10 分鐘以上的訊息才會被清掉
    assert db.execute("SELECT COUNT(*) FROM chat").fetchone()[0] == 3
    clock.advance(11 * 60)
    ok(report(client, a))
    ok(say(client, a, "later"))
    assert [r[0] for r in db.execute("SELECT text FROM chat ORDER BY id")] == ["later"]
    db.close()


# ---------- 表情 ----------
def test_emote_age(client, register, clock):
    a, b = register("alice"), register("bob")
    ok(report(client, a, em=2, en=1))
    clock.advance(1)
    (p,) = ok(report(client, b))["players"]
    assert p["em"] == 2 and p["en"] == 1 and p["ea"] == 1000
    clock.advance(1)
    ok(report(client, a, em=2, en=1))                   # 同一個表情序號：開始時間不變
    clock.advance(0.5)
    (p,) = ok(report(client, b))["players"]
    assert p["ea"] == 2500
    ok(report(client, a, em=-1, en=1))
    clock.advance(0.5)
    (p,) = ok(report(client, b))["players"]
    assert p["em"] == -1 and p["ea"] is None


# ---------- 即時資料庫 ----------
def test_live_db_is_separate_file(client, register):
    a = register("alice")
    ok(report(client, a))
    main = sqlite3.connect(flask_app.config["DB_PATH"])
    tables = {r[0] for r in main.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    main.close()
    assert "presence" not in tables and "users" in tables
    live = sqlite3.connect(app_module.live_db_path())
    tables = {r[0] for r in live.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    live.close()
    assert {"presence", "chat", "rate_buckets"} <= tables and "users" not in tables
