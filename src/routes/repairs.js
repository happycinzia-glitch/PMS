/* ── 保固維修工單 (報修 → 派工 → 完修) ───────────────── */
const express = require('express');
const store = require('../store');
const { requirePerm, str, date, nowISO, today, empName, custName, projName } = require('../util');

const router = express.Router();
const perm = requirePerm('perm_project');   // 與專案管理共用權限

const EDITABLE = ['cust_id', 'proj_id', 'assignee', 'status', 'issue', 'note'];

function body(src) {
  const out = {};
  for (const k of EDITABLE) if (k in src) out[k] = str(src[k]);
  for (const k of ['reported_date', 'scheduled_date', 'completed_date']) if (k in src) out[k] = date(src[k]);
  return out;
}
function decorate(r) {
  return {
    ...r,
    cust_name: custName(r.cust_id),
    proj_name: projName(r.proj_id),
    assignee_name: empName(r.assignee),
    created_by_name: empName(r.created_by),
  };
}

/* 無關鍵字：只顯示未完修；有關鍵字：涵蓋所有工單 */
router.get('/repairs', perm, (req, res) => {
  const q = str(req.query.q).toLowerCase();
  let rows = store.all('repairs').map(decorate);
  if (q) {
    rows = rows.filter(r => ['ro_id', 'cust_name', 'proj_name', 'proj_id', 'issue']
      .some(f => String(r[f] ?? '').toLowerCase().includes(q)));
  } else {
    rows = rows.filter(r => r.status !== '已完修');
  }
  rows.sort((a, b) => str(b.reported_date).localeCompare(str(a.reported_date))
    || b.ro_id.localeCompare(a.ro_id));
  res.json(rows);
});

router.get('/repairs/:id', perm, (req, res) => {
  const r = store.find('repairs', 'ro_id', req.params.id);
  if (!r) return res.status(404).json({ error: '查無此維修單。' });
  res.json(decorate(r));
});

router.post('/repairs', perm, (req, res) => {
  const v = body(req.body || {});
  if (!v.issue) return res.status(400).json({ error: '請填寫問題描述。' });
  const row = {
    ro_id: store.nextCode('repairs', 'ro_id', 'RO'),
    cust_id: v.cust_id || '', proj_id: v.proj_id || '',
    reported_date: v.reported_date || today(),
    assignee: v.assignee || '',
    scheduled_date: v.scheduled_date || null,
    status: v.status || '待處理',
    completed_date: v.completed_date || null,
    issue: v.issue, note: v.note || '',
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.insert('repairs', row);
  res.json(decorate(row));
});

router.put('/repairs/:id', perm, (req, res) => {
  const r = store.find('repairs', 'ro_id', req.params.id);
  if (!r) return res.status(404).json({ error: '查無此維修單。' });
  const v = body(req.body || {});
  if (!v.issue) return res.status(400).json({ error: '請填寫問題描述。' });
  // 狀態改為已完修但沒填完修日期時，自動帶今天
  if (v.status === '已完修' && !v.completed_date) v.completed_date = today();
  Object.assign(r, v, { updated_at: nowISO() });
  store.commit();
  res.json(decorate(r));
});

router.delete('/repairs/:id', perm, (req, res) => {
  const n = store.remove('repairs', r => r.ro_id === req.params.id);
  if (!n) return res.status(404).json({ error: '查無此維修單。' });
  res.json({ ok: true });
});

module.exports = router;
