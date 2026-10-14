# 晨霧森林 即時連線伺服器（Cloudflare Worker + Durable Objects）

第六階段的即時連線：玩家位置、動作、表情與頻道聊天改走 WebSocket（6-1），以及伺服器權威的一般怪物同步（6-2）。
帳號、雲端存檔、排行榜仍在 PythonAnywhere，不受影響。

```
瀏覽器 ──HTTPS──▶ PythonAnywhere：POST /api/rt-ticket 取得短效票券（HMAC-SHA256，5 分鐘）
   └──WebSocket──▶ 這個 Worker /ws?ch=N ──▶ Durable Object「頻道 N」（N = 1～10，每頻道 20 人）
                                       └──▶ Durable Object「大廳」（各頻道人數）
```

- `src/index.js`：入口（檢查來源網站 Origin、挑頻道、轉給頻道物件）
- `src/channel.js`：頻道（WebSocket Hibernation API、位置廣播、聊天、怪物 10 Hz tick 與命中訊息）
- `src/mobworld.js`：伺服器權威的一般怪物（模擬、命中檢查、傷害上限、經驗分配、興趣範圍快照；不依賴 Cloudflare，可直接測試）
- `src/mobs.gen.js`：**自動產生**，從 `../index.html` 的 `// <mobsim>` 區塊抽出的怪物資料與 AI（`npm run gen`；不要手改）
- `src/lobby.js`：大廳（各頻道人數、幫剛上線的玩家挑有空位的頻道）
- `src/ticket.js`：驗證 PythonAnywhere 簽發的票券
- `src/chat.js`、`src/state.js`：聊天過濾、狀態檢查（規則和 `server/app.py` 相同）

前端的 `RT_URL_PROD` 已設為正式 Worker；即時連線連不上時自動退回 HTTP 輪詢（此時怪物也改回本機單機模擬）。
怪物同步只有在 Worker 的 welcome 宣告 `mobs: 1` 而且怪物資料指紋（`msig`）和前端相同時才會啟用，
所以前端可以比 Worker 先上線：舊版 Worker、或 `<mobsim>` 區塊改了但 Worker 還沒重新部署時，前端都會安靜地使用本機怪物。

### 修改怪物資料／AI 之後

```bash
cd worker
npm run gen        # 重新產生 src/mobs.gen.js（要 commit）
npm test           # 會檢查 mobs.gen.js 是否和 index.html 一致
npx wrangler deploy
```

---

## 本機開發

需要 Node.js（v20 以上）。不需要 Cloudflare 帳號。

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars      # 把 RT_SECRET 改成一長串隨機字串（.dev.vars 不會進 git）
npx wrangler dev                    # http://127.0.0.1:8787 ，打開看到 {"ok":true,...} 就是成功
npm test                            # 單元測試（票券、聊天過濾、狀態檢查、來源網站、怪物同步）
```

後端也要用**同一個密鑰**啟動（在 repo 根目錄）：

```bash
MISTWOOD_RT_SECRET=<和 .dev.vars 相同> python -m flask --app server/app.py run --host 127.0.0.1 --port 5055
python -m http.server 8770 --bind 127.0.0.1
```

瀏覽器開 `http://127.0.0.1:8770/index.html?api=http://127.0.0.1:5055&rt=ws://127.0.0.1:8787` ，登入後社群視窗（C）
會顯示「連線方式：即時連線（WebSocket）」。要同時測兩個帳號，第二個分頁用 `http://localhost:8770/...`（不同網址的存檔與登入狀態是分開的）。

---

## 部署步驟（第一次）

### 1. 註冊 Cloudflare 並登入 wrangler

1. 到 https://dash.cloudflare.com/sign-up 註冊免費帳號（免費方案就能用 SQLite 的 Durable Objects）。
2. 第一次登入後，左側選 **Workers 和 Pages**，照畫面指示設定一個 `workers.dev` 子網域（例如 `peoplepop`），
   之後 Worker 網址會是 `https://mistwood-rt.<子網域>.workers.dev`。
3. 在本機 `worker` 資料夾：

```bash
cd worker
npm install
npx wrangler login        # 會開瀏覽器，按「Allow」授權
npx wrangler whoami       # 確認已登入
```

### 2. 產生密鑰並設定到 Worker

先產生一串隨機密鑰（Worker 和 PythonAnywhere 要用**同一串**，不要放進 git）：

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

```bash
npx wrangler secret put RT_SECRET      # 貼上剛剛那串，按 Enter
```

（第一次執行時 Worker 還沒建立，wrangler 會問要不要建立，回答 `Y` 即可。）

### 3. 部署 Worker

```bash
npx wrangler deploy
```

完成後會印出網址，例如 `https://mistwood-rt.peoplepop.workers.dev`。用瀏覽器打開，看到
`{"ok":true,"name":"mistwood-rt","nch":10,"ready":true}` 就成功了（`ready: false` 代表 RT_SECRET 沒設定好）。

### 4. PythonAnywhere 設定 `MISTWOOD_RT_SECRET`

1. 在 PythonAnywhere 的 **Web** 分頁，點 **WSGI configuration file** 的連結（`/var/www/peoplepop_pythonanywhere_com_wsgi.py`）。
2. 在其他 `os.environ[...]` 那幾行旁邊加上一行（換成步驟 2 的同一串密鑰），按 **Save**：

```python
os.environ["MISTWOOD_RT_SECRET"] = "貼上和 Worker 相同的密鑰"
```

3. 開一個 **Bash console** 更新程式：

```bash
cd ~/mistwood
git pull
```

4. 回到 **Web** 分頁按 **Reload peoplepop.pythonanywhere.com**。
5. 確認：登入遊戲後，在瀏覽器開發者工具的 Network 可以看到 `POST /api/rt-ticket` 回 200
   （沒設定密鑰時會回 503，前端會安靜地改用 HTTP 輪詢）。

### 5. 先用網址參數測試，再對所有玩家開放

1. 打開 `https://peoplepop.github.io/mistwood/?rt=wss://mistwood-rt.<子網域>.workers.dev` 並登入，
   社群視窗（C）顯示「連線方式：即時連線（WebSocket）」就代表連上了。可以找朋友用同樣的網址一起測。
   （正式網站只接受 `wss://*.workers.dev` 的網址；沒帶 `?rt=` 的玩家完全不受影響。）
2. 確認沒問題後，把 `index.html` 開頭附近的常數填上正式網址，commit + push：

```js
const RT_URL_PROD = 'wss://mistwood-rt.<子網域>.workers.dev';
```

   GitHub Pages 更新後，所有登入玩家都會優先使用即時連線（連不上時自動退回 HTTP 輪詢）。
   需要緊急關掉時，把它改回 `''` 再 push 即可；個別玩家也可以用 `?rt=off` 停用。
3. Artifact 版本（claude.ai）也一樣：Worker 已允許 `claude.ai`、`*.claudeusercontent.com` 的來源，
   但 PythonAnywhere 也要允許該來源（`MISTWOOD_EXTRA_ORIGINS`）才拿得到票券。

### 之後更新 Worker

```bash
cd worker
git pull
npx wrangler deploy
```

密鑰（`RT_SECRET`）設定一次就好；要更換時 Worker（`npx wrangler secret put RT_SECRET`）與 PythonAnywhere（WSGI 檔）兩邊要一起改，
改完 PythonAnywhere 要 Reload。換密鑰當下已連線的玩家不受影響，重新連線時會自動取新票券。

### 用量與費用（免費方案）

- Workers 免費方案：每天 10 萬次請求；Durable Objects（SQLite）免費方案有每日請求數與執行時間額度。
- 每位玩家連線時只算一次 Worker 請求；**收到的** WebSocket 訊息以 20:1 換算成 Durable Object 請求（伺服器送出的怪物快照不算請求），
  使用 Hibernation API，沒人說話、沒人移動時物件會休眠不計時間。
- 6-2 之後：有活躍玩家的頻道會以 10 Hz 模擬怪物，期間物件保持清醒（計 Duration：128 MB × 秒數）；
  所有人掛機超過 2 分鐘或離開後 5 秒停止。估計每位玩家每小時約 1,500～2,000 個 DO 請求（位置回報＋命中），
  每個「有人在打怪的頻道」每小時約 460 GB-s；免費額度（每天 10 萬請求、13,000 GB-s）大約夠每天 50 玩家小時、28 頻道小時。
- 用量可在 Cloudflare 後台 **Workers 和 Pages → mistwood-rt → 指標** 查看；`npx wrangler tail` 可以即時看 log。
