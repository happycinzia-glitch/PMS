/* ── 客戶基本資料表 ─────────────────────────────────── */
const express = require('express');
const store = require('../store');
const { requirePerm, str, matches, empName, nowISO, stamp } = require('../util');

const router = express.Router();
const perm = requirePerm('perm_customer');

const SEARCH_FIELDS = ['cust_id', 'name', 'mobile', 'company'];
const EDITABLE = ['name', 'mobile', 'company', 'job_title', 'company_phone', 'company_email',
  'company_addr', 'home_phone', 'home_addr', 'contact_addr', 'maintainer', 'status', 'note'];

function body(src) {
  const out = {};
  for (const k of EDITABLE) if (k in src) out[k] = str(src[k]);
  if (!out.status) out.status = '正常';
  return out;
}
// 明細/清單要顯示的關聯名稱
function decorate(c) {
  return { ...c, created_by_name: empName(c.created_by), maintainer_name: empName(c.maintainer) };
}

router.get('/customers', perm, (req, res) => {
  const q = str(req.query.q);
  const rows = store.all('customers')
    .filter(c => matches(c, SEARCH_FIELDS, q))
    .sort((a, b) => a.cust_id.localeCompare(b.cust_id))
    .map(decorate);
  res.json(rows);
});

router.get('/customers/:id', perm, (req, res) => {
  const c = store.find('customers', 'cust_id', req.params.id);
  if (!c) return res.status(404).json({ error: '查無此客戶。' });
  res.json(decorate(c));
});

router.post('/customers', perm, (req, res) => {
  const v = body(req.body || {});
  if (!v.name) return res.status(400).json({ error: '請填寫客戶姓名。' });
  if (!v.mobile) return res.status(400).json({ error: '請填寫手機。' });
  const row = { cust_id: store.nextCode('customers', 'cust_id', 'C'), ...v, ...stamp(req) };
  store.insert('customers', row);
  res.json(decorate(row));
});

router.put('/customers/:id', perm, (req, res) => {
  const c = store.find('customers', 'cust_id', req.params.id);
  if (!c) return res.status(404).json({ error: '查無此客戶。' });
  const v = body(req.body || {});
  if (!v.name) return res.status(400).json({ error: '請填寫客戶姓名。' });
  Object.assign(c, v, { updated_at: nowISO() });
  store.commit();
  res.json(decorate(c));
});

router.delete('/customers/:id', perm, (req, res) => {
  const id = req.params.id;
  if (!store.find('customers', 'cust_id', id)) return res.status(404).json({ error: '查無此客戶。' });
  // 已被其他單據引用時不可刪除，避免報表出現孤兒資料
  const used = [
    ['projects', 'cust_id', '專案'],
    ['quotes', 'cust_id', '報價單'],
    ['receivables', 'cust_id', '應收款項'],
    ['repairs', 'cust_id', '維修工單'],
  ].filter(([t, f]) => store.all(t).some(r => r[f] === id)).map(([, , label]) => label);
  if (used.length) return res.status(400).json({ error: `此客戶已被「${used.join('、')}」使用，無法刪除。` });

  store.remove('customers', c => c.cust_id === id);
  res.json({ ok: true });
});

/* ── CSV 匯入 (姓名/手機/公司/連絡地址/備註) ── */
router.post('/customers/import', perm, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'CSV 沒有可匯入的資料。' });

  let ok = 0;
  const skipped = [];
  rows.forEach((r, i) => {
    const name = str(r.name), mobile = str(r.mobile);
    if (!name) { skipped.push(`第 ${i + 2} 行：缺少姓名`); return; }
    // 同名同手機視為重複
    if (store.all('customers').some(c => c.name === name && c.mobile === mobile)) {
      skipped.push(`第 ${i + 2} 行：${name} 已存在`); return;
    }
    store.all('customers').push({
      cust_id: store.nextCode('customers', 'cust_id', 'C'),
      name, mobile,
      company: str(r.company), job_title: '', company_phone: '', company_email: '',
      company_addr: '', home_phone: '', home_addr: '',
      contact_addr: str(r.contact_addr), note: str(r.note),
      status: '正常', maintainer: req.session.user.emp_id,
      created_by: req.session.user.emp_id, created_at: nowISO(), updated_at: nowISO(),
    });
    ok++;
  });
  store.commit();
  res.json({ ok, skipped });
});

module.exports = router;
