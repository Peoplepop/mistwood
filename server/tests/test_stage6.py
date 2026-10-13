"""晨霧森林 後端第六階段測試：即時連線票券（POST /api/rt-ticket）、與 Worker 共用的不雅字詞清單"""
import base64
import hashlib
import hmac
import json
import os
import re

import pytest

import app as app_module
from app import app as flask_app
from test_app import auth, make_save

SECRET = "test-rt-secret-0123456789"


@pytest.fixture
def rt_secret():
    old = flask_app.config.get("RT_SECRET")
    flask_app.config["RT_SECRET"] = SECRET
    yield SECRET
    flask_app.config["RT_SECRET"] = old


def unb64(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def decode(ticket, secret=SECRET):
    """驗證簽章並取出內容（和 worker/src/ticket.js 的做法相同）"""
    body, sig = ticket.split(".")
    want = hmac.new(secret.encode(), body.encode("ascii"), hashlib.sha256).digest()
    assert hmac.compare_digest(unb64(sig), want), "簽章不符"
    return json.loads(unb64(body).decode("utf-8"))


def ticket(client, token):
    return client.post("/api/rt-ticket", headers=auth(token))


def test_ticket_requires_login(client, rt_secret):
    res = client.post("/api/rt-ticket")
    assert res.status_code == 401
    res = client.post("/api/rt-ticket", headers=auth("not-a-token"))
    assert res.status_code == 401


def test_ticket_disabled_without_secret(client, register):
    flask_app.config["RT_SECRET"] = ""
    token = register("alice")
    res = ticket(client, token)
    assert res.status_code == 503
    assert "error" in res.get_json()


def test_ticket_signed_and_short_lived(client, register, clock, rt_secret):
    token = register("阿嵐")
    res = ticket(client, token)
    assert res.status_code == 200, res.get_json()
    data = res.get_json()
    assert data["username"] == "阿嵐"
    p = decode(data["ticket"])
    assert p["v"] == 1
    assert p["uid"] == data["uid"]
    assert p["name"] == "阿嵐"
    assert p["iat"] == clock()
    assert p["exp"] == data["exp"] == clock() + app_module.RT_TICKET_SEC
    assert 60 <= app_module.RT_TICKET_SEC <= 600
    # 沒有雲端存檔：等級 1、新手，顯示等級上限 = NO_SAVE_LV_MAX
    assert (p["lv"], p["job"], p["lvmax"]) == (1, "novice", app_module.NO_SAVE_LV_MAX)
    # 用別的密鑰驗證一定失敗
    with pytest.raises(AssertionError):
        decode(data["ticket"], "other-secret")


def test_ticket_uses_cloud_save_level_and_job(client, register, rt_secret):
    token = register("bob")
    res = client.put("/api/save", json={"save": make_save(lv=15, kills=500, job="archer")}, headers=auth(token))
    assert res.status_code == 200, res.get_json()
    p = decode(ticket(client, token).get_json()["ticket"])
    assert (p["lv"], p["job"]) == (15, "archer")
    assert p["lvmax"] == 15 + app_module.PRESENCE_LV_SLACK


def test_ticket_rate_limited(client, register, clock, rt_secret):
    token = register("carol")
    cap = app_module.RT_TICKET_RATE[0]
    for _ in range(cap):
        assert ticket(client, token).status_code == 200
    assert ticket(client, token).status_code == 429
    clock.advance(1 / app_module.RT_TICKET_RATE[1] + 0.1)   # 補回一次
    assert ticket(client, token).status_code == 200


def test_worker_profanity_list_matches_backend():
    """worker/src/chat.js 的不雅字詞清單要和後端完全一樣（兩邊都會過濾聊天）"""
    path = os.path.join(os.path.dirname(app_module.BASE_DIR), "worker", "src", "chat.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    block = re.search(r"export const PROFANITY = \[(.*?)\];", src, re.S).group(1)
    words = re.findall(r'"([^"]*)"', block)
    assert words == app_module.PROFANITY
    for name in ("CHAT_MAX_LEN", "CHAT_GAP_MS", "CHAT_BURST", "CHAT_BURST_WINDOW_MS"):
        m = re.search(rf"export const {name} = ([\d_]+);", src)
        assert m and int(m.group(1).replace("_", "")) == getattr(app_module, name), name
