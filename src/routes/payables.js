/* ── 應付款項 (薪資/獎金單不在此列出，僅「會計維護→員工薪資」可查) ── */
const express = require('express');
const store = require('../store');
const {
  requirePerm, hasPerm,
  str, num, numOrNull, date, bool, nowISO, today, empName, projName,
} = require('../util');

const router = express.Router();
const perm = requirePerm('perm_payable');
const permAcct = (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: '尚未登入。' });
  if (hasPerm(req.session.user, 'perm_accounting') || hasPerm(req.session.user, 'perm_payable')) return next();
  return res.status(403).json({ error: '您的帳號沒有使用此功能的權限，請聯絡系統管理者。' });
};

// 僅這兩類憑證可扣抵進項稅額，其餘一律歸零
const DEDUCTIBLE = ['三聯式發票', '電子發票(含統編)'];
const isDeductible = (docType) => DEDUCTIBLE.includes(str(docType));

function decorate(p) {
  const v = store.find('vendors', 'vend_id', p.vend_id);
  return {
    ...p,
    vend_name: p.emp_id ? empName(p.emp_id) : (v?.company_name || ''),
    vend_tax_id: v?.tax_id || '',
    emp_name: p.emp_id ? empName(p.emp_id) : '',
    proj_name: projName(p.proj_id),
    created_by_name: empName(p.created_by),
  };
}

function body(src) {
  const doc_type = str(src.doc_type);
  return {
    vend_id: str(src.vend_id),
    proj_id: str(src.proj_id),
    due_date: date(src.due_date),
    item: str(src.item),
    expense_category: str(src.expense_category),
    amount: num(src.amount),
    doc_type,
    // 非可扣抵憑證系統會自動歸零
    tax_deduct: isDeductible(doc_type) ? num(src.tax_deduct) : 0,
    invoice_no: str(src.invoice_no),
    invoice_date: date(src.invoice_date),
    invoice_void: bool(src.invoice_void),
    income_type: str(src.income_type),
    withholding_tax: num(src.withholding_tax),
    nhi_surcharge: num(src.nhi_surcharge),
    discount: num(src.discount),
    pay_method: str(src.pay_method),
    note: str(src.note),
  };
}

/* ── AI 發票辨識 ──
   需設定環境變數 ANTHROPIC_API_KEY 才能使用 (原站同樣呼叫外部 AI 服務)。 */
router.post('/payables/parse-invoice', perm, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: '尚未設定 AI 服務金鑰，發票辨識無法使用。請設定環境變數 ANTHROPIC_API_KEY 後重新啟動，或手動填寫欄位。',
    });
  }
  const image = String(req.body?.image || '');
  if (!image) return res.status(400).json({ error: '沒有收到圖片。' });

  const prompt = `你是台灣會計助理。請閱讀這張發票／收據圖片，只輸出一個 JSON 物件，不要有任何其他文字或程式碼區塊標記。
欄位：
{"amount":未稅金額(整數,無法判斷填0),"tax":稅額(整數,無稅填0),"invoice_no":"發票號碼(格式 AB-12345678,無則空字串)","invoice_date":"發票日期(YYYY-MM-DD,無則空字串)","doc_type":"三聯式發票|電子發票(含統編)|二聯式發票|收據|免用統一發票|勞務報酬單|其他","seller_name":"賣方名稱","seller_tax_id":"賣方統一編號","confidence":"高|中|低","note":"需要人工確認的事項,沒有則空字串"}
注意：台灣發票日期可能是民國年 (例如 114/03/25 = 2025-03-25)，請換算成西元。若圖上只有含稅總額，請回推未稅金額與 5% 稅額。`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: str(req.body?.mime) || 'image/jpeg', data: image } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `AI 服務回應錯誤 (${r.status})：${t.slice(0, 200)}` });
    }
    const data = await r.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ error: '無法解析辨識結果，請手動填寫。' });
    const out = JSON.parse(m[0]);
    res.json({
      amount: num(out.amount),
      tax: num(out.tax),
      invoice_no: str(out.invoice_no),
      invoice_date: date(out.invoice_date) || '',
      doc_type: str(out.doc_type),
      seller_name: str(out.seller_name),
      seller_tax_id: str(out.seller_tax_id),
      confidence: str(out.confidence),
      note: str(out.note),
    });
  } catch (e) {
    res.status(502).json({ error: '辨識失敗：' + e.message });
  }
});

/* 無關鍵字：只顯示待付款，依付款單號遞減；薪資/獎金單一律排除 */
router.get('/payables', perm, (req, res) => {
  const q = str(req.query.q).toLowerCase();
  let rows = store.all('payables').filter(p => !p.emp_id).map(decorate);
  if (q) {
    rows = rows.filter(r => ['ap_id', 'vend_name', 'item', 'expense_category', 'proj_id']
      .some(f => String(r[f] ?? '').toLowerCase().includes(q)));
  } else {
    rows = rows.filter(r => r.status === '待付款');
  }
  rows.sort((a, b) => b.ap_id.localeCompare(a.ap_id));
  res.json(rows);
});

router.get('/payables/:id', permAcct, (req, res) => {
  const p = store.find('payables', 'ap_id', req.params.id);
  if (!p) return res.status(404).json({ error: '查無此付款單。' });
  res.json(decorate(p));
});

router.post('/payables', perm, (req, res) => {
  const v = body(req.body || {});
  const row = {
    ap_id: store.nextCode('payables', 'ap_id', 'AP'),
    ...v,
    emp_id: null,                          // 一般應付款不掛員工
    salary_detail: null,
    status: '待付款',                       // 新增固定待付款，付款請至「會計維護」
    paid_date: null,
    paid_amount: null,
    check_no: '', check_due: null,
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.insert('payables', row);
  res.json(decorate(row));
});

router.put('/payables/:id', perm, (req, res) => {
  const p = store.find('payables', 'ap_id', req.params.id);
  if (!p) return res.status(404).json({ error: '查無此付款單。' });
  if (p.emp_id) return res.status(400).json({ error: '薪資/獎金單請於「會計維護→員工薪資」維護。' });
  Object.assign(p, body(req.body || {}), { updated_at: nowISO() });
  store.commit();
  res.json(decorate(p));
});

/* ── 會計維護：付款登錄 (欄位全部可改) ── */
router.patch('/payables/:id/pay', permAcct, (req, res) => {
  const p = store.find('payables', 'ap_id', req.params.id);
  if (!p) return res.status(404).json({ error: '查無此付款單。' });
  const b = req.body || {};
  const v = body(b);
  const status = ['已付款', '待付款'].includes(str(b.status)) ? str(b.status) : p.status;

  Object.assign(p, v, {
    status,
    paid_date: status === '已付款' ? (date(b.paid_date) || today()) : date(b.paid_date),
    paid_amount: status === '已付款'
      ? (numOrNull(b.paid_amount) ?? (v.amount - v.discount))
      : numOrNull(b.paid_amount),
    check_no: str(b.check_no),
    check_due: date(b.check_due),
    updated_at: nowISO(),
  });
  store.commit();
  res.json(decorate(p));
});

router.delete('/payables/:id', perm, (req, res) => {
  const p = store.find('payables', 'ap_id', req.params.id);
  if (!p) return res.status(404).json({ error: '查無此付款單。' });
  if (p.emp_id) return res.status(400).json({ error: '薪資/獎金單請於「會計維護→員工薪資」維護。' });
  store.remove('payables', x => x.ap_id === p.ap_id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.decorate = decorate;
module.exports.isDeductible = isDeductible;
