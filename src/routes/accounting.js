/* ── 會計維護 (應收 / 應付 / 員工薪資) ────────────────── */
const express = require('express');
const store = require('../store');
const {
  requirePerm, str, num, date, nowISO, today, empName,
} = require('../util');
const { decorate: decorateAR } = require('./receivables');
const { decorate: decorateAP } = require('./payables');

const router = express.Router();
const perm = requirePerm('perm_accounting');

// 待處理的排前面，其餘依單號遞減
const byPendingThenId = (pendingStatus, idKey) => (a, b) => {
  const pa = a.status === pendingStatus ? 0 : 1;
  const pb = b.status === pendingStatus ? 0 : 1;
  return pa - pb || b[idKey].localeCompare(a[idKey]);
};

router.get('/accounting/receivables', perm, (req, res) => {
  const rows = store.all('receivables').map(decorateAR).sort(byPendingThenId('待收款', 'ar_id'));
  res.json(rows);
});

router.get('/accounting/payables', perm, (req, res) => {
  const rows = store.all('payables').filter(p => !p.emp_id)
    .map(decorateAP).sort(byPendingThenId('待付款', 'ap_id'));
  res.json(rows);
});

/* ── 員工薪資 ──
   薪資與獎金單存放於應付款項 (emp_id 有值)，只在本頁籤查得到。 */
const isSalaryRow = (p) => !!p.emp_id;
const ymLabel = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;

router.get('/accounting/salaries', perm, (req, res) => {
  const q = str(req.query.q).toLowerCase();
  let rows = store.all('payables').filter(isSalaryRow)
    .map(p => ({ ...decorateAP(p), emp_name: empName(p.emp_id) }));
  if (q) {
    rows = rows.filter(r => ['ap_id', 'emp_id', 'emp_name', 'item']
      .some(f => String(r[f] ?? '').toLowerCase().includes(q)));
  }
  rows.sort((a, b) => b.ap_id.localeCompare(a.ap_id));
  res.json({ rows });
});

router.get('/accounting/salaries/:id', perm, (req, res) => {
  const p = store.find('payables', 'ap_id', req.params.id);
  if (!p || !isSalaryRow(p)) return res.status(404).json({ error: '查無此薪資單。' });
  // 本單沒有明細時，帶入同一員工最近一次的明細作為預填值
  const prev = store.all('payables')
    .filter(x => x.emp_id === p.emp_id && x.ap_id !== p.ap_id && x.salary_detail)
    .sort((a, b) => b.ap_id.localeCompare(a.ap_id))[0];
  res.json({
    ...decorateAP(p),
    emp_name: empName(p.emp_id),
    salary_detail: p.salary_detail || null,
    prev_detail: prev?.salary_detail || null,
  });
});

router.patch('/accounting/salaries/:id/pay', perm, (req, res) => {
  const p = store.find('payables', 'ap_id', req.params.id);
  if (!p || !isSalaryRow(p)) return res.status(404).json({ error: '查無此薪資單。' });
  const b = req.body || {};
  const d = b.salary_detail || {};
  const detail = {
    labor_ins: num(d.labor_ins), health_ins: num(d.health_ins), salary_tax: num(d.salary_tax),
    emp_labor: num(d.emp_labor), emp_health: num(d.emp_health), pension: num(d.pension),
  };
  const status = ['已付款', '待付款'].includes(str(b.status)) ? str(b.status) : p.status;
  // 實發 ＝ 應發 − 勞保自付 − 健保自付 − 所得稅扣繳
  const net = num(p.amount) - detail.labor_ins - detail.health_ins - detail.salary_tax;

  Object.assign(p, {
    status,
    paid_date: status === '已付款' ? (date(b.paid_date) || today()) : date(b.paid_date),
    paid_amount: b.paid_amount === undefined || b.paid_amount === '' ? net : num(b.paid_amount),
    note: str(b.note),
    salary_detail: detail,
    withholding_tax: detail.salary_tax,   // 供扣繳彙總使用
    updated_at: nowISO(),
  });
  store.commit();
  res.json(decorateAP(p));
});

/* ── 本月發薪：狀態「正常」且有設定薪資的員工各建立一筆，重複執行不會重建 ── */
router.post('/accounting/salaries/pay-month', perm, (req, res) => {
  const ym = ymLabel();
  const item = `${ym}薪資`;
  const created = [], skipped = [], no_salary = [];

  for (const a of store.all('accounts').filter(x => x.status === '正常')) {
    const label = `${a.name}(${a.emp_id})`;
    if (!num(a.salary)) { no_salary.push(label); continue; }
    if (store.all('payables').some(p => p.emp_id === a.emp_id && p.item === item)) {
      skipped.push(label); continue;
    }
    store.all('payables').push(newSalaryRow(req, a.emp_id, item, num(a.salary), '薪資', ''));
    created.push(label);
  }
  store.commit();
  res.json({ item, created, skipped, no_salary });
});

/* ── 本月獎金：手動選員工與金額 ── */
router.post('/accounting/salaries/bonus', perm, (req, res) => {
  const emp_id = str(req.body?.emp_id);
  const amount = num(req.body?.amount);
  const a = store.find('accounts', 'emp_id', emp_id);
  if (!a) return res.status(400).json({ error: '請選擇員工。' });
  if (amount <= 0) return res.status(400).json({ error: '請輸入獎金金額。' });

  const item = `${ymLabel()}獎金`;
  const row = newSalaryRow(req, emp_id, item, amount, '獎金', str(req.body?.note));
  store.insert('payables', row);
  res.json({ ap_id: row.ap_id, item, emp_name: a.name });
});

function newSalaryRow(req, emp_id, item, amount, category, note) {
  return {
    ap_id: store.nextCode('payables', 'ap_id', 'AP'),
    vend_id: '', proj_id: '',
    emp_id,
    due_date: null,
    item,
    expense_category: category,          // 計入損益表的營業費用
    amount,
    doc_type: '', tax_deduct: 0,
    invoice_no: '', invoice_date: null, invoice_void: false,
    income_type: '薪資所得(50)',          // 供扣繳彙總歸類
    withholding_tax: 0, nhi_surcharge: 0, discount: 0,
    pay_method: '', note: note || '',
    salary_detail: null,
    status: '待付款',
    paid_date: null, paid_amount: null,
    check_no: '', check_due: null,
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
}

module.exports = router;
