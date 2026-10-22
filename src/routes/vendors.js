/* ── 廠商基本資料表 ─────────────────────────────────── */
const express = require('express');
const store = require('../store');
const { requirePerm, str, matches, empName, nowISO, stamp } = require('../util');

const router = express.Router();
const perm = requirePerm('perm_vendor');

const SEARCH_FIELDS = ['vend_id', 'company_name', 'sales_name', 'business_item', 'mobile'];
const EDITABLE = ['company_name', 'tax_id', 'sales_name', 'job_title', 'mobile', 'business_item',
  'payment_method', 'company_phone', 'company_email', 'company_addr', 'maintainer', 'status', 'note'];

function body(src) {
  const out = {};
  for (const k of EDITABLE) if (k in src) out[k] = str(src[k]);
  if (!out.status) out.status = '正常';
  return out;
}
function decorate(v) {
  return { ...v, created_by_name: empName(v.created_by), maintainer_name: empName(v.maintainer) };
}

router.get('/vendors', perm, (req, res) => {
  const q = str(req.query.q);
  const rows = store.all('vendors')
    .filter(v => matches(v, SEARCH_FIELDS, q))
    .sort((a, b) => a.vend_id.localeCompare(b.vend_id))
    .map(decorate);
  res.json(rows);
});

router.get('/vendors/:id', perm, (req, res) => {
  const v = store.find('vendors', 'vend_id', req.params.id);
  if (!v) return res.status(404).json({ error: '查無此廠商。' });
  res.json(decorate(v));
});

router.post('/vendors', perm, (req, res) => {
  const v = body(req.body || {});
  if (!v.company_name) return res.status(400).json({ error: '請填寫公司名稱。' });
  if (!v.sales_name) return res.status(400).json({ error: '請填寫業務姓名。' });
  if (!v.mobile) return res.status(400).json({ error: '請填寫手機。' });
  const row = { vend_id: store.nextCode('vendors', 'vend_id', 'V'), ...v, ...stamp(req) };
  store.insert('vendors', row);
  res.json(decorate(row));
});

router.put('/vendors/:id', perm, (req, res) => {
  const v = store.find('vendors', 'vend_id', req.params.id);
  if (!v) return res.status(404).json({ error: '查無此廠商。' });
  const patch = body(req.body || {});
  if (!patch.company_name) return res.status(400).json({ error: '請填寫公司名稱。' });
  Object.assign(v, patch, { updated_at: nowISO() });
  store.commit();
  res.json(decorate(v));
});

router.delete('/vendors/:id', perm, (req, res) => {
  const id = req.params.id;
  if (!store.find('vendors', 'vend_id', id)) return res.status(404).json({ error: '查無此廠商。' });
  if (store.all('payables').some(p => p.vend_id === id)) {
    return res.status(400).json({ error: '此廠商已被「應付款項」使用，無法刪除。' });
  }
  store.remove('vendors', v => v.vend_id === id);
  res.json({ ok: true });
});

/* ── CSV 匯入 (公司名稱/業務姓名/手機/營業項目/結帳方式/統編/備註) ── */
router.post('/vendors/import', perm, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'CSV 沒有可匯入的資料。' });

  let ok = 0;
  const skipped = [];
  rows.forEach((r, i) => {
    const company_name = str(r.company_name);
    if (!company_name) { skipped.push(`第 ${i + 2} 行：缺少公司名稱`); return; }
    if (store.all('vendors').some(v => v.company_name === company_name)) {
      skipped.push(`第 ${i + 2} 行：${company_name} 已存在`); return;
    }
    store.all('vendors').push({
      vend_id: store.nextCode('vendors', 'vend_id', 'V'),
      company_name,
      tax_id: str(r.tax_id), sales_name: str(r.sales_name), job_title: '',
      mobile: str(r.mobile), business_item: str(r.business_item),
      payment_method: str(r.payment_method),
      company_phone: '', company_email: '', company_addr: '',
      note: str(r.note), status: '正常', maintainer: req.session.user.emp_id,
      created_by: req.session.user.emp_id, created_at: nowISO(), updated_at: nowISO(),
    });
    ok++;
  });
  store.commit();
  res.json({ ok, skipped });
});

module.exports = router;
