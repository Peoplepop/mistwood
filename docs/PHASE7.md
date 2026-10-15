# 第七階段：組隊系統（規劃）

> 狀態：**規劃中（2026-10-15）**，尚未實作。標「待確認」的項目請使用者裁示後再開工。
> 沿用第六階段架構：PA（帳號／存檔／票券）＋ Cloudflare Worker（`Channel` DO 每頻道一個、全域 `Lobby`）。

## 架構

```
瀏覽器 ──WebSocket──▶ Channel DO（ch-1～ch-10）── RPC ──▶ PartyHub DO（全域一個，新增）
   ▲                     │  經驗共享在這裡算（只看同頻道玩家）     │ 隊伍、成員位置（頻道／地圖）、邀請
   └──── {t:'pu'/'pi'/'pe'/'pc'} ◀── partyPush(RPC) ◀──────────┘ 推給隊員所在的各頻道
```

- **隊伍狀態放新的 `PartyHub` DO**（`idFromName('hub')`，全域一個）：隊伍可跨頻道，必須有單一權威；不放 `Lobby` 是為了隔離（`Lobby.pick()` 是連線入口，隊伍程式出錯不該影響進頻道）。最多 200 人同時在線，單一 DO 綽綽有餘。
- **玩家只連自己的 Channel**：隊伍指令由 Channel 轉給 Hub（RPC）；Hub 有變化時呼叫隊員所在頻道的 `Channel.partyPush([[uid, 訊息], ...])`，由 Channel 送給玩家，並更新本地快取 `P.pt = {id, mem:Set}`。
- **擊殺結算不經過 Hub**：Channel 用本地快取的隊伍成員＋本頻道玩家位置算經驗共享（隊友不在同頻道就不可能符合條件），打怪路徑沒有額外延遲。
- **隊友 HP／位置**：同頻道已經有 `{t:'ps'}`（含 `hp`、`x`）→ 前端直接從 `NET.others` 取；Hub 只記 `ch`、`z`（0 = 森林、1 = 雪原，依 `zoneL`）、`lv`、`job`、在線與否，給跨頻道的隊伍視窗顯示。
- 純邏輯放可單獨測試的模組（比照 `mobworld.js`）：`src/party.js`（`PartyBook`：隊伍／邀請／逾時規則）、`src/share.js`（`splitPartyExp`）。

## 已決定的規則（使用者確認）

1. 隊伍上限 **4 人**；只有登入且走 WebSocket 的玩家能組隊（訪客、HTTP 備援不行）。
2. **經驗共享＋加成**：怪物死亡時，同頻道、同地圖、約 1 個畫面內的隊友，沒打也分得到；隊內依等級比例分；每多 1 位符合條件的隊友，隊伍總經驗 +10%。
3. **可跨頻道**：換頻道不退隊；隊伍視窗顯示隊友頻道／地圖；只有同頻道同地圖才分經驗、看得到 HP。
4. 附加功能全做：隊伍聊天、小地圖標示隊友、隊長踢人／轉移隊長、隊伍任務／隊伍 Boss 獎勵（後期子階段）。
5. 基本功能：邀請（玩家資訊卡、社群視窗）、接受／拒絕（逾時）、退出、隊伍 HP 條 UI（含手機）。

## 經驗共享規則（7-2）

**流程**（取代 `MobWorld.hit()` 擊殺後直接用 `splitExp` 結果）：
1. 照舊 `splitExp(exp, m.dmg, last)`：依傷害比例、多人最後一擊 +10%，總和 = 怪物經驗。
2. **不在隊伍的出力者**：拿自己那份，和現在完全一樣。
3. **每個有出力者的隊伍**：隊伍份額 `pool` = 隊內出力者份額總和；符合條件隊友 `E`（含出力者本人）；
   `total = round(pool × (1 + 0.1 × (|E| − 1)))`，依 `lv_i / Σlv` 分（無條件捨去，零頭給隊內最後一擊或出力最多者）。
4. 隊伍裡沒人出手 → 不分（避免旁觀灌經驗）。

**符合條件的隊友**（沒出手的人；出力者本人一律算）：
- 同頻道、同地圖（`zoneL` 相同）、與怪物距離 `|dx| ≤ PARTY_SHARE_X`、`|dy| ≤ 600`
- 活著（`st !== 'dead'`）、最近 `PARTY_ACTIVE_MS` 內有回報狀態（防掛機）
- 前端支援組隊（hello 帶 `pty`）
- **等級差**：等級 ≥ 符合條件者中最高等級 − `PARTY_LV_GAP`（低太多的人不分、也不計入加成）

**上限**（讓後端不用放寬經驗常數）：
- 一般怪：每人一次 ≤ 怪物基礎經驗 `m.d.exp`（數學上只有極端等級差才會超過，Worker 仍夾住；前端 `mnKill` 本來就 `clamp(x, 0, m.d.exp)`）。
- Boss：達討伐門檻者 ≤ 9000；**沒達門檻的隊友**分到的 ≤ 2,000（＝ `MAX_EXP_PER_KILL`），算 1 次「協助擊殺」，不算 Boss 擊殺／q10／掉寶。
- 討伐門檻（`bossCredit`）仍看個人輸出，不受隊伍影響（7-3 另議）。

**範例**：怪物 1000 經驗；A（隊伍、Lv.40）出 70% 且最後一擊、B（隊外）30%。`splitExp` → A 730、B 270。A 的隊友 C（Lv.36）在旁邊、D 在別張地圖 → E = {A, C}，total = 803 → A 423（含零頭）、C 380；B 照拿 270（全場 1073）。

**沒出手的隊友收到結算時**（`a = 1`）：給經驗、`stats.assists +1`、任務擊殺數（待確認），**不擲掉寶**（個人掉寶規則不變）。

**對後端合理性檢查的影響**（`server/app.py`）：
- `MAX_EXP_PER_KILL`、`BOSS_EXP_MAX`、`EXP_PER_SEC_MAX` 不用改（每人每隻 ≤ 基礎經驗）。
- 問題：沒出手的隊友有經驗但沒擊殺 → `min_kills_for_level` 可能誤判「等級與擊殺數不符」。
- 建議：新增 `stats.assists`（協助擊殺數），存檔多一欄；後端 `extract_scores` 讀 `assists`，`min_kills_for_level` 用 `kills + assists`；新增 `hw_assists`／`hw_assists_ts` 欄位以 `KILLS_PER_SEC_MAX` 檢查速度；**擊殺排行榜仍只算 `kills`**（不被組隊灌）；金幣檢查不變（協助擊殺沒有金幣）。
- 風險：4 人隊狂掃時每人 `kills + assists` 成長 = 全隊擊殺速度，可能逼近 `KILLS_PER_SEC_MAX = 5`（寬限 300）；7-2 實測看 flag_reason，必要時調到 8。

## 隊伍規則（7-0）

- **建立**：未組隊者邀請他人、對方接受 → 建立隊伍，邀請者為隊長。
- **邀請**：只有隊長（或未組隊者）可邀請；對方需在線（WebSocket）、支援組隊、未在隊伍中、隊伍未滿；同一位被邀請者同時只有一筆邀請；邀請 `PARTY_INVITE_TTL` 後逾時；邀請頻率限制（每人 3 秒 1 次、每分鐘 10 次）。邀請入口在同頻道（資訊卡、社群視窗），Hub 本身支援跨頻道送達。
- **退出**：任何人可退出；隊長退出 → 最早加入的在線隊員接任；剩 1 人 → 解散。
- **踢人／轉移隊長**：隊長限定；被踢者 60 秒內不能再被同隊邀請。
- **斷線／重連**：Channel `drop()` → `hub.offline(uid, conn)`；`onHello` → `hub.online({uid, name, lv, job, ch, z, pty, conn})`（welcome 先送，不等 Hub）。`conn` = Channel 在 hello 時產生的連線編號，Hub 只接受「目前 conn」的 offline／指令。
  - **換頻道**：前端先連新頻道、welcome 後才關舊連線（`rtWelcome` 的 `S.sw`）→ Hub 先收到新 conn 的 online、再收到舊 conn 的 offline（被忽略），隊伍不閃斷。
  - **4001 被取代**：同頻道時舊連線 `drop()` 本來就不處理（`P.ws !== ws`）；跨頻道兩處連線時，Hub 以最後一個 online 為準，舊 conn 的指令回 `stale`，前端顯示「隊伍功能在另一處使用中」。
  - **離線逾時**：離線 `PARTY_OFFLINE_KICK` 自動退隊；隊長離線 `PARTY_LEAD_HANDOFF` 自動轉給在線隊員；全員離線超過逾時 → 整隊刪除。Hub 用 alarm 掃描（不用 `setTimeout`，DO 休眠會丟計時器）。
  - 登出、`/api/claim` 被取代暫停、退回 HTTP 備援 → 都算離線（不是退隊），回來在逾時內自動恢復。
- **保存**：隊伍與成員存 Hub storage（休眠／回收後還在）；邀請只放記憶體（丟了就當逾時）。Channel 把 `pid`、隊員 uid 放進連線 attachment（≤ 2KB），醒來不必問 Hub。

## WebSocket 協定（新增）

前端 → 伺服器

| 訊息 | 說明 |
|---|---|
| `{t:'hello', ..., pty:1}` | 新欄位：前端支援組隊（沒有 = 舊版，不能被邀請、不收協助擊殺） |
| `{t:'p', q, op:'inv', id}` | 邀請 uid |
| `{t:'p', q, op:'ans', id, ok:1/0}` | 回覆邀請（id = 邀請者） |
| `{t:'p', q, op:'leave'}` / `op:'kick', id` / `op:'lead', id` | 退出／踢人／轉移隊長 |
| `{t:'p', q, op:'chat', text}` | 隊伍聊天（Channel 先跑 `prepareChat`，共用 `P.chatTs` 頻率限制） |

伺服器 → 前端（指令回覆沿用 `{t:'r', q, ok, error?}`，前端用現有 `rtRequest()`）

| 訊息 | 說明 |
|---|---|
| `welcome` 新增 `party` | 組隊協定版本（0 = 不支援 → 前端隱藏組隊 UI） |
| `{t:'pu', p}` | 隊伍快照：`p = {id, v, lead, mem:[{id, name, lv, job, ch, z, on}]}`；`p = null` 代表不在隊伍 |
| `{t:'pi', from, name, lv, job, ttl}` | 收到邀請（ttl 秒） |
| `{t:'pe', k, id, name}` | 事件：`join`／`leave`／`kick`／`lead`／`decline`／`timeout`／`disband`／`stale` |
| `{t:'pc', msg:{id, uid, name, text, ts}}` | 隊伍聊天 |
| `{t:'k', ..., a?, pb?, pn?, pr?}` | 擊殺結算新增：`a = 1` 協助擊殺（沒出手，只給經驗）、`pb` 隊伍加成 %、`pn` 符合條件隊友數、`pr` 隊伍 Boss 獎勵（7-3） |

Channel ↔ Hub（RPC，非 WebSocket）：`online(info)`、`offline(uid, conn)`、`loc(uid, conn, {ch, z, lv, job})`（地圖／等級／職業有變才送）、`cmd(uid, conn, op, args)` → `{ok, error?}`；Hub → `Channel.partyPush(list)`。

## 各端修改

**Worker**
- 新增 `src/partyhub.js`（`PartyHub` DO）、`src/party.js`（`PartyBook` 純邏輯）、`src/share.js`（`splitPartyExp`）；`index.js` export；`wrangler.toml` 新增 binding `PARTY` 與 `[[migrations]] tag = "v2"`、`new_sqlite_classes = ["PartyHub"]`。
- `channel.js`：開關 `PARTY_SYNC`／`PARTY_EXP`／`PARTY_BOSS`；`onHello` 記 `pty`、送 `hub.online`；`drop` 送 `hub.offline`；`webSocketMessage` 新增 `d.t === 'p'`；`onState` 偵測 `zoneL`／`lv`／`job` 變化送 `hub.loc`；新 RPC `partyPush`；`persist()` attachment 加 `pid`、`pm`；`onHits` 擊殺後改用 `splitPartyExp` 並加 `a/pb/pn`（只對 `pty` 玩家送 `a = 1`）。
- `mobworld.js`：`hit()` 的 kill 多回傳 `x/y/zone`、Boss 的 `credit` 照舊；`MobWorld` 不認識隊伍（共享在 Channel 做）。

**前端（`index.html`）**
- 狀態 `PT = {on, p, inv, log}`；`rtWelcome` 依 `m.party` 啟用；`rtMessage` 處理 `pu/pi/pe/pc`；`rtClosed` 時隊伍 UI 顯示「重新連線中」（保留最後快照、灰階）；hello 加 `pty: 1`。
- **玩家資訊卡** `renderCard()`：「邀請組隊」（對方已在隊伍／不支援時停用並說明）；隊長看隊友卡多「踢出」「轉為隊長」。
- **社群視窗** `fillSocial()`：每位玩家列加「邀請」小按鈕；上方「隊伍」區塊（或獨立隊伍視窗，待確認）：成員、Lv、職業、`頻道 N・地圖`／離線、隊長標記、退出／踢人／轉移按鈕。
- **邀請提示**：畫面上方中間的小對話框（倒數＋接受／拒絕；鍵盤 Y／N），手機用大按鈕、不擋左半邊搖桿與右下按鈕。
- **隊伍 HP 條** `drawPartyHud()`：小地圖下方、`drawNetHud()` 狀態列之下（桌機與手機同位置；手機精簡成名字＋HP 條、每列 14px）。同頻道同地圖顯示 `NET.others` 的 `hp`；其他情況顯示「頻道 N・霜月雪原」或「離線」。
- **小地圖** `drawMinimap()`：同頻道同地圖的隊友畫青色點（白框），自己仍是黃點。
- **名牌** `drawRemotes()`：隊友名牌改綠底＋小隊伍圖示；隊友不受「顯示其他玩家」關閉影響（待確認）。
- **隊伍聊天**：聊天列 `chatBar` 加「頻道／隊伍」切換鈕，並支援 `/p 訊息`；`chatAdd()` 加 `pt` 旗標，`drawChatLog()`／社群紀錄顯示 `[隊伍]` 淡藍色；隊伍訊息泡泡只有隊友看得到。
- **結算** `mnKill()`／`mnBossKill()`：`a = 1` → `gainExp`、`p.stats.assists++`、`questKill`（待確認），不呼叫 `mobLoot`；`pb > 0` 時偶爾 toast「隊伍加成 +20%」。
- **存檔** `saveState()`：`stats.assists`（讀檔預設 0）。

**後端（`server/app.py`，7-2 才需要）**
- `extract_scores` 讀 `stats.assists`；`min_kills_for_level` 用 `kills + assists`；新增 `hw_assists`／`hw_assists_ts`（沿用現有欄位遷移機制）與速度檢查；擊殺排行榜不變；新增 pytest。
- 7-3 若 q15 經驗 > 10,500，`QUEST_EXP_ABOVE_FREE`（目前 130,000，q7～q14 共 119,500）要同步調高。

## 分階段

| 步驟 | 內容 | 部署 |
|---|---|---|
| 7-0 隊伍核心 | `PartyHub`＋`PartyBook`、協定 `p/pu/pi/pe`、邀請／接受／拒絕／逾時、退出、踢人、轉移、斷線／重連／換頻道／離線逾時；前端最小 UI（資訊卡邀請鈕、邀請提示、社群視窗隊伍清單） | Worker deploy（含 migration v2）＋前端 push；PA 不用 |
| 7-1 UI＋聊天＋小地圖 | 隊伍 HP 條（含手機）、隊伍聊天、小地圖隊友點、隊友名牌、社群視窗邀請鈕、隊伍視窗 | Worker deploy＋前端 push；PA 不用 |
| 7-2 經驗共享 | `splitPartyExp`、`k` 的 `a/pb/pn`、協助擊殺、`stats.assists`、後端合理性檢查 | **PA `git pull` + Reload → 前端 push → Worker deploy**（順序重要） |
| 7-3 隊伍 Boss／任務 | 隊伍討伐額外掉寶、q15（提案見下） | Worker deploy＋前端 push；q15 經驗超過寬限才要 PA |

### 7-3 提案（全部待確認）

- **隊伍討伐獎勵**：同一場霧之守衛擊殺中，同隊 ≥ 2 人達討伐門檻 → 這些人各自額外擲 **1 件** Boss 裝備（機率同 `bossLoot` 第二件，不加金幣），`k` 帶 `pr = 1`，橫幅「隊伍討伐」。最高金幣價值約 27,500 + 12,000 = 39,500，仍在 `COINS_PER_BOSS_MAX`（50,000）內 → 後端不用改。
- **（選項）隊伍門檻**：討伐門檻改看隊伍合計輸出、個人至少 1%。容易被帶，建議**不做**。
- **任務 q15「並肩作戰」**（NPC 希爾妲、Lv.30、前置 q10）：組隊狀態（`pn ≥ 2`）擊敗 Lv.30 以上怪物 40 隻，或隊伍討伐霧之守衛 1 次（二選一）；新任務類型 `pkill`。獎勵建議 exp 10,000（不用動後端）＋金幣 5,000＋飾品。

### 驗收與測試

- **7-0**：`npm test` 新增 `test/party.test.js`（建立／邀請滿 4 人第 5 人被拒、重複邀請、逾時、拒絕、退出接任、剩 1 人解散、踢人冷卻、轉移、conn 新舊順序、離線逾時退隊、隊長離線轉移、保存／讀取）。本機 `wrangler dev` ＋ Node 假玩家 4 人分在 2 個頻道：跨頻道快照一致、換頻道不退隊、斷線 5 分鐘內重連恢復、4001 不破壞隊伍；瀏覽器雙帳號實測邀請流程。
- **7-1**：瀏覽器雙帳號：HP 條即時、跨頻道顯示頻道／地圖、小地圖點、隊伍聊天只有隊友收到（第三帳號收不到）、手機版面（375×812）不擋操作。
- **7-2**：`test/share.test.js`（範例數字、總和、加成、等級差、距離／地圖／死亡／掛機排除、上限、隊外出力者不受影響、Boss 非討伐上限 2,000）；後端 pytest（assists 解析、等級／擊殺下限、速度檢查、排行榜不含 assists）；本機雙帳號一人打一人旁觀，確認經驗、協助擊殺、存檔未被 flagged。
- **7-3**：`boss.test.js` 擴充（隊伍額外掉寶條件）；瀏覽器雙帳號合打 Boss；q15 進度與回報。

## 待使用者確認（附建議值）

1. 分經驗距離：建議 `PARTY_SHARE_X = 1000`（畫面寬 560～960，約 1 個畫面）、`|dy| ≤ 600`，以怪物位置為準。
2. 等級差：建議 `PARTY_LV_GAP = 15`（比最高等級低超過 15 級不分、不計加成）。
3. 掛機判定：建議 `PARTY_ACTIVE_MS = 30 秒` 內有動作才分。
4. 沒出手的隊友：建議**算任務擊殺數、不擲掉寶**、記協助擊殺 `stats.assists`。
5. 後端：建議新增 `stats.assists`（擊殺排行榜不含），而不是直接算進擊殺數。
6. 邀請逾時：建議 `PARTY_INVITE_TTL = 30 秒`；只有隊長能邀請。
7. 離線自動退隊：建議 `PARTY_OFFLINE_KICK = 5 分鐘`；隊長離線 `PARTY_LEAD_HANDOFF = 60 秒` 自動轉移。
8. 剩 1 人時：建議自動解散。
9. 隊伍 UI：建議獨立「隊伍」視窗（快捷鍵 **P**，觸控選單加一項），社群視窗只放邀請鈕。
10. 隊伍 HP 條位置：建議小地圖／連線狀態下方（桌機、手機同位置，手機精簡）。
11. 隊友在「顯示其他玩家」關閉時：建議仍顯示隊友。
12. 隊伍聊天：建議切換鈕＋`/p` 前綴，不保留歷史（重連後看不到斷線前的隊伍訊息）。
13. 7-3 隊伍討伐額外 1 件 Boss 掉寶（不加金幣）、不做隊伍門檻。
14. 7-3 q15 內容與獎勵（建議 exp 10,000，不用改後端；若要更高需調 `QUEST_EXP_ABOVE_FREE`）。

## 風險與緊急開關

- **開關**（`worker/src/channel.js`，改完 `npx wrangler deploy`）：`PARTY_SYNC = false` → welcome `party: 0`，前端隱藏組隊、經驗回到純傷害比例；`PARTY_EXP = false` → 只關經驗共享；`PARTY_BOSS = false` → 只關 7-3 獎勵。
- **Hub 掛掉**：Channel RPC 失敗回 `{ok:false, error:'隊伍伺服器忙碌'}`；打怪、聊天、Boss 不受影響（共享用本地快取）。
- **競態**：換頻道／重連的 online／offline 順序 → 以 `conn` 判斷；需測試覆蓋。
- **休眠**：Hub 計時一律用 alarm；Channel 隊伍快取存 attachment。
- **濫用**：高等帶練（等級差、距離、掛機規則）、同一人多帳號帶自己（`/api/claim` 只限同帳號；IP 註冊限制有幫助但擋不完）、擊殺速度檢查誤判（看 flag_reason，必要時調 `KILLS_PER_SEC_MAX`）。
- **相容**：新前端＋舊 Worker → 沒有 `party` 欄位，組隊 UI 隱藏；舊前端＋新 Worker → 沒有 `pty`，不能被邀請、不收 `a = 1`（避免舊版把協助擊殺當成擊殺並擲掉寶）。HTTP 備援、訪客一律沒有組隊。
- **用量**：隊伍指令與 online／offline／loc 都是低頻 RPC；位置與 HP 沿用 `ps`，Cloudflare 請求數幾乎不變。
- **單檔前端變大**：組隊 UI 集中在一段 `// ---- 組隊（第七階段） ----` 區塊，避免散落。
