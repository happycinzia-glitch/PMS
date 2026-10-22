/* ── 應收款項 ─────────────────────────────────────────── */
const express = require('express');
const store = require('../store');
const {
  requirePerm, requireLogin, hasPerm,
  str, num, numOrNull, date, bool, nowISO, today, empName, custName, projName,
} = require('../util');

const router = express.Router();
const perm = requirePerm('perm_receivable');
// 「會計維護」頁也要能改應收單：具會計或應收任一權限即可
const permAcct = (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: '尚未登入。' });
  if (hasPerm(req.session.user, 'perm_accounting') || hasPerm(req.session.user, 'perm_receivable')) return next();
  return res.status(403).json({ error: '您的帳號沒有使用此功能的權限，請聯絡系統管理者。' });
};

function decorate(r) {
  const c = store.find('customers', 'cust_id', r.cust_id);
  return {
    ...r,
    cust_name: c?.name || '',
    cust_company: c?.company || '',
    proj_name: projName(r.proj_id),
    created_by_name: empName(r.created_by),
  };
}

// 稅額留空時自動以金額 × 5% 計算
function taxOf(src, amount) {
  const t = numOrNull(src.tax);
  return t === null ? Math.round(amount * 0.05) : t;
}

function body(src) {
  const amount = num(src.amount);
  return {
    cust_id: str(src.cust_id),
    quote_id: str(src.quote_id),
    proj_id: str(src.proj_id),
    due_date: date(src.due_date) || today(),
    item: str(src.item),
    amount,
    tax: taxOf(src, amount),
    invoice_no: str(src.invoice_no),
    invoice_date: date(src.invoice_date),
    invoice_void: bool(src.invoice_void),
    receive_method: str(src.receive_method),
    discount: num(src.discount),
    is_retention: bool(src.is_retention),
    note: str(src.note),
  };
}

/* 無關鍵字：只顯示待收款，依收款單號遞減 */
router.get('/receivables', perm, (req, res) => {
  const q = str(req.query.q).toLowerCase();
  let rows = store.all('receivables').map(decorate);
  if (q) {
    rows = rows.filter(r => ['ar_id', 'quote_id', 'cust_name', 'proj_id', 'item']
      .some(f => String(r[f] ?? '').toLowerCase().includes(q)));
  } else {
    rows = rows.filter(r => r.status === '待收款');
  }
  rows.sort((a, b) => b.ar_id.localeCompare(a.ar_id));
  res.json(rows);
});

router.get('/receivables/:id', permAcct, (req, res) => {
  const r = store.find('receivables', 'ar_id', req.params.id);
  if (!r) return res.status(404).json({ error: '查無此收款單。' });
  res.json(decorate(r));
});

router.post('/receivables', perm, (req, res) => {
  const v = body(req.body || {});
  if (!v.cust_id) return res.status(400).json({ error: '請選擇客戶。' });
  const row = {
    ar_id: store.nextCode('receivables', 'ar_id', 'AR'),
    ...v,
    status: '待收款',                      // 新增固定待收款，收款請至「會計維護」
    received_date: null,
    received_amount: null,
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.insert('receivables', row);
  res.json(decorate(row));
});

router.put('/receivables/:id', perm, (req, res) => {
  const r = store.find('receivables', 'ar_id', req.params.id);
  if (!r) return res.status(404).json({ error: '查無此收款單。' });
  Object.assign(r, body(req.body || {}), { updated_at: nowISO() });
  store.commit();
  res.json(decorate(r));
});

/* ── 會計維護：收款登錄 (欄位全部可改) ── */
router.patch('/receivables/:id/receive', permAcct, (req, res) => {
  const r = store.find('receivables', 'ar_id', req.params.id);
  if (!r) return res.status(404).json({ error: '查無此收款單。' });
  const b = req.body || {};
  const v = body(b);
  const status = ['已收款', '待收款'].includes(str(b.status)) ? str(b.status) : r.status;

  Object.assign(r, v, {
    status,
    received_date: status === '已收款' ? (date(b.received_date) || today()) : date(b.received_date),
    received_amount: status === '已收款'
      ? (numOrNull(b.received_amount) ?? (v.amount + v.tax - v.discount))
      : numOrNull(b.received_amount),
    updated_at: nowISO(),
  });
  store.commit();
  res.json(decorate(r));
});

router.delete('/receivables/:id', perm, (req, res) => {
  const n = store.remove('receivables', r => r.ar_id === req.params.id);
  if (!n) return res.status(404).json({ error: '查無此收款單。' });
  res.json({ ok: true });
});

module.exports = router;
module.exports.decorate = decorate;
