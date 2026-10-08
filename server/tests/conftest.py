"""pytest 共用設定：每個測試都使用一個全新的暫存資料庫"""
import itertools
import os
import sys

import pytest

# 讓測試可以 import 上一層的 app.py
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module  # noqa: E402
from app import app as flask_app  # noqa: E402


@pytest.fixture
def client(tmp_path):
    flask_app.config["TESTING"] = True
    flask_app.config["DB_PATH"] = str(tmp_path / "test.db")   # 每個測試一個新檔案，互不影響
    with flask_app.test_client() as c:
        yield c


@pytest.fixture
def register(client):
    """註冊帳號並回傳 token 的小幫手：token = register("alice")
    每次註冊都用不同的 IP，避免碰到「同一個 IP 註冊次數限制」"""
    ips = itertools.count(1)

    def _register(username, password="secret123"):
        n = next(ips)
        ip = f"10.0.{n // 250}.{n % 250 + 1}"
        res = client.post("/api/register", json={"username": username, "password": password},
                          headers={"X-Real-IP": ip})
        assert res.status_code == 201, res.get_json()
        return res.get_json()["token"]
    return _register


class FakeClock:
    """可以手動調整的時鐘（取代 app.now_ts 與 app.now_ms），用來測試進度速度、註冊頻率限制與多人同步"""

    def __init__(self, start=1_800_000_000):
        self.now = start

    def __call__(self):
        return int(self.now)

    def ms(self):
        return int(round(self.now * 1000))

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock()
    monkeypatch.setattr(app_module, "now_ts", fake)
    monkeypatch.setattr(app_module, "now_ms", fake.ms)
    return fake
