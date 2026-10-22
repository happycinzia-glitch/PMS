/* ── 下拉選單資料來源 ──────────────────────────────────
   /api/lookups/:name  各表的簡表 (表單下拉用)
   /api/options/:cat   「項目維護」管理的清單
──────────────────────────────────────────────────── */
const express = require('express');
const store = require('../store');
const { requireLogin, requirePerm, custName, str, matches } = require('../util');

const router = express.Router();

const LOOKUPS = {
  employees: () => store.all('accounts')
    .filter(a => a.status !== '已離職')
    .sort((a, b) => a.emp_id.localeCompare(b.emp_id))
    .map(a => ({ emp_id: a.emp_id, name: a.name })),

  customers: () => store.all('customers')
    .filter(c => c.status !== '拒絕往來')
    .sort((a, b) => a.cust_id.localeCompare(b.cust_id))
    .map(c => ({ cust_id: c.cust_id, name: c.name })),

  // 廠商 (排除拒絕往來)。可帶 q 搜尋 廠商編號/公司名稱/業務/手機/統編/營業項目
  // (料號與資產表單的「查詢廠商」視窗用，所以多回傳幾個欄位)
  vendors: (q) => store.all('vendors')
    .filter(v => v.status !== '拒絕往來')
    .filter(v => matches(v, ['vend_id', 'company_name', 'sales_name', 'mobile', 'tax_id', 'business_item'], q))
    .sort((a, b) => a.vend_id.localeCompare(b.vend_id))
    .map(v => ({
      vend_id: v.vend_id, company_name: v.company_name, sales_name: v.sales_name,
      mobile: v.mobile, tax_id: v.tax_id, business_item: v.business_item, payment_method: v.payment_method,
    })),

  projects: () => store.all('projects')
    .slice().sort((a, b) => b.proj_id.localeCompare(a.proj_id))
    .map(p => ({ proj_id: p.proj_id, proj_name: p.proj_name })),

  quotes: () => store.all('quotes')
    .slice().sort((a, b) => b.quote_id.localeCompare(a.quote_id))
    .map(q => ({ quote_id: q.quote_id, proj_name: q.proj_name })),

  // 新增專案時可從「已確認」報價單帶入名稱/客戶/地址
  'confirmed-quotes': () => store.all('quotes')
    .filter(q => q.status === '已確認')
    .sort((a, b) => b.quote_id.localeCompare(a.quote_id))
    .map(q => ({
      quote_id: q.quote_id, proj_name: q.proj_name,
      cust_id: q.cust_id, cust_name: custName(q.cust_id), addr: q.addr,
    })),
};

router.get('/lookups/:name', requireLogin, (req, res) => {
  const fn = LOOKUPS[req.params.name];
  if (!fn) return res.status(404).json({ error: '找不到此清單。' });
  res.json(fn(str(req.query.q)));
});

/* ── 項目維護的下拉清單 ── */
const VALID_CATEGORIES = new Set([
  'vendor_business', 'vendor_payment',
  'receivable_item', 'receivable_receive_method',
  'payable_item', 'payable_pay_method',
  'expense_category', 'project_status',
]);

router.get('/options/:cat', requireLogin, (req, res) => {
  const cat = req.params.cat;
  if (!VALID_CATEGORIES.has(cat)) return res.status(404).json({ error: '找不到此清單。' });
  const values = store.all('options')
    .filter(o => o.category === cat)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map(o => o.value);
  res.json(values);
});

// 維護清單需要「會計」權限 (與項目維護頁一致)
router.put('/options/:cat', requirePerm('perm_accounting'), (req, res) => {
  const cat = req.params.cat;
  if (!VALID_CATEGORIES.has(cat)) return res.status(404).json({ error: '找不到此清單。' });
  const input = Array.isArray(req.body?.values) ? req.body.values : null;
  if (!input) return res.status(400).json({ error: '資料格式不正確。' });

  // 去空白、去重複，保留送出的順序
  const clean = [];
  for (const v of input.map(str)) if (v && !clean.includes(v)) clean.push(v);

  store.remove('options', o => o.category === cat);
  clean.forEach((value, i) => store.all('options').push({ category: cat, value, seq: i + 1 }));
  store.commit();
  res.json(clean);
});

module.exports = router;
