/* ============================================================
   門禁登入：在系統登入頁「之前」的外層關卡
   沒通過門禁的人連系統登入頁、前端程式、API 都拿不到。
   門禁帳號與系統帳號分開管理，只有系統管理者能維護。

   安全設計：
   - 門禁需「開關打開」且「至少一個啟用中的門禁帳號」才會生效，避免把所有人鎖在外面
   - 開啟門禁時必須輸入一組門禁帳號密碼確認，並讓操作者本人直接通過
   - 連續錯誤 5 次暫停該帳號 15 分鐘 (暫時鎖定，避免被惡意猜帳號鎖死)
   - 每次請求重新檢查門禁帳號：停用、刪除或重設密碼後，已通過的人立即被請出
   - 緊急狀況可設定環境變數 GATE_OFF=1 重新啟動，暫時略過門禁
   ============================================================ */
const express = require('express');
const store = require('../store');
const { requirePerm, str, nowISO, hashPassword, verifyPassword, matches } = require('../util');

const router = express.Router();
const perm = requirePerm('perm_admin');

const MAX_FAIL = 5;
const LOCK_MINUTES = 15;
const MIN_PASSWORD = 8;
const ID_RULE = /^[A-Za-z0-9_.-]{3,32}$/;

// 未通過門禁也能取得的檔案與 API (門禁登入頁本身要用的)
const OPEN_PATHS = new Set([
  '/gate', '/gate.html', '/css/style.css', '/img/logo.png', '/favicon.ico',
  '/api/gate/login', '/api/gate/status',
  '/api/backup/trigger',   // 外部排程服務觸發備份 (以 BACKUP_KEY 驗證，見 routes/backup.js)
]);

/* ── 設定 (settings 表：{ key, value }) ── */
function getSetting(key) {
  return store.find('settings', 'key', key)?.value;
}
function setSetting(key, value) {
  const row = store.find('settings', 'key', key);
  if (row) row.value = value;
  else store.all('settings').push({ key, value });
  store.commit();
}

const isActive = (g) => g.status === '啟用';
const activeCount = () => store.all('gate_accounts').filter(isActive).length;

// 門禁是否真的生效
function gateOn() {
  if (process.env.GATE_OFF === '1') return false;
  return getSetting('gate_enabled') === true && activeCount() > 0;
}

// 目前 session 的門禁通行證是否仍有效
function passValid(req) {
  const pass = req.session?.gate;
  if (!pass) return false;
  const g = store.find('gate_accounts', 'gate_id', pass.gate_id);
  if (!g || !isActive(g)) return false;
  // 通過之後密碼被重設 → 通行證作廢
  if (g.password_changed_at && g.password_changed_at > pass.at) return false;
  return true;
}

/* ── 守門中介層：掛在所有路由之前 ── */
function gateGuard(req, res, next) {
  if (OPEN_PATHS.has(req.path) || !gateOn() || passValid(req)) return next();
  if (req.session?.gate) delete req.session.gate;
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '請先通過門禁登入。', gate: true });
  }
  if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.redirect('/gate');
  return res.status(401).type('text').send('請先通過門禁登入。');
}

const publicRow = ({ password, ...rest }) => ({
  ...rest,
  locked: !!(rest.locked_until && rest.locked_until > nowISO()),
});

/* ── 門禁登入頁用 ── */
router.get('/gate/status', (req, res) => {
  res.json({ required: gateOn(), passed: !gateOn() || passValid(req) });
});

router.post('/gate/login', (req, res) => {
  const gate_id = str(req.body?.gate_id);
  const password = String(req.body?.password || '');
  if (!gate_id || !password) return res.status(400).json({ error: '請輸入門禁帳號與密碼。' });

  const g = store.find('gate_accounts', 'gate_id', gate_id);
  // 帳號不存在或停用都回同一句話，不透露帳號是否存在
  if (!g || !isActive(g)) return res.status(401).json({ error: '門禁帳號或密碼錯誤。' });
  if (g.locked_until && g.locked_until > nowISO()) {
    return res.status(403).json({ error: `錯誤次數過多，請 ${LOCK_MINUTES} 分鐘後再試，或聯絡系統管理者解除。` });
  }
  if (!verifyPassword(password, g.password)) {
    g.fail_count = (Number(g.fail_count) || 0) + 1;
    if (g.fail_count >= MAX_FAIL) {
      g.locked_until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      g.fail_count = 0;
    }
    store.commit();
    return res.status(401).json({ error: '門禁帳號或密碼錯誤。' });
  }

  g.fail_count = 0;
  g.locked_until = null;
  g.last_login = nowISO();
  store.commit();
  req.session.gate = { gate_id: g.gate_id, at: nowISO() };
  res.json({ ok: true });
});

router.post('/gate/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ── 維護頁 (僅系統管理者) ── */
router.get('/gate/settings', perm, (req, res) => {
  res.json({
    enabled: getSetting('gate_enabled') === true,
    active: gateOn(),
    active_count: activeCount(),
    env_off: process.env.GATE_OFF === '1',
  });
});

// 開啟時必須輸入一組門禁帳號密碼，確認真的進得來，並讓操作者本人直接通過
router.put('/gate/settings', perm, (req, res) => {
  const enabled = req.body?.enabled === true;
  if (!enabled) {
    setSetting('gate_enabled', false);
    return res.json({ ok: true, enabled: false });
  }
  const g = store.find('gate_accounts', 'gate_id', str(req.body?.gate_id));
  if (!g || !isActive(g) || !verifyPassword(String(req.body?.password || ''), g.password)) {
    return res.status(400).json({ error: '請輸入一組「啟用中」門禁帳號的正確密碼，確認開啟後進得來。' });
  }
  setSetting('gate_enabled', true);
  req.session.gate = { gate_id: g.gate_id, at: nowISO() };
  res.json({ ok: true, enabled: true });
});

router.get('/gate/accounts', perm, (req, res) => {
  const q = str(req.query.q);
  res.json(store.all('gate_accounts')
    .filter(g => matches(g, ['gate_id', 'name', 'note'], q))
    .sort((a, b) => a.gate_id.localeCompare(b.gate_id))
    .map(publicRow));
});

router.get('/gate/accounts/:id', perm, (req, res) => {
  const g = store.find('gate_accounts', 'gate_id', req.params.id);
  if (!g) return res.status(404).json({ error: '查無此門禁帳號。' });
  res.json(publicRow(g));
});

function checkPassword(pw) {
  if (pw.length < MIN_PASSWORD) return `門禁密碼至少 ${MIN_PASSWORD} 個字元（會放在網路上，請用不好猜的密碼）。`;
  return null;
}

router.post('/gate/accounts', perm, (req, res) => {
  const b = req.body || {};
  const gate_id = str(b.gate_id);
  const password = String(b.password || '');
  if (!ID_RULE.test(gate_id)) return res.status(400).json({ error: '門禁帳號請用 3～32 個英文、數字或 _ . -。' });
  if (store.find('gate_accounts', 'gate_id', gate_id)) return res.status(400).json({ error: '此門禁帳號已存在。' });
  if (!str(b.name)) return res.status(400).json({ error: '請填寫名稱。' });
  const err = checkPassword(password);
  if (err) return res.status(400).json({ error: err });

  const row = {
    gate_id,
    name: str(b.name),
    status: str(b.status) === '停用' ? '停用' : '啟用',
    note: str(b.note),
    password: hashPassword(password),
    password_changed_at: nowISO(),
    fail_count: 0, locked_until: null, last_login: null,
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.insert('gate_accounts', row);
  res.json(publicRow(row));
});

// 門禁開啟中，不可讓「啟用中」的門禁帳號歸零 (否則門禁會自動失效)
function wouldEmptyGate(g) {
  return getSetting('gate_enabled') === true && isActive(g) && activeCount() <= 1;
}

router.put('/gate/accounts/:id', perm, (req, res) => {
  const g = store.find('gate_accounts', 'gate_id', req.params.id);
  if (!g) return res.status(404).json({ error: '查無此門禁帳號。' });
  const b = req.body || {};
  if (!str(b.name)) return res.status(400).json({ error: '請填寫名稱。' });
  const status = str(b.status) === '停用' ? '停用' : '啟用';
  if (status === '停用' && wouldEmptyGate(g)) {
    return res.status(400).json({ error: '門禁開啟中，至少要保留一個啟用的門禁帳號。請先關閉門禁再停用。' });
  }
  const password = String(b.password || '');
  if (password) {
    const err = checkPassword(password);
    if (err) return res.status(400).json({ error: err });
    g.password = hashPassword(password);
    g.password_changed_at = nowISO();     // 已用舊密碼通過的人會被請出
  }
  Object.assign(g, { name: str(b.name), status, note: str(b.note), updated_at: nowISO() });
  if (b.unlock) { g.locked_until = null; g.fail_count = 0; }
  store.commit();
  // 改的是自己正在用的門禁帳號密碼 → 讓操作者本人維持通過
  if (password && req.session.gate?.gate_id === g.gate_id) req.session.gate.at = nowISO();
  res.json(publicRow(g));
});

router.delete('/gate/accounts/:id', perm, (req, res) => {
  const g = store.find('gate_accounts', 'gate_id', req.params.id);
  if (!g) return res.status(404).json({ error: '查無此門禁帳號。' });
  if (wouldEmptyGate(g)) {
    return res.status(400).json({ error: '門禁開啟中，至少要保留一個啟用的門禁帳號。請先關閉門禁再刪除。' });
  }
  store.remove('gate_accounts', x => x.gate_id === g.gate_id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.gateGuard = gateGuard;
