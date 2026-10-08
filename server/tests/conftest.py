"""pytest 共用設定：每個測試都使用一個全新的暫存資料庫"""
import os
import sys

import pytest

# 讓測試可以 import 上一層的 app.py
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app as flask_app  # noqa: E402


@pytest.fixture
def client(tmp_path):
    flask_app.config["TESTING"] = True
    flask_app.config["DB_PATH"] = str(tmp_path / "test.db")   # 每個測試一個新檔案，互不影響
    with flask_app.test_client() as c:
        yield c


@pytest.fixture
def register(client):
    """註冊帳號並回傳 token 的小幫手：token = register("alice")"""
    def _register(username, password="secret123"):
        res = client.post("/api/register", json={"username": username, "password": password})
        assert res.status_code == 201, res.get_json()
        return res.get_json()["token"]
    return _register
