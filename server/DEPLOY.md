# 晨霧森林 後端部署教學（PythonAnywhere 付費帳號）

這份文件一步一步說明怎麼把 `server/` 的 Flask 後端（雲端存檔＋排行榜）部署到 PythonAnywhere。
以下範例的帳號名稱都是 **peoplepop**，網址為 **https://peoplepop.pythonanywhere.com**。

> 完成後的架構：
> - 前端（遊戲畫面）：GitHub Pages → https://peoplepop.github.io/mistwood/
> - 後端（API）：PythonAnywhere → https://peoplepop.pythonanywhere.com/api/...

---

## 步驟 1：用 Bash console 下載程式

1. 登入 PythonAnywhere，點上方的 **Consoles**。
2. 在「Start a new console」點 **Bash**。
3. 輸入以下指令（下載 GitHub 上的程式）：

```bash
cd ~
git clone https://github.com/Peoplepop/mistwood.git
```

完成後程式會在 `/home/peoplepop/mistwood`，後端在 `/home/peoplepop/mistwood/server`。

4. 建立一個放資料庫的資料夾（放在程式資料夾外面，之後 `git pull` 不會動到資料）：

```bash
mkdir -p ~/mistwood-data
```

## 步驟 2：建立 virtualenv 並安裝套件

在同一個 Bash console 輸入：

```bash
mkvirtualenv mistwood-venv --python=/usr/bin/python3.10
pip install -r ~/mistwood/server/requirements.txt
```

- `mkvirtualenv` 會建立並自動進入虛擬環境，提示字元前面會出現 `(mistwood-venv)`。
- 虛擬環境的位置是 `/home/peoplepop/.virtualenvs/mistwood-venv`（步驟 3 會用到）。
- 之後要再進入這個環境，輸入 `workon mistwood-venv`。

（可選）在伺服器上跑一次測試，確認程式沒問題：

```bash
cd ~/mistwood/server
python -m pytest -q
```

看到 `50 passed`（全部通過、沒有 failed）就代表正常。

## 步驟 3：在 Web 分頁建立網站

1. 點上方的 **Web** → **Add a new web app**。
2. 網域選 `peoplepop.pythonanywhere.com` → **Next**。
3. 框架選 **Manual configuration**（不要選「Flask」，那個會幫你產生範例程式）。
4. Python 版本選 **Python 3.10**（要和步驟 2 的版本一樣；部分帳號的系統映像中 3.11 的 venv 會出現 `_posixsubprocess` 錯誤，故使用 3.10）→ **Next**。
5. 建立完成後，在同一頁往下設定：

| 區塊 | 欄位 | 填入 |
| --- | --- | --- |
| Code | Source code | `/home/peoplepop/mistwood/server` |
| Code | Working directory | `/home/peoplepop/mistwood/server` |
| Virtualenv | （輸入框） | `/home/peoplepop/.virtualenvs/mistwood-venv` |

6. Static files：**不需要設定**（遊戲畫面放在 GitHub Pages，這裡只提供 API）。
7. Security 區塊：建議把 **Force HTTPS** 打開。

## 步驟 4：編輯 WSGI 設定檔（含環境變數）

1. 先產生一串隨機密鑰，在 Bash console 輸入：

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

把印出來的那串字複製起來（這是 `MISTWOOD_SECRET`，**不要放到 GitHub**）。

2. 回到 **Web** 分頁，在 Code 區塊點 **WSGI configuration file** 的連結
   （檔名類似 `/var/www/peoplepop_pythonanywhere_com_wsgi.py`）。
3. 把檔案內容**全部刪掉**，換成下面這段，然後按 **Save**：

```python
import os
import sys

# ---- 環境變數（設定） ----
os.environ["MISTWOOD_SECRET"] = "貼上剛剛產生的隨機字串"
os.environ["MISTWOOD_DB"] = "/home/peoplepop/mistwood-data/mistwood.db"
# 如果之後前端換了網域，可以在這裡加上允許的網址（逗號分隔）
# os.environ["MISTWOOD_EXTRA_ORIGINS"] = "https://example.com"

# ---- 讓 Python 找得到 app.py ----
path = "/home/peoplepop/mistwood/server"
if path not in sys.path:
    sys.path.insert(0, path)

from app import app as application  # noqa: E402
```

> 注意：`MISTWOOD_SECRET` 設定後就不要再改。改了之後，所有玩家的登入狀態都會失效（需要重新登入，但存檔不會不見）。

## 步驟 5：Reload 並測試

1. 回到 **Web** 分頁，按最上面綠色的 **Reload peoplepop.pythonanywhere.com**。
2. 用瀏覽器開啟 https://peoplepop.pythonanywhere.com/api/health
   看到類似 `{"ok": true, "time": "..."}` 就成功了。
3. 開啟遊戲 https://peoplepop.github.io/mistwood/ ，按 **L**（或 HUD 的「帳號」）註冊帳號測試。
   - 前端 `index.html` 開頭的 `PA_USERNAME` 已經設為 `'peoplepop'`，不需要再改。
   - 資料庫檔案會在第一次有人呼叫 API 時自動建立在 `~/mistwood-data/mistwood.db`。

## 更新後端

GitHub 上的程式有更新時（例如第四階段），在 PythonAnywhere 的 Bash console 輸入：

```bash
cd ~/mistwood
git pull
```

如果 `requirements.txt` 有變動，再多做一步：

```bash
workon mistwood-venv
pip install -r ~/mistwood/server/requirements.txt
```

最後到 **Web** 分頁按 **Reload**，新程式才會生效（**沒按 Reload，伺服器會繼續跑舊程式**）。

- **資料庫會自動升級**：Reload 後第一次有人呼叫 API 時，程式會自動替舊資料庫補上新欄位／新資料表，
  既有的帳號與存檔都會保留，不需要手動執行任何 SQL。保險起見，更新前可以先照下面「備份資料庫」做一份備份。
- **第四階段（Boss 排行榜、存檔合理性檢查、註冊頻率限制）一定要做 `git pull` + Reload**：
  新版前端會向後端要 `by=boss` 的排行榜，舊後端會回 400（前端雖然會處理，但 Boss 排行榜就看不到）。
- 更新後可以用瀏覽器開 https://peoplepop.pythonanywhere.com/api/leaderboard?by=boss 確認，
  有回傳 `{"by": "boss", ...}` 就代表新版已經生效。
- 被合理性檢查標記的存檔會照樣保存，只是不列入排行榜；Error log 會出現「存檔被標記」的 WARNING，方便查看。
（前端 `index.html` 推到 GitHub 後，GitHub Pages 會自動更新，不需要動 PythonAnywhere。）

## 出問題時：查看 log

**Web** 分頁最下面的 **Log files** 有三個連結：

| Log | 內容 |
| --- | --- |
| Access log | 每一次 API 呼叫的紀錄 |
| Error log | **最重要**：程式錯誤、import 失敗都會出現在這裡（看最下面的最新訊息） |
| Server log | 伺服器啟動／重新載入的紀錄 |

也可以在 Bash console 直接看最新的錯誤：

```bash
tail -n 50 /var/log/peoplepop.pythonanywhere.com.error.log
```

常見問題：

- **網站顯示「Something went wrong」**：看 Error log。最常見的是 WSGI 檔裡的路徑打錯，或 Virtualenv 沒設定。
- **`ModuleNotFoundError: No module named 'flask'`**：Virtualenv 路徑沒填，或套件沒裝在 `mistwood-venv` 裡。
- **遊戲顯示「雲端連線失敗」**：先開 `/api/health` 確認後端有在跑；再確認是從 `https://peoplepop.github.io` 開啟遊戲（其他網址會被 CORS 擋下）。

## 備份資料庫

所有帳號與存檔都在 `~/mistwood-data/mistwood.db`。在 Bash console 備份：

```bash
cp ~/mistwood-data/mistwood.db ~/mistwood-data/backup-$(date +%Y%m%d).db
```

也可以在 **Files** 分頁直接下載這個檔案。
