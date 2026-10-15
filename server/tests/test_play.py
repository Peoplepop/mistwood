"""晨霧森林 後端測試：遊玩工作階段（同一個帳號同時在兩個地方遊玩時，只有最後開始的那邊能存檔、連線）"""
import sqlite3

import pytest

import app as app_module
from app import app as flask_app
from test_app import auth, make_save
from test_stage4 import OLD_SCHEMA

SECRET = "test-rt-secret-0123456789"


@pytest.fixture
def rt_secret():
    old = flask_app.config.get("RT_SECRET")
    flask_app.config["RT_SECRET"] = SECRET
    yield SECRET
    flask_app.config["RT_SECRET"] = old


def claim(client, token):
    res = client.post("/api/claim", headers=auth(token))
    assert res.status_code == 200, res.get_json()
    return res.get_json()["sid"]


def put(client, token, save, sid=None):
    body = {"save": save}
    if sid is not None:
        body["sid"] = sid
    return client.put("/api/save", json=body, headers=auth(token))


def assert_superseded(res):
    assert res.status_code == 409
    assert res.get_json()["code"] == "superseded"


def test_claim_requires_login(client):
    assert client.post("/api/claim").status_code == 401
    assert client.get("/api/claim?sid=x").status_code == 401


def test_claim_gives_new_sid_each_time(client, register):
    token = register("alice")
    a, b = claim(client, token), claim(client, token)
    assert a and b and a != b
    res = client.post("/api/claim", headers=auth(token))
    assert res.get_json()["username"] == "alice"


def test_check_sid(client, register):
    token = register("alice")
    old = claim(client, token)
    assert client.get(f"/api/claim?sid={old}", headers=auth(token)).get_json() == {"ok": True}
    new = claim(client, token)   # 另一台裝置開始遊玩
    assert_superseded(client.get(f"/api/claim?sid={old}", headers=auth(token)))
    assert client.get(f"/api/claim?sid={new}", headers=auth(token)).status_code == 200
    assert_superseded(client.get("/api/claim", headers=auth(token)))   # 沒帶 sid 不算有效


def test_old_sid_save_rejected(client, register):
    token = register("alice")
    old = claim(client, token)
    assert put(client, token, make_save(lv=2, kills=5), old).status_code == 200
    new = claim(client, token)
    assert_superseded(put(client, token, make_save(lv=1, kills=1), old))
    # 被拒絕的存檔沒有寫入
    assert client.get("/api/save", headers=auth(token)).get_json()["save"]["player"]["lv"] == 2
    assert put(client, token, make_save(lv=3, kills=12), new).status_code == 200
    assert client.get("/api/save", headers=auth(token)).get_json()["save"]["player"]["lv"] == 3


def test_unknown_or_bad_sid_rejected(client, register):
    token = register("alice")
    assert_superseded(put(client, token, make_save(), "never-claimed"))   # 還沒 claim 過
    claim(client, token)
    assert_superseded(put(client, token, make_save(), "wrong"))
    assert_superseded(put(client, token, make_save(), 123))


def test_save_without_sid_still_accepted(client, register):
    """還沒重新整理的舊版前端不會帶 sid：照舊接受"""
    token = register("alice")
    claim(client, token)
    assert put(client, token, make_save(lv=2, kills=5)).status_code == 200
    assert put(client, token, make_save(lv=2, kills=6), "").status_code == 200


def test_sid_is_per_account(client, register):
    a, b = register("alice"), register("bob")
    sa = claim(client, a)
    claim(client, b)   # 別的帳號 claim 不影響
    assert put(client, a, make_save(), sa).status_code == 200
    assert_superseded(put(client, b, make_save(), sa))   # 拿別人的 sid 也沒用


def test_rt_ticket_old_sid_rejected(client, register, rt_secret):
    token = register("alice")
    old = claim(client, token)
    assert client.post("/api/rt-ticket", json={"sid": old}, headers=auth(token)).status_code == 200
    claim(client, token)
    assert_superseded(client.post("/api/rt-ticket", json={"sid": old}, headers=auth(token)))
    # 沒帶 sid（舊版前端）照舊發票券
    assert client.post("/api/rt-ticket", headers=auth(token)).status_code == 200


def test_presence_old_sid_rejected(client, register, clock):
    token = register("alice")
    old = claim(client, token)
    body = {"x": 100, "y": 600, "f": 1, "st": "idle", "job": "novice", "lv": 1, "sid": old}
    assert client.post("/api/presence", json=body, headers=auth(token)).status_code == 200
    claim(client, token)
    clock.advance(1)
    assert_superseded(client.post("/api/presence", json=body, headers=auth(token)))


def test_old_database_gets_play_columns(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript(OLD_SCHEMA)
    db.execute("INSERT INTO users (username, pw_hash, created_at) VALUES ('veteran', 'x', '2026-10-08T00:00:00Z')")
    db.commit()
    db.close()

    flask_app.config["TESTING"] = True
    flask_app.config["DB_PATH"] = str(path)
    with flask_app.test_client() as client:
        token = client.post("/api/register", json={"username": "newbie", "password": "secret123"},
                            headers={"X-Real-IP": "10.9.9.9"}).get_json()["token"]
        sid = claim(client, token)
        assert put(client, token, make_save(), sid).status_code == 200

    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    cols = {r[1] for r in db.execute("PRAGMA table_info(users)")}
    assert {"play_sid", "play_ts"} <= cols
    old = db.execute("SELECT * FROM users WHERE username = 'veteran'").fetchone()
    assert old["play_sid"] is None and old["play_ts"] == 0 and old["pw_hash"] == "x"   # 舊資料不受影響
    app_module.migrate_db(db)   # 重複執行不會出錯
    db.close()
