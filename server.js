/* ============================================================
   專案管理系統 — 本機版伺服器
   啟動：npm start   → http://localhost:3000
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

/* ── 載入 .env 設定檔（如果有的話）── 必須在載入 store / seed 之前執行 (見 src/env.js) */
require('./src/env').loadDotEnv(path.join(__dirname, '.env'));

/* ── 時區：日期、報表歸期與自動備份的排程時間都以台灣時間為準。
   本機 Windows 本來就是台灣時間；放到 Render 這類主機預設是 UTC，不設的話
   「18:00 備份」會在台灣凌晨 2 點執行、今天的日期也會差 8 小時。 */
process.env.TZ = process.env.APP_TZ || 'Asia/Taipei';

const store = require('./src/store');
const { seed } = require('./src/seed');
const { nowISO } = require('./src/util');

const PORT = Number(process.env.PORT) || 3000;
const app = express();

/* ── Session 簽章金鑰 ──
   優先用環境變數 SESSION_SECRET；沒有的話首次啟動自動產生一組亂數存檔，
   之後每次啟動沿用同一組。目的是讓每套安裝各自擁有獨立金鑰，
   而不是全部共用寫死在原始碼裡的同一組。
   註：登入狀態本身存在記憶體，重啟伺服器仍會需要重新登入。 */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  const file = path.join(store.DATA_DIR, 'session-secret.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch { /* 檔案還不存在，往下產生 */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret + '\n', 'utf8');
  console.log('  已產生本機專用的 session 金鑰：' + file);
  return secret;
}

// 檔案上傳走 base64 JSON，單檔上限 10MB → 放寬 body 上限
app.use(express.json({ limit: '25mb' }));
app.use(session({
  name: 'pms.sid',
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },  // 8 小時
}));

/* ── 操作紀錄：記錄所有寫入動作 (不含查詢與密碼內容) ── */
const SECRET_KEYS = ['password', 'old_password', 'new_password', 'new_password2', 'data', 'image'];
function recordAudit(req, res) {
  const user = req.session?.user;
  const detail = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (SECRET_KEYS.includes(k)) detail[k] = '***';
    else if (typeof v === 'string' && v.length > 120) detail[k] = v.slice(0, 120) + '…';
    else if (Array.isArray(v)) detail[k] = `[${v.length} 筆]`;
    else detail[k] = v;
  }
  const rows = store.all('audit');
  rows.push({
    id: store.nextInt('audit'),
    at: nowISO(),
    emp_id: user?.emp_id || '',
    emp_name: user?.name || '',
    method: req.method,
    path: req.path,
    status: res.statusCode,
    detail,
  });
  // 只保留最近 1000 筆
  if (rows.length > 1000) rows.splice(0, rows.length - 1000);
  store.commit();
}
// 資料庫模式改由下方的中介層在等待寫入前記錄，和這次的修改一起寫進資料庫
if (!store.USE_PG) {
  app.use((req, res, next) => {
    if (req.method === 'GET' || !req.path.startsWith('/api/')) return next();
    res.on('finish', () => recordAudit(req, res));
    next();
  });
}

/* ── 資料庫模式：寫入類請求要等資料真的寫進資料庫才回應 ──
   各路由照舊同步改記憶體裡的資料再回應；這裡把「送出回應」攔下來，
   等 store.settle() 確認寫入完成才真的送出。寫入失敗就改回 503，
   讓使用者知道這次的修改沒有存進去，而不是畫面顯示成功、重啟後資料卻不見。 */
if (store.USE_PG) {
  // 本機版與線上版共用同一個資料庫時，先確認對方有沒有改過資料 (見 store.refresh)
  app.use('/api', (req, res, next) => { store.refresh(req.method !== 'GET').then(() => next(), next); });
  app.use((req, res, next) => {
    if (req.method === 'GET' || !req.path.startsWith('/api/')) return next();
    const since = store.currentVersion();
    const end = res.end;
    res.end = function (...args) {
      res.end = end;
      recordAudit(req, res);   // 跟這次的修改同一次寫入，不會在回應後另外再寫一次
      store.settle(since).then(
        () => end.apply(res, args),
        (err) => {
          console.error('  資料庫寫入失敗：', err.message);
          const conflict = err.code === 'PMS_CONFLICT';
          const body = JSON.stringify({ error: conflict
            ? '資料剛被另一處 (另一台電腦或線上版) 修改過，這次的修改沒有儲存。請重新整理畫面後再做一次。'
            : '資料庫連線失敗，這次的修改沒有儲存，請稍後再試一次。' });
          for (const h of res.getHeaderNames()) if (h !== 'set-cookie') res.removeHeader(h);
          res.statusCode = conflict ? 409 : 503;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(body));
          end.call(res, body);
        });
      return res;
    };
    next();
  });
}

/* ── 門禁：沒通過的人連系統登入頁、前端程式、API 都拿不到 (見 src/routes/gate.js) ── */
const gateRoutes = require('./src/routes/gate');
app.use(gateRoutes.gateGuard);

/* ── API 路由 ── */
app.use('/api', require('./src/routes/auth'));   // 須在最前：每次請求重新載入權限
app.use('/api', gateRoutes);
app.use('/api', require('./src/routes/lookups'));
app.use('/api', require('./src/routes/customers'));
app.use('/api', require('./src/routes/vendors'));
app.use('/api', require('./src/routes/projects'));
app.use('/api', require('./src/routes/repairs'));
app.use('/api', require('./src/routes/quotes'));
app.use('/api', require('./src/routes/receivables'));
app.use('/api', require('./src/routes/payables'));
app.use('/api', require('./src/routes/accounting'));
app.use('/api', require('./src/routes/reports'));
app.use('/api', require('./src/routes/inventory'));
app.use('/api', require('./src/routes/assets'));
app.use('/api', require('./src/routes/accounts'));
app.use('/api', require('./src/routes/admin'));
app.use('/api', require('./src/routes/backup'));

// 未定義的 API 一律回 JSON (避免前端 res.json() 解析到 HTML)
app.use('/api', (req, res) => res.status(404).json({ error: '找不到此功能 (' + req.path + ')。' }));

/* ── 前端檔案需登入才能下載 ──
   未登入只開放登入頁本身用到的檔案，其餘 (app.html、app.js、流程圖…) 一律擋下，
   避免外人不用帳號就能把整個前端程式存走。
   採白名單：日後在 public/ 新增的檔案預設都受保護。 */
const PUBLIC_FILES = new Set(['/', '/index.html', '/index', '/gate', '/gate.html',
  '/css/style.css', '/img/logo.png', '/favicon.ico']);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || PUBLIC_FILES.has(req.path)) return next();
  const user = req.session?.user;
  const a = user && store.find('accounts', 'emp_id', user.emp_id);
  if (!a || a.status !== '正常') {
    // 瀏覽器直接開網頁就導回登入頁；其他檔案 (js/css/圖片) 回 401
    if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.redirect('/');
    return res.status(401).type('text').send('請先登入。');
  }
  // 登入後才拿得到的檔案不讓中間的代理伺服器快取
  res.setHeader('Cache-Control', 'private, no-cache');
  next();
});

/* ── 靜態檔案 (前端與原站完全相同) ── */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ── 錯誤處理 ── */
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const tooLarge = err.type === 'entity.too.large';
  res.status(tooLarge ? 413 : 500)
    .json({ error: tooLarge ? '檔案過大，單檔上限 10MB。' : (err.message || '伺服器發生錯誤。') });
});

/* ── 啟動：先載入資料 (資料庫模式要等連線) 再開始接受連線 ── */
(async () => {
  await store.load();
  await seed();
  app.listen(PORT, () => {
    require('./src/backup').start();   // 自動備份排程 (見 備份設定 頁)
    console.log('');
    console.log('  專案管理系統已啟動');
    console.log(`  網址：http://localhost:${PORT}`);
    console.log(`  資料：${store.describe()}`);
    console.log('');
  });
})().catch((err) => {
  console.error('');
  console.error('  系統無法啟動：' + err.message);
  if (store.USE_PG) {
    console.error('  請確認 .env 的 DATABASE_URL 是從 Neon 用 Copy 按鈕複製的完整一行');
    console.error('  (開頭 postgresql://、中間沒有空白或斷行)，以及這台電腦可以連上網路。');
  }
  console.error('');
  process.exit(1);
});
