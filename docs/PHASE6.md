# 第六階段：怪物同步（Cloudflare Durable Objects）

## 架構

```
瀏覽器 ──HTTPS──▶ PythonAnywhere（帳號、雲端存檔、排行榜，不動）
   │                    │ 登入後簽發短效「連線票券」（HMAC，約 5 分鐘）
   └──WebSocket──▶ Cloudflare Worker ──▶ Durable Object「頻道 1～10」
                                          每頻道一份：怪物、玩家位置、聊天
```

- 每個頻道一個 Durable Object（`idFromName('ch-N')`），10～20 Hz 模擬怪物；沒人時停止 tick、休眠。
- **怪物由伺服器權威**：出生、HP、位置、AI、死亡、重生。只模擬有玩家所在區域的怪。
- **玩家由客戶端權威**：移動、技能、自身 HP（被怪打的傷害在前端依伺服器怪物位置判定）。每秒約 10 次回報位置。
- **打怪**：前端判定命中與傷害並立即顯示；送 `hit` 給伺服器，伺服器檢查（怪還活著、距離、傷害上限依票券中的等級/職業、出手頻率）後扣血。
- **興趣範圍**：每人只收左右約 1500px 內的怪物快照。
- **備援**：連不上 Worker 時，自動退回單機本地怪 + 現有 HTTP 輪詢。
- **共用程式碼**：`index.html` 仍是唯一來源（Artifact 需要單一檔案）；怪物資料與 AI 用標記區塊包起來，`worker/` 的同步腳本把它抽出成 Worker 用的模組。

## 已決定的規則（2026-10-13 使用者確認）

1. **訪客**：不連同步頻道，打本機單機怪，**也看不到其他玩家**（登入後才看得到）。這會取代目前「訪客唯讀看得到其他玩家」的行為。
2. **經驗分配**：依傷害比例分，最後一擊另加一點；任務擊殺數給有出力的人。
3. **掉寶**：個人掉寶，每位有出力的玩家在自己的前端各自擲骰，只看得到自己的掉落。

## 里程碑

| 步驟 | 內容 | 使用者要做 |
|---|---|---|
| 6-0 準備 | `worker/` 專案骨架（wrangler）、PA 新增 `POST /api/rt-ticket`、本機 `wrangler dev` 連線打通 | 註冊 Cloudflare、`npx wrangler login` |
| 6-1 連線層 | 玩家位置與聊天改走 WebSocket，保留 HTTP 備援；訪客不再看到其他玩家 | PA `git pull` + Reload；部署 Worker |
| 6-2 一般怪同步 | 伺服器權威怪物、命中驗證、擊殺結算（經驗依傷害比例、個人掉寶、任務計數） | 部署、一起實測 |
| 6-3 Boss 同步 | 霧之守衛 AI 搬到伺服器、全頻道共鬥、HP 依人數加成 | 部署 |

## 進度

- **2026-10-13 完成 6-0、6-1（本機驗證通過，尚未部署）**
  - `worker/`：Worker 入口（Origin 檢查、挑頻道）、`Channel` Durable Object（Hibernation API、位置 10 Hz 合併廣播、聊天＋不雅字詞過濾、怪物 tick 預留 `MOB_SYNC`／`tick()`）、`Lobby` Durable Object（各頻道人數）、票券驗證；`npm test` 單元測試。
  - PA 後端：`POST /api/rt-ticket`（HMAC-SHA256，5 分鐘，內容 uid／name／lv／lvmax／job／iat／exp；未設定 `MISTWOOD_RT_SECRET` 回 503）＋ pytest。
  - 前端：登入玩家優先走 WebSocket，連不上自動退回 HTTP 輪詢；訪客不再看到其他玩家、不再輪詢；`RT_URL_PROD` 已設為 `wss://mistwood-rt.b98010327.workers.dev`（2026-10-13 部署並經使用者雙帳號實測通過）。
  - 已部署：Worker `mistwood-rt.b98010327.workers.dev`、PA 已設 `MISTWOOD_RT_SECRET`（密鑰本機備份在 repo 外 `D:\claude\小k\mistwood_rt_secret.txt`）。
- 6-2 一般怪同步：尚未開始。

前端在 Worker 正式上線前，同步功能預設關閉（只在 `?rt=` 參數或設定了正式 Worker 網址時啟用），避免 GitHub Pages 先上線卻連不到伺服器。
