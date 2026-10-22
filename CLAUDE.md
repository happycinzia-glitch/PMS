# 專案管理系統 — 開發須知

裝修工程公司的內部 ERP：客戶、廠商、報價、專案、維修、應收應付、會計與台灣稅務報表。
介面全繁體中文。使用者導向的說明請看 `首次設定指南.md`。

## 架構

| 路徑 | 說明 |
|---|---|
| `server.js` | Express 設定、session、稽核中介層、掛載路由 |
| `src/store.js` | 資料層。資料放記憶體供路由同步讀寫；落地到 `data/db.json`（tmp + rename 原子替換），或設定 `DATABASE_URL` 時落地到 PostgreSQL |
| `src/env.js` | 讀 `.env`（自行解析以去除記事本 BOM），`server.js` 與 `tools/` 共用 |
| `tools/import-db.js` | 把 `data/db.json` 或備份檔匯入資料庫 |
| `src/util.js` | 型別轉換、權限中介層、關聯名稱查詢、scrypt 密碼雜湊 |
| `src/seed.js` | 首次啟動建立管理者與八組下拉清單預設值 |
| `src/backup.js` | 自動備份：排程器（每分鐘檢查）、備份檔產生、Google 雲端硬碟上傳（內建 fetch 直呼 Drive API）、本機資料夾、保留份數 |
| `src/routes/*.js` | 各模組 API，依模組拆檔（`inventory.js` 庫存管理、`assets.js` 資產管理） |
| `public/` | 前端。原生 JS 單頁應用，未經打包，可直接搜尋與修改 |
| `public/vendor/xlsx.full.min.js` | SheetJS 靜態檔。報價單 Excel 與庫存報表匯出用，前端 `loadXLSX()` 登入後用到時才載入；不是 npm 套件 |
| `data/` | 執行時產生，不在版控內 |

無原生模組、無絕對路徑，只依賴 `express`、`express-session` 與 `pg`（只在設定 `DATABASE_URL` 時才載入）。

### 資料庫模式（`DATABASE_URL`）

- 每個 `store.TABLES` 一張表 `(pos integer PK, data jsonb)`，另有 `pms_meta` 存 `seq` 與寫入代數 `gen`；啟動時 `CREATE TABLE IF NOT EXISTS`。
- 路由完全不用改：照舊同步修改記憶體再 `store.commit()`。寫入時比對各表 JSON，只重寫有變動的表（整表 DELETE + INSERT，同一個交易）。
- `server.js` 攔下非 GET 的 `/api` 回應，等 `store.settle(since)` 確認寫入完成才送出；失敗回 503、與別處衝突回 409，
  且記憶體會還原成資料庫內容（`discardUnsaved` / `reloadAfterConflict`），所以「沒有儲存」就是真的沒存。
- 本機版與線上版可共用同一個資料庫：寫入前以 `gen` 做樂觀鎖（`SELECT … FOR UPDATE`），請求前 `store.refresh()` 發現 `gen` 變了就重新載入
  （寫入每次查、讀取最多每 10 秒查一次，不做背景輪詢以免 Neon 不休眠）。
- 操作紀錄在資料庫模式下是在送出回應前記錄、和該次修改同一次寫入，不在 `finish` 之後另外寫。
- 新增資料表只要加進 `store.TABLES`，資料庫會自動建表。

## 前端

`public/js/app.js`（約 4150 行）是整個 SPA，結構是一個 `MODULES` 物件，
每個模組有 `title`、`perm`、`render()`，清單與表單都用共用的
`renderListPage()` / `pagedTable()` / `openForm()` 產生。

**後端 API 是依前端實際送出與讀取的欄位設計的。**
要改後端行為前，先在 `public/js/app.js` 搜尋對應的 `api('/api/...')` 呼叫，
確認前端到底送了什麼、讀了哪些欄位名稱，不要憑空猜測。

## 慣例

- 單據編號由 `store.nextCode()` 掃描現有最大值產生：
  `C0001` 客戶、`V0001` 廠商、`P0001` 專案、`Q0001` 報價（改版加 `-1`）、
  `AR0001` 應收、`AP0001` 應付、`RO0001` 維修、`A0001` 帳號（預設管理者帳號為 `Admin`，不在流水號內）、
  `MA00001` 料號（5 碼）、`SI0001` 入庫單、`SO0001` 領料單、`CA00001` 資產（5 碼）。
- 金額一律整數（`util.num()` 四捨五入）；日期存 `YYYY-MM-DD` 字串，空值存 `null`。
- 權限九種（`perm_admin`、customer、quote、project、vendor、payable、receivable、accounting、inventory），
  `perm_admin` 自動擁有全部（見 `util.hasPerm`）。資產管理用 `perm_accounting`，庫存管理用 `perm_inventory`。
  新增權限時要同時改 `routes/accounts.js` 的 `PERMS`、`routes/auth.js` 的 `publicUser`、`seed.js` 與前端 `PERM_LIST`。
- **報價明細分大項**：`quote_items.section` 為大項名稱，前端依大項順序送出、`seq_no` 為整張單的流水順序，
  後端 `saveItems` 略過空白列並重新編號。前端 `groupQuoteItems()` 以「連續相同 section」分組，
  明細、列印與 Excel 匯出都靠它；大項小計／合計／稅額／總計由前端計算，後端只存單價×數量的 `subtotal`。
- **庫存**：目前庫存＝`materials.init_qty`＋入庫合計－領料合計，由 `routes/inventory.js` 即時計算、不存欄位；
  領料與修改領料單會檢查庫存（修改時排除自己那張），刪入庫單不可讓庫存變負。
  入庫／領料表單送的日期欄位是 `doc_date`（後端也接受 `in_date`／`out_date`）。
- **資產**：`assets.scrap_date` 有值＝已報廢（API 回傳 `status`），報廢日期不可早於購入日期。
- 每次請求都從 DB 重讀權限（`routes/auth.js` 的 `router.use`），權限調整立即生效。
- 所有非 GET 的 `/api/` 請求都會寫入操作紀錄，密碼與檔案內容以 `***` 遮蔽。
- **`public/` 的檔案預設要登入才能下載**（`server.js` 的 `PUBLIC_FILES` 白名單）。
  未登入只拿得到登入頁本身用的 `index.html`、`style.css`、`logo.png`；
  登入頁若要新增圖片或程式，必須加進白名單，否則未登入時會載入失敗。
- **自動備份**（`src/backup.js` + `src/routes/backup.js`）：設定存 `settings` 表的 `backup`、狀態存 `backup_state`。
  排程時間以本機時間字串比較，`server.js` 啟動時把 `TZ` 設成 `Asia/Taipei`（可用 `APP_TZ` 改），
  否則放到 Render（UTC）會差 8 小時。`/api/backup/trigger` 不需登入、以 `BACKUP_KEY` 驗證，已加進門禁 `OPEN_PATHS`。
  備份內容由 `exportData()` 產生，與 `/api/admin/export`、系統還原完全相同。
- **門禁**（`src/routes/gate.js`）是系統登入之前的外層關卡，`gateGuard` 掛在所有路由之前。
  門禁帳號存 `gate_accounts`、開關存 `settings`，與系統帳號 `accounts` 完全分開。
  門禁頁要用的檔案在 `OPEN_PATHS` 白名單。門禁「開關打開且至少一個啟用帳號」才生效，
  API 會擋下停用/刪除最後一個啟用帳號；`GATE_OFF=1` 為緊急略過。
  系統登出 (`/api/logout`) 只清 `req.session.user`、保留門禁通行證；
  離開門禁 (`/api/gate/logout`) 才整個 session 清掉。

## 容易踩到的商業邏輯

- **薪資／獎金單存在 `payables`，以 `emp_id` 有值區分**，且**必須排除在 `/api/payables` 之外**，
  只有「會計維護 → 員工薪資」查得到。
- **會計歸期**：應收「已收款」依收款日、「待收款」依應收日；
  應付「已付款」依付款日、「待付款」依建立日。
  改報表前先讀 `src/routes/reports.js` 開頭的 `arAcctDate` / `apAcctDate`。
- **損益表**：工程成本＝有掛 `proj_id` 的應付；營業費用＝沒掛專案的應付（含薪資獎金），
  依 `expense_category` 分組。
- **進項稅額**只有憑證類別為「三聯式發票」「電子發票(含統編)」可扣抵，
  其餘一律歸零（`payables.isDeductible`）。
- **401 申報依發票日期歸期**，不是應收應付日期；沒填發票日期的單據不會納入。
- **支票到期提醒不看付款狀態**——遠期支票一定已登錄為「已付款」，錢是到期日才扣。
- **首頁熱區** `HOME_SPOTS` 是對準 `public/img/home.png` 的百分比座標，
  換圖必須同步檢查，否則點擊區會錯位。

## 環境相依的注意事項

`啟動系統.bat` 是 **CP950(Big5) 編碼 + CRLF 換行**。
這兩點都不能改成 UTF-8 或 LF——在繁體中文 Windows 上，
UTF-8 會讓訊息變亂碼，LF 會讓 cmd 誤判多行區塊導致視窗直接關閉。
批次檔內用 `goto` 標籤而非多行 `if (...)` 區塊，也是為了同一個原因。

## 修改後的驗證

改動後請跑一次完整流程：登入 → 各模組新增修改刪除 → 報價大項／Excel 匯入匯出／依加成算售價 → 報價改版 →
專案階段與變更單 → 結案附件上傳下載 → 收付款登錄 → 發薪 →
五種報表 → 庫存（入庫單查無料號→新增料號→查無廠商→新增廠商、領料單庫存不足、庫存報表匯出與列印）→
資產（新增、報廢、報廢日期早於購入日期被擋）→ 備份還原 → 備份設定（本機資料夾立即備份、保留份數、排程）→
權限隔離（用非管理者帳號確認看不到不該看的功能；只有庫存權限看不到資產、只有會計權限看不到庫存）→
門禁（開啟後外人只看得到門禁頁、停用或重設密碼立即生效、離開門禁）。
