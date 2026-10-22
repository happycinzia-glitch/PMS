/* ── 帳號管理 (僅系統管理者) ─────────────────────────── */
const express = require('express');
const store = require('../store');
const { requirePerm, str, num, date, bool, nowISO, hashPassword, matches } = require('../util');

const router = express.Router();
const perm = requirePerm('perm_admin');

const PERMS = ['perm_admin', 'perm_customer', 'perm_quote', 'perm_project',
  'perm_vendor', 'perm_payable', 'perm_receivable', 'perm_accounting', 'perm_inventory'];

// 一律不回傳密碼雜湊
const publicRow = ({ password, ...rest }) => rest;

function body(src) {
  const out = {
    name: str(src.name),
    title: str(src.title),
    salary: num(src.salary),
    hire_date: date(src.hire_date),
    resign_date: date(src.resign_date),
    status: str(src.status) || '正常',
    note: str(src.note),            // 備註 (負責區域、排班等備忘)，清單與明細都會顯示
  };
  for (const p of PERMS) out[p] = bool(src[p]);
  return out;
}

router.get('/accounts', perm, (req, res) => {
  const q = str(req.query.q);
  const rows = store.all('accounts')
    .filter(a => matches(a, ['emp_id', 'name', 'title'], q))
    .sort((a, b) => a.emp_id.localeCompare(b.emp_id))
    .map(publicRow);
  res.json(rows);
});

router.get('/accounts/:id', perm, (req, res) => {
  const a = store.find('accounts', 'emp_id', req.params.id);
  if (!a) return res.status(404).json({ error: '查無此帳號。' });
  res.json(publicRow(a));
});

router.post('/accounts', perm, (req, res) => {
  const v = body(req.body || {});
  const password = String(req.body?.password || '');
  if (!v.name) return res.status(400).json({ error: '請填寫姓名。' });
  if (!password) return res.status(400).json({ error: '新帳號必須設定密碼。' });

  const row = {
    emp_id: store.nextCode('accounts', 'emp_id', 'A'),
    ...v,
    password: hashPassword(password),
    last_login: null,
    fail_count: 0,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.insert('accounts', row);
  res.json(publicRow(row));
});

router.put('/accounts/:id', perm, (req, res) => {
  const a = store.find('accounts', 'emp_id', req.params.id);
  if (!a) return res.status(404).json({ error: '查無此帳號。' });
  const v = body(req.body || {});
  if (!v.name) return res.status(400).json({ error: '請填寫姓名。' });

  // 不可移除自己的系統管理者權限，也不可把自己停用 (避免鎖死系統)
  if (a.emp_id === req.session.user.emp_id) {
    if (!v.perm_admin) return res.status(400).json({ error: '不可移除自己的系統管理者權限。' });
    if (v.status !== '正常') return res.status(400).json({ error: '不可將自己的帳號設為停用或鎖住。' });
  }
  // 系統至少要保留一位可登入的管理者
  if ((a.perm_admin && !v.perm_admin) || (a.status === '正常' && v.status !== '正常')) {
    const others = store.all('accounts')
      .filter(x => x.emp_id !== a.emp_id && x.perm_admin && x.status === '正常');
    if (!others.length) return res.status(400).json({ error: '系統必須保留至少一位「正常」狀態的系統管理者。' });
  }

  Object.assign(a, v, { updated_at: nowISO() });
  if (req.body?.password) a.password = hashPassword(String(req.body.password));
  if (v.status === '正常') a.fail_count = 0;   // 改回正常即完成解鎖
  store.commit();
  res.json(publicRow(a));
});

router.delete('/accounts/:id', perm, (req, res) => {
  const a = store.find('accounts', 'emp_id', req.params.id);
  if (!a) return res.status(404).json({ error: '查無此帳號。' });
  if (a.emp_id === req.session.user.emp_id) return res.status(400).json({ error: '不可刪除自己的帳號。' });
  if (a.perm_admin) {
    const others = store.all('accounts')
      .filter(x => x.emp_id !== a.emp_id && x.perm_admin && x.status === '正常');
    if (!others.length) return res.status(400).json({ error: '系統必須保留至少一位系統管理者。' });
  }
  if (store.all('payables').some(p => p.emp_id === a.emp_id)) {
    return res.status(400).json({ error: '此帳號已有薪資/獎金紀錄，建議改為「已離職」而非刪除。' });
  }
  store.remove('accounts', x => x.emp_id === a.emp_id);
  res.json({ ok: true });
});

module.exports = router;
