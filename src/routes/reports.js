/* ── 公司報表 (營收結算 / 專案獲利 / 帳齡 / 401 / 扣繳) 與首頁待辦提醒 ── */
const express = require('express');
const store = require('../store');
const {
  requirePerm, requireLogin, hasPerm,
  str, num, today, daysFromToday, daysBetween, inPeriod, empName, custName, projName, vendName,
} = require('../util');
const { isDeductible } = require('./payables');

const router = express.Router();
const perm = requirePerm('perm_accounting');

/* 歸期方式：
   應收「已收款」依收款日期、「待收款」依應收日期；
   應付「已付款」依付款日期、「待付款」依建立日期。 */
const arAcctDate = (r) => r.status === '已收款' ? (r.received_date || r.due_date) : r.due_date;
const apAcctDate = (p) => p.status === '已付款'
  ? (p.paid_date || str(p.created_at).slice(0, 10))
  : str(p.created_at).slice(0, 10);

const sum = (rows, fn) => rows.reduce((t, r) => t + (Number(fn(r)) || 0), 0);
const pct = (part, whole) => whole ? Math.round(part / whole * 1000) / 10 : 0;

function readPeriod(req) {
  const year = Number(req.query.year) || new Date().getFullYear();
  const from = Math.min(Math.max(Number(req.query.from) || 1, 1), 12);
  const to = Math.min(Math.max(Number(req.query.to) || 12, 1), 12);
  return { year, from: Math.min(from, to), to: Math.max(from, to) };
}

/* ── 營收結算 (損益表 + 現金流量 + 明細) ── */
router.get('/accounting/report', perm, (req, res) => {
  const period = readPeriod(req);
  const { year, from, to } = period;

  const receivables = store.all('receivables')
    .map(r => ({ ...r, acct_date: arAcctDate(r), cust_name: custName(r.cust_id), proj_name: projName(r.proj_id) }))
    .filter(r => inPeriod(r.acct_date, year, from, to))
    .sort((a, b) => str(a.acct_date).localeCompare(str(b.acct_date)));

  const payables = store.all('payables')
    .map(p => ({
      ...p, acct_date: apAcctDate(p), proj_name: projName(p.proj_id),
      vend_name: p.emp_id ? empName(p.emp_id) : vendName(p.vend_id),
    }))
    .filter(p => inPeriod(p.acct_date, year, from, to))
    .sort((a, b) => str(a.acct_date).localeCompare(str(b.acct_date)));

  // 工程成本＝有掛專案的應付款；營業費用＝未掛專案的應付款 (含薪資/獎金)
  const costRows = payables.filter(p => p.proj_id);
  const expenseRows = payables.filter(p => !p.proj_id);

  const revenue = sum(receivables, r => r.amount);
  const sales_discount = sum(receivables, r => r.discount);
  const net_revenue = revenue - sales_discount;
  const cost = sum(costRows, p => p.amount);
  const cost_discount = sum(costRows, p => p.discount);
  const gross = net_revenue - cost + cost_discount;

  const byCategory = new Map();
  for (const p of expenseRows) {
    const name = p.expense_category || p.item || '其他費用';
    byCategory.set(name, (byCategory.get(name) || 0) + num(p.amount) - num(p.discount));
  }
  const expenses = [...byCategory.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
  const expense_total = sum(expenses, e => e.amount);
  const net_income = gross - expense_total;

  const ar_received = sum(receivables, r => r.received_amount);
  const ap_paid = sum(payables, p => p.paid_amount);

  const summary = {
    ar_count: receivables.length,
    ar_total: revenue,
    ar_tax: sum(receivables, r => r.tax),
    ar_discount: sales_discount,
    ar_received,
    ar_pending: sum(receivables.filter(r => r.status === '待收款'), r => num(r.amount) + num(r.tax)),
    ap_count: payables.length,
    ap_total: sum(payables, p => p.amount),
    ap_tax_deduct: sum(payables, p => p.tax_deduct),
    ap_discount: sum(payables, p => p.discount),
    ap_paid,
    ap_pending: sum(payables.filter(p => p.status === '待付款'), p => p.amount),
  };

  const statement = {
    revenue, sales_discount, net_revenue,
    cost, cost_discount,
    gross, gross_pct: pct(gross, net_revenue),
    expenses, expense_total,
    net_income, net_pct: pct(net_income, net_revenue),
    sales_tax: sum(receivables, r => r.invoice_void ? 0 : r.tax),
    purchase_tax: sum(payables, p => p.invoice_void ? 0 : p.tax_deduct),
    net_cash: ar_received - ap_paid,
  };

  res.json({ period, receivables, payables, summary, statement });
});

/* ── 專案獲利 (只計有掛專案編號的單據) ── */
router.get('/accounting/project-profit', perm, (req, res) => {
  const period = readPeriod(req);
  const { year, from, to } = period;
  const acc = new Map();
  const bucket = (id) => {
    if (!acc.has(id)) acc.set(id, { proj_id: id, ar_amount: 0, ap_amount: 0 });
    return acc.get(id);
  };

  for (const r of store.all('receivables')) {
    if (!r.proj_id || !inPeriod(arAcctDate(r), year, from, to)) continue;
    bucket(r.proj_id).ar_amount += num(r.amount);
  }
  for (const p of store.all('payables')) {
    if (!p.proj_id || !inPeriod(apAcctDate(p), year, from, to)) continue;
    bucket(p.proj_id).ap_amount += num(p.amount);
  }

  const rows = [...acc.values()].map(x => {
    const proj = store.find('projects', 'proj_id', x.proj_id);
    const profit = x.ar_amount - x.ap_amount;
    return {
      ...x,
      proj_name: proj?.proj_name || '',
      cust_name: custName(proj?.cust_id),
      proj_status: proj?.proj_status || '',
      sys_status: proj?.status || '',
      profit,
      profit_pct: x.ar_amount ? pct(profit, x.ar_amount) : null,
    };
  }).sort((a, b) => b.profit - a.profit);

  const ar_amount = sum(rows, r => r.ar_amount);
  const ap_amount = sum(rows, r => r.ap_amount);
  const profit = ar_amount - ap_amount;
  res.json({
    period, rows,
    summary: {
      count: rows.length, ar_amount, ap_amount, profit,
      profit_pct: ar_amount ? pct(profit, ar_amount) : null,
    },
  });
});

/* ── 帳齡分析：所有待收款依逾期天數分桶 ── */
router.get('/accounting/aging', perm, (req, res) => {
  const as_of = today();
  const bucketOf = (d) => {
    if (d <= 0) return 'not_due';
    if (d <= 30) return 'd1_30';
    if (d <= 60) return 'd31_60';
    if (d <= 90) return 'd61_90';
    return 'd90p';
  };
  const buckets = { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  const custMap = new Map();

  const rows = store.all('receivables')
    .filter(r => r.status === '待收款')
    .map(r => {
      const days_overdue = r.due_date ? daysBetween(as_of, r.due_date) : 0;
      const bucket = bucketOf(days_overdue);
      const outstanding = num(r.amount) + num(r.tax);
      buckets[bucket] += outstanding;

      const c = store.find('customers', 'cust_id', r.cust_id);
      const key = r.cust_id || '(未指定)';
      if (!custMap.has(key)) {
        custMap.set(key, {
          cust_id: key, cust_name: c?.name || '(未指定)', mobile: c?.mobile || '',
          count: 0, not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0, total: 0,
        });
      }
      const cu = custMap.get(key);
      cu.count++; cu[bucket] += outstanding; cu.total += outstanding;

      return {
        ar_id: r.ar_id, cust_name: c?.name || '', item: r.item, is_retention: !!r.is_retention,
        due_date: r.due_date, days_overdue, bucket, outstanding,
      };
    })
    .sort((a, b) => b.days_overdue - a.days_overdue || b.outstanding - a.outstanding);

  res.json({
    as_of, buckets,
    total: Object.values(buckets).reduce((a, b) => a + b, 0),
    customers: [...custMap.values()].sort((a, b) => b.total - a.total),
    rows,
  });
});

/* ── 營業稅申報 401：每 2 個月一期，依發票日期歸期 ── */
router.get('/accounting/vat-return', perm, (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const term = Math.min(Math.max(Number(req.query.term) || 1, 1), 6);
  const from = term * 2 - 1, to = term * 2;
  const period = { year, roc_year: year - 1911, term, months: `${from}-${to}月` };

  // 銷項：有發票號碼的應收款 (作廢者列出但不計金額)
  const sales = store.all('receivables')
    .filter(r => r.invoice_no && inPeriod(r.invoice_date, year, from, to))
    .map(r => ({
      invoice_date: r.invoice_date, invoice_no: r.invoice_no, ar_id: r.ar_id,
      cust_name: custName(r.cust_id), item: r.item,
      amount: num(r.amount), tax: num(r.tax), invoice_void: !!r.invoice_void,
    }))
    .sort((a, b) => str(a.invoice_date).localeCompare(str(b.invoice_date)));

  // 進項：憑證類別可扣抵且未作廢的應付款
  const inTerm = store.all('payables').filter(p => inPeriod(p.invoice_date, year, from, to));
  const deductible = inTerm.filter(p => isDeductible(p.doc_type) && !p.invoice_void);
  const purchases = deductible.map(p => ({
    invoice_date: p.invoice_date, invoice_no: p.invoice_no, doc_type: p.doc_type, ap_id: p.ap_id,
    payee_name: p.emp_id ? empName(p.emp_id) : vendName(p.vend_id),
    item: p.item, expense_category: p.expense_category,
    amount: num(p.amount), tax_deduct: num(p.tax_deduct),
  })).sort((a, b) => str(a.invoice_date).localeCompare(str(b.invoice_date)));

  const valid = sales.filter(s => !s.invoice_void);
  const sales_amount = sum(valid, s => s.amount);
  const sales_tax = sum(valid, s => s.tax);
  const purchase_amount = sum(purchases, p => p.amount);
  const purchase_tax = sum(purchases, p => p.tax_deduct);

  res.json({
    period, sales, purchases,
    summary: {
      sales_count: valid.length,
      void_count: sales.length - valid.length,
      sales_amount, sales_tax,
      purchase_count: purchases.length,
      purchase_amount, purchase_tax,
      net_tax: sales_tax - purchase_tax,
      other_purchase_count: inTerm.length - deductible.length,
    },
  });
});

/* ── 扣繳彙總：年度內「已付款」的個人所得給付與員工薪資 ── */
router.get('/accounting/withholding', perm, (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const paidInYear = (p) => p.status === '已付款' && Number(str(p.paid_date).slice(0, 4)) === year;

  const otherMap = new Map();
  for (const p of store.all('payables')) {
    if (p.emp_id || !p.income_type || !paidInYear(p)) continue;
    const v = store.find('vendors', 'vend_id', p.vend_id);
    const payee = v?.company_name || '(未指定)';
    const key = payee + '|' + p.income_type;
    if (!otherMap.has(key)) {
      otherMap.set(key, {
        payee, tax_id: v?.tax_id || '', income_type: p.income_type,
        cnt: 0, total_paid: 0, withholding: 0, nhi: 0,
      });
    }
    const o = otherMap.get(key);
    o.cnt++; o.total_paid += num(p.amount);
    o.withholding += num(p.withholding_tax); o.nhi += num(p.nhi_surcharge);
  }

  const salMap = new Map();
  for (const p of store.all('payables')) {
    if (!p.emp_id || !paidInYear(p)) continue;
    if (!salMap.has(p.emp_id)) {
      salMap.set(p.emp_id, { emp_id: p.emp_id, payee: empName(p.emp_id), cnt: 0, total_paid: 0, withholding: 0 });
    }
    const s = salMap.get(p.emp_id);
    s.cnt++; s.total_paid += num(p.amount);
    s.withholding += num(p.salary_detail?.salary_tax ?? p.withholding_tax);
  }

  res.json({
    year,
    others: [...otherMap.values()].sort((a, b) => b.total_paid - a.total_paid),
    salaries: [...salMap.values()].sort((a, b) => a.emp_id.localeCompare(b.emp_id)),
  });
});

/* ── 首頁待辦提醒 (前端會再依權限決定要不要顯示) ── */
router.get('/reminders', requireLogin, (req, res) => {
  const now = today();
  const soon = daysFromToday(7);
  const warrantySoon = daysFromToday(30);
  const out = {
    ar_overdue: [], ar_soon: [], ap_overdue: [], ap_soon: [],
    check_due: [], stage_overdue: [], accepting: [], warranty_due: [],
  };

  for (const r of store.all('receivables')) {
    if (r.status !== '待收款' || !r.due_date) continue;
    const item = { id: r.ar_id, name: custName(r.cust_id), item: r.item, due_date: r.due_date, amt: num(r.amount) + num(r.tax) };
    if (r.due_date < now) out.ar_overdue.push(item);
    else if (r.due_date <= soon) out.ar_soon.push(item);
  }

  // 支票即使已登錄付款，票款仍是到期日才真正扣款，因此不限「待付款」
  const checkFrom = daysFromToday(-30);
  for (const p of store.all('payables')) {
    const name = p.emp_id ? empName(p.emp_id) : vendName(p.vend_id);
    if (p.status === '待付款' && p.due_date) {
      const item = { id: p.ap_id, name, item: p.item, due_date: p.due_date, amt: num(p.amount) };
      if (p.due_date < now) out.ap_overdue.push(item);
      else if (p.due_date <= soon) out.ap_soon.push(item);
    }
    if (p.check_no && p.check_due && p.check_due <= soon && p.check_due >= checkFrom) {
      out.check_due.push({ id: p.ap_id, name, item: p.check_no, due_date: p.check_due, amt: num(p.amount) });
    }
  }

  const liveProjects = store.all('projects').filter(p => p.status === '進行中');
  for (const p of liveProjects) {
    if (String(p.proj_status || '').includes('驗收')) {
      out.accepting.push({ id: p.proj_id, name: p.proj_name, item: p.proj_status, due_date: null, amt: null });
    }
  }
  // 保固期限通常在結案後才填，因此不限「進行中」
  for (const p of store.all('projects')) {
    if (p.warranty && p.warranty >= now && p.warranty <= warrantySoon) {
      out.warranty_due.push({ id: p.proj_id, name: p.proj_name, item: '保固', due_date: p.warranty, amt: null });
    }
  }
  const liveIds = new Set(liveProjects.map(p => p.proj_id));
  for (const s of store.all('project_stages')) {
    if (s.actual_end || !s.planned_end || s.planned_end >= now || !liveIds.has(s.proj_id)) continue;
    out.stage_overdue.push({ id: s.proj_id, name: projName(s.proj_id), item: s.stage_name, due_date: s.planned_end, amt: null });
  }

  const byDate = (a, b) => str(a.due_date).localeCompare(str(b.due_date));
  for (const k of Object.keys(out)) out[k].sort(byDate);
  res.json(out);
});

module.exports = router;
