/* ── 資產管理 (perm_accounting)：公司設備清冊 ──
   資產編號 CA + 5 碼流水號；有填報廢日期＝已報廢。只是清冊，不會自動產生應付款項。 */
const express = require('express');
const store = require('../store');
const { requirePerm, str, num, date, nowISO, empName, vendName } = require('../util');

const router = express.Router();
const perm = requirePerm('perm_accounting');

function decorate(a) {
  return {
    ...a,
    vend_name: vendName(a.vend_id),
    manager_name: empName(a.manager),
    created_by_name: empName(a.created_by),
    status: a.scrap_date ? '已報廢' : '使用中',
  };
}

function body(b) {
  return {
    name: str(b.name),
    vend_id: str(b.vend_id),
    spec: str(b.spec),
    dept: str(b.dept),
    manager: str(b.manager),
    purchase_date: date(b.purchase_date),
    scrap_date: date(b.scrap_date),
    amount: num(b.amount),
    note: str(b.note),
  };
}
function validate(v) {
  if (!v.name) return '請填品名。';
  if (v.purchase_date && v.scrap_date && v.scrap_date < v.purchase_date) return '報廢日期不可早於購入日期。';
  return null;
}

// 清單：預設全部，依資產編號遞減；帶 q 搜尋 資產編號/品名/廠商/規格/部門/管理人
router.get('/assets', perm, (req, res) => {
  const q = str(req.query.q).toLowerCase();
  let rows = store.all('assets').map(decorate);
  if (q) rows = rows.filter(r => ['asset_id', 'name', 'vend_name', 'spec', 'dept', 'manager_name']
    .some(f => String(r[f] ?? '').toLowerCase().includes(q)));
  rows.sort((a, b) => b.asset_id.localeCompare(a.asset_id));
  res.json(rows);
});

router.get('/assets/:id', perm, (req, res) => {
  const a = store.find('assets', 'asset_id', req.params.id);
  if (!a) return res.status(404).json({ error: '查無此資產。' });
  res.json(decorate(a));
});

router.post('/assets', perm, (req, res) => {
  const v = body(req.body || {});
  const err = validate(v);
  if (err) return res.status(400).json({ error: err });
  const row = {
    asset_id: store.nextCode('assets', 'asset_id', 'CA', 5),
    ...v,
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.insert('assets', row);
  res.json({ asset_id: row.asset_id });
});

router.put('/assets/:id', perm, (req, res) => {
  const a = store.find('assets', 'asset_id', req.params.id);
  if (!a) return res.status(404).json({ error: '查無此資產。' });
  const v = body(req.body || {});
  const err = validate(v);
  if (err) return res.status(400).json({ error: err });
  Object.assign(a, v, { updated_at: nowISO() });
  store.commit();
  res.json({ ok: true });
});

router.delete('/assets/:id', perm, (req, res) => {
  const a = store.find('assets', 'asset_id', req.params.id);
  if (!a) return res.status(404).json({ error: '查無此資產。' });
  store.remove('assets', x => x.asset_id === a.asset_id);
  res.json({ ok: true });
});

module.exports = router;
