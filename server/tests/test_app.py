"""晨霧森林 後端測試（執行方式：在 server 資料夾輸入 python -m pytest）"""


def auth(token):
    """產生帶 token 的標頭"""
    return {"Authorization": f"Bearer {token}"}


def make_save(lv=1, coins=0, kills=0, job="novice"):
    """產生一份最小的測試存檔（格式和前端 saveState() 一樣）"""
    return {"v": 2, "savedAt": 1700000000000, "player": {"lv": lv, "coins": coins, "job": job, "stats": {"kills": kills}}}


# ---------- 健康檢查與錯誤格式 ----------
def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.get_json()["ok"] is True


def test_unknown_api_returns_json_error(client):
    res = client.get("/api/not-exist")
    assert res.status_code == 404
    assert res.get_json() == {"error": "找不到這個 API"}


def test_wrong_method_returns_json_error(client):
    res = client.delete("/api/save")
    assert res.status_code == 405
    assert "error" in res.get_json()


# ---------- 註冊 ----------
def test_register_success(client):
    res = client.post("/api/register", json={"username": "阿嵐_01", "password": "secret123"})
    assert res.status_code == 201
    data = res.get_json()
    assert data["username"] == "阿嵐_01"
    assert len(data["token"]) > 20


def test_register_duplicate_name_is_case_insensitive(client, register):
    register("Alice")
    res = client.post("/api/register", json={"username": "alice", "password": "secret123"})
    assert res.status_code == 409
    assert "已經有人使用" in res.get_json()["error"]


def test_register_validation(client):
    bad_cases = [
        {"username": "a", "password": "secret123"},               # 太短
        {"username": "a" * 13, "password": "secret123"},          # 太長
        {"username": "bad name", "password": "secret123"},        # 有空白
        {"username": "<script>", "password": "secret123"},        # 特殊字元
        {"username": "bob", "password": "12345"},                 # 密碼太短
        {"username": "bob", "password": "x" * 65},                # 密碼太長
        {"username": 123, "password": "secret123"},               # 型別錯誤
    ]
    for body in bad_cases:
        res = client.post("/api/register", json=body)
        assert res.status_code == 400, body
        assert "error" in res.get_json()


def test_register_requires_json(client):
    res = client.post("/api/register", data="not json", content_type="text/plain")
    assert res.status_code == 400
    assert "error" in res.get_json()


# ---------- 登入／登出 ----------
def test_login_success(client, register):
    register("bob")
    res = client.post("/api/login", json={"username": "BOB", "password": "secret123"})
    assert res.status_code == 200
    data = res.get_json()
    assert data["username"] == "bob"
    assert data["token"]


def test_login_wrong_password(client, register):
    register("bob")
    res = client.post("/api/login", json={"username": "bob", "password": "wrong-pass"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "帳號或密碼錯誤"


def test_login_unknown_user(client):
    res = client.post("/api/login", json={"username": "nobody", "password": "secret123"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "帳號或密碼錯誤"


def test_login_locked_after_too_many_failures(client, register):
    register("carol")
    for _ in range(5):
        res = client.post("/api/login", json={"username": "carol", "password": "wrong-pass"})
        assert res.status_code == 401
    # 第 6 次就算密碼正確也會被暫時擋下
    res = client.post("/api/login", json={"username": "carol", "password": "secret123"})
    assert res.status_code == 429
    assert "次數過多" in res.get_json()["error"]


def test_logout_invalidates_token(client, register):
    token = register("dave")
    assert client.get("/api/save", headers=auth(token)).status_code == 200
    assert client.post("/api/logout", headers=auth(token)).status_code == 200
    assert client.get("/api/save", headers=auth(token)).status_code == 401


# ---------- 存檔 ----------
def test_save_requires_login(client):
    assert client.get("/api/save").status_code == 401
    assert client.put("/api/save", json={"save": make_save()}).status_code == 401
    res = client.get("/api/save", headers=auth("fake-token"))
    assert res.status_code == 401
    assert res.get_json()["error"] == "請先登入"


def test_save_roundtrip(client, register):
    token = register("erin")
    res = client.get("/api/save", headers=auth(token))
    assert res.get_json()["save"] is None   # 一開始沒有雲端存檔

    save = make_save(lv=7, coins=321, kills=55, job="novice")
    save["player"]["bag"] = [{"b": "cap", "r": 1, "st": {"def": 2}}]
    res = client.put("/api/save", json={"save": save}, headers=auth(token))
    assert res.status_code == 200
    assert res.get_json()["updated_at"].endswith("Z")

    res = client.get("/api/save", headers=auth(token))
    data = res.get_json()
    assert data["save"] == save
    assert data["username"] == "erin"
    assert data["updated_at"]


def test_save_size_limit(client, register):
    token = register("frank")
    save = make_save()
    save["junk"] = "x" * (210 * 1024)        # 超過 200KB 的存檔上限
    res = client.put("/api/save", json={"save": save}, headers=auth(token))
    assert res.status_code == 413
    assert "太大" in res.get_json()["error"]

    save["junk"] = "x" * (300 * 1024)        # 超過整個請求的上限（256KB）
    res = client.put("/api/save", json={"save": save}, headers=auth(token))
    assert res.status_code == 413
    assert "error" in res.get_json()


def test_save_rejects_bad_data(client, register):
    token = register("gina")
    bad_saves = [
        {"v": 2},                              # 沒有角色資料
        make_save(lv=0),                       # 等級太低
        make_save(lv=999),                     # 等級超過上限
        make_save(coins=-5),                   # 金幣是負的
        make_save(kills=10 ** 9),              # 擊殺數不合理
        {"player": {"lv": "10"}},              # 型別錯誤
    ]
    for save in bad_saves:
        res = client.put("/api/save", json={"save": save}, headers=auth(token))
        assert res.status_code == 400, save
        assert "error" in res.get_json()
    res = client.put("/api/save", json={"notsave": 1}, headers=auth(token))
    assert res.status_code == 400


def test_old_save_without_stats_is_accepted(client, register):
    token = register("hank")
    save = {"v": 2, "player": {"lv": 3, "coins": 10}}
    assert client.put("/api/save", json={"save": save}, headers=auth(token)).status_code == 200


# ---------- 排行榜 ----------
def setup_leaderboard(client, register):
    players = {
        "alpha": make_save(lv=10, coins=500, kills=40, job="warrior"),
        "beta": make_save(lv=15, coins=100, kills=90, job="mage"),
        "gamma": make_save(lv=5, coins=900, kills=10),
        "delta": make_save(lv=10, coins=50, kills=5, job="archer"),
    }
    tokens = {}
    for name, save in players.items():
        tokens[name] = register(name)
        client.put("/api/save", json={"save": save}, headers=auth(tokens[name]))
    register("nosave")   # 沒有存檔的玩家不會出現在排行榜
    return tokens


def test_leaderboard_sorting(client, register):
    setup_leaderboard(client, register)

    res = client.get("/api/leaderboard?by=level")
    data = res.get_json()
    assert [e["username"] for e in data["entries"]] == ["beta", "alpha", "delta", "gamma"]
    assert [e["rank"] for e in data["entries"]] == [1, 2, 2, 4]   # 同分同名次
    assert data["total"] == 4
    assert data["me"] is None

    kills = client.get("/api/leaderboard?by=kills").get_json()["entries"]
    assert [e["username"] for e in kills] == ["beta", "alpha", "gamma", "delta"]
    assert kills[0]["value"] == 90

    gold = client.get("/api/leaderboard?by=gold").get_json()["entries"]
    assert [e["username"] for e in gold] == ["gamma", "alpha", "beta", "delta"]
    assert gold[0]["job"] == "novice"


def test_leaderboard_limit_and_my_rank(client, register):
    tokens = setup_leaderboard(client, register)
    data = client.get("/api/leaderboard?by=gold&limit=2", headers=auth(tokens["delta"])).get_json()
    assert len(data["entries"]) == 2
    assert data["me"] == {"username": "delta", "rank": 4, "value": 50}   # 不在前 2 名也看得到自己的名次


def test_leaderboard_uses_server_side_values(client, register):
    token = register("cheater")
    save = make_save(lv=3, coins=10, kills=1)
    save["score"] = 999999   # 前端額外送的分數不會被採用
    client.put("/api/save", json={"save": save}, headers=auth(token))
    entry = client.get("/api/leaderboard?by=level").get_json()["entries"][0]
    assert entry["value"] == 3


def test_leaderboard_invalid_params(client):
    assert client.get("/api/leaderboard?by=hp").status_code == 400
    assert client.get("/api/leaderboard?limit=abc").status_code == 400


# ---------- CORS ----------
def test_cors_allowed_origins(client):
    for origin in ["https://peoplepop.github.io", "http://localhost:8765", "http://127.0.0.1:5500", "http://localhost"]:
        res = client.get("/api/health", headers={"Origin": origin})
        assert res.headers.get("Access-Control-Allow-Origin") == origin, origin


def test_cors_blocked_origins(client):
    for origin in ["https://evil.example.com", "https://peoplepop.github.io.evil.com", "http://localhost.evil.com", "https://localhost:8000"]:
        res = client.get("/api/health", headers={"Origin": origin})
        assert "Access-Control-Allow-Origin" not in res.headers, origin


def test_cors_preflight(client):
    res = client.options("/api/save", headers={
        "Origin": "https://peoplepop.github.io",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization, content-type",
    })
    assert res.status_code == 200
    assert res.headers["Access-Control-Allow-Origin"] == "https://peoplepop.github.io"
    assert "PUT" in res.headers["Access-Control-Allow-Methods"]
    assert "Authorization" in res.headers["Access-Control-Allow-Headers"]


def test_cors_headers_on_error_response(client):
    res = client.get("/api/save", headers={"Origin": "http://localhost:8765"})
    assert res.status_code == 401
    assert res.headers.get("Access-Control-Allow-Origin") == "http://localhost:8765"
