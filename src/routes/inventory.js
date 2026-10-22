/* ── 庫存管理 (perm_inventory)：料號基本資料 / 入庫單 / 領料單 / 庫存報表 ──
   目前庫存 = 期初數量 + 入庫合計 − 領料合計，由單據即時計算，不另外存欄位。
   料號 MA + 5 碼流水號；入庫單 SI0001、領料單 SO0001 (store.nextCode 掃描產生)。 */
const express = require('express');
const store = require('../store');
const { requirePerm, str, num, date, today, daysFromToday, nowISO, empName, vendName, projName } = require('../util');

const router = express.Router();
const perm = requirePerm('perm_inventory');

/* ── 料號 + 目前庫存 ── */
const sumQty = (table, matId, excludeFn) => store.all(table)
  .filter(r => r.mat_id === matId && !(excludeFn && excludeFn(r)))
  .reduce((t, r) => t + (Number(r.qty) || 0), 0);

function decorateMat(m) {
  const in_qty = sumQty('stock_in', m.mat_id);
  const out_qty = sumQty('stock_out', m.mat_id);
  return {
    ...m,
    vend_name: vendName(m.vend_id),
    maintainer_name: empName(m.maintainer),
    in_qty, out_qty,
    stock: (Number(m.init_qty) || 0) + in_qty - out_qty,
  };
}

// 目前庫存 (可排除某張領料單，供修改領料單時檢查)
function stockOf(matId, excludeOutId = null) {
  const m = store.find('materials', 'mat_id', matId);
  if (!m) return null;
  return (Number(m.init_qty) || 0) + sumQty('stock_in', matId)
    - sumQty('stock_out', matId, r => excludeOutId && r.out_id === excludeOutId);
}

const matBody = (b, req) => ({
  name: str(b.name),
  spec: str(b.spec),
  vend_id: str(b.vend_id),
  init_qty: num(b.init_qty),
  unit_price: num(b.unit_price),
  note: str(b.note),
  maintainer: str(b.maintainer) || req.session.user.emp_id,
});

/* ── 料號基本資料 ── */
// 清單：可帶 q 搜尋 料號/品名/規格/廠商名稱 (料號查詢視窗用)
router.get('/inventory/materials', perm, (req, res) => {
  const q = str(req.query.q).toLowerCase();
  let rows = store.all('materials').map(decorateMat);
  if (q) rows = rows.filter(m => ['mat_id', 'name', 'spec', 'vend_name']
    .some(f => String(m[f] ?? '').toLowerCase().includes(q)));
  rows.sort((a, b) => a.mat_id.localeCompare(b.mat_id));
  res.json(rows);
});

router.get('/inventory/materials/:id', perm, (req, res) => {
  const m = store.find('materials', 'mat_id', req.params.id);
  if (!m) return res.status(404).json({ error: '查無此料號。' });
  res.json(decorateMat(m));
});

router.post('/inventory/materials', perm, (req, res) => {
  const v = matBody(req.body || {}, req);
  if (!v.name) return res.status(400).json({ error: '請填品名。' });
  const row = {
    mat_id: store.nextCode('materials', 'mat_id', 'MA', 5),
    ...v,
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.insert('materials', row);
  res.json(decorateMat(row));
});

router.put('/inventory/materials/:id', perm, (req, res) => {
  const m = store.find('materials', 'mat_id', req.params.id);
  if (!m) return res.status(404).json({ error: '查無此料號。' });
  const v = matBody(req.body || {}, req);
  if (!v.name) return res.status(400).json({ error: '請填品名。' });
  Object.assign(m, v, { updated_at: nowISO() });
  store.commit();
  res.json({ ok: true });
});

router.delete('/inventory/materials/:id', perm, (req, res) => {
  const id = req.params.id;
  if (!store.find('materials', 'mat_id', id)) return res.status(404).json({ error: '查無此料號。' });
  const i = store.all('stock_in').filter(r => r.mat_id === id).length;
  const o = store.all('stock_out').filter(r => r.mat_id === id).length;
  if (i || o) return res.status(400).json({ error: `此料號已有 ${i} 筆入庫、${o} 筆領料，無法刪除。` });
  store.remove('materials', m => m.mat_id === id);
  res.json({ ok: true });
});

/* ── 入庫單 / 領料單 (兩者結構幾乎相同，用同一組函式) ──
   kind = { table, idCol, dateCol, prefix, label, hasProj }
   前端送出的欄位：doc_date (或 in_date / out_date)、mat_id、qty、unit_price、note、emp_id、proj_id(領料) */
const IN  = { table: 'stock_in',  idCol: 'in_id',  dateCol: 'in_date',  prefix: 'SI', path: 'si', label: '入庫單', hasProj: false };
const OUT = { table: 'stock_out', idCol: 'out_id', dateCol: 'out_date', prefix: 'SO', path: 'so', label: '領料單', hasProj: true };

function decorateDoc(k, d) {
  const m = store.find('materials', 'mat_id', d.mat_id) || {};
  const out = {
    ...d,
    doc_id: d[k.idCol], doc_date: d[k.dateCol],
    name: m.name || '', spec: m.spec || '', vend_id: m.vend_id || '',
    vend_name: vendName(m.vend_id),
    emp_name: empName(d.emp_id),
    created_by_name: empName(d.created_by),
  };
  if (k.hasProj) out.proj_name = projName(d.proj_id);
  return out;
}

function docRoutes(k) {
  // 清單：預設近一個月；帶 q 搜尋 單號/料號/品名/規格/廠商 (不限期間)
  router.get('/inventory/' + k.path, perm, (req, res) => {
    const q = str(req.query.q).toLowerCase();
    let rows = store.all(k.table).map(d => decorateDoc(k, d));
    if (q) {
      rows = rows.filter(r => ['doc_id', 'mat_id', 'name', 'spec', 'vend_name']
        .some(f => String(r[f] ?? '').toLowerCase().includes(q)));
    } else {
      const from = daysFromToday(-30);
      rows = rows.filter(r => str(r.doc_date) >= from);
    }
    rows.sort((a, b) => str(b.doc_date).localeCompare(str(a.doc_date)) || b.doc_id.localeCompare(a.doc_id));
    res.json(rows);
  });

  router.get(`/inventory/${k.path}/:id`, perm, (req, res) => {
    const d = store.find(k.table, k.idCol, req.params.id);
    if (!d) return res.status(404).json({ error: `查無此${k.label}。` });
    res.json(decorateDoc(k, d));
  });

  function validate(b, excludeId) {
    const mat_id = str(b.mat_id);
    if (!mat_id) return '請選擇料號。';
    if (!store.find('materials', 'mat_id', mat_id)) return '查無此料號，請先按「新增料號」建立。';
    const qty = num(b.qty);
    if (qty <= 0) return '數量必須大於 0。';
    if (k.hasProj) {
      const stock = stockOf(mat_id, excludeId);
      if (stock !== null && qty > stock) return `庫存不足：目前庫存 ${stock}，無法領料 ${qty}。`;
      if (str(b.proj_id) && !store.find('projects', 'proj_id', str(b.proj_id))) return '查無此專案編號。';
    }
    return null;
  }
  function body(b, req) {
    const out = {
      [k.dateCol]: date(b[k.dateCol]) || date(b.doc_date) || today(),
      mat_id: str(b.mat_id),
      qty: num(b.qty),
      unit_price: num(b.unit_price),
      note: str(b.note),
      emp_id: str(b.emp_id) || req.session.user.emp_id,
    };
    if (k.hasProj) out.proj_id = str(b.proj_id);
    return out;
  }

  router.post('/inventory/' + k.path, perm, (req, res) => {
    const b = req.body || {};
    const err = validate(b, null);
    if (err) return res.status(400).json({ error: err });
    const id = store.nextCode(k.table, k.idCol, k.prefix);
    const row = {
      [k.idCol]: id,
      ...body(b, req),
      created_by: req.session.user.emp_id,
      created_at: nowISO(), updated_at: nowISO(),
    };
    store.insert(k.table, row);
    res.json({ [k.idCol]: id, doc_id: id });
  });

  router.put(`/inventory/${k.path}/:id`, perm, (req, res) => {
    const d = store.find(k.table, k.idCol, req.params.id);
    if (!d) return res.status(404).json({ error: `查無此${k.label}。` });
    const b = req.body || {};
    const err = validate(b, req.params.id);
    if (err) return res.status(400).json({ error: err });
    Object.assign(d, body(b, req), { updated_at: nowISO() });
    store.commit();
    res.json({ ok: true });
  });

  router.delete(`/inventory/${k.path}/:id`, perm, (req, res) => {
    const d = store.find(k.table, k.idCol, req.params.id);
    if (!d) return res.status(404).json({ error: `查無此${k.label}。` });
    if (!k.hasProj) {
      // 刪入庫單後庫存不可變負
      const stock = stockOf(d.mat_id);
      if (stock - num(d.qty) < 0) {
        return res.status(400).json({ error: `刪除後庫存會變成負數（目前 ${stock}，此單 ${num(d.qty)}），請先處理領料單。` });
      }
    }
    store.remove(k.table, r => r[k.idCol] === d[k.idCol]);
    res.json({ ok: true });
  });
}
docRoutes(IN);
docRoutes(OUT);

/* ── 庫存報表 (盤點用)：全部料號 + 期初/入庫/領料/目前庫存 ── */
router.get('/inventory/report', perm, (req, res) => {
  const rows = store.all('materials').map(decorateMat).sort((a, b) => a.mat_id.localeCompare(b.mat_id));
  const total_value = rows.reduce((t, r) => t + r.stock * (Number(r.unit_price) || 0), 0);
  res.json({ as_of: today(), rows, summary: { count: rows.length, total_value: Math.round(total_value) } });
});

module.exports = router;
