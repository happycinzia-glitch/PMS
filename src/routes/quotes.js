/* ── 報價單 (含明細子表單 / 複製 / 複製改版 / PDF 由前端列印) ── */
const express = require('express');
const store = require('../store');
const { requirePerm, str, num, date, nowISO, today, daysFromToday, bool, empName, custName } = require('../util');

const router = express.Router();
const perm = requirePerm('perm_quote');

const itemsOf = (id) => store.all('quote_items')
  .filter(i => i.quote_id === id).sort((a, b) => (a.seq_no || 0) - (b.seq_no || 0));

const totalOf = (id) => itemsOf(id).reduce((t, i) => t + (Number(i.subtotal) || 0), 0);

function decorate(q, withItems = false) {
  const out = {
    ...q,
    cust_name: custName(q.cust_id),
    created_by_name: empName(q.created_by),
    maintainer_name: empName(q.maintainer),
    total: totalOf(q.quote_id),
  };
  if (withItems) out.items = itemsOf(q.quote_id);
  return out;
}

// 明細：小計＝單價×數量 (皆取整數)。
// 前端依「大項」順序送出，seq_no 為整張報價單的流水順序；section 為大項名稱 (舊資料可能空白＝未分大項)。
// 空白列略過，依 seq_no 遞增排序後重新編號 1,2,3…
function saveItems(quoteId, list) {
  store.remove('quote_items', i => i.quote_id === quoteId);
  const rows = (Array.isArray(list) ? list : [])
    .filter(it => it && (str(it.item) || num(it.unit_price) || num(it.qty)))
    .map((it, i) => ({ ...it, _seq: num(it.seq_no) || i + 1, _idx: i }))
    .sort((a, b) => a._seq - b._seq || a._idx - b._idx);
  rows.forEach((it, i) => {
    const unit_price = num(it.unit_price);
    const qty = num(it.qty);
    store.all('quote_items').push({
      id: store.nextInt('quote_items'),
      quote_id: quoteId,
      seq_no: i + 1,
      section: str(it.section),
      item: str(it.item),
      unit_price, unit: str(it.unit), qty,
      subtotal: unit_price * qty,
      vendor_price: num(it.vendor_price),
      note: str(it.note),
    });
  });
  store.commit();
}

function quoteBody(src) {
  return {
    cust_id: str(src.cust_id),
    proj_name: str(src.proj_name),
    addr: str(src.addr),
    quote_date: date(src.quote_date) || today(),
    valid_date: date(src.valid_date),
    maintainer: str(src.maintainer),
    tax_flag: bool(src.tax_flag),
    note: str(src.note),
  };
}

/* 無關鍵字：近二個月的報價單，依報價日期遞減
   有關鍵字：比對報價單號與客戶名稱 (涵蓋全部) */
router.get('/quotes', perm, (req, res) => {
  const q = str(req.query.q).toLowerCase();
  let rows = store.all('quotes').map(x => decorate(x));
  if (q) {
    rows = rows.filter(r => ['quote_id', 'cust_name', 'proj_name']
      .some(f => String(r[f] ?? '').toLowerCase().includes(q)));
  } else if (req.session.user.perm_admin) {
    // 預設：系統管理者看全部「進行中」的報價單 (不限維護窗口、不限日期)
    rows = rows.filter(r => r.status === '進行中');
  } else {
    // 預設：一般員工看「維護窗口是自己」且進行中的報價單
    const me = req.session.user.emp_id;
    rows = rows.filter(r => r.status === '進行中' && r.maintainer === me);
  }
  rows.sort((a, b) => str(b.quote_date).localeCompare(str(a.quote_date))
    || b.quote_id.localeCompare(a.quote_id));
  res.json(rows);
});

router.get('/quotes/:id', perm, (req, res) => {
  const q = store.find('quotes', 'quote_id', req.params.id);
  if (!q) return res.status(404).json({ error: '查無此報價單。' });
  res.json(decorate(q, true));
});

router.post('/quotes', perm, (req, res) => {
  const v = quoteBody(req.body || {});
  const row = {
    quote_id: store.nextCode('quotes', 'quote_id', 'Q'),
    ...v,
    status: '進行中',                       // 新增時固定「進行中」
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.all('quotes').push(row);
  saveItems(row.quote_id, req.body?.items);
  res.json(decorate(row, true));
});

router.put('/quotes/:id', perm, (req, res) => {
  const q = store.find('quotes', 'quote_id', req.params.id);
  if (!q) return res.status(404).json({ error: '查無此報價單。' });
  if (q.status !== '進行中') {
    return res.status(400).json({ error: `此報價單已「${q.status}」，無法修改；如需變更請使用「複製改版」。` });
  }
  const v = quoteBody(req.body || {});
  const status = str(req.body?.status);
  Object.assign(q, v, { updated_at: nowISO() });
  if (['進行中', '已確認', '作廢'].includes(status)) q.status = status;
  saveItems(q.quote_id, req.body?.items);
  res.json(decorate(q, true));
});

router.delete('/quotes/:id', perm, (req, res) => {
  const q = store.find('quotes', 'quote_id', req.params.id);
  if (!q) return res.status(404).json({ error: '查無此報價單。' });
  if (store.all('receivables').some(r => r.quote_id === q.quote_id)) {
    return res.status(400).json({ error: '此報價單已被「應收款項」使用，無法刪除。' });
  }
  store.remove('quote_items', i => i.quote_id === q.quote_id);
  store.remove('quotes', x => x.quote_id === q.quote_id);
  res.json({ ok: true });
});

/* ── 複製：以全新單號整份複製 (含明細)，狀態回到「進行中」 ── */
router.post('/quotes/:id/duplicate', perm, (req, res) => {
  const src = store.find('quotes', 'quote_id', req.params.id);
  if (!src) return res.status(404).json({ error: '查無此報價單。' });
  const row = {
    ...src,
    quote_id: store.nextCode('quotes', 'quote_id', 'Q'),
    status: '進行中',
    quote_date: today(),
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.all('quotes').push(row);
  saveItems(row.quote_id, itemsOf(src.quote_id));
  res.json({ quote_id: row.quote_id });
});

/* ── 複製改版：單號加 -1 / -2 …，狀態「進行中」可再編輯 ── */
router.post('/quotes/:id/revise', perm, (req, res) => {
  const src = store.find('quotes', 'quote_id', req.params.id);
  if (!src) return res.status(404).json({ error: '查無此報價單。' });

  const base = String(src.quote_id).replace(/-\d+$/, '');   // 由改版單再改版時仍以原單號為基底
  let n = 1;
  while (store.find('quotes', 'quote_id', `${base}-${n}`)) n++;

  const row = {
    ...src,
    quote_id: `${base}-${n}`,
    status: '進行中',
    quote_date: today(),
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.all('quotes').push(row);
  saveItems(row.quote_id, itemsOf(src.quote_id));
  res.json({ quote_id: row.quote_id });
});

module.exports = router;
