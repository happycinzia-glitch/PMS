/* ============================================================
   專案管理系統 前端邏輯 (原生 JS，單頁應用)
   ============================================================ */

let USER = null;
const lookupCache = {};
const optionCache = {};  // 項目維護的下拉清單快取

/* ── 通用工具 ─────────────────────────────────────────── */
async function api(url, options = {}) {
  const opt = { headers: {}, ...options };
  if (opt.body && typeof opt.body !== 'string') {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(opt.body);
  }
  const method = (opt.method || 'GET').toUpperCase();
  const res = await fetch(url, opt);
  if (res.status === 401) { location.href = '/'; throw new Error('未登入'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '操作失敗');
  // 有寫入動作時清除快取，確保新資料即時出現
  if (method !== 'GET') {
    for (const k in lookupCache) delete lookupCache[k];
    for (const k in optionCache) delete optionCache[k];
  }
  return data;
}
const esc = (s) => (s === null || s === undefined) ? '' : String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => (n === null || n === undefined || n === '') ? '' : Number(n).toLocaleString('en-US');
const fmtDate = (d) => d ? String(d).slice(0, 10) : '';
// 依本機時區取 YYYY-MM-DD (toISOString 是 UTC，台灣早上 8 點前會變成前一天)
const localISO = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// 檔案大小顯示 (B / KB / MB)
const fileSize = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
};
const fmtDT = (d) => d ? String(d).replace('T', ' ').slice(0, 16) : '';

function statusBadge(s) {
  const map = {
    '啟用': 'green', '正常': 'green', '已收款': 'green', '已付款': 'green', '已確認': 'green',
    '進行中': 'blue', '準備進場': 'blue',
    '待收款': 'amber', '待付款': 'amber', '施工中': 'amber', '設計中': 'amber', '停工': 'amber',
    '待處理': 'amber', '待確認': 'amber', '派工中': 'blue', '已完修': 'green',
    '已結案': 'gray', '已完工': 'gray', '結案': 'gray', '已報廢': 'gray', '使用中': 'green',
    '停用': 'red', '作廢': 'red', '鎖住': 'red', '已離職': 'red', '拒絕往來': 'red',
  };
  return `<span class="badge ${map[s] || 'gray'}">${esc(s || '')}</span>`;
}

async function getLookup(name) {
  if (!lookupCache[name]) lookupCache[name] = await api('/api/lookups/' + name);
  return lookupCache[name];
}
// 項目維護的下拉清單 (由資料庫維護)
async function getOptions(category) {
  if (!optionCache[category]) optionCache[category] = await api('/api/options/' + category);
  return optionCache[category];
}
// 由字串陣列產生 <option> (單選下拉，不可自填)
function optionsFromList(list, selected, withBlank = true) {
  let html = withBlank ? '<option value="">— 請選擇 —</option>' : '';
  html += list.map(o => `<option ${o === selected ? 'selected' : ''}>${esc(o)}</option>`).join('');
  return html;
}
function options(items, valueKey, labelKey, selected, withBlank = true) {
  let html = withBlank ? '<option value="">— 請選擇 —</option>' : '';
  for (const it of items) {
    const v = it[valueKey];
    const label = `${v}${it[labelKey] ? ' ' + it[labelKey] : ''}`;
    html += `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
  }
  return html;
}
// 固定選項的狀態下拉 (不可自行輸入)
function statusSelectOptions(list, selected) {
  return list.map(s => `<option ${s === selected ? 'selected' : ''}>${esc(s)}</option>`).join('');
}

/* ── 彈窗 ─────────────────────────────────────────────── */
const mask = document.getElementById('modalMask');
let __modalSeq = 0;   // 每開一次視窗 +1，openForm 用來判斷存檔後是否已換成別的視窗
function openModal(title, bodyHtml, footHtml) {
  __modalSeq++;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFoot').innerHTML = footHtml || '';
  mask.classList.add('show');
}
function closeModal() { mask.classList.remove('show'); }
document.getElementById('modalClose').onclick = closeModal;
mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });

/* ── 通用表單彈窗 ─────────────────────────────────────
   fields: [{name,label,type,options(html),required,full,value,readonly,hint,disabledOpts}]
   type: text|number|date|textarea|select|password|checkbox
─────────────────────────────────────────────────────── */
function fieldHtml(f) {
  const v = f.value ?? '';
  const req = f.required ? 'required' : '';
  const ro = f.readonly ? 'readonly' : '';
  let input;
  if (f.type === 'textarea') {
    input = `<textarea name="${f.name}" rows="2" ${req} ${ro}>${esc(v)}</textarea>`;
  } else if (f.type === 'select') {
    input = `<select name="${f.name}" ${req} ${f.onchange ? `onchange="${f.onchange}"` : ''}>${f.options}</select>`;
  } else if (f.type === 'datalist') {
    const listId = f.name + '_dl';
    input = `<input name="${f.name}" list="${listId}" value="${esc(v)}" ${req} placeholder="選擇或自行輸入">
      <datalist id="${listId}">${(f.list || []).map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
  } else if (f.type === 'multicheck') {
    // 複選核取方塊，提交時以逗號串接；保留清單外的既有值
    const selected = String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    const all = (f.list || []).slice();
    selected.forEach(s => { if (!all.includes(s)) all.push(s); });
    input = `<div class="multicheck">${all.length ? all.map(o =>
      `<label class="mc-item"><input type="checkbox" name="${f.name}" value="${esc(o)}" ${selected.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`
    ).join('') : '<span class="hint">尚無選項，請至「項目維護」新增</span>'}</div>`;
  } else if (f.type === 'locked') {
    // 顯示用唯讀文字，實際值以隱藏欄位送出 (例如客戶不可改但要保留)
    input = `<input type="text" value="${esc(f.display ?? v)}" readonly>
      <input type="hidden" name="${f.name}" value="${esc(v)}">`;
  } else if (f.type === 'checkbox') {
    input = `<label style="font-weight:400"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''} ${f.onchange ? `onchange="${f.onchange}"` : ''}> ${esc(f.checkLabel || '')}</label>`;
  } else {
    input = `<input type="${f.type || 'text'}" name="${f.name}" value="${esc(v)}" ${req} ${ro}
      ${f.step ? `step="${f.step}"` : ''} ${f.list ? `list="${f.list}" autocomplete="off"` : ''} ${f.oninput ? `oninput="${f.oninput}"` : ''} ${f.onchange ? `onchange="${f.onchange}"` : ''}>`;
  }
  return `<div class="field ${f.full ? 'full' : ''}">
    <label>${esc(f.label)}${f.required ? ' *' : ''}</label>${input}
    ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
}

function openForm({ title, fields, extraHtml = '', topHtml = '', onSubmit }) {
  const body = `<form id="modalForm">${topHtml}<div class="form-grid">
    ${fields.map(fieldHtml).join('')}</div>${extraHtml}</form>`;
  const foot = `<button class="btn ghost" type="button" id="fCancel">取消</button>
    <button class="btn" type="submit" form="modalForm" id="fSave">儲存</button>`;
  openModal(title, body, foot);
  const mySeq = __modalSeq;
  document.getElementById('fCancel').onclick = closeModal;
  document.getElementById('modalForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const values = {};
    fields.forEach(f => {
      if (f.type === 'checkbox') values[f.name] = fd.get(f.name) === 'on';
      else if (f.type === 'multicheck') values[f.name] = fd.getAll(f.name).join(',');
      else values[f.name] = fd.get(f.name);
    });
    const saveBtn = document.getElementById('fSave');
    saveBtn.disabled = true; saveBtn.textContent = '儲存中...';
    try {
      await onSubmit(values, e.target);
      if (__modalSeq === mySeq) closeModal();   // onSubmit 若已開了別的視窗 (例：建完料號回到入庫單)，保留它
    } catch (err) {
      alert(err.message);
      saveBtn.disabled = false; saveBtn.textContent = '儲存';
    }
  };
}

function confirmDelete(text, fn) {
  if (confirm(text)) fn();
}

/* ── 清單頁面骨架 ─────────────────────────────────────── */
function renderListPage({ searchable, placeholder, defaultHint }) {
  document.getElementById('content').innerHTML = `
    <div class="toolbar">
      ${searchable ? `<input class="search" id="searchInput" placeholder="${esc(placeholder || '搜尋關鍵字...')}">
        <button class="btn" id="searchBtn">搜尋</button>` : ''}
      <button class="btn ghost" id="exportCsvBtn" style="margin-left:auto">匯出CSV</button>
    </div>
    ${defaultHint ? `<div class="hint" id="listHint" style="margin-bottom:10px">${esc(defaultHint)}</div>` : ''}
    <div class="card"><div id="listArea"><div class="empty">${searchable ? '請輸入關鍵字後查詢' : '載入中...'}</div></div></div>`;
  document.getElementById('exportCsvBtn').onclick = () => exportListCSV();
}

// 將一個表格轉為 CSV 文字列陣列 (略過操作/維護欄)
function tableToCsvLines(table) {
  const skip = new Set();
  Array.from(table.querySelectorAll('thead th')).forEach((th, i) => {
    const t = th.textContent.trim();
    if (!t || t === '操作' || t === '維護') skip.add(i);
  });
  const lines = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('th,td'))
      .filter((_, i) => !skip.has(i))
      .map(td => '"' + td.textContent.trim().replace(/"/g, '""') + '"');
    if (cells.length) lines.push(cells.join(','));
  });
  return lines;
}
// 下載 CSV (含 Excel 中文 BOM)
function downloadCSV(lines, filename) {
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}
// 匯出目前清單明細為 CSV (分頁清單會匯出「全部」資料，不只當前頁)
function exportListCSV() {
  let table = document.querySelector('#listArea table');
  const wrap = document.querySelector('#listArea [id^="pg"]');
  if (wrap && __paged[wrap.id]) {
    const s = __paged[wrap.id];
    const tmp = document.createElement('div');
    tmp.innerHTML = tableHtml(s.columns, s.rows, s.footer);   // 全部資料重組
    table = tmp.querySelector('table');
  }
  if (!table) { alert('目前沒有可匯出的明細，請先查詢。'); return; }
  const lines = tableToCsvLines(table);
  if (lines.length <= 1) { alert('目前沒有可匯出的明細。'); return; }
  const title = (document.getElementById('pageTitle').textContent || '明細').trim();
  downloadCSV(lines, `${title}_${localISO()}.csv`);
}
// footer：與 columns 對齊的合計列陣列 (字串 HTML，不需要時省略)
function tableHtml(columns, rows, footer) {
  if (!rows.length) return `<div class="empty">查無資料</div>`;
  const head = columns.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map(r => '<tr>' + columns.map(c => {
    let val = c.render ? c.render(r) : esc(r[c.key]);
    return `<td class="${c.num ? 'num' : ''}">${val}</td>`;
  }).join('') + '</tr>').join('');
  const foot = footer
    ? `<tfoot><tr>${columns.map((c, i) => `<td class="${c.num ? 'num' : ''}">${footer[i] ?? ''}</td>`).join('')}</tr></tfoot>`
    : '';
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
}

/* ── CSV 匯入 (客戶/廠商) ─────────────────────────────── */
const IMPORT_DEFS = {
  customer: {
    api: '/api/customers/import', name: '客戶',
    headers: ['姓名', '手機', '公司', '連絡地址', '備註'],
    keys: ['name', 'mobile', 'company', 'contact_addr', 'note'],
  },
  vendor: {
    api: '/api/vendors/import', name: '廠商',
    headers: ['公司名稱', '業務姓名', '手機', '營業項目', '結帳方式', '統編', '備註'],
    keys: ['company_name', 'sales_name', 'mobile', 'business_item', 'payment_method', 'tax_id', 'note'],
  },
};
// 簡易 CSV 解析 (支援引號欄位)；自動嘗試 UTF-8 與 Big5 (Excel 存的 CSV)
function parseCSV(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}
function decodeCsvBuffer(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  try { return new TextDecoder('big5').decode(buf); } catch { return utf8.replace(/^﻿/, ''); }
}
function importCSVFlow(kind) {
  const def = IMPORT_DEFS[kind];
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.csv,text/csv';
  input.onchange = async () => {
    if (!input.files.length) return;
    try {
      const buf = await input.files[0].arrayBuffer();
      const rows = parseCSV(decodeCsvBuffer(buf));
      if (rows.length < 2) { alert('CSV 內容不足（第一行需為欄位名稱，之後每行一筆）。'); return; }
      const head = rows[0].map(h => h.trim());
      // 依範本欄名對應欄位位置 (順序可不同，缺欄位視為空)
      const idx = def.headers.map(h => head.indexOf(h));
      if (idx[0] === -1) { alert(`第一行找不到必要欄位「${def.headers[0]}」。\n請先下載範本核對欄位名稱。`); return; }
      const data = rows.slice(1).map(r => {
        const o = {};
        def.keys.forEach((k, i) => { o[k] = idx[i] >= 0 ? (r[idx[i]] || '').trim() : ''; });
        return o;
      });
      if (!confirm(`即將匯入 ${data.length} 筆${def.name}資料，確定執行？`)) return;
      const res = await api(def.api, { method: 'POST', body: { rows: data } });
      let msg = `匯入完成：成功 ${res.ok} 筆`;
      if (res.skipped?.length) msg += `\n略過 ${res.skipped.length} 筆：\n` + res.skipped.slice(0, 10).join('\n');
      alert(msg);
      MODULES[kind].render();
    } catch (e) { alert('匯入失敗：' + e.message); }
  };
  input.click();
}
function downloadImportTemplate(kind) {
  const def = IMPORT_DEFS[kind];
  downloadCSV([def.headers.map(h => `"${h}"`).join(',')], `${def.name}匯入範本.csv`);
}
// 在清單工具列加入 匯入CSV / 範本 按鈕 (客戶與廠商頁用)
function addImportButtons(kind) {
  const exp = document.getElementById('exportCsvBtn');
  if (!exp) return;
  exp.style.marginLeft = '0';
  exp.insertAdjacentHTML('beforebegin',
    `<button class="btn ghost" id="importCsvBtn" style="margin-left:auto">匯入CSV</button>
     <button class="btn ghost" id="tplCsvBtn">範本</button>`);
  document.getElementById('importCsvBtn').onclick = () => importCSVFlow(kind);
  document.getElementById('tplCsvBtn').onclick = () => downloadImportTemplate(kind);
}

/* ── 清單分頁 (每頁 25 筆) ────────────────────────────── */
const PAGE_SIZE = 25;
let __pagedSeq = 0;
const __paged = {};   // pid → { columns, rows, footer, page }
// 取代 tableHtml 用於清單頁：超過 25 筆自動出現換頁列
function pagedTable(columns, rows, footer) {
  const pid = 'pg' + (++__pagedSeq);
  __paged[pid] = { columns, rows, footer, page: 1 };
  return `<div id="${pid}">${pagedInner(pid)}</div>`;
}
function pagedInner(pid) {
  const s = __paged[pid];
  const total = s.rows.length;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  s.page = Math.min(Math.max(s.page, 1), pages);
  const from = (s.page - 1) * PAGE_SIZE;
  const slice = s.rows.slice(from, from + PAGE_SIZE);
  let pager = '';
  if (total > PAGE_SIZE) {
    const btn = (label, page, disabled) =>
      `<button class="btn ghost sm" ${disabled ? 'disabled' : ''} onclick="pagedGo('${pid}',${page})">${label}</button>`;
    // 頁碼最多列 7 個，目前頁置中
    let start = Math.max(1, Math.min(s.page - 3, pages - 6));
    const nums = [];
    for (let i = start; i <= Math.min(start + 6, pages); i++) {
      nums.push(i === s.page
        ? `<button class="btn sm" disabled style="opacity:1">${i}</button>`
        : `<button class="btn ghost sm" onclick="pagedGo('${pid}',${i})">${i}</button>`);
    }
    pager = `<div class="pager">
      <span class="pager-info">第 ${from + 1}–${Math.min(from + PAGE_SIZE, total)} 筆，共 ${total} 筆</span>
      <span class="pager-btns">${btn('上一頁', s.page - 1, s.page <= 1)}${nums.join('')}${btn('下一頁', s.page + 1, s.page >= pages)}</span>
    </div>`;
  }
  return tableHtml(s.columns, slice, s.footer) + pager;
}
function pagedGo(pid, page) {
  const s = __paged[pid];
  const el = document.getElementById(pid);
  if (!s || !el) return;
  s.page = page;
  el.innerHTML = pagedInner(pid);
}

/* ============================================================
   各模組
   ============================================================ */
const MODULES = {};

/* ── 客戶基本資料表 ─────────────────────────────────── */
MODULES.customer = {
  title: '客戶基本資料', perm: 'perm_customer',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 客戶編號 / 姓名 / 手機 / 公司',
      defaultHint: '請輸入關鍵字查詢明細如下：' });
    addImportButtons('customer');
    setTopAction('＋ 新增客戶', () => this.form());
    const doSearch = async () => {
      const q = document.getElementById('searchInput').value.trim();
      const rows = await api('/api/customers?q=' + encodeURIComponent(q));
      document.getElementById('listArea').innerHTML = pagedTable([
        { key: 'cust_id', label: '客戶編號', render: r => `<a class="link" onclick="MODULES.customer.detail('${r.cust_id}')">${esc(r.cust_id)}</a>` },
        { key: 'name', label: '客戶姓名' },
        { key: 'mobile', label: '手機' },
        { key: 'status', label: '系統狀態', render: r => statusBadge(r.status) },
      ], rows);
    };
    document.getElementById('searchBtn').onclick = doSearch;
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  },
  async detail(id) {
    const c = await api('/api/customers/' + id);
    openModal('客戶明細 ' + c.cust_id, `<dl class="dl">
      <dt>客戶編號</dt><dd>${esc(c.cust_id)}</dd>
      <dt>客戶姓名</dt><dd>${esc(c.name)}</dd>
      <dt>手機</dt><dd>${esc(c.mobile)}</dd>
      <dt>任職公司</dt><dd>${esc(c.company)}</dd>
      <dt>任職職稱</dt><dd>${esc(c.job_title)}</dd>
      <dt>公司電話</dt><dd>${esc(c.company_phone)}</dd>
      <dt>公司信箱</dt><dd>${esc(c.company_email)}</dd>
      <dt>公司地址</dt><dd>${esc(c.company_addr)}</dd>
      <dt>家裡電話</dt><dd>${esc(c.home_phone)}</dd>
      <dt>家裡地址</dt><dd>${esc(c.home_addr)}</dd>
      <dt>連絡地址</dt><dd>${esc(c.contact_addr)}</dd>
      <dt>備註</dt><dd>${esc(c.note)}</dd>
      <dt>系統狀態</dt><dd>${statusBadge(c.status)}</dd>
      <dt>填表人</dt><dd>${esc(c.created_by_name || c.created_by)}</dd>
      <dt>建立日期</dt><dd>${fmtDT(c.created_at)}</dd>
      <dt>最後修改日期</dt><dd>${fmtDT(c.updated_at)}</dd>
      <dt>維護窗口</dt><dd>${esc(c.maintainer_name || c.maintainer)}</dd>
    </dl>`, `<button class="btn ghost" onclick="closeModal()">關閉</button>
      <button class="btn" onclick="MODULES.customer.form('${c.cust_id}')">修改</button>
      <button class="btn danger" onclick="MODULES.customer.remove('${c.cust_id}')">刪除</button>`);
  },
  async form(id) {
    const c = id ? await api('/api/customers/' + id) : {};
    const emps = await getLookup('employees');
    openForm({
      title: id ? '修改客戶 ' + id : '新增客戶',
      fields: [
        { name: 'name', label: '客戶姓名', required: true, value: c.name },
        { name: 'mobile', label: '手機', required: true, value: c.mobile },
        { name: 'company', label: '任職公司', value: c.company },
        { name: 'job_title', label: '任職職稱', value: c.job_title },
        { name: 'company_phone', label: '公司電話', value: c.company_phone },
        { name: 'company_email', label: '公司信箱', value: c.company_email },
        { name: 'company_addr', label: '公司地址', full: true, value: c.company_addr },
        { name: 'home_phone', label: '家裡電話', value: c.home_phone },
        { name: 'home_addr', label: '家裡地址', value: c.home_addr },
        { name: 'contact_addr', label: '連絡地址', full: true, value: c.contact_addr },
        { name: 'maintainer', label: '維護窗口', type: 'select', options: options(emps, 'emp_id', 'name', c.maintainer || USER.emp_id) },
        { name: 'status', label: '系統狀態', type: 'select', options: statusSelectOptions(['正常', '拒絕往來'], c.status || '正常') },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: c.note },
      ],
      onSubmit: async (v) => {
        if (id) await api('/api/customers/' + id, { method: 'PUT', body: v });
        else await api('/api/customers', { method: 'POST', body: v });
        MODULES.customer.render();
      },
    });
  },
  remove(id) {
    confirmDelete('確定刪除客戶 ' + id + '？', async () => {
      try { await api('/api/customers/' + id, { method: 'DELETE' }); closeModal(); MODULES.customer.render(); }
      catch (e) { alert(e.message); }
    });
  },
};

/* ── 廠商基本資料表 ─────────────────────────────────── */
MODULES.vendor = {
  title: '廠商基本資料', perm: 'perm_vendor',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 廠商編號 / 公司 / 業務 / 營業項目 / 手機',
      defaultHint: '請輸入關鍵字查詢明細如下：' });
    addImportButtons('vendor');
    setTopAction('＋ 新增廠商', () => this.form());
    const doSearch = async () => {
      const q = document.getElementById('searchInput').value.trim();
      const rows = await api('/api/vendors?q=' + encodeURIComponent(q));
      document.getElementById('listArea').innerHTML = pagedTable([
        { key: 'vend_id', label: '廠商編號', render: r => `<a class="link" onclick="MODULES.vendor.detail('${r.vend_id}')">${esc(r.vend_id)}</a>` },
        { key: 'company_name', label: '公司名稱' },
        { key: 'sales_name', label: '業務姓名' },
        { key: 'business_item', label: '營業項目' },
        { key: 'mobile', label: '手機' },
        { key: 'status', label: '系統狀態', render: r => statusBadge(r.status) },
      ], rows);
    };
    document.getElementById('searchBtn').onclick = doSearch;
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  },
  async detail(id) {
    const v = await api('/api/vendors/' + id);
    openModal('廠商明細 ' + v.vend_id, `<dl class="dl">
      <dt>廠商編號</dt><dd>${esc(v.vend_id)}</dd>
      <dt>公司名稱</dt><dd>${esc(v.company_name)}</dd>
      <dt>公司統編</dt><dd>${esc(v.tax_id)}</dd>
      <dt>業務姓名</dt><dd>${esc(v.sales_name)}</dd>
      <dt>任職職稱</dt><dd>${esc(v.job_title)}</dd>
      <dt>手機</dt><dd>${esc(v.mobile)}</dd>
      <dt>營業項目</dt><dd>${esc(v.business_item)}</dd>
      <dt>結帳方式</dt><dd>${esc(v.payment_method)}</dd>
      <dt>公司電話</dt><dd>${esc(v.company_phone)}</dd>
      <dt>公司信箱</dt><dd>${esc(v.company_email)}</dd>
      <dt>公司地址</dt><dd>${esc(v.company_addr)}</dd>
      <dt>備註</dt><dd>${esc(v.note)}</dd>
      <dt>系統狀態</dt><dd>${statusBadge(v.status)}</dd>
      <dt>填表人</dt><dd>${esc(v.created_by_name || v.created_by)}</dd>
      <dt>建立日期</dt><dd>${fmtDT(v.created_at)}</dd>
      <dt>最後修改日期</dt><dd>${fmtDT(v.updated_at)}</dd>
      <dt>維護窗口</dt><dd>${esc(v.maintainer_name || v.maintainer)}</dd>
    </dl>`, `<button class="btn ghost" onclick="closeModal()">關閉</button>
      <button class="btn" onclick="MODULES.vendor.form('${v.vend_id}')">修改</button>
      <button class="btn danger" onclick="MODULES.vendor.remove('${v.vend_id}')">刪除</button>`);
  },
  // opts.presetName：公司名稱預填 (料號／資產表單「查無廠商」時帶入關鍵字)
  // opts.after(v)：建完廠商後不回廠商清單，改呼叫此函式 (回到料號／資產表單並選好該廠商)
  async form(id, opts = {}) {
    const v = id ? await api('/api/vendors/' + id) : {};
    const emps = await getLookup('employees');
    // 直接抓最新清單 (不吃快取)，確保與「項目維護」即時連動
    const [bizOpts, payOpts] = [await api('/api/options/vendor_business'), await api('/api/options/vendor_payment')];
    openForm({
      title: id ? '修改廠商 ' + id : '新增廠商',
      fields: [
        { name: 'company_name', label: '公司名稱', required: true, value: v.company_name || opts.presetName || '' },
        { name: 'tax_id', label: '公司統編', value: v.tax_id },
        { name: 'sales_name', label: '業務姓名', required: true, value: v.sales_name },
        { name: 'job_title', label: '任職職稱', value: v.job_title },
        { name: 'mobile', label: '手機', required: true, value: v.mobile },
        { name: 'business_item', label: '營業項目（可複選）', full: true, type: 'multicheck', list: bizOpts, value: v.business_item },
        { name: 'payment_method', label: '結帳方式', type: 'select', options: optionsFromList(payOpts, v.payment_method) },
        { name: 'company_phone', label: '公司電話', value: v.company_phone },
        { name: 'company_email', label: '公司信箱', value: v.company_email },
        { name: 'company_addr', label: '公司地址', full: true, value: v.company_addr },
        { name: 'maintainer', label: '維護窗口', type: 'select', options: options(emps, 'emp_id', 'name', v.maintainer || USER.emp_id) },
        { name: 'status', label: '系統狀態', type: 'select', options: statusSelectOptions(['正常', '拒絕往來'], v.status || '正常') },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: v.note },
      ],
      onSubmit: async (val) => {
        let r = { vend_id: id };
        if (id) await api('/api/vendors/' + id, { method: 'PUT', body: val });
        else r = await api('/api/vendors', { method: 'POST', body: val });
        if (opts.after) { closeModal(); await opts.after({ vend_id: r.vend_id, company_name: val.company_name }); }
        else MODULES.vendor.render();
      },
    });
  },
  remove(id) {
    confirmDelete('確定刪除廠商 ' + id + '？', async () => {
      try { await api('/api/vendors/' + id, { method: 'DELETE' }); closeModal(); MODULES.vendor.render(); }
      catch (e) { alert(e.message); }
    });
  },
};

/* ── 專案管理資料表 ─────────────────────────────────── */
MODULES.project = {
  title: '專案管理資料', perm: 'perm_project',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 專案名稱',
      defaultHint: USER.perm_admin
        ? '預設顯示全部「進行中」的專案（不限負責人），依開工日期遞減；搜尋關鍵字將涵蓋所有專案(含結案)。'
        : '預設顯示「您負責且進行中」的專案，依開工日期遞減；搜尋關鍵字將涵蓋所有專案(含結案)。' });
    setTopAction('＋ 新增專案', () => this.form());
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async load(q) {
    const rows = await api('/api/projects?q=' + encodeURIComponent(q || ''));
    document.getElementById('listArea').innerHTML = pagedTable([
      { key: 'proj_id', label: '專案編號', render: r => `<a class="link" onclick="MODULES.project.detail('${r.proj_id}')">${esc(r.proj_id)}</a>` },
      { key: 'proj_name', label: '專案名稱' },
      { key: 'cust_name', label: '客戶名稱' },
      { key: 'sales_name', label: '業務姓名' },
      { key: 'start_date', label: '開工日期', render: r => fmtDate(r.start_date) },
      { key: 'owner_name', label: '專案負責人' },
      { key: '_prog', label: '進度', render: r => {
        if (!r.stage_total) return '<span class="hint">—</span>';
        const pct = Math.round(r.stage_done / r.stage_total * 100);
        return `<div class="prog"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
          <span class="prog-txt">${r.stage_done}/${r.stage_total}</span></div>`;
      } },
      { key: 'status', label: '系統狀態', render: r => statusBadge(r.status) },
    ], rows);
  },
  async detail(id) {
    const p = await api('/api/projects/' + id);
    const logRows = (p.logs || []).map(l => `<tr>
      <td>${fmtDate(l.log_date)}</td><td>${esc(l.progress)}</td><td>${esc(l.note)}</td>
      <td>${esc(l.created_by_name || l.created_by)}</td>
      <td><button class="btn danger sm" onclick="MODULES.project.delLog('${id}',${l.log_id})">刪</button></td></tr>`).join('')
      || `<tr><td colspan="5" class="empty">尚無日誌</td></tr>`;
    openModal('專案明細 ' + p.proj_id, `
      <div class="detail-actions">
        <button class="btn" onclick="MODULES.project.form('${p.proj_id}')">修改</button>
        <button class="btn danger" onclick="MODULES.project.remove('${p.proj_id}')">刪除</button>
      </div>
      <dl class="dl">
      <dt>專案編號</dt><dd>${esc(p.proj_id)}</dd>
      <dt>專案名稱</dt><dd>${esc(p.proj_name)}</dd>
      <dt>客戶</dt><dd>${esc(p.cust_id)} ${esc(p.cust_name || '')}</dd>
      <dt>開工日期</dt><dd>${fmtDate(p.start_date)}</dd>
      <dt>結束日期</dt><dd>${fmtDate(p.end_date)}</dd>
      <dt>保固期限</dt><dd>${esc(p.warranty)}</dd>
      <dt>裝修地址</dt><dd>${esc(p.addr)}</dd>
      <dt>專案狀態</dt><dd>${esc(p.proj_status)}</dd>
      <dt>系統狀態</dt><dd>${statusBadge(p.status)}</dd>
      <dt>專案負責人</dt><dd>${esc(p.owner_name || p.owner)}</dd>
      <dt>業務(填表人)</dt><dd>${esc(p.created_by_name || p.created_by)}</dd>
      <dt>建立日期</dt><dd>${fmtDT(p.created_at)}</dd>
      <dt>備註</dt><dd>${esc(p.note)}</dd>
    </dl>
    <div class="section-title">進度追蹤 (甘特圖)
      <button class="btn sm" style="float:right" onclick="MODULES.project.stageForm('${id}')">＋ 新增階段</button></div>
    ${stageSection(p)}
    <div class="section-title">追加減帳 (變更單)
      <button class="btn sm" style="float:right" onclick="MODULES.project.changeForm('${id}')">＋ 新增變更單</button></div>
    ${changeSection(p)}
    <div class="section-title">專案日誌 (子表單)
      <button class="btn sm" style="float:right" onclick="MODULES.project.addLog('${id}')">＋ 新增日誌</button></div>
    <table class="subtable"><thead><tr><th>建檔日期</th><th>進度說明</th><th>備註</th><th>填表人</th><th></th></tr></thead>
      <tbody>${logRows}</tbody></table>
    <div class="section-title">結案附件</div>
    <div id="fileArea"><div class="hint">載入中...</div></div>
    <div class="section-title">應收款項 (本專案)</div>
    ${projArTable(p.receivables || [])}
    <div class="section-title">應付款項 (本專案)</div>
    ${projApTable(p.payables || [])}
    <div class="section-title">維修工單 (本專案)</div>
    ${projRepairTable(p.repairs || [])}`,
      `<button class="btn ghost" onclick="closeModal()">關閉</button>`);
    this.loadFiles(id, p.status);
  },

  /* ── 結案附件：僅「結案」專案可上傳；下載/刪除限系統管理者 ── */
  async loadFiles(id, status) {
    const area = document.getElementById('fileArea');
    if (!area) return;
    const closed = ['結案', '已結案'].includes(status);
    try {
      const r = await api('/api/projects/' + id + '/files');
      const rows = r.files.map(f => `<tr>
        <td>${esc(f.orig_name)}</td>
        <td class="num">${fileSize(f.size_bytes)}</td>
        <td>${esc(f.uploaded_by_name || f.uploaded_by || '')}</td>
        <td>${fmtDT(f.uploaded_at)}</td>
        <td>${r.can_download ? `<div class="row-actions">
              <button class="btn sm" onclick="MODULES.project.download('${id}',${f.file_id},'${esc(f.orig_name).replace(/'/g, "\\'")}')">下載</button>
              <button class="btn danger sm" onclick="MODULES.project.delFile('${id}',${f.file_id})">刪</button>
            </div>` : '<span class="hint">僅管理者可下載</span>'}</td></tr>`).join('')
        || `<tr><td colspan="5" class="empty">尚無附件</td></tr>`;
      area.innerHTML = `
        ${closed ? `<div class="toolbar" style="margin-bottom:10px">
            <input type="file" id="fileInput" multiple>
            <button class="btn" id="fileUploadBtn">上傳</button>
          </div>` : `<div class="hint" style="margin-bottom:10px">
            專案系統狀態為「結案」後才能上傳附件。</div>`}
        ${r.drive_ready ? '' : '<div class="hint" style="color:var(--danger);margin-bottom:10px">雲端硬碟尚未設定完成，暫時無法上傳。</div>'}
        <table class="subtable"><thead><tr><th>檔名</th><th class="num">大小</th><th>上傳者</th><th>上傳時間</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table>
        <div class="hint" style="margin-top:6px">檔案存放於公司 Google Drive，依專案編號分資料夾；單檔上限 10MB。</div>`;
      const btn = document.getElementById('fileUploadBtn');
      if (btn) btn.onclick = () => this.upload(id);
    } catch (e) {
      area.innerHTML = `<div class="hint" style="color:var(--danger)">${esc(e.message)}</div>`;
    }
  },
  async upload(id) {
    const input = document.getElementById('fileInput');
    const btn = document.getElementById('fileUploadBtn');
    if (!input.files.length) { alert('請先選擇檔案。'); return; }
    btn.disabled = true;
    try {
      let n = 0;
      for (const file of Array.from(input.files)) {
        if (file.size > 10 * 1024 * 1024) { alert(`「${file.name}」超過 10MB，已略過。`); continue; }
        btn.textContent = `上傳中 ${++n}/${input.files.length}...`;
        const data = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result).split(',').pop());
          fr.onerror = () => reject(new Error('讀取檔案失敗。'));
          fr.readAsDataURL(file);
        });
        await api('/api/projects/' + id + '/files', {
          method: 'POST',
          body: { name: file.name, mime: file.type || 'application/octet-stream', data },
        });
      }
      alert('上傳完成。');
      const p = await api('/api/projects/' + id);
      this.loadFiles(id, p.status);
    } catch (e) {
      alert('上傳失敗：' + e.message);
      btn.disabled = false; btn.textContent = '上傳';
    }
  },
  async download(id, fileId, name) {
    try {
      const res = await fetch(`/api/projects/${id}/files/${fileId}/download`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || '下載失敗');
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    } catch (e) { alert(e.message); }
  },
  delFile(id, fileId) {
    confirmDelete('確定刪除這個附件？(雲端檔案會移到 Google Drive 垃圾桶)', async () => {
      try {
        await api(`/api/projects/${id}/files/${fileId}`, { method: 'DELETE' });
        const p = await api('/api/projects/' + id);
        MODULES.project.loadFiles(id, p.status);
      } catch (e) { alert(e.message); }
    });
  },
  async form(id) {
    const p = id ? await api('/api/projects/' + id) : {};
    const emps = await getLookup('employees');
    const iso = localISO;
    let fields;
    if (!id) {
      // 新增：隱藏 專案狀態/系統狀態/結束日期/保固期限；提供「已確認報價單」帶入
      const [custs, cquotes] = [await getLookup('customers'), await getLookup('confirmed-quotes')];
      window.__confirmedQuotes = cquotes;
      const quoteOpts = '<option value="">— 不帶入 —</option>' +
        cquotes.map(q => `<option value="${esc(q.quote_id)}">${esc(q.proj_name || '')}${q.cust_name ? '（' + esc(q.cust_name) + '）' : ''}</option>`).join('');
      fields = [
        { name: '_from_quote', label: '從「已確認」報價單挑選專案名稱帶入（含客戶、裝修地址）', full: true, type: 'select', options: quoteOpts, onchange: 'projFillFromQuote(this)' },
        { name: 'proj_name', label: '專案名稱', required: true, full: true, value: p.proj_name },
        { name: 'cust_id', label: '客戶', type: 'select', options: options(custs, 'cust_id', 'name', p.cust_id) },
        { name: 'owner', label: '專案負責人', type: 'select', options: options(emps, 'emp_id', 'name', p.owner || USER.emp_id) },
        { name: 'start_date', label: '開工日期', type: 'date', value: iso(new Date()) },
        { name: 'end_date', label: '預定完工日期', type: 'date', hint: '供進度追蹤分配階段日期，可留空' },
        { name: 'stage_count', label: '進度追蹤：分幾個階段', type: 'select',
          options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map(n2 => `<option value="${n2}" ${n2 === 5 ? 'selected' : ''}>${n2 === 0 ? '不建立' : n2 + ' 個階段'}</option>`).join(''),
          hint: '自動以「專案狀態」清單命名並平均分配預定完成日期(無完工日則每階段14天)，建立後可修改' },
        { name: 'addr', label: '裝修地址', full: true, value: p.addr },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: p.note },
      ];
    } else {
      // 修改：顯示全部欄位（不含報價單帶入）；專案名稱與客戶不可修改
      // 專案狀態下拉(由項目維護管理，保留既有值)
      let psOpts = await api('/api/options/project_status');
      const curPs = p.proj_status || '準備進場';
      if (curPs && !psOpts.includes(curPs)) psOpts = [curPs, ...psOpts];
      fields = [
        { name: 'proj_name', label: '專案名稱', required: true, full: true, readonly: true, value: p.proj_name },
        { name: 'cust_id', label: '客戶（不可修改）', type: 'locked', value: p.cust_id, display: `${p.cust_id || ''} ${p.cust_name || ''}`.trim() },
        { name: 'owner', label: '專案負責人', type: 'select', options: options(emps, 'emp_id', 'name', p.owner) },
        { name: 'start_date', label: '開工日期', type: 'date', value: fmtDate(p.start_date) },
        { name: 'end_date', label: '結束日期', type: 'date', value: fmtDate(p.end_date) },
        { name: 'warranty', label: '保固期限', type: 'date', value: fmtDate(p.warranty) },
        { name: 'contract_amount', label: '原約金額', type: 'number', step: '1',
          value: p.contract_amount ? Math.round(Number(p.contract_amount)) : '', hint: '追加減帳的基準金額，非必填' },
        { name: 'addr', label: '裝修地址', full: true, value: p.addr },
        { name: 'proj_status', label: '專案狀態', type: 'select', options: optionsFromList(psOpts, curPs) },
        { name: 'status', label: '系統狀態', type: 'select', options: statusSelectOptions(['進行中', '停工', '結案'], p.status || '進行中') },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: p.note },
      ];
    }
    openForm({
      title: id ? '修改專案 ' + id : '新增專案',
      fields,
      onSubmit: async (v) => {
        delete v._from_quote;
        const closing = id && v.status === '結案' && p.status !== '結案';  // 這次才改成結案
        if (id) await api('/api/projects/' + id, { method: 'PUT', body: v });
        else await api('/api/projects', { method: 'POST', body: v });
        MODULES.project.render();
        // 結案時提示上傳附件 (也可日後再補傳)
        if (closing && confirm('專案已結案。要現在上傳結案附件嗎？\n(按「取消」可日後從專案明細再上傳)')) {
          await MODULES.project.detail(id);
        }
      },
    });
  },
  // 進度追蹤：新增/修改階段 (sid 省略＝新增)
  async stageForm(id, sid) {
    const p = await api('/api/projects/' + id);
    const st = sid ? (p.stages || []).find(s => String(s.stage_id) === String(sid)) : null;
    if (sid && !st) { alert('查無此階段。'); return; }
    const maxNo = (p.stages || []).length + (sid ? 0 : 1);
    openForm({
      title: sid ? `維護階段（${st.stage_name}）` : '新增階段',
      fields: [
        { name: 'seq_no', label: 'NO（順序）', type: 'number', step: '1', value: st ? st.seq_no : maxNo, hint: '改數字即可調整順序' },
        { name: 'stage_name', label: '階段名稱', required: true, value: st?.stage_name },
        { name: 'planned_end', label: '預定完成日期', type: 'date', value: fmtDate(st?.planned_end) },
        { name: 'actual_end', label: '實際完成日期', type: 'date', value: fmtDate(st?.actual_end), hint: '完成後填入，甘特圖與進度依此計算' },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: st?.note },
      ],
      onSubmit: async (v) => {
        if (sid) await api(`/api/projects/${id}/stages/${sid}`, { method: 'PUT', body: v });
        else await api(`/api/projects/${id}/stages`, { method: 'POST', body: v });
        MODULES.project.detail(id);
      },
    });
  },
  delStage(id, sid) {
    confirmDelete('確定刪除這個階段？', async () => {
      await api(`/api/projects/${id}/stages/${sid}`, { method: 'DELETE' });
      MODULES.project.detail(id);
    });
  },
  // 追加減帳：新增/修改變更單 (金額 正=追加、負=減帳)
  async changeForm(id, cid) {
    const p = await api('/api/projects/' + id);
    const c = cid ? (p.changes || []).find(x => String(x.change_id) === String(cid)) : null;
    if (cid && !c) { alert('查無此變更單。'); return; }
    openForm({
      title: cid ? '修改變更單' : '新增變更單（追加減帳）',
      fields: [
        { name: 'co_date', label: '變更日期', type: 'date', value: fmtDate(c?.co_date) || localISO() },
        { name: 'amount', label: '金額（正＝追加、負＝減帳）', type: 'number', step: '1', required: true, value: c ? Math.round(Number(c.amount)) : '' },
        { name: 'description', label: '變更說明', required: true, full: true, value: c?.description },
        { name: 'status', label: '狀態', type: 'select', options: statusSelectOptions(['已確認', '待確認', '作廢'], c?.status || '已確認') },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: c?.note },
      ],
      onSubmit: async (v) => {
        if (cid) await api(`/api/projects/${id}/changes/${cid}`, { method: 'PUT', body: v });
        else await api(`/api/projects/${id}/changes`, { method: 'POST', body: v });
        MODULES.project.detail(id);
      },
    });
  },
  delChange(id, cid) {
    confirmDelete('確定刪除這張變更單？', async () => {
      await api(`/api/projects/${id}/changes/${cid}`, { method: 'DELETE' });
      MODULES.project.detail(id);
    });
  },
  addLog(id) {
    openForm({
      title: '新增專案日誌',
      fields: [
        { name: 'log_date', label: '建檔日期', type: 'date', value: localISO() },
        { name: 'progress', label: '進度說明', type: 'textarea', full: true },
        { name: 'note', label: '備註', type: 'textarea', full: true },
      ],
      onSubmit: async (v) => { await api(`/api/projects/${id}/logs`, { method: 'POST', body: v }); MODULES.project.detail(id); },
    });
  },
  delLog(id, logId) {
    confirmDelete('警告!!該筆專案日誌資料刪除後無法複原！', async () => { await api(`/api/projects/${id}/logs/${logId}`, { method: 'DELETE' }); MODULES.project.detail(id); });
  },
  remove(id) {
    confirmDelete('警告!!該筆專案資料刪除後，包含專案日誌均無法複原！', async () => {
      try { await api('/api/projects/' + id, { method: 'DELETE' }); closeModal(); MODULES.project.render(); }
      catch (e) { alert(e.message); }
    });
  },
};

/* ── 專案進度追蹤：甘特圖 + 階段列表 ─────────────────── */
// 階段狀態文字：已完成(綠) / 逾期(紅) / 進行中
function stageStatus(st) {
  const today = localISO();
  if (st.actual_end) {
    const late = st.planned_end && fmtDate(st.actual_end) > fmtDate(st.planned_end);
    return `<span class="badge ${late ? 'amber' : 'green'}">完成${late ? '(晚)' : ''}</span>`;
  }
  if (st.planned_end && fmtDate(st.planned_end) < today) return '<span class="badge red">逾期</span>';
  return '<span class="badge blue">進行中</span>';
}

// 甘特圖 + 階段列表 (放在專案明細)
function stageSection(p) {
  const stages = p.stages || [];
  if (!stages.length) return '<div class="hint" style="margin-bottom:8px">尚未建立階段，按右上「＋ 新增階段」開始。</div>';

  // 時間軸範圍：開工日(或最早日期) ～ 最晚的預定/實際/今天
  const today = localISO();
  const dates = [fmtDate(p.start_date), today];
  stages.forEach(s => { dates.push(fmtDate(s.planned_end), fmtDate(s.actual_end)); });
  const valid = dates.filter(Boolean).map(d => Date.parse(d));
  const min = Math.min(...valid), max = Math.max(...valid);
  const span = Math.max(max - min, 86400000);
  const pct = (d) => Math.min(Math.max((Date.parse(d) - min) / span * 100, 0), 100);
  const start = fmtDate(p.start_date) || new Date(min).toISOString().slice(0, 10);

  let prev = start;   // 每階段的橫桿從上一階段預定日開始 (第一階段從開工日)
  const rows = stages.map(s => {
    const pEnd = fmtDate(s.planned_end), aEnd = fmtDate(s.actual_end);
    const from = prev; if (pEnd) prev = pEnd;
    const left = pct(from);
    const planW = pEnd ? Math.max(pct(pEnd) - left, 1.5) : 0;
    const actW = aEnd ? Math.max(pct(aEnd) - left, 1.5) : 0;
    const overdue = !aEnd && pEnd && pEnd < today;
    return `<div class="g-row">
      <div class="g-label">${s.seq_no}. ${esc(s.stage_name)}</div>
      <div class="g-track">
        ${pEnd ? `<div class="g-bar plan ${overdue ? 'late' : ''}" style="left:${left}%;width:${planW}%" title="預定 ${pEnd}"></div>` : ''}
        ${aEnd ? `<div class="g-bar actual ${pEnd && aEnd > pEnd ? 'late' : ''}" style="left:${left}%;width:${actW}%" title="實際 ${aEnd}"></div>` : ''}
        <div class="g-today" style="left:${pct(today)}%" title="今天 ${today}"></div>
      </div>
      <div class="g-date">${pEnd || '—'}</div>
    </div>`;
  }).join('');

  const table = `<table class="subtable"><thead><tr><th>NO</th><th>階段名稱</th><th>預定完成</th><th>實際完成</th><th>狀態</th><th>備註</th><th></th></tr></thead>
    <tbody>${stages.map(s => `<tr>
      <td class="num">${s.seq_no}</td>
      <td>${esc(s.stage_name)}</td>
      <td>${fmtDate(s.planned_end)}</td>
      <td>${fmtDate(s.actual_end)}</td>
      <td>${stageStatus(s)}</td>
      <td>${esc(s.note)}</td>
      <td><div class="row-actions">
        <button class="btn sm" onclick="MODULES.project.stageForm('${p.proj_id}',${s.stage_id})">維護</button>
        <button class="btn danger sm" onclick="MODULES.project.delStage('${p.proj_id}',${s.stage_id})">刪</button>
      </div></td></tr>`).join('')}</tbody></table>`;

  const done = stages.filter(s => s.actual_end).length;
  return `<div class="gantt">
      <div class="g-head"><span>開工 ${start}</span>
        <span>完成 ${done}/${stages.length}（${Math.round(done / stages.length * 100)}%）</span>
        <span>${new Date(max).toISOString().slice(0, 10)}</span></div>
      ${rows}
      <div class="g-legend"><i class="lg plan"></i>預定 <i class="lg actual"></i>實際完成 <i class="lg latebox"></i>逾期/延遲 <i class="lg todayline"></i>今天</div>
    </div>${table}`;
}

// 追加減帳區塊：原約金額 + 已確認變更合計 = 現行合約金額
function changeSection(p) {
  const chs = p.changes || [];
  const n = (v) => Math.round(Number(v)) || 0;
  const confirmed = chs.filter(c => c.status === '已確認').reduce((s, c) => s + n(c.amount), 0);
  const contract = p.contract_amount !== null && p.contract_amount !== undefined ? n(p.contract_amount) : null;
  const amtCell = (v) => `<span class="${Number(v) < 0 ? 'neg-num' : ''}">${Number(v) > 0 ? '+' : ''}${money(v)}</span>`;
  const summary = `<div class="hint" style="margin-bottom:8px">
    原約金額 <b>${contract === null ? '未設定（可在「修改」填寫）' : money(contract)}</b>
    ＋ 已確認追加減 <b>${confirmed >= 0 ? '+' : ''}${money(confirmed)}</b>
    ＝ 現行合約金額 <b>${contract === null ? '—' : money(contract + confirmed)}</b></div>`;
  if (!chs.length) return summary + '<div class="hint" style="margin-bottom:8px">尚無變更單。</div>';
  return summary + `<div class="subtable-wrap"><table class="subtable">
    <thead><tr><th>變更日期</th><th>變更說明</th><th class="num">金額(±)</th><th>狀態</th><th>備註</th><th>填表人</th><th></th></tr></thead>
    <tbody>${chs.map(c => `<tr>
      <td>${fmtDate(c.co_date)}</td><td>${esc(c.description)}</td>
      <td class="num">${amtCell(c.amount)}</td>
      <td>${statusBadge(c.status)}</td><td>${esc(c.note)}</td>
      <td>${esc(c.created_by_name || c.created_by)}</td>
      <td><div class="row-actions">
        <button class="btn sm" onclick="MODULES.project.changeForm('${p.proj_id}',${c.change_id})">修改</button>
        <button class="btn danger sm" onclick="MODULES.project.delChange('${p.proj_id}',${c.change_id})">刪</button>
      </div></td></tr>`).join('')}</tbody></table></div>`;
}

// 專案明細：本專案的維修工單子表單
function projRepairTable(rows) {
  if (!rows.length) return '<div class="hint" style="margin-bottom:8px">本專案尚無維修工單。</div>';
  return `<div class="subtable-wrap"><table class="subtable">
    <thead><tr><th>維修單號</th><th>報修日期</th><th>問題描述</th><th>負責人</th><th>預計處理日</th><th>狀態</th><th>完修日期</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><a class="link" onclick="MODULES.repair.detail('${r.ro_id}')">${esc(r.ro_id)}</a></td>
      <td>${fmtDate(r.reported_date)}</td><td>${esc(r.issue)}</td>
      <td>${esc(r.assignee_name)}</td><td>${fmtDate(r.scheduled_date)}</td>
      <td>${statusBadge(r.status)}</td><td>${fmtDate(r.completed_date)}</td></tr>`).join('')}</tbody></table></div>`;
}

// 專案明細：本專案的應收款項子表單 (含合計)
function projArTable(rows) {
  if (!rows.length) return '<div class="hint" style="margin-bottom:8px">本專案尚無應收款項。</div>';
  const sum = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
  return `<div class="subtable-wrap"><table class="subtable">
    <thead><tr><th>收款單號</th><th>應收日期</th><th>項目</th><th class="num">應收金額</th>
      <th class="num">5%稅額</th><th>狀態</th><th>收款日期</th><th class="num">實收金額</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(r.ar_id)}</td><td>${fmtDate(r.due_date)}</td>
      <td>${esc(r.item)}${r.is_retention ? ' <span class="badge amber">保留款</span>' : ''}</td>
      <td class="num">${money(r.amount)}</td><td class="num">${money(r.tax)}</td>
      <td>${statusBadge(r.status)}</td><td>${fmtDate(r.received_date)}</td>
      <td class="num">${money(r.received_amount)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="3" class="right">合計</th><th class="num">${money(sum('amount'))}</th>
      <th class="num">${money(sum('tax'))}</th><th></th><th></th>
      <th class="num">${money(sum('received_amount'))}</th></tr></tfoot></table></div>`;
}
// 專案明細：本專案的應付款項子表單 (含合計)
function projApTable(rows) {
  if (!rows.length) return '<div class="hint" style="margin-bottom:8px">本專案尚無應付款項。</div>';
  const sum = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
  return `<div class="subtable-wrap"><table class="subtable">
    <thead><tr><th>付款單號</th><th>廠商</th><th>項目</th><th class="num">應付金額</th>
      <th class="num">抵扣稅額</th><th>狀態</th><th>付款日期</th><th class="num">實付金額</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(r.ap_id)}</td><td>${esc(r.vend_name)}</td><td>${esc(r.item)}</td>
      <td class="num">${money(r.amount)}</td><td class="num">${money(r.tax_deduct)}</td>
      <td>${statusBadge(r.status)}</td><td>${fmtDate(r.paid_date)}</td>
      <td class="num">${money(r.paid_amount)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="3" class="right">合計</th><th class="num">${money(sum('amount'))}</th>
      <th class="num">${money(sum('tax_deduct'))}</th><th></th><th></th>
      <th class="num">${money(sum('paid_amount'))}</th></tr></tfoot></table></div>`;
}

// 從已確認報價單帶入 專案名稱 / 客戶 / 裝修地址 (皆可再修改)
function projFillFromQuote(sel) {
  const q = (window.__confirmedQuotes || []).find(x => x.quote_id === sel.value);
  if (!q) return;
  const form = sel.closest('form');
  if (!form) return;
  const set = (name, val) => { const el = form.querySelector(`[name=${name}]`); if (el) el.value = val || ''; };
  set('proj_name', q.proj_name);
  set('cust_id', q.cust_id);
  set('addr', q.addr);
}

/* ── 保固維修工單 (報修 → 派工 → 完修) ───────────────── */
MODULES.repair = {
  title: '維修工單', perm: 'perm_project',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 單號 / 客戶 / 專案 / 問題',
      defaultHint: '預設顯示「未完修」的工單；搜尋涵蓋所有工單(含已完修)。' });
    setTopAction('＋ 新增維修單', () => this.form());
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async load(q) {
    const rows = await api('/api/repairs?q=' + encodeURIComponent(q || ''));
    document.getElementById('listArea').innerHTML = pagedTable([
      { key: 'ro_id', label: '維修單號', render: r => `<a class="link" onclick="MODULES.repair.detail('${r.ro_id}')">${esc(r.ro_id)}</a>` },
      { key: 'proj_id', label: '專案編號', render: r => r.proj_id
        ? `<a class="link" onclick="MODULES.project.detail('${r.proj_id}')">${esc(r.proj_id)}</a>` : '' },
      { key: 'reported_date', label: '報修日期', render: r => fmtDate(r.reported_date) },
      { key: 'cust_name', label: '客戶' },
      { key: 'proj_name', label: '原專案' },
      { key: 'issue', label: '問題描述' },
      { key: 'assignee_name', label: '負責人' },
      { key: 'scheduled_date', label: '預計處理日', render: r => fmtDate(r.scheduled_date) },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
    ], rows);
  },
  async detail(id) {
    const r = await api('/api/repairs/' + id);
    openModal('維修單明細 ' + r.ro_id, `<dl class="dl">
      <dt>維修單號</dt><dd>${esc(r.ro_id)}</dd>
      <dt>報修日期</dt><dd>${fmtDate(r.reported_date)}</dd>
      <dt>客戶</dt><dd>${esc(r.cust_id)} ${esc(r.cust_name || '')}</dd>
      <dt>原專案</dt><dd>${esc(r.proj_id)} ${esc(r.proj_name || '')}</dd>
      <dt>問題描述</dt><dd>${esc(r.issue)}</dd>
      <dt>負責人</dt><dd>${esc(r.assignee_name || r.assignee)}</dd>
      <dt>預計處理日</dt><dd>${fmtDate(r.scheduled_date)}</dd>
      <dt>狀態</dt><dd>${statusBadge(r.status)}</dd>
      <dt>完修日期</dt><dd>${fmtDate(r.completed_date)}</dd>
      <dt>填表人</dt><dd>${esc(r.created_by_name || r.created_by)}</dd>
      <dt>備註</dt><dd>${esc(r.note)}</dd>
    </dl>`, `<button class="btn ghost" onclick="closeModal()">關閉</button>
      <button class="btn" onclick="MODULES.repair.form('${r.ro_id}')">修改</button>
      <button class="btn danger" onclick="MODULES.repair.remove('${r.ro_id}')">刪除</button>`);
  },
  async form(id) {
    const r = id ? await api('/api/repairs/' + id) : {};
    const [custs, projs, emps] = [await getLookup('customers'), await getLookup('projects'), await getLookup('employees')];
    openForm({
      title: id ? '修改維修單 ' + id : '新增維修單',
      fields: [
        { name: 'cust_id', label: '客戶', type: 'select', options: options(custs, 'cust_id', 'name', r.cust_id) },
        { name: 'proj_id', label: '原專案', type: 'select', options: options(projs, 'proj_id', 'proj_name', r.proj_id), hint: '非必填' },
        { name: 'reported_date', label: '報修日期', type: 'date', value: fmtDate(r.reported_date) || localISO() },
        { name: 'assignee', label: '負責人（派工）', type: 'select', options: options(emps, 'emp_id', 'name', r.assignee) },
        { name: 'scheduled_date', label: '預計處理日', type: 'date', value: fmtDate(r.scheduled_date) },
        { name: 'status', label: '狀態', type: 'select', options: statusSelectOptions(['待處理', '派工中', '已完修'], r.status || '待處理') },
        { name: 'completed_date', label: '完修日期', type: 'date', value: fmtDate(r.completed_date), hint: '完修時填寫' },
        { name: 'issue', label: '問題描述', required: true, full: true, value: r.issue },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: r.note },
      ],
      onSubmit: async (v) => {
        if (id) await api('/api/repairs/' + id, { method: 'PUT', body: v });
        else await api('/api/repairs', { method: 'POST', body: v });
        MODULES.repair.render();
      },
    });
  },
  remove(id) {
    confirmDelete('確定刪除維修單 ' + id + '？', async () => {
      try { await api('/api/repairs/' + id, { method: 'DELETE' }); closeModal(); MODULES.repair.render(); }
      catch (e) { alert(e.message); }
    });
  },
};

/* ── 操作紀錄 (僅系統管理者) ─────────────────────────── */
MODULES.audit = {
  title: '操作紀錄', perm: 'perm_admin',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 人員代號 / 姓名 / API 路徑',
      defaultHint: '顯示最近 1000 筆寫入動作（新增/修改/刪除；不含查詢與密碼內容）。' });
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async load(q) {
    const rows = await api('/api/admin/audit?q=' + encodeURIComponent(q || ''));
    document.getElementById('listArea').innerHTML = pagedTable([
      { key: 'at', label: '時間', render: r => fmtDT(r.at) },
      { key: 'emp_id', label: '人員', render: r => `${esc(r.emp_name || '')}${r.emp_id ? '（' + esc(r.emp_id) + '）' : ''}` },
      { key: 'method', label: '動作' },
      { key: 'path', label: '路徑' },
      { key: 'status', label: '結果', render: r => `<span class="badge ${r.status < 400 ? 'green' : 'red'}">${r.status}</span>` },
      { key: 'detail', label: '內容摘要', render: r => {
        const t = r.detail ? JSON.stringify(r.detail) : '';
        return `<span class="hint">${esc(t.length > 80 ? t.slice(0, 80) + '…' : t)}</span>`;
      } },
    ], rows);
  },
};

/* ── 報價單 ─────────────────────────────────────────── */
MODULES.quote = {
  title: '報價資料', perm: 'perm_quote',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 報價單號 / 客戶名稱',
      defaultHint: USER.perm_admin
        ? '預設顯示全部「進行中」的報價單（不限維護窗口），依報價日期遞減；搜尋關鍵字（單號、客戶）將涵蓋所有報價單。'
        : '預設顯示「維護窗口是您且進行中」的報價單，依報價日期遞減；搜尋關鍵字（單號、客戶）將涵蓋所有報價單。' });
    setTopAction('＋ 新增報價單', () => this.form());
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async load(q) {
    const rows = await api('/api/quotes?q=' + encodeURIComponent(q || ''));
    document.getElementById('listArea').innerHTML = pagedTable([
      { key: 'quote_id', label: '報價單編號', render: r => `<a class="link" onclick="MODULES.quote.detail('${r.quote_id}')">${esc(r.quote_id)}</a>` },
      { key: 'cust_name', label: '客戶名稱' },
      { key: 'proj_name', label: '專案名稱' },
      { key: 'quote_date', label: '報價日期', render: r => fmtDate(r.quote_date) },
      { key: 'total', label: '金額', num: true, render: r => money(r.total) },
      { key: 'maintainer_name', label: '維護窗口' },
      { key: 'status', label: '系統狀態', render: r => statusBadge(r.status) },
    ], rows);
  },
  async detail(id) {
    const q = await api('/api/quotes/' + id);
    // 依大項分組：大項標題列顯示「一、木作工程」與該大項小計，下方為細項 1,2,3…
    const groups = groupQuoteItems(q.items);
    const sectioned = groups.some(g => g.name);
    let total = 0, costTotal = 0;
    const itemRows = groups.map((g, gi) => {
      total += g.sub; costTotal += g.cost;
      const head = sectioned ? `<tr class="sec-row"><td class="num">${cnNum(gi + 1)}</td>
        <td colspan="4">${esc(g.name) || '（未命名大項）'}</td><td class="num">${money(g.sub)}</td>
        <td class="num">${money(g.cost)}</td><td class="num">${profitNum(g.sub - g.cost)}</td>
        <td class="num">${profitPct(g.sub - g.cost, g.sub)}</td><td></td></tr>` : '';
      return head + g.items.map((it, i) => {
        const sub = Number(it.subtotal) || 0;
        const cost = Number(it.vendor_price) || 0;
        return `<tr><td class="num">${i + 1}</td>
        <td>${esc(it.item)}</td><td class="num">${money(it.unit_price)}</td><td>${esc(it.unit)}</td>
        <td class="num">${money(it.qty)}</td><td class="num">${money(sub)}</td>
        <td class="num">${money(cost)}</td><td class="num">${profitNum(sub - cost)}</td>
        <td class="num">${profitPct(sub - cost, sub)}</td><td>${esc(it.note)}</td></tr>`;
      }).join('');
    }).join('') || `<tr><td colspan="10" class="empty">無明細</td></tr>`;
    const tax = q.tax_flag ? Math.round(total * 0.05) : 0;   // 稅金 (5% 或 0)
    const grand = total + tax;                                // 總計
    const profit = total - costTotal;                         // 利潤 = 小計合計 − 廠商報價合計
    openModal('報價單明細 ' + q.quote_id, `
    <div class="detail-actions">
      <button class="btn ghost" onclick="exportQuoteExcel('${q.quote_id}')">匯出Excel</button>
      <button class="btn" onclick="MODULES.quote.duplicate('${q.quote_id}')">複製報價單</button>
    </div>
    <dl class="dl">
      <dt>報價單編號</dt><dd>${esc(q.quote_id)}</dd>
      <dt>客戶</dt><dd>${esc(q.cust_id)} ${esc(q.cust_name || '')}</dd>
      <dt>專案名稱</dt><dd>${esc(q.proj_name)}</dd>
      <dt>裝修地址</dt><dd>${esc(q.addr)}</dd>
      <dt>報價日期</dt><dd>${fmtDate(q.quote_date)}</dd>
      <dt>有效日期</dt><dd>${fmtDate(q.valid_date)}</dd>
      <dt>系統狀態</dt><dd>${statusBadge(q.status)}</dd>
      <dt>稅金</dt><dd>${q.tax_flag ? '計 5% 稅金 (V)' : '不計稅'}</dd>
      <dt>填表人</dt><dd>${esc(q.created_by_name || q.created_by)}</dd>
      <dt>維護窗口</dt><dd>${esc(q.maintainer_name || q.maintainer)}</dd>
      <dt>備註</dt><dd>${esc(q.note)}</dd>
    </dl>
    <div class="section-title">報價明細 (子表單)</div>
    <div class="subtable-wrap">
    <table class="subtable"><thead><tr><th class="num">NO</th><th>項目</th><th class="num">單價</th><th>單位</th><th class="num">數量</th>
      <th class="num">小計</th><th class="num">廠商報價</th><th class="num">利潤</th><th class="num">%</th><th>備註</th></tr></thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        <tr><th colspan="5" class="right">合計</th><th class="num">${money(total)}</th>
          <th class="num">${money(costTotal)}</th><th class="num">${profitNum(profit)}</th>
          <th class="num">${profitPct(profit, total)}</th><th></th></tr>
        <tr><th colspan="5" class="right">稅額 (${q.tax_flag ? '5%' : '免'})</th><th class="num">${money(tax)}</th><th colspan="4"></th></tr>
        <tr><th colspan="5" class="right">總計</th><th class="num">${money(grand)}</th><th colspan="4"></th></tr>
      </tfoot></table></div>
    <div class="hint" style="margin-top:6px">廠商報價／利潤／% 為內部成本資訊，匯出給客戶的報價單 PDF 不會列印。</div>
      ${q.status !== '進行中' ? `<div class="hint" style="margin-top:10px;color:var(--warn)">此報價單已「${esc(q.status)}」，僅供檢視、無法修改；如需變更請按「複製改版」建立新版本。</div>` : ''}`,
      quoteDetailFoot(q));
  },
  async form(id) {
    const q = id ? await api('/api/quotes/' + id) : { items: [] };
    const [custs, emps] = [await getLookup('customers'), await getLookup('employees')];
    // 依大項分組；舊報價單沒有大項 → 一個未命名大項 (可補上名稱)
    const groups = groupQuoteItems(q.items);
    if (!groups.length) groups.push({ name: '', items: [{}] });
    const dl = (dlId, arr) => `<datalist id="${dlId}">${arr.map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
    const itemsHtml = `<div class="section-title">報價明細</div>
      <div class="q-excel-bar">
        <button type="button" class="btn ghost sm" onclick="pickQuoteExcel()">匯入Excel</button>
        <button type="button" class="btn ghost sm" onclick="downloadQuoteTemplate()">下載範本</button>
        <span class="hint">習慣用 Excel 打報價單：照範本格式填好後匯入，會取代下方目前的明細。</span>
      </div>
      ${dl('qSectionOptions', QUOTE_ITEM_OPTIONS)}${dl('qItemOptions', QUOTE_ITEM_OPTIONS)}${dl('qUnitOptions', QUOTE_UNIT_OPTIONS)}
      <div id="qSections">${groups.map((g, gi) => quoteSectionBlock(g, gi + 1)).join('')}</div>
      <button type="button" class="btn ghost sm" style="margin-top:10px" onclick="addQuoteSection()">＋ 新增大項</button>
      <div class="hint">報價明細依「大項」分組（例：一、木作工程　二、水電工程），每個大項自動計算小計，最後彙總為合計、稅額、總計。<br>
        大項名稱必填（只有一個大項也要填），可自行輸入；項目與單位可從清單選擇，亦可自行輸入。<br>
        各大項的「匯入廠商報價」可讀廠商的 Excel 報價單：項目、單位、數量帶入，廠商單價填到「廠商報價」，售價依加成 % 算出或留空自填。<br>
        口頭報價：直接逐筆填「廠商報價」（該筆總成本，可打算式如 3000*10），再按大項的「依加成算售價」一次算出售價。<br>
        NO 可直接改數字調整該大項內的順序；大項可用 ↑ ↓ 調整先後。數量、單價與廠商報價請填整數。<br>
        廠商報價為該項目的成本，利潤 ＝ 小計 － 廠商報價、% ＝ 利潤 ÷ 小計；此三欄僅供內部參考，客戶報價單 PDF 不會列印。</div>
      <div class="quote-totals">
        <div><span>合計</span><b id="qt_sub">0</b></div>
        <div><span>稅額</span><b id="qt_tax">0</b></div>
        <div class="grand"><span>總計</span><b id="qt_grand">0</b></div>
        <div><span>廠商報價合計</span><b id="qt_cost">0</b></div>
        <div><span>利潤</span><b id="qt_profit">0</b></div>
        <div><span>利潤%</span><b id="qt_pct">—</b></div>
      </div>`;
    const iso = localISO;
    const today = new Date();
    const plus7 = new Date(today.getTime() + 7 * 86400000);
    const taxDefault = (q.tax_flag === undefined ? false : q.tax_flag);
    // 新增時系統狀態固定「進行中」不可修改；修改時才可調整
    const statusField = id
      ? { name: 'status', label: '系統狀態', type: 'select', options: ['進行中', '已確認', '作廢'].map(s => `<option ${q.status === s ? 'selected' : ''}>${s}</option>`).join('') }
      : { name: 'status', label: '系統狀態', type: 'text', value: '進行中', readonly: true, hint: '新增時固定為「進行中」' };
    openForm({
      title: id ? '修改報價單 ' + id : '新增報價單',
      fields: [
        { name: 'cust_id', label: '客戶', type: 'select', options: options(custs, 'cust_id', 'name', q.cust_id) },
        { name: 'proj_name', label: '專案名稱', value: q.proj_name },
        { name: 'addr', label: '裝修地址', full: true, value: q.addr },
        { name: 'quote_date', label: '報價日期', type: 'date', value: fmtDate(q.quote_date) || iso(today), onchange: 'quoteDateChanged(this)' },
        { name: 'valid_date', label: '有效日期', type: 'date', value: fmtDate(q.valid_date) || iso(plus7), hint: '改報價日期會自動帶入 +7 天，仍可手動調整' },
        statusField,
        { name: 'maintainer', label: '維護窗口', type: 'select', options: options(emps, 'emp_id', 'name', q.maintainer || USER.emp_id) },
        { name: 'tax_flag', label: '稅金', type: 'checkbox', checkLabel: '勾選另計 5% 稅金', value: taxDefault, onchange: 'updateQuoteTotals()' },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: q.note },
      ],
      extraHtml: itemsHtml,
      onSubmit: async (v, formEl) => {
        v.items = collectItems(formEl);
        if (id) await api('/api/quotes/' + id, { method: 'PUT', body: v });
        else await api('/api/quotes', { method: 'POST', body: v });
        MODULES.quote.render();
      },
    });
    updateQuoteTotals(); // 初次載入即計算合計/稅金/總計
  },
  remove(id) {
    confirmDelete('確定刪除報價單 ' + id + '？(含明細)', async () => {
      try { await api('/api/quotes/' + id, { method: 'DELETE' }); closeModal(); MODULES.quote.render(); }
      catch (e) { alert(e.message); }
    });
  },
  // 複製報價單：整份複製 (含明細) 成全新單號，接著直接進入編輯畫面
  async duplicate(id) {
    if (!confirm('要複製報價單 ' + id + ' 嗎？\n會以「全新單號」建立一份相同內容 (含明細)，並直接進入編輯。')) return;
    try {
      const r = await api('/api/quotes/' + id + '/duplicate', { method: 'POST' });
      closeModal();
      await MODULES.quote.form(r.quote_id);   // 畫面留在編輯該張新報價單
    } catch (e) { alert(e.message); }
  },
  async revise(id) {
    if (!confirm('要複製報價單 ' + id + ' 為新版本嗎？\n新版本編號會加上 -1／-2…，狀態為「進行中」可再編輯。')) return;
    try {
      const r = await api('/api/quotes/' + id + '/revise', { method: 'POST' });
      closeModal();
      alert('已建立新版本：' + r.quote_id + '，請編輯內容後儲存。');
      await MODULES.quote.form(r.quote_id);
    } catch (e) { alert(e.message); }
  },
  async exportPDF(id) {
    try { const q = await api('/api/quotes/' + id); quotePrint(q); }
    catch (e) { alert(e.message); }
  },
};

// 報價日期改了 → 有效日期自動帶成報價日期 +7 天 (之後仍可手動改；再改報價日期才會重新帶入)
function quoteDateChanged(inp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inp.value || '');
  if (!m) return;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 7);   // 以本機日期計算，避免時區差一天
  const valid = inp.form.querySelector('[name=valid_date]');
  if (valid) valid.value = localISO(d);
}

// 報價單明細視窗底部按鈕 (依系統狀態決定可用動作)
function quoteDetailFoot(q) {
  const id = q.quote_id;
  let btns = `<button class="btn ghost" onclick="closeModal()">關閉</button>`;
  if (q.status === '進行中') {
    btns += `<button class="btn" onclick="MODULES.quote.form('${id}')">修改</button>
             <button class="btn danger" onclick="MODULES.quote.remove('${id}')">刪除</button>`;
  } else if (q.status === '已確認') {
    btns += `<button class="btn ghost" onclick="MODULES.quote.revise('${id}')">複製改版</button>
             <button class="btn" onclick="MODULES.quote.exportPDF('${id}')">匯出PDF</button>`;
  } else { // 作廢
    btns += `<button class="btn ghost" onclick="MODULES.quote.revise('${id}')">複製改版</button>`;
  }
  return btns;
}

// 匯出報價單 PDF (以列印方式，換頁時整列不切斷、表頭每頁重複)
function quotePrint(q) {
  // 依大項分組：大項標題列「一、木作工程」＋小計，下方細項 1,2,3…；舊報價單沒有大項則照原本列印
  const groups = groupQuoteItems(q.items);
  const sectioned = groups.some(g => g.name);
  let total = 0;
  const rows = groups.map((g, gi) => {
    total += g.sub;
    const head = sectioned ? `<tr class="sec"><td class="c">${cnNum(gi + 1)}</td><td colspan="4">${esc(g.name) || '（未命名大項）'}</td>
      <td class="r">${money(g.sub)}</td><td></td></tr>` : '';
    return head + g.items.map((it, i) => `<tr><td class="c">${i + 1}</td><td>${esc(it.item)}</td><td class="r">${money(it.unit_price)}</td>
      <td class="c">${esc(it.unit)}</td><td class="r">${money(it.qty)}</td>
      <td class="r">${money(Number(it.subtotal) || 0)}</td><td>${esc(it.note)}</td></tr>`).join('');
  }).join('') || `<tr><td colspan="7" style="text-align:center">無明細</td></tr>`;
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">
    <title>報價單_${esc(q.quote_id)}</title><style>
    *{font-family:"Microsoft JhengHei","Segoe UI",sans-serif;box-sizing:border-box;}
    body{margin:0;color:#222;}
    .wrap{padding:24px;}
    .head{display:flex;align-items:center;gap:14px;border-bottom:3px solid #98c810;padding-bottom:12px;margin-bottom:16px;}
    .head img{width:60px;height:60px;border-radius:50%;border:1px solid #ccc;}
    .head h1{margin:0;font-size:22px;}
    .head .sub{color:#666;font-size:13px;margin-top:2px;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin-bottom:16px;font-size:14px;}
    .meta span{color:#777;display:inline-block;width:76px;}
    table{border-collapse:collapse;width:100%;font-size:13px;}
    th,td{border:1px solid #bbb;padding:7px 9px;}
    thead th{background:#eef6d8;}
    td.r{text-align:right;}td.c{text-align:center;}
    tfoot th{text-align:right;background:#f7fbe9;font-size:14px;}
    tr.sec td{background:#f3f8e6;font-weight:700;}
    .foot{margin-top:16px;font-size:12px;color:#555;display:flex;justify-content:space-between;}
    @page{margin:16mm;}
    @media print{
      thead{display:table-header-group;}   /* 表頭每頁重複 */
      tfoot{display:table-row-group;}
      tr{page-break-inside:avoid;}          /* 換頁時整列不切斷 */
    }
    </style></head>
    <body onload="setTimeout(function(){window.focus();window.print();},250)">
    <div class="wrap">
      <div class="head"><img src="/img/logo.png" alt="logo">
        <div><h1>報價單 QUOTATION</h1><div class="sub">單號：${esc(q.quote_id)}</div></div></div>
      <div class="meta">
        <div><span>客戶</span>${esc(q.cust_name || '')} ${q.cust_id ? '(' + esc(q.cust_id) + ')' : ''}</div>
        <div><span>專案名稱</span>${esc(q.proj_name || '')}</div>
        <div><span>報價日期</span>${fmtDate(q.quote_date)}</div>
        <div><span>有效日期</span>${fmtDate(q.valid_date)}</div>
        <div style="grid-column:1/-1"><span>裝修地址</span>${esc(q.addr || '')}</div>
      </div>
      <table>
        <thead><tr><th style="width:38px">NO</th><th>項目</th><th>單價</th><th>單位</th><th>數量</th><th>小計</th><th>備註</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><th colspan="5" style="text-align:right">合計</th><th style="text-align:right">${money(total)}</th><th></th></tr>
          <tr><th colspan="5" style="text-align:right">稅額 (${q.tax_flag ? '5%' : '免'})</th><th style="text-align:right">${money(q.tax_flag ? Math.round(total * 0.05) : 0)}</th><th></th></tr>
          <tr><th colspan="5" style="text-align:right">總計</th><th style="text-align:right">${money(total + (q.tax_flag ? Math.round(total * 0.05) : 0))}</th><th></th></tr>
        </tfoot>
      </table>
      <div class="foot"><span>填表人：${esc(q.created_by_name || q.created_by || '')}</span>
        <span>列印日期：${new Date().toLocaleDateString('zh-TW')}</span></div>
    </div></body></html>`;
  printHtml(html);
}

// 以隱藏 iframe 列印 (瀏覽器列印視窗可選「另存為 PDF」)
function printHtml(html) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  iframe.contentWindow.onafterprint = () => iframe.remove();
  setTimeout(() => { if (document.body.contains(iframe)) iframe.remove(); }, 60000);
}

// 請款單 PDF (應收款項)：表頭「請款單」、表尾「請款人」
function receivablePrint(r) {
  const amount = Number(r.amount) || 0;
  const tax = Number(r.tax) || 0;
  const discount = Number(r.discount) || 0;
  const total = amount + tax - discount;                      // 應收合計
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">
    <title>請款單_${esc(r.ar_id)}</title><style>
    *{font-family:"Microsoft JhengHei","Segoe UI",sans-serif;box-sizing:border-box;}
    body{margin:0;color:#222;}
    .wrap{padding:24px;}
    .head{display:flex;align-items:center;gap:14px;border-bottom:3px solid #98c810;padding-bottom:12px;margin-bottom:16px;}
    .head img{width:60px;height:60px;border-radius:50%;border:1px solid #ccc;}
    .head h1{margin:0;font-size:22px;letter-spacing:4px;}
    .head .sub{color:#666;font-size:13px;margin-top:2px;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin-bottom:16px;font-size:14px;}
    .meta span{color:#777;display:inline-block;width:76px;}
    table{border-collapse:collapse;width:100%;font-size:14px;}
    th,td{border:1px solid #bbb;padding:9px 10px;}
    thead th{background:#eef6d8;}
    td.r{text-align:right;}
    .note{margin-top:14px;font-size:13px;border:1px solid #bbb;padding:10px;min-height:56px;}
    .note b{color:#777;font-weight:600;}
    .sign{margin-top:28px;display:flex;justify-content:space-between;align-items:flex-end;font-size:14px;}
    .sign .line{border-bottom:1px solid #333;display:inline-block;width:190px;height:22px;}
    .foot{margin-top:22px;font-size:12px;color:#555;display:flex;justify-content:space-between;}
    @page{margin:16mm;}
    </style></head>
    <body onload="setTimeout(function(){window.focus();window.print();},250)">
    <div class="wrap">
      <div class="head"><img src="/img/logo.png" alt="logo">
        <div><h1>請款單</h1><div class="sub">單號：${esc(r.ar_id)}</div></div></div>
      <div class="meta">
        <div><span>客戶</span>${esc(r.cust_name || '')} ${r.cust_id ? '(' + esc(r.cust_id) + ')' : ''}</div>
        <div><span>公司</span>${esc(r.cust_company || '')}</div>
        <div><span>專案</span>${esc(r.proj_id || '')} ${esc(r.proj_name || '')}</div>
        <div><span>報價單號</span>${esc(r.quote_id || '')}</div>
        <div><span>項目</span>${esc(r.item || '')}${r.is_retention ? '（保留款）' : ''}</div>
        <div><span>應收日期</span>${fmtDate(r.due_date) || ''}</div>
        <div><span>發票號碼</span>${esc(r.invoice_no || '')}${r.invoice_void ? '（作廢）' : ''}</div>
        <div><span>發票日期</span>${fmtDate(r.invoice_date) || ''}</div>
        <div><span>收款方式</span>${esc(r.receive_method || '')}</div>
        <div><span>收款日期</span>${fmtDate(r.received_date) || ''}</div>
      </div>
      <table>
        <thead><tr><th>應收金額</th><th>5%稅額</th><th>折讓</th><th>應收合計</th></tr></thead>
        <tbody><tr>
          <td class="r">${money(amount)}</td><td class="r">${money(tax)}</td>
          <td class="r">${money(discount)}</td><td class="r"><b>${money(total)}</b></td>
        </tr></tbody>
      </table>
      <div class="note"><b>備註：</b>${esc(r.note || '')}</div>
      <div class="sign">
        <div>請款人：<span class="line"></span></div>
        <div>日期：<span class="line" style="width:150px"></span></div>
      </div>
      <div class="foot"><span>填表人：${esc(r.created_by_name || r.created_by || '')}</span>
        <span>列印日期：${new Date().toLocaleDateString('zh-TW')}</span></div>
    </div></body></html>`;
  printHtml(html);
}

// 付款憑証 PDF (應付款項)：表頭「付款憑証」、表尾「簽收人」
function payablePrint(p) {
  const amount = Number(p.amount) || 0;
  const taxDeduct = Number(p.tax_deduct) || 0;
  const discount = Number(p.discount) || 0;
  const paid = (p.paid_amount === null || p.paid_amount === undefined || p.paid_amount === '')
    ? amount - discount : Number(p.paid_amount);
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">
    <title>付款憑証_${esc(p.ap_id)}</title><style>
    *{font-family:"Microsoft JhengHei","Segoe UI",sans-serif;box-sizing:border-box;}
    body{margin:0;color:#222;}
    .wrap{padding:24px;}
    .head{display:flex;align-items:center;gap:14px;border-bottom:3px solid #98c810;padding-bottom:12px;margin-bottom:16px;}
    .head img{width:60px;height:60px;border-radius:50%;border:1px solid #ccc;}
    .head h1{margin:0;font-size:22px;letter-spacing:4px;}
    .head .sub{color:#666;font-size:13px;margin-top:2px;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin-bottom:16px;font-size:14px;}
    .meta span{color:#777;display:inline-block;width:76px;}
    table{border-collapse:collapse;width:100%;font-size:14px;}
    th,td{border:1px solid #bbb;padding:9px 10px;}
    thead th{background:#eef6d8;}
    td.r{text-align:right;}
    tfoot th{text-align:right;background:#f7fbe9;font-size:15px;}
    .note{margin-top:14px;font-size:13px;border:1px solid #bbb;padding:10px;min-height:56px;}
    .note b{color:#777;font-weight:600;}
    .sign{margin-top:28px;display:flex;justify-content:space-between;align-items:flex-end;font-size:14px;}
    .sign .line{border-bottom:1px solid #333;display:inline-block;width:190px;height:22px;}
    .foot{margin-top:22px;font-size:12px;color:#555;display:flex;justify-content:space-between;}
    @page{margin:16mm;}
    </style></head>
    <body onload="setTimeout(function(){window.focus();window.print();},250)">
    <div class="wrap">
      <div class="head"><img src="/img/logo.png" alt="logo">
        <div><h1>付款憑証</h1><div class="sub">單號：${esc(p.ap_id)}</div></div></div>
      <div class="meta">
        <div><span>廠商</span>${esc(p.vend_name || '')} ${p.vend_id ? '(' + esc(p.vend_id) + ')' : ''}</div>
        <div><span>統一編號</span>${esc(p.vend_tax_id || '')}</div>
        <div><span>專案</span>${esc(p.proj_id || '')} ${esc(p.proj_name || '')}</div>
        <div><span>項目</span>${esc(p.item || p.expense_category || '')}</div>
        <div><span>憑證類別</span>${esc(p.doc_type || '')}</div>
        <div><span>發票號碼</span>${esc(p.invoice_no || '')}${p.invoice_void ? '（作廢）' : ''}</div>
        <div><span>發票日期</span>${fmtDate(p.invoice_date) || ''}</div>
        <div><span>付款日期</span>${fmtDate(p.paid_date) || ''}</div>
        <div><span>付款方式</span>${esc(p.pay_method || '')}${p.check_no ? '（票號 ' + esc(p.check_no) + (p.check_due ? '，到期 ' + fmtDate(p.check_due) : '') + '）' : ''}</div>
      </div>
      <table>
        <thead><tr><th>應付金額</th><th>抵扣稅額</th><th>折讓</th><th>實付金額</th></tr></thead>
        <tbody><tr>
          <td class="r">${money(amount)}</td><td class="r">${money(taxDeduct)}</td>
          <td class="r">${money(discount)}</td><td class="r"><b>${money(paid)}</b></td>
        </tr></tbody>
      </table>
      <div class="note"><b>備註：</b>${esc(p.note || '')}</div>
      <div class="sign">
        <div>簽收人：<span class="line"></span></div>
        <div>日期：<span class="line" style="width:150px"></span></div>
      </div>
      <div class="foot"><span>填表人：${esc(p.created_by_name || p.created_by || '')}</span>
        <span>列印日期：${new Date().toLocaleDateString('zh-TW')}</span></div>
    </div></body></html>`;
  printHtml(html);
}

// 報價明細下拉選項 (可自行輸入)
const QUOTE_ITEM_OPTIONS = ['丈量費', '設計圖費用', '工程管理費用', '拆除工程', '清潔工程',
  '保護工程', '窗簾工程', '冷氣工程', '地板工程', '木作工程', '輕隔間工程', '壁紙工程',
  '油漆工程', '門窗工程', '鐵件工程'];
const QUOTE_UNIT_OPTIONS = ['式', '組', '個', '坪', '平方公尺', '條', '支', '片', '才'];

// 利潤數字 (負數紅字)；利潤% = 利潤 ÷ 小計，小計為 0 時顯示「—」
function profitNum(v) { return `<span class="${Number(v) < 0 ? 'neg-num' : ''}">${money(v)}</span>`; }
function profitPct(profit, sub) {
  if (!Number(sub)) return '—';
  const p = Math.round(profit / Number(sub) * 1000) / 10;
  return `<span class="${p < 0 ? 'neg-num' : ''}">${p.toFixed(1)}%</span>`;
}

// 明細依大項分組 (連續相同 section 為一組)，並算出各組小計與成本
function groupQuoteItems(items) {
  const groups = [];
  for (const it of items || []) {
    const name = String(it.section || '').trim();
    let g = groups[groups.length - 1];
    if (!g || g.name !== name) { g = { name, items: [], sub: 0, cost: 0 }; groups.push(g); }
    g.items.push(it);
    g.sub += Number(it.subtotal) || 0;
    g.cost += Number(it.vendor_price) || 0;
  }
  return groups;
}
// 大項編號：一、二、…、十、十一…九十九
function cnNum(n) {
  const d = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return d[n];
  if (n < 20) return '十' + d[n % 10];
  return d[Math.floor(n / 10)] + '十' + d[n % 10];
}

// 編輯畫面：一個大項區塊 (標題列＋細項表＋新增明細)
function quoteSectionBlock(g = { name: '', items: [{}] }, no = 1) {
  const items = g.items && g.items.length ? g.items : [{}];
  return `<div class="q-section">
    <div class="q-sec-head">
      <b class="q-sec-no">${cnNum(no)}、</b>
      <input name="s_name" list="qSectionOptions" value="${esc(g.name)}" placeholder="大項名稱，例：木作工程" class="q-sec-name">
      <span class="q-sec-sum">小計 <b class="q-sec-sub">0</b></span>
      <span class="q-sec-btns">
        <button type="button" class="btn ghost sm" onclick="applyMarkup(this)">依加成算售價</button>
        <button type="button" class="btn ghost sm" onclick="pickVendorQuote(this)">匯入廠商報價</button>
        <button type="button" class="btn ghost sm" title="上移" onclick="moveQuoteSection(this, -1)">↑</button>
        <button type="button" class="btn ghost sm" title="下移" onclick="moveQuoteSection(this, 1)">↓</button>
        <button type="button" class="btn danger sm" onclick="removeQuoteSection(this)">刪除大項</button>
      </span>
    </div>
    <div class="subtable-wrap">
    <table class="subtable"><thead><tr><th>NO</th><th>項目</th><th>單價</th><th>單位</th><th>數量</th>
      <th>小計</th><th>廠商報價</th><th>利潤</th><th>%</th><th>備註</th><th></th></tr></thead>
    <tbody class="q-items">${items.map((it, i) => itemRowInputs(it, i + 1)).join('')}</tbody></table></div>
    <button type="button" class="btn ghost sm" style="margin-top:6px" onclick="addItemRow(this)">＋ 新增明細</button>
  </div>`;
}
function addQuoteSection() {
  const box = document.getElementById('qSections');
  box.insertAdjacentHTML('beforeend', quoteSectionBlock({ name: '', items: [{}] }, box.children.length + 1));
  renumberSections();
  updateQuoteTotals();
  box.lastElementChild.querySelector('[name=s_name]').focus();
}
function removeQuoteSection(btn) {
  const sec = btn.closest('.q-section');
  if (document.querySelectorAll('#qSections .q-section').length <= 1) { alert('至少要保留一個大項。'); return; }
  const filled = Array.from(sec.querySelectorAll('.q-items tr'))
    .some(tr => rowAmounts(tr).sub || tr.querySelector('[name=i_item]').value);
  const name = sec.querySelector('[name=s_name]').value || '這個大項';
  if (filled && !confirm(`確定刪除「${name}」及其所有明細？`)) return;
  sec.remove();
  renumberSections();
  updateQuoteTotals();
}
function moveQuoteSection(btn, dir) {
  const sec = btn.closest('.q-section');
  const other = dir < 0 ? sec.previousElementSibling : sec.nextElementSibling;
  if (!other) return;
  if (dir < 0) other.before(sec); else other.after(sec);
  renumberSections();
}
function renumberSections() {
  document.querySelectorAll('#qSections .q-section').forEach((sec, i) => {
    sec.querySelector('.q-sec-no').textContent = cnNum(i + 1) + '、';
  });
}

function itemRowInputs(it = {}, no = 0) {
  const sub = (it.unit_price && it.qty) ? Math.round(it.unit_price) * Math.round(it.qty) : (Number(it.subtotal) || 0);
  const cost = Math.round(Number(it.vendor_price)) || 0;
  const hasRow = it.unit_price || it.qty || it.subtotal;
  return `<tr>
    <td><input name="i_no" type="number" step="1" min="1" value="${no || it.seq_no || ''}" style="width:52px" class="right" onchange="reorderItems(this)"></td>
    <td><input name="i_item" list="qItemOptions" value="${esc(it.item)}" placeholder="選擇或輸入" style="width:130px"></td>
    <td><input name="i_price" type="number" step="1" min="0" value="${esc(it.unit_price ? Math.round(it.unit_price) : it.unit_price)}" style="width:80px" oninput="calcRow(this)"></td>
    <td><input name="i_unit" list="qUnitOptions" value="${esc(it.unit)}" placeholder="選擇或輸入" style="width:64px"></td>
    <td><input name="i_qty" type="number" step="1" min="0" value="${esc(it.qty ? Math.round(it.qty) : it.qty)}" style="width:64px" oninput="calcRow(this)"></td>
    <td><input name="i_sub" value="${hasRow ? money(sub) : ''}" style="width:84px" class="right" readonly></td>
    <td><input name="i_cost" type="text" inputmode="decimal" value="${it.vendor_price !== undefined && it.vendor_price !== null ? cost : ''}" style="width:84px" class="right"
      title="該筆總成本，可直接打算式，例如 3000*10" oninput="calcRow(this)" onchange="evalCostInput(this)"></td>
    <td><input name="i_profit" value="${hasRow ? money(sub - cost) : ''}" style="width:84px" class="right ${sub - cost < 0 ? 'neg-num' : ''}" readonly></td>
    <td><input name="i_pct" value="${sub ? (Math.round((sub - cost) / sub * 1000) / 10).toFixed(1) + '%' : ''}" style="width:60px" class="right ${sub - cost < 0 ? 'neg-num' : ''}" readonly></td>
    <td><input name="i_note" value="${esc(it.note)}" style="width:90px"></td>
    <td><button type="button" class="btn danger sm" onclick="removeItemRow(this)">刪</button></td></tr>`;
}
function removeItemRow(btn) {
  const body = btn.closest('tbody');
  btn.closest('tr').remove();
  renumberItems(body);
  updateQuoteTotals();
}
// 在按鈕所屬的大項新增一列明細 (未指定則加到第一個大項)
function addItemRow(btn) {
  const body = btn ? btn.closest('.q-section').querySelector('.q-items') : document.querySelector('#qSections .q-items');
  body.insertAdjacentHTML('beforeend', itemRowInputs({}, body.querySelectorAll('tr').length + 1));
  updateQuoteTotals();
}
// NO 欄重新編號 1,2,3… (每個大項各自從 1 開始；未指定大項則全部重編)
function renumberItems(body) {
  const bodies = body ? [body] : document.querySelectorAll('#qSections .q-items');
  bodies.forEach(b => b.querySelectorAll('tr').forEach((tr, i) => {
    tr.querySelector('[name=i_no]').value = i + 1;
  }));
}
// 使用者改了某列的 NO：在同一大項內依 NO 遞增重新排列，改動的那一列往前移插到該位置之前、往後移插到之後，再重新編號
function reorderItems(inp) {
  const body = inp.closest('tbody');
  const moved = inp.closest('tr');
  const rows = Array.from(body.querySelectorAll('tr'));
  const keyed = rows.map((tr, i) => {
    const v = Number(tr.querySelector('[name=i_no]').value);
    const key = Number.isFinite(v) && v > 0 ? v : i + 1;
    if (tr !== moved) return { tr, key, i };
    return { tr, key: key > i + 1 ? key + 0.5 : key - 0.5, i };   // i + 1 為該列原本的 NO
  });
  keyed.sort((a, b) => a.key - b.key || a.i - b.i);
  keyed.forEach(k => body.appendChild(k.tr));
  renumberItems(body);
}
// 廠商報價欄可以打算式 (例 3000*10、2,500*4+800)：只允許數字與 + - * / ( ) .，算出整數
// 回傳 null=空白、NaN=格式不對、否則為整數
function evalCostExpr(v) {
  const s = String(v ?? '').replace(/[,\s，]/g, '');
  if (s === '') return null;
  if (!/^[\d+\-*\/().]+$/.test(s)) return NaN;
  try {
    const n = Function('"use strict"; return (' + s + ')')();
    return Number.isFinite(n) ? Math.round(n) : NaN;
  } catch { return NaN; }
}
const costValue = (v) => { const n = evalCostExpr(v); return (n === null || Number.isNaN(n)) ? 0 : n; };
function evalCostInput(inp) {
  const n = evalCostExpr(inp.value);
  if (n === null) inp.value = '';
  else if (Number.isNaN(n)) { alert('廠商報價請輸入數字或算式（例如 3000*10）。'); inp.focus(); return; }
  else inp.value = n;
  calcRow(inp);
}
// 大項「依加成算售價」：已填數量與廠商報價的每一筆，售價 = 廠商報價 ÷ 數量 × (1 + 加成%)
function applyMarkup(btn) {
  const sec = btn.closest('.q-section');
  const rows = Array.from(sec.querySelectorAll('.q-items tr'));
  const ready = rows.filter(tr => costValue(tr.querySelector('[name=i_cost]').value) > 0
    && Number(tr.querySelector('[name=i_qty]').value) > 0);
  if (!ready.length) { alert('請先填好各筆的「數量」與「廠商報價」，再依加成算售價。'); return; }
  const ans = prompt(`這個大項有 ${ready.length} 筆已填數量與廠商報價。\n售價加成 %（例如 20 ＝ 成本 × 1.2）：`, '20');
  if (ans === null) return;
  const pct = Number(ans);
  if (!Number.isFinite(pct)) { alert('加成請填數字，例如 20。'); return; }
  ready.forEach(tr => {
    const cost = costValue(tr.querySelector('[name=i_cost]').value);
    const qty = Number(tr.querySelector('[name=i_qty]').value);
    const price = tr.querySelector('[name=i_price]');
    price.value = Math.round(cost / qty * (1 + pct / 100));
    calcRow(price);
  });
  const skipped = rows.length - ready.length;
  alert(`已依加成 ${pct}% 算出 ${ready.length} 筆售價` + (skipped ? `，另有 ${skipped} 筆缺數量或廠商報價未處理` : '') + '，可再逐筆修改。');
}
// 讀取一列的 小計 / 廠商報價 / 利潤
function rowAmounts(tr) {
  const price = Math.round(Number(tr.querySelector('[name=i_price]').value)) || 0;
  const qty = Math.round(Number(tr.querySelector('[name=i_qty]').value)) || 0;
  const cost = costValue(tr.querySelector('[name=i_cost]').value);
  const sub = price * qty;
  return { sub, cost, profit: sub - cost };
}
function calcRow(inp) {
  const tr = inp.closest('tr');
  const { sub, profit } = rowAmounts(tr);
  tr.querySelector('[name=i_sub]').value = money(sub);          // 小計顯示千分位
  const pf = tr.querySelector('[name=i_profit]'), pc = tr.querySelector('[name=i_pct]');
  pf.value = money(profit);                                     // 利潤 = 小計 − 廠商報價
  pc.value = sub ? (Math.round(profit / sub * 1000) / 10).toFixed(1) + '%' : '';
  pf.classList.toggle('neg-num', profit < 0);                   // 負值紅字
  pc.classList.toggle('neg-num', profit < 0);
  updateQuoteTotals();
}
// 計算各大項小計，以及報價單 合計 / 稅額(5%或0) / 總計 / 成本 / 利潤，並更新畫面
function updateQuoteTotals() {
  const f = document.getElementById('modalForm');
  if (!f || !document.getElementById('qt_sub')) return;
  let sub = 0, cost = 0;
  f.querySelectorAll('#qSections .q-section').forEach(sec => {
    let secSub = 0;
    sec.querySelectorAll('.q-items tr').forEach(tr => {
      const a = rowAmounts(tr);
      secSub += a.sub; cost += a.cost;
    });
    sec.querySelector('.q-sec-sub').textContent = money(secSub);
    sub += secSub;
  });
  const cb = f.querySelector('[name=tax_flag]');
  const taxOn = cb ? cb.checked : true;
  const tax = taxOn ? Math.round(sub * 0.05) : 0;
  const profit = sub - cost;
  document.getElementById('qt_sub').textContent = money(sub);
  document.getElementById('qt_tax').textContent = money(tax);
  document.getElementById('qt_grand').textContent = money(sub + tax);
  document.getElementById('qt_cost').textContent = money(cost);
  document.getElementById('qt_profit').innerHTML = profitNum(profit);
  document.getElementById('qt_pct').innerHTML = profitPct(profit, sub);
}
// 依畫面上大項的先後收集明細：seq_no 為整張報價單的流水順序，section 為大項名稱
// 有明細的大項都必須有名稱 (只有一個大項也要填)
function collectItems(formEl) {
  const out = [];
  const used = [];
  formEl.querySelectorAll('#qSections .q-section').forEach(sec => {
    const section = sec.querySelector('[name=s_name]').value.trim();
    let count = 0;
    sec.querySelectorAll('.q-items tr').forEach(tr => {
      const price = tr.querySelector('[name=i_price]').value;
      const qty = tr.querySelector('[name=i_qty]').value;
      const cost = tr.querySelector('[name=i_cost]').value;
      const it = {
        section,
        item: tr.querySelector('[name=i_item]').value,
        unit_price: price === '' ? '' : Math.round(Number(price)), // 單價為整數
        unit: tr.querySelector('[name=i_unit]').value,
        qty: qty === '' ? '' : Math.round(Number(qty)),            // 數量為整數
        vendor_price: costValue(cost),                             // 廠商報價為整數 (可打算式，存檔前算出)
        note: tr.querySelector('[name=i_note]').value,
      };
      if (!(it.item || it.unit_price || it.qty)) return;           // 空白列略過
      if (Number.isNaN(evalCostExpr(cost))) throw new Error(`「${it.item || '第 ' + (count + 1) + ' 筆'}」的廠商報價格式不對，請輸入數字或算式（例如 3000*10）。`);
      it.seq_no = out.length + 1;
      out.push(it);
      count++;
    });
    if (count) used.push(section);
  });
  if (used.some(n => !n)) throw new Error('每個大項都要填寫名稱（例：木作工程）。');
  return out;
}

/* ── 報價單 Excel 匯入／匯出 (SheetJS，放在 /vendor，用到時才載入) ──
   格式：大項 | 項目 | 單價 | 單位 | 數量 | 小計 | 廠商報價 | 備註
   「大項」欄有填 → 開始一個新大項；之後「大項」留空的列都歸到這個大項。
   合計 / 稅額 / 總計 列與「小計」欄匯入時略過，金額由系統重新計算。 */
const QUOTE_XLSX_HEAD = ['大項', '項目', '單價', '單位', '數量', '小計', '廠商報價', '備註'];
let xlsxLoading = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLoading) {
    xlsxLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => { xlsxLoading = null; reject(new Error('Excel 元件載入失敗，請重新整理頁面後再試。')); };
      document.head.appendChild(s);
    });
  }
  return xlsxLoading;
}
const xlsNum = (v) => (v === null || v === undefined || v === '') ? null : Math.round(Number(v)) || 0;

// 工作表欄寬與金額千分位格式
function styleQuoteSheet(X, ws) {
  ws['!cols'] = [{ wch: 14 }, { wch: 26 }, { wch: 11 }, { wch: 7 }, { wch: 8 }, { wch: 13 }, { wch: 11 }, { wch: 22 }];
  const range = X.utils.decode_range(ws['!ref']);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (const c of [2, 4, 5, 6]) {                       // 單價、數量、小計、廠商報價
      const cell = ws[X.utils.encode_cell({ r, c })];
      if (cell && (cell.t === 'n' || cell.f)) cell.z = '#,##0';
    }
  }
}

// 匯出：報價單資訊 → 表頭 → 各大項 (大項列含小計) 與明細 → 合計 / 稅額 / 總計
async function exportQuoteExcel(id) {
  try {
    const [X, q] = await Promise.all([loadXLSX(), api('/api/quotes/' + id)]);
    const groups = groupQuoteItems(q.items);
    const aoa = [
      ['報價單號', q.quote_id],
      ['客戶', q.cust_name || ''],
      ['專案名稱', q.proj_name || ''],
      ['裝修地址', q.addr || ''],
      ['報價日期', fmtDate(q.quote_date)],
      ['有效日期', fmtDate(q.valid_date)],
      [],
      QUOTE_XLSX_HEAD,
    ];
    let total = 0;
    groups.forEach((g) => {
      total += g.sub;
      aoa.push([g.name || '（未命名大項）', '', null, '', null, g.sub, null, '']);
      g.items.forEach(it => aoa.push(['', it.item || '', xlsNum(it.unit_price), it.unit || '', xlsNum(it.qty),
        xlsNum(it.subtotal), xlsNum(it.vendor_price), it.note || '']));
    });
    const tax = q.tax_flag ? Math.round(total * 0.05) : 0;
    aoa.push([], ['', '合計', null, '', null, total],
      ['', `稅額 (${q.tax_flag ? '5%' : '免'})`, null, '', null, tax],
      ['', '總計', null, '', null, total + tax]);
    const ws = X.utils.aoa_to_sheet(aoa);
    styleQuoteSheet(X, ws);
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, '報價單');
    X.writeFile(wb, `報價單_${q.quote_id}.xlsx`);
  } catch (e) { alert(e.message); }
}

// 範本：兩個大項的範例，小計欄為公式 (單價 × 數量)，另附「說明」工作表
async function downloadQuoteTemplate() {
  try {
    const X = await loadXLSX();
    const rows = [
      QUOTE_XLSX_HEAD,
      ['木作工程'],
      ['', '天花板', 3000, '坪', 10, null, 20000, ''],
      ['', '系統櫃', 12000, '式', 1, null, 8000, ''],
      ['水電工程'],
      ['', '配電', 500, '組', 6, null, 1800, ''],
    ];
    const ws = X.utils.aoa_to_sheet(rows);
    [3, 4, 6].forEach(r => { ws['F' + r] = { t: 'n', f: `C${r}*E${r}` }; });
    styleQuoteSheet(X, ws);
    const help = X.utils.aoa_to_sheet([
      ['報價明細 Excel 匯入說明'],
      [],
      ['1. 第一列為欄位名稱，請勿修改：大項、項目、單價、單位、數量、小計、廠商報價、備註'],
      ['2. 在「大項」欄填名稱 (例：木作工程) 就開始一個新大項，該列其他欄位可留空'],
      ['3. 之後「大項」欄留空的列，都歸在上一個大項底下'],
      ['4. 單價、數量、廠商報價請填數字；小計由系統自動計算 (此欄可留空或用公式)'],
      ['5. 合計、稅額、總計列匯入時會自動略過'],
      ['6. 系統「匯出Excel」的檔案修改後也可以直接匯入'],
      ['7. 廠商報價為內部成本，不會列印在給客戶的報價單 PDF'],
    ]);
    help['!cols'] = [{ wch: 80 }];
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, '報價明細');
    X.utils.book_append_sheet(wb, help, '說明');
    X.writeFile(wb, '報價明細匯入範本.xlsx');
  } catch (e) { alert(e.message); }
}

// 讀取 Excel 檔轉成大項分組 [{ name, items: [...] }]
async function readQuoteExcel(file) {
  const X = await loadXLSX();
  const wb = X.read(await file.arrayBuffer());
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = X.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  // 欄位名稱可用同義詞 (廠商的 Excel 常寫 品名/工項、金額/總價…)，依序取第一個找到的
  const SYN = {
    sec: ['大項'],
    item: ['項目', '品名', '品項', '工項', '工程項目', '名稱', '內容'],
    price: ['單價', '價格', '價錢', '報價'],
    unit: ['單位'],
    qty: ['數量', '數', '量'],
    amount: ['小計', '金額', '總價', '複價'],
    cost: ['廠商報價', '成本'],
    note: ['備註', '說明'],
  };
  const norm = (c) => String(c ?? '').replace(/\s/g, '');
  const findCol = (head, names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  // 表頭列：有「項目」且有「單價」或「金額」的第一列 (前面可以有報價單資訊)
  const hi = rows.findIndex(r => { const h = r.map(norm); return findCol(h, SYN.item) >= 0 && (findCol(h, SYN.price) >= 0 || findCol(h, SYN.amount) >= 0); });
  if (hi < 0) throw new Error('找不到欄位名稱列（需要有「項目」，以及「單價」或「金額」）。請先下載範本對照格式。');
  const head = rows[hi].map(norm);
  const C = {};
  for (const k of Object.keys(SYN)) C[k] = findCol(head, SYN[k]);
  const text = (r, k) => (C[k] >= 0 ? String(r[C[k]] ?? '').trim() : '');
  const toNum = (r, k) => {
    const v = C[k] >= 0 ? r[C[k]] : '';
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(String(v).replace(/[,\s元$]|NT/g, ''));
    return Number.isFinite(n) ? Math.round(n) : '';
  };
  const stripNo = (s) => s.replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, '');   // 「一、木作工程」→「木作工程」

  const groups = [];
  let cur = null;
  for (const r of rows.slice(hi + 1)) {
    const item = text(r, 'item');
    let price = toNum(r, 'price'), qty = toNum(r, 'qty');
    const cost = toNum(r, 'cost');
    const blank = price === '' && qty === '';     // 沒填單價也沒填數量 (大項標題列、空白列的判斷依據；小計欄不算)
    if (/^(合計|小計|稅額|稅金|營業稅|總計)/.test(item)) continue;            // 彙總列略過
    let sec = stripNo(text(r, 'sec'));
    // 沒有「大項」欄的自製表格：只有文字、沒有單價與數量的列視為大項標題
    if (C.sec < 0 && item && blank) sec = stripNo(item);
    if (sec) {
      cur = { name: sec === '（未命名大項）' ? '' : sec, items: [] };
      groups.push(cur);
      if (C.sec < 0 || (!item && blank)) continue;                             // 純大項列 (系統匯出的大項列只有小計，也算)
    }
    if (!item && blank) continue;                                              // 空白列
    if (price === '' && C.amount >= 0) {          // 只有金額沒有單價：單價 = 金額 ÷ 數量 (沒填數量就當 1)
      const amt = toNum(r, 'amount');
      if (amt !== '') { if (!qty) qty = 1; price = Math.round(amt / qty); }
    }
    if (!cur) { cur = { name: '', items: [] }; groups.push(cur); }
    cur.items.push({
      item, unit_price: price, unit: text(r, 'unit'), qty,
      subtotal: (Number(price) || 0) * (Number(qty) || 0),
      vendor_price: cost === '' ? null : cost, note: text(r, 'note'),
    });
  }
  const filled = groups.filter(g => g.items.length);
  if (!filled.length) throw new Error('Excel 裡沒有可匯入的明細。');
  return filled;
}

// 把讀到的大項與明細放進編輯畫面 (取代目前的明細)
function applyQuoteGroups(groups) {
  const box = document.getElementById('qSections');
  box.innerHTML = groups.map((g, gi) => quoteSectionBlock(g, gi + 1)).join('');
  renumberSections();
  updateQuoteTotals();
}
// 編輯畫面「匯入Excel」：選檔 → 讀取 → 確認後取代目前明細
function pickQuoteExcel() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  input.onchange = async () => {
    if (!input.files.length) return;
    try {
      const groups = await readQuoteExcel(input.files[0]);
      const count = groups.reduce((t, g) => t + g.items.length, 0);
      const hasData = Array.from(document.querySelectorAll('#qSections .q-items tr'))
        .some(tr => rowAmounts(tr).sub || tr.querySelector('[name=i_item]').value);
      const summary = `讀到 ${groups.length} 個大項、${count} 筆明細。`;
      if (hasData && !confirm(summary + '\n匯入會取代目前畫面上的明細，確定匯入？')) return;
      applyQuoteGroups(groups);
      const noName = groups.some(g => !g.name) ? '\n有大項沒有名稱，請補上大項名稱後再儲存。' : '';
      alert('匯入完成：' + summary + noName);
    } catch (e) { alert('匯入失敗：' + e.message); }
  };
  input.click();
}

/* ── 大項「匯入廠商報價」：讀廠商的 Excel 報價單 → 項目/單位/數量帶進該大項，
   廠商的單價填到「廠商報價」(成本)，售價 = 廠商報價 × (1 + 加成%)，或留空稍後自填 ── */
function pickVendorQuote(btn) {
  const sec = btn.closest('.q-section');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  input.onchange = async () => {
    if (!input.files.length) return;
    try {
      const items = (await readQuoteExcel(input.files[0])).flatMap(g => g.items);   // 廠商檔內的分組全部併入此大項
      const hasData = Array.from(sec.querySelectorAll('.q-items tr'))
        .some(tr => rowAmounts(tr).sub || tr.querySelector('[name=i_item]').value);
      if (hasData && !confirm(`讀到 ${items.length} 筆廠商明細，匯入會取代這個大項目前的明細，確定？`)) return;
      const ans = prompt(`讀到 ${items.length} 筆廠商明細。\n售價加成 %（例如 20 ＝ 廠商報價 × 1.2）；留空則售價先不填，稍後自己輸入：`, '20');
      if (ans === null) return;
      const pct = ans.trim() === '' ? null : Number(ans);
      if (pct !== null && !Number.isFinite(pct)) { alert('加成請填數字，例如 20。'); return; }
      applyVendorItems(sec, items, pct);
    } catch (e) { alert('匯入失敗：' + e.message); }
  };
  input.click();
}
function applyVendorItems(sec, items, pct) {
  const rows = items.map(it => {
    const unitCost = Number(it.unit_price) || 0;                 // 廠商 Excel 的「單價」＝每單位成本
    const qty = Number(it.qty) || 0;
    return {
      item: it.item, unit: it.unit, qty: it.qty, note: it.note,
      vendor_price: qty ? unitCost * qty : unitCost,             // 系統的「廠商報價」是該筆總成本 (單價 × 數量)
      unit_price: pct === null ? '' : Math.round(unitCost * (1 + pct / 100)),   // 售價 = 廠商單價 × (1 + 加成%)
    };
  });
  const body = sec.querySelector('.q-items');
  body.innerHTML = rows.map((it, i) => itemRowInputs(it, i + 1)).join('');
  updateQuoteTotals();
  alert(`已帶入 ${rows.length} 筆，廠商成本（單價 × 數量）已填入「廠商報價」欄` +
    (pct === null ? '，售價請自行填寫。' : `，售價以加成 ${pct}% 算出，可再逐筆修改。`));
}

/* ── 應收款項 ─────────────────────────────────────────── */
MODULES.receivable = {
  title: '應收款項', perm: 'perm_receivable',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 報價單號 / 客戶名稱',
      defaultHint: '預設顯示「待收款」，依收款單號遞減。' });
    setTopAction('＋ 新增應收款', () => this.form());
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async load(q) {
    const rows = await api('/api/receivables?q=' + encodeURIComponent(q || ''));
    document.getElementById('listArea').innerHTML = pagedTable([
      { key: 'ar_id', label: '收款單號', render: r => `<a class="link" onclick="MODULES.receivable.detail('${r.ar_id}')">${esc(r.ar_id)}</a>` },
      { key: 'cust_name', label: '客戶名稱' },
      { key: 'quote_id', label: '報價單號' },
      { key: 'item', label: '項目', render: r => `${esc(r.item)}${r.is_retention ? ' <span class="badge amber">保留款</span>' : ''}` },
      { key: 'amount', label: '應收金額', num: true, render: r => money(r.amount) },
      { key: 'tax', label: '5%稅額', num: true, render: r => money(r.tax) },
      { key: 'created_by_name', label: '填表人' },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
    ], rows);
  },
  async detail(id) {
    const r = await api('/api/receivables/' + id);
    openModal('收款單明細 ' + r.ar_id, `<dl class="dl">
      <dt>收款單號</dt><dd>${esc(r.ar_id)}</dd>
      <dt>建立日期</dt><dd>${fmtDT(r.created_at)}</dd>
      <dt>應收日期</dt><dd>${fmtDate(r.due_date)}</dd>
      <dt>客戶</dt><dd>${esc(r.cust_id)} ${esc(r.cust_name || '')}</dd>
      <dt>報價單號</dt><dd>${esc(r.quote_id)}</dd>
      <dt>專案編號</dt><dd>${esc(r.proj_id)}</dd>
      <dt>項目</dt><dd>${esc(r.item)}</dd>
      <dt>應收金額</dt><dd>${money(r.amount)}</dd>
      <dt>5%稅額</dt><dd>${money(r.tax)}</dd>
      <dt>發票號碼</dt><dd>${esc(r.invoice_no)}${r.invoice_void ? ' <span class="badge red">作廢</span>' : ''}</dd>
      <dt>發票日期</dt><dd>${fmtDate(r.invoice_date)}</dd>
      <dt>收款方式</dt><dd>${esc(r.receive_method)}</dd>
      <dt>折讓</dt><dd>${money(r.discount)}</dd>
      <dt>保留款</dt><dd>${r.is_retention ? '是（應收日期即到期日）' : '否'}</dd>
      <dt>狀態</dt><dd>${statusBadge(r.status)}</dd>
      <dt>收款日期</dt><dd>${fmtDate(r.received_date)}</dd>
      <dt>實收金額</dt><dd>${money(r.received_amount)}</dd>
      <dt>填表人</dt><dd>${esc(r.created_by_name || r.created_by)}</dd>
      <dt>備註</dt><dd>${esc(r.note)}</dd>
    </dl>`, `<button class="btn ghost" onclick="closeModal()">關閉</button>
      <button class="btn ghost" onclick="MODULES.receivable.exportPDF('${r.ar_id}')">匯出PDF</button>
      <button class="btn" onclick="MODULES.receivable.form('${r.ar_id}')">修改</button>
      <button class="btn danger" onclick="MODULES.receivable.remove('${r.ar_id}')">刪除</button>`);
  },
  async exportPDF(id) {
    try { receivablePrint(await api('/api/receivables/' + id)); }
    catch (e) { alert(e.message); }
  },
  async form(id) {
    const r = id ? await api('/api/receivables/' + id) : {};
    const [custs, quotes, projs] = [await getLookup('customers'), await getLookup('quotes'), await getLookup('projects')];
    // 應收「項目」「收款方式」下拉清單 (由項目維護管理，即時抓取)
    let itemOpts = await api('/api/options/receivable_item');
    if (r.item && !itemOpts.includes(r.item)) itemOpts = [r.item, ...itemOpts]; // 保留清單外的既有值
    let rmOpts = await api('/api/options/receivable_receive_method');
    if (r.receive_method && !rmOpts.includes(r.receive_method)) rmOpts = [r.receive_method, ...rmOpts];
    // 狀態一律唯讀 (新增固定待收款、修改沿用原值)；變更狀態請至「會計維護」
    const statusField = { name: 'status', label: '狀態', type: 'text', value: r.status || '待收款', readonly: true };
    openForm({
      title: id ? '修改應收款 ' + id : '新增應收款',
      fields: [
        { name: 'cust_id', label: '客戶', type: 'select', required: true, options: options(custs, 'cust_id', 'name', r.cust_id) },
        { name: 'quote_id', label: '報價單號', type: 'select', required: true, options: options(quotes, 'quote_id', 'proj_name', r.quote_id) },
        { name: 'proj_id', label: '專案編號', type: 'select', required: true, options: options(projs, 'proj_id', 'proj_name', r.proj_id) },
        { name: 'due_date', label: '應收日期', type: 'date', value: fmtDate(r.due_date) || localISO() },
        { name: 'item', label: '項目', type: 'select', options: optionsFromList(itemOpts, r.item) },
        { name: 'amount', label: '應收金額', type: 'number', step: '1', value: r.amount },
        { name: 'tax', label: '5%稅額', type: 'number', step: '1', value: r.tax, hint: '留空則自動以金額×5%計算' },
        { name: 'invoice_no', label: '發票號碼', value: r.invoice_no, hint: '非必填，格式如 AB-12345678' },
        { name: 'invoice_date', label: '發票日期', type: 'date', value: fmtDate(r.invoice_date), hint: '營業稅(401)申報依此日期歸期' },
        { name: 'invoice_void', label: '發票作廢', type: 'checkbox', checkLabel: '此發票已作廢', value: r.invoice_void },
        { name: 'receive_method', label: '收款方式', type: 'select', options: optionsFromList(rmOpts, r.receive_method || '現金', false) },
        { name: 'discount', label: '折讓', type: 'number', step: '1', value: r.discount || 0, hint: '非必填' },
        { name: 'is_retention', label: '保留款', type: 'checkbox', checkLabel: '此筆為保留款/保固金', value: r.is_retention },
        statusField,
        { name: 'note', label: '備註', type: 'textarea', full: true, value: r.note },
      ],
      onSubmit: async (v) => {
        if (id) await api('/api/receivables/' + id, { method: 'PUT', body: v });
        else await api('/api/receivables', { method: 'POST', body: v });
        MODULES.receivable.render();
      },
    });
  },
  remove(id) {
    confirmDelete('確定刪除收款單 ' + id + '？', async () => {
      try { await api('/api/receivables/' + id, { method: 'DELETE' }); closeModal(); MODULES.receivable.render(); }
      catch (e) { alert(e.message); }
    });
  },
};

/* ── 應付款項 ─────────────────────────────────────────── */
MODULES.payable = {
  title: '應付款項', perm: 'perm_payable',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 廠商名稱',
      defaultHint: '預設顯示「待付款」，依付款單號遞減。' });
    setTopAction('＋ 新增應付款', () => this.form());
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async load(q) {
    const rows = await api('/api/payables?q=' + encodeURIComponent(q || ''));
    document.getElementById('listArea').innerHTML = pagedTable([
      { key: 'ap_id', label: '付款單號', render: r => `<a class="link" onclick="MODULES.payable.detail('${r.ap_id}')">${esc(r.ap_id)}</a>` },
      { key: 'vend_name', label: '廠商名稱' },
      { key: 'item', label: '項目' },
      { key: 'amount', label: '應付金額', num: true, render: r => money(r.amount) },
      { key: 'tax_deduct', label: '抵扣稅額', num: true, render: r => money(r.tax_deduct) },
      { key: 'created_by_name', label: '填表人' },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
    ], rows);
  },
  async detail(id) {
    const p = await api('/api/payables/' + id);
    openModal('付款單明細 ' + p.ap_id, `<dl class="dl">
      <dt>付款單號</dt><dd>${esc(p.ap_id)}</dd>
      <dt>建立日期</dt><dd>${fmtDT(p.created_at)}</dd>
      <dt>廠商</dt><dd>${esc(p.vend_id)} ${esc(p.vend_name || '')}</dd>
      <dt>專案編號</dt><dd>${esc(p.proj_id)}</dd>
      <dt>應付日期</dt><dd>${fmtDate(p.due_date)}</dd>
      <dt>項目</dt><dd>${esc(p.item)}</dd>
      <dt>費用類別</dt><dd>${esc(p.expense_category)}</dd>
      <dt>應付金額</dt><dd>${money(p.amount)}</dd>
      <dt>憑證類別</dt><dd>${esc(p.doc_type)}</dd>
      <dt>抵扣稅額</dt><dd>${money(p.tax_deduct)}</dd>
      <dt>發票號碼</dt><dd>${esc(p.invoice_no)}${p.invoice_void ? ' <span class="badge red">作廢</span>' : ''}</dd>
      <dt>發票日期</dt><dd>${fmtDate(p.invoice_date)}</dd>
      <dt>所得類別</dt><dd>${esc(p.income_type)}</dd>
      <dt>扣繳稅額</dt><dd>${money(p.withholding_tax)}</dd>
      <dt>二代健保</dt><dd>${money(p.nhi_surcharge)}</dd>
      <dt>折讓</dt><dd>${money(p.discount)}</dd>
      <dt>狀態</dt><dd>${statusBadge(p.status)}</dd>
      <dt>付款日期</dt><dd>${fmtDate(p.paid_date)}</dd>
      <dt>付款方式</dt><dd>${esc(p.pay_method)}${p.check_no ? '（票號 ' + esc(p.check_no) + (p.check_due ? '，到期 ' + fmtDate(p.check_due) : '') + '）' : ''}</dd>
      <dt>實付金額</dt><dd>${money(p.paid_amount)}</dd>
      <dt>填表人</dt><dd>${esc(p.created_by_name || p.created_by)}</dd>
      <dt>備註</dt><dd>${esc(p.note)}</dd>
    </dl>`, `<button class="btn ghost" onclick="closeModal()">關閉</button>
      <button class="btn ghost" onclick="MODULES.payable.exportPDF('${p.ap_id}')">匯出PDF</button>
      <button class="btn" onclick="MODULES.payable.form('${p.ap_id}')">修改</button>
      <button class="btn danger" onclick="MODULES.payable.remove('${p.ap_id}')">刪除</button>`);
  },
  async exportPDF(id) {
    try { payablePrint(await api('/api/payables/' + id)); }
    catch (e) { alert(e.message); }
  },
  async form(id) {
    const p = id ? await api('/api/payables/' + id) : {};
    const [vends, projs] = [await getLookup('vendors'), await getLookup('projects')];
    // 應付「項目」與「費用類別」下拉清單 (由項目維護管理，即時抓取)
    let itemOpts = await api('/api/options/payable_item');
    if (p.item && !itemOpts.includes(p.item)) itemOpts = [p.item, ...itemOpts];
    let expOpts = await api('/api/options/expense_category');
    if (p.expense_category && !expOpts.includes(p.expense_category)) expOpts = [p.expense_category, ...expOpts];
    let pmOpts = await api('/api/options/payable_pay_method');
    if (p.pay_method && !pmOpts.includes(p.pay_method)) pmOpts = [p.pay_method, ...pmOpts];
    // 狀態一律唯讀 (新增固定待付款、修改沿用原值)；變更狀態請至「會計維護」
    const statusField = { name: 'status', label: '狀態', type: 'text', value: p.status || '待付款', readonly: true };
    openForm({
      title: id ? '修改應付款 ' + id : '新增應付款',
      topHtml: `<div class="ai-scan">
        <button type="button" class="btn ghost" id="aiScanBtn">📷 AI 發票辨識</button>
        <input type="file" id="aiScanFile" accept="image/*" capture="environment" style="display:none">
        <span class="hint" id="aiScanMsg">拍照或選擇發票圖片，自動填入 金額 / 稅額 / 發票號碼</span>
      </div>`,
      fields: [
        { name: 'vend_id', label: '廠商', type: 'select', options: options(vends, 'vend_id', 'company_name', p.vend_id), hint: '工程款請選廠商；營業費用可留空' },
        { name: 'proj_id', label: '專案編號', type: 'select', options: options(projs, 'proj_id', 'proj_name', p.proj_id), hint: '工程款請選專案；營業費用可留空' },
        { name: 'due_date', label: '應付日期', type: 'date', value: fmtDate(p.due_date), hint: '非必填，首頁到期提醒依此日期' },
        { name: 'item', label: '項目', type: 'select', options: optionsFromList(itemOpts, p.item) },
        { name: 'expense_category', label: '費用類別', type: 'select', options: optionsFromList(expOpts, p.expense_category), hint: '非專案的營業費用 (房租/水電…) 請選類別' },
        { name: 'amount', label: '應付金額', type: 'number', step: '1', value: p.amount },
        { name: 'doc_type', label: '憑證類別', type: 'select',
          options: optionsFromList(['三聯式發票', '電子發票(含統編)', '二聯式發票', '收據', '免用統一發票', '勞務報酬單'], p.doc_type),
          hint: '僅三聯式/含統編電子發票可扣抵進項稅額' },
        { name: 'tax_deduct', label: '抵扣稅額', type: 'number', step: '1', value: p.tax_deduct, hint: '非可扣抵憑證系統會自動歸零' },
        { name: 'invoice_no', label: '發票號碼', value: p.invoice_no, hint: '非必填，格式如 AB-12345678' },
        { name: 'invoice_date', label: '發票日期', type: 'date', value: fmtDate(p.invoice_date), hint: '營業稅(401)申報依此日期歸期' },
        { name: 'invoice_void', label: '發票作廢', type: 'checkbox', checkLabel: '此發票已作廢', value: p.invoice_void },
        { name: 'discount', label: '折讓', type: 'number', step: '1', value: p.discount || 0, hint: '非必填' },
        { name: 'income_type', label: '所得類別', type: 'select',
          options: optionsFromList(['薪資所得(50)', '執行業務所得(9B)', '其他所得(92)'], p.income_type),
          hint: '付款對象為個人(無發票)時填寫，供扣繳憑單使用' },
        { name: 'withholding_tax', label: '扣繳稅額', type: 'number', step: '1', value: p.withholding_tax || 0, hint: '非必填' },
        { name: 'nhi_surcharge', label: '二代健保補充保費', type: 'number', step: '1', value: p.nhi_surcharge || 0, hint: '非必填' },
        { name: 'pay_method', label: '付款方式', type: 'select', options: optionsFromList(pmOpts, p.pay_method || '現金', false) },
        statusField,
        { name: 'note', label: '備註', type: 'textarea', full: true, value: p.note },
      ],
      onSubmit: async (v) => {
        if (id) await api('/api/payables/' + id, { method: 'PUT', body: v });
        else await api('/api/payables', { method: 'POST', body: v });
        MODULES.payable.render();
      },
    });
    wireAiInvoiceScan();   // 啟用「AI 發票辨識」按鈕
  },
  remove(id) {
    confirmDelete('確定刪除付款單 ' + id + '？', async () => {
      try { await api('/api/payables/' + id, { method: 'DELETE' }); closeModal(); MODULES.payable.render(); }
      catch (e) { alert(e.message); }
    });
  },
};

/* ── AI 發票辨識：縮圖上傳 → 解析 → 自動填入表單 ─────────── */
// 將圖片縮到長邊 2000px 內並轉 JPEG，控制上傳量與辨識費用
function shrinkImage(file, maxSide = 2000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取圖片，請改用 JPG/PNG 格式。')); };
    img.src = url;
  });
}
function wireAiInvoiceScan() {
  const btn = document.getElementById('aiScanBtn');
  const fileInput = document.getElementById('aiScanFile');
  const msg = document.getElementById('aiScanMsg');
  if (!btn || !fileInput) return;
  btn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    if (!fileInput.files.length) return;
    const f = document.getElementById('modalForm');
    btn.disabled = true; btn.textContent = '🔍 辨識中…';
    msg.textContent = 'AI 正在讀取發票內容，約需 10～30 秒…';
    try {
      const image = await shrinkImage(fileInput.files[0]);
      const r = await api('/api/payables/parse-invoice', { method: 'POST', body: { image, mime: 'image/jpeg' } });
      const set = (name, val) => { const el = f.querySelector(`[name=${name}]`); if (el && val !== undefined && val !== null && val !== '') el.value = val; };
      set('amount', r.amount || '');
      set('tax_deduct', r.tax || 0);
      set('invoice_no', r.invoice_no);
      set('invoice_date', r.invoice_date);
      if (r.doc_type && r.doc_type !== '其他') set('doc_type', r.doc_type);
      const parts = [];
      if (r.seller_name) parts.push('賣方：' + r.seller_name + (r.seller_tax_id ? '（統編 ' + r.seller_tax_id + '）' : ''));
      parts.push('信心：' + (r.confidence || '—'));
      if (r.note) parts.push('⚠ ' + r.note);
      msg.textContent = '✅ 已自動填入，請核對金額與號碼。' + parts.join('；');
      if (r.seller_name) msg.textContent += '（廠商請自行從下拉選擇）';
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
    } finally {
      btn.disabled = false; btn.textContent = '📷 AI 發票辨識';
      fileInput.value = '';
    }
  };
}

/* ── 會計維護 ─────────────────────────────────────────── */
MODULES.accounting = {
  title: '會計維護', perm: 'perm_accounting',
  _tab: 'ar',
  render() {
    clearTopAction();
    document.getElementById('content').innerHTML = `
      <div class="tabs">
        <button class="tab" id="tabAR" onclick="MODULES.accounting.tab('ar')">應收款項</button>
        <button class="tab" id="tabAP" onclick="MODULES.accounting.tab('ap')">應付款項</button>
        <button class="tab" id="tabSal" onclick="MODULES.accounting.tab('salary')">員工薪資</button>
      </div>
      <div id="acctWrap"><div class="card"><div id="acctArea"><div class="empty">載入中...</div></div></div></div>`;
    this.tab(this._tab || 'ar');
  },
  tab(which) {
    this._tab = which;
    document.getElementById('tabAR').classList.toggle('active', which === 'ar');
    document.getElementById('tabAP').classList.toggle('active', which === 'ap');
    document.getElementById('tabSal').classList.toggle('active', which === 'salary');
    if (which === 'salary') { this.renderSalary(); return; }
    document.getElementById('acctWrap').innerHTML =
      '<div class="card"><div id="acctArea"><div class="empty">載入中...</div></div></div>';
    if (which === 'ar') this.loadAR(); else this.loadAP();
  },

  /* ── 員工薪資 (薪資單存於應付款項，僅本頁籤可查) ── */
  renderSalary() {
    document.getElementById('acctWrap').innerHTML = `
      <div class="toolbar">
        <input class="search" id="salSearch" placeholder="搜尋 員工代號 / 姓名 / 項目 / 單號">
        <button class="btn" id="salSearchBtn">搜尋</button>
        <button class="btn ghost" id="salBonusBtn" style="margin-left:auto">＋ 本月獎金</button>
        <button class="btn" id="salPayBtn">本月發薪</button>
      </div>
      <div class="hint" style="margin-bottom:10px">
        「本月發薪」會為狀態「正常」的員工各建立一筆當月薪資應付款（項目：年月薪資、金額：帳號管理設定的薪資、狀態：待付款），同一個月重複按不會重複建立。
        「＋ 本月獎金」則手動選員工、輸入金額建立獎金單（項目：年月獎金）。薪資與獎金單都不會出現在「應付款項」功能，只有這裡查得到。
      </div>
      <div class="card"><div id="salArea"><div class="empty">載入中...</div></div></div>`;
    document.getElementById('salSearchBtn').onclick = () => this.loadSalary();
    document.getElementById('salSearch').addEventListener('keydown', e => { if (e.key === 'Enter') this.loadSalary(); });
    document.getElementById('salPayBtn').onclick = () => this.payMonth();
    document.getElementById('salBonusBtn').onclick = () => this.bonusForm();
    this.loadSalary();
  },
  // 本月獎金：空白表單自行選員工/輸入金額
  async bonusForm() {
    const emps = await getLookup('employees');
    const now = new Date();
    const item = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}獎金`;
    openForm({
      title: '本月獎金',
      fields: [
        { name: 'emp_id', label: '員工', type: 'select', required: true, options: options(emps, 'emp_id', 'name') },
        { name: '_proj', label: '專案編號', type: 'text', readonly: true, value: '員工獎金' },
        { name: '_item', label: '項目', type: 'text', readonly: true, value: item },
        { name: 'amount', label: '獎金金額', type: 'number', step: '1', required: true },
        { name: '_status', label: '狀態', type: 'text', readonly: true, value: '待付款' },
        { name: 'note', label: '備註', type: 'textarea', full: true },
      ],
      onSubmit: async (v) => {
        const r = await api('/api/accounting/salaries/bonus', { method: 'POST', body: v });
        alert(`已建立 ${r.item}：${r.emp_name}（單號 ${r.ap_id}）`);
        MODULES.accounting.loadSalary();
      },
    });
  },
  async loadSalary() {
    const q = (document.getElementById('salSearch')?.value || '').trim();
    const data = await api('/api/accounting/salaries?q=' + encodeURIComponent(q));
    document.getElementById('salArea').innerHTML = pagedTable([
      { key: 'ap_id', label: '付款單號' },
      { key: 'emp_name', label: '廠商(員工姓名)', render: r => `${esc(r.emp_name || '')}${r.emp_id ? '（' + esc(r.emp_id) + '）' : ''}` },
      { key: '_proj', label: '專案編號', render: r => /獎金$/.test(r.item || '') ? '員工獎金' : '員工薪資' },
      { key: 'item', label: '項目' },
      { key: 'amount', label: '應付金額', num: true, render: r => money(r.amount) },
      { key: 'discount', label: '折讓金額', num: true, render: r => money(r.discount) },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
      { key: 'paid_date', label: '付款日期', render: r => fmtDate(r.paid_date) },
      { key: 'paid_amount', label: '實付金額', num: true, render: r => money(r.paid_amount) },
      { key: '_', label: '維護', render: r => `<button class="btn sm" onclick="MODULES.accounting.editSalary('${r.ap_id}')">維護</button>` },
    ], data.rows);
  },
  async payMonth() {
    const now = new Date();
    const ym = `${now.getFullYear()}年${now.getMonth() + 1}月`;
    if (!confirm(`確定要建立 ${ym} 的薪資應付款嗎？\n(狀態「正常」且有設定薪資的員工各一筆，已建立過的不會重複)`)) return;
    const btn = document.getElementById('salPayBtn');
    btn.disabled = true; btn.textContent = '處理中...';
    try {
      const r = await api('/api/accounting/salaries/pay-month', { method: 'POST' });
      const lines = [`${r.item} 發薪完成。`, `新增 ${r.created.length} 筆${r.created.length ? '：' + r.created.join('、') : ''}`];
      if (r.skipped.length) lines.push(`已存在略過 ${r.skipped.length} 筆：${r.skipped.join('、')}`);
      if (r.no_salary.length) lines.push(`未設定薪資略過 ${r.no_salary.length} 筆：${r.no_salary.join('、')}`);
      alert(lines.join('\n'));
      this.loadSalary();
    } catch (e) { alert(e.message); }
    finally { btn.disabled = false; btn.textContent = '本月發薪'; }
  },
  async editSalary(id) {
    const p = await api('/api/accounting/salaries/' + id);
    const d = p.salary_detail || p.prev_detail || {};   // 本單明細；沒有則帶上次的預填
    const n = (v) => Math.round(Number(v)) || 0;
    window.__salGross = n(p.amount);
    openForm({
      title: `員工薪資維護 ${id}（${p.emp_name || ''}）`,
      fields: [
        { name: '_item', label: '項目', type: 'text', readonly: true, value: p.item },
        { name: '_amount', label: '應發薪資', type: 'text', readonly: true, value: money(p.amount) },
        { name: 'labor_ins', label: '勞保自付', type: 'number', step: '1', value: d.labor_ins || 0, oninput: 'calcSalaryNet()' },
        { name: 'health_ins', label: '健保自付', type: 'number', step: '1', value: d.health_ins || 0, oninput: 'calcSalaryNet()' },
        { name: 'salary_tax', label: '所得稅扣繳', type: 'number', step: '1', value: d.salary_tax || 0, oninput: 'calcSalaryNet()' },
        { name: 'paid_amount', label: '實發金額', type: 'number', step: '1', readonly: true,
          value: p.paid_amount ?? (n(p.amount) - n(d.labor_ins) - n(d.health_ins) - n(d.salary_tax)),
          hint: '＝應發 − 勞保 − 健保 − 所得稅，自動計算' },
        { name: 'emp_labor', label: '公司負擔-勞保', type: 'number', step: '1', value: d.emp_labor || 0, hint: '不影響實發，供成本與申報記錄' },
        { name: 'emp_health', label: '公司負擔-健保', type: 'number', step: '1', value: d.emp_health || 0, hint: '不影響實發，供成本與申報記錄' },
        { name: 'pension', label: '公司負擔-勞退6%', type: 'number', step: '1', value: d.pension || 0, hint: '不影響實發，供成本與申報記錄' },
        { name: 'status', label: '狀態', type: 'select', options: statusSelectOptions(['已付款', '待付款'], '已付款') },
        { name: 'paid_date', label: '付款日期', type: 'date', value: fmtDate(p.paid_date) || localISO() },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: p.note },
      ],
      onSubmit: async (v) => {
        const body = {
          status: v.status, paid_date: v.paid_date, note: v.note,
          paid_amount: n(v.paid_amount),
          salary_detail: {
            labor_ins: n(v.labor_ins), health_ins: n(v.health_ins), salary_tax: n(v.salary_tax),
            emp_labor: n(v.emp_labor), emp_health: n(v.emp_health), pension: n(v.pension),
          },
        };
        await api(`/api/accounting/salaries/${id}/pay`, { method: 'PATCH', body });
        MODULES.accounting.loadSalary();
      },
    });
    calcSalaryNet();   // 依預填值先算一次實發
  },
  async loadAR() {
    const ar = await api('/api/accounting/receivables');
    document.getElementById('acctArea').innerHTML = pagedTable([
      { key: 'ar_id', label: '收款單號' },
      { key: 'cust_name', label: '客戶' },
      { key: 'item', label: '項目' },
      { key: 'amount', label: '應收金額', num: true, render: r => money(r.amount) },
      { key: 'discount', label: '折讓金額', num: true, render: r => money(r.discount) },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
      { key: 'received_date', label: '收款日期', render: r => fmtDate(r.received_date) },
      { key: 'received_amount', label: '實收金額', num: true, render: r => money(r.received_amount) },
      { key: 'created_by_name', label: '填表人' },
      { key: '_', label: '維護', render: r => `<button class="btn sm" onclick="MODULES.accounting.editAR('${r.ar_id}')">維護</button>` },
    ], ar);
  },
  async loadAP() {
    const ap = await api('/api/accounting/payables');
    document.getElementById('acctArea').innerHTML = pagedTable([
      { key: 'ap_id', label: '付款單號' },
      { key: 'vend_name', label: '廠商' },
      { key: 'item', label: '項目' },
      { key: 'amount', label: '應付金額', num: true, render: r => money(r.amount) },
      { key: 'discount', label: '折讓金額', num: true, render: r => money(r.discount) },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
      { key: 'paid_date', label: '付款日期', render: r => fmtDate(r.paid_date) },
      { key: 'paid_amount', label: '實付金額', num: true, render: r => money(r.paid_amount) },
      { key: 'created_by_name', label: '填表人' },
      { key: '_', label: '維護', render: r => `<button class="btn sm" onclick="MODULES.accounting.editAP('${r.ap_id}')">維護</button>` },
    ], ap);
  },
  // 維護表單：完整欄位皆可修改 (含原始單據資訊 + 會計收付款資訊)
  async editAR(id) {
    const r = await api('/api/receivables/' + id);
    const [custs, quotes, projs] = [await getLookup('customers'), await getLookup('quotes'), await getLookup('projects')];
    let itemOpts = await api('/api/options/receivable_item');
    if (r.item && !itemOpts.includes(r.item)) itemOpts = [r.item, ...itemOpts];
    let rmOpts = await api('/api/options/receivable_receive_method');
    if (r.receive_method && !rmOpts.includes(r.receive_method)) rmOpts = [r.receive_method, ...rmOpts];
    const num = (v) => Math.round(Number(v)) || 0;
    openForm({
      title: '會計維護 - 應收 ' + id,
      fields: [
        { name: 'cust_id', label: '客戶', type: 'select', options: options(custs, 'cust_id', 'name', r.cust_id) },
        { name: 'quote_id', label: '報價單號', type: 'select', options: options(quotes, 'quote_id', 'proj_name', r.quote_id) },
        { name: 'proj_id', label: '專案編號', type: 'select', options: options(projs, 'proj_id', 'proj_name', r.proj_id) },
        { name: 'due_date', label: '應收日期', type: 'date', value: fmtDate(r.due_date) },
        { name: 'item', label: '項目', type: 'select', options: optionsFromList(itemOpts, r.item) },
        { name: 'amount', label: '應收金額', type: 'number', step: '1', value: num(r.amount) },
        { name: 'tax', label: '5%稅額', type: 'number', step: '1', value: num(r.tax), hint: '留空則自動以金額×5%計算' },
        { name: 'invoice_no', label: '發票號碼', value: r.invoice_no, hint: '格式如 AB-12345678' },
        { name: 'invoice_date', label: '發票日期', type: 'date', value: fmtDate(r.invoice_date), hint: '營業稅(401)申報依此日期歸期' },
        { name: 'invoice_void', label: '發票作廢', type: 'checkbox', checkLabel: '此發票已作廢', value: r.invoice_void },
        { name: 'is_retention', label: '保留款', type: 'checkbox', checkLabel: '此筆為保留款/保固金', value: r.is_retention },
        { name: 'status', label: '狀態', type: 'select', options: statusSelectOptions(['已收款', '待收款'], '已收款') },
        { name: 'received_date', label: '收款日期', type: 'date', value: fmtDate(r.received_date) || localISO() },
        { name: 'receive_method', label: '收款方式', type: 'select', options: optionsFromList(rmOpts, r.receive_method || '現金', false) },
        { name: 'discount', label: '折讓金額', type: 'number', step: '1', value: num(r.discount) },
        { name: 'received_amount', label: '實收金額', type: 'number', step: '1',
          value: r.received_amount ?? (num(r.amount) + num(r.tax) - num(r.discount)), hint: '預帶 金額＋稅額－折讓，可修改' },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: r.note },
      ],
      onSubmit: async (v) => { await api(`/api/receivables/${id}/receive`, { method: 'PATCH', body: v }); MODULES.accounting.tab('ar'); },
    });
  },
  async editAP(id) {
    const p = await api('/api/payables/' + id);
    const [vends, projs] = [await getLookup('vendors'), await getLookup('projects')];
    let itemOpts = await api('/api/options/payable_item');
    if (p.item && !itemOpts.includes(p.item)) itemOpts = [p.item, ...itemOpts];
    let expOpts = await api('/api/options/expense_category');
    if (p.expense_category && !expOpts.includes(p.expense_category)) expOpts = [p.expense_category, ...expOpts];
    let pmOpts = await api('/api/options/payable_pay_method');
    if (p.pay_method && !pmOpts.includes(p.pay_method)) pmOpts = [p.pay_method, ...pmOpts];
    const num = (v) => Math.round(Number(v)) || 0;
    openForm({
      title: '會計維護 - 應付 ' + id,
      fields: [
        { name: 'vend_id', label: '廠商', type: 'select', options: options(vends, 'vend_id', 'company_name', p.vend_id) },
        { name: 'proj_id', label: '專案編號', type: 'select', options: options(projs, 'proj_id', 'proj_name', p.proj_id) },
        { name: 'due_date', label: '應付日期', type: 'date', value: fmtDate(p.due_date) },
        { name: 'item', label: '項目', type: 'select', options: optionsFromList(itemOpts, p.item) },
        { name: 'expense_category', label: '費用類別', type: 'select', options: optionsFromList(expOpts, p.expense_category), hint: '非專案的營業費用請選類別' },
        { name: 'amount', label: '應付金額', type: 'number', step: '1', value: num(p.amount) },
        { name: 'doc_type', label: '憑證類別', type: 'select',
          options: optionsFromList(['三聯式發票', '電子發票(含統編)', '二聯式發票', '收據', '免用統一發票', '勞務報酬單'], p.doc_type),
          hint: '僅三聯式/含統編電子發票可扣抵進項稅額' },
        { name: 'tax_deduct', label: '抵扣稅額', type: 'number', step: '1', value: num(p.tax_deduct), hint: '非可扣抵憑證系統會自動歸零' },
        { name: 'invoice_no', label: '發票號碼', value: p.invoice_no, hint: '格式如 AB-12345678' },
        { name: 'invoice_date', label: '發票日期', type: 'date', value: fmtDate(p.invoice_date), hint: '營業稅(401)申報依此日期歸期' },
        { name: 'invoice_void', label: '發票作廢', type: 'checkbox', checkLabel: '此發票已作廢', value: p.invoice_void },
        { name: 'income_type', label: '所得類別', type: 'select',
          options: optionsFromList(['薪資所得(50)', '執行業務所得(9B)', '其他所得(92)'], p.income_type),
          hint: '付款對象為個人(無發票)時填寫' },
        { name: 'withholding_tax', label: '扣繳稅額', type: 'number', step: '1', value: num(p.withholding_tax) },
        { name: 'nhi_surcharge', label: '二代健保補充保費', type: 'number', step: '1', value: num(p.nhi_surcharge) },
        { name: 'status', label: '狀態', type: 'select', options: statusSelectOptions(['已付款', '待付款'], '已付款') },
        { name: 'paid_date', label: '付款日期', type: 'date', value: fmtDate(p.paid_date) || localISO() },
        { name: 'discount', label: '折讓金額', type: 'number', step: '1', value: num(p.discount) },
        { name: 'paid_amount', label: '實付金額', type: 'number', step: '1',
          value: p.paid_amount ?? (num(p.amount) - num(p.discount)), hint: '預帶 金額－折讓，可修改' },
        { name: 'pay_method', label: '付款方式', type: 'select', options: optionsFromList(pmOpts, p.pay_method || '現金', false) },
        { name: 'check_no', label: '支票號碼', value: p.check_no, hint: '付款方式為支票時填寫' },
        { name: 'check_due', label: '支票到期日', type: 'date', value: fmtDate(p.check_due), hint: '付款方式為支票時填寫' },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: p.note },
      ],
      onSubmit: async (v) => { await api(`/api/payables/${id}/pay`, { method: 'PATCH', body: v }); MODULES.accounting.tab('ap'); },
    });
  },
};

/* ── 公司報表 (營收結算 / 專案獲利 兩個分頁) ──────────── */
// 期間查詢列：年份 + 月份起迄 (前綴 id 供各分頁各自使用)
function periodToolbar(prefix, defFrom, defTo, extraHtml = '') {
  const now = new Date();
  const thisYear = now.getFullYear();
  const years = [];
  for (let y = thisYear + 1; y >= thisYear - 6; y--) years.push(y);
  const monthOpts = (sel) => Array.from({ length: 12 }, (_, i) => i + 1)
    .map(m => `<option value="${m}" ${m === sel ? 'selected' : ''}>${m} 月</option>`).join('');
  return `<div class="toolbar">
    <span class="tb-label">年份</span>
    <select id="${prefix}Year">${years.map(y => `<option ${y === thisYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
    <span class="tb-label">期間</span>
    <select id="${prefix}From">${monthOpts(defFrom)}</select>
    <span class="tb-sep">～</span>
    <select id="${prefix}To">${monthOpts(defTo)}</select>
    <button class="btn" id="${prefix}Search">查詢</button>
    ${extraHtml}
  </div>`;
}
function readPeriod(prefix) {
  return {
    year: Number(document.getElementById(prefix + 'Year').value),
    from: Number(document.getElementById(prefix + 'From').value),
    to: Number(document.getElementById(prefix + 'To').value),
  };
}
const ACCT_DATE_HINT = '歸期方式：應收「已收款」依收款日期、「待收款」依應收日期；應付「已付款」依付款日期、「待付款」依建立日期。';

MODULES.acctreport = {
  title: '公司報表', perm: 'perm_accounting',
  _tab: 'revenue', _data: null, _proj: null,
  render() {
    clearTopAction();
    document.getElementById('content').innerHTML = `
      <div class="tabs">
        <button class="tab" id="tabRev" onclick="MODULES.acctreport.tab('revenue')">營收結算</button>
        <button class="tab" id="tabProf" onclick="MODULES.acctreport.tab('profit')">專案獲利</button>
        <button class="tab" id="tabAging" onclick="MODULES.acctreport.tab('aging')">帳齡分析</button>
        <button class="tab" id="tabVat" onclick="MODULES.acctreport.tab('vat')">營業稅申報(401)</button>
        <button class="tab" id="tabWh" onclick="MODULES.acctreport.tab('wh')">扣繳彙總</button>
      </div>
      <div id="rpBody"></div>`;
    this.tab(this._tab || 'revenue');
  },
  tab(which) {
    this._tab = which;
    for (const [id2, k] of [['tabRev', 'revenue'], ['tabProf', 'profit'], ['tabAging', 'aging'], ['tabVat', 'vat'], ['tabWh', 'wh']]) {
      document.getElementById(id2).classList.toggle('active', which === k);
    }
    if (which === 'revenue') this.renderRevenue();
    else if (which === 'profit') this.renderProfit();
    else if (which === 'aging') this.renderAging();
    else if (which === 'wh') this.renderWithholding();
    else this.renderVat();
  },

  /* ── 帳齡分析：待收款依逾期天數分桶 (以今天為基準) ── */
  _aging: null,
  async renderAging() {
    document.getElementById('rpBody').innerHTML = `
      <div class="toolbar">
        <button class="btn" id="agReload">重新整理</button>
        <button class="btn ghost" id="agCsv" style="margin-left:auto">匯出CSV</button>
      </div>
      <div class="hint" style="margin-bottom:10px">
        所有「待收款」依應收日期與今天的差距分桶，用於催款排序；含保留款（會標示）。
      </div>
      <div id="agArea"><div class="empty">載入中...</div></div>`;
    document.getElementById('agReload').onclick = () => this.loadAging();
    document.getElementById('agCsv').onclick = () => this.exportAgingCSV();
    this.loadAging();
  },
  async loadAging() {
    const area = document.getElementById('agArea');
    try {
      this._aging = await api('/api/accounting/aging');
      const a = this._aging;
      const card = (label, value, cls = '') =>
        `<div class="sum-card ${cls}"><div class="k">${esc(label)}</div><div class="v">${money(value)}</div></div>`;
      const custTable = tableHtml([
        { key: 'cust_name', label: '客戶' },
        { key: 'mobile', label: '手機' },
        { key: 'count', label: '筆數', num: true },
        { key: 'not_due', label: '未逾期', num: true, render: r => money(r.not_due) },
        { key: 'd1_30', label: '逾期1-30天', num: true, render: r => money(r.d1_30) },
        { key: 'd31_60', label: '31-60天', num: true, render: r => money(r.d31_60) },
        { key: 'd61_90', label: '61-90天', num: true, render: r => money(r.d61_90) },
        { key: 'd90p', label: '90天以上', num: true, render: r => money(r.d90p) },
        { key: 'total', label: '合計', num: true, render: r => `<b>${money(r.total)}</b>` },
      ], a.customers, ['合計', '', `${a.rows.length} 筆`,
        money(a.buckets.not_due), money(a.buckets.d1_30), money(a.buckets.d31_60),
        money(a.buckets.d61_90), money(a.buckets.d90p), money(a.total)]);
      const bucketName = { not_due: '未逾期', d1_30: '1-30天', d31_60: '31-60天', d61_90: '61-90天', d90p: '90天以上' };
      const detTable = tableHtml([
        { key: 'ar_id', label: '收款單號' },
        { key: 'cust_name', label: '客戶' },
        { key: 'item', label: '項目', render: r => `${esc(r.item)}${r.is_retention ? ' <span class="badge amber">保留款</span>' : ''}` },
        { key: 'due_date', label: '應收日期', render: r => fmtDate(r.due_date) },
        { key: 'days_overdue', label: '逾期天數', num: true, render: r => (r.days_overdue > 0 ? `<span class="neg-num">${r.days_overdue}</span>` : '—') },
        { key: 'bucket', label: '帳齡', render: r => bucketName[r.bucket] || '' },
        { key: 'outstanding', label: '未收金額(含稅)', num: true, render: r => money(r.outstanding) },
      ], a.rows, ['合計', '', '', '', '', '', money(a.total)]);
      area.innerHTML = `
        <div class="section-title">帳齡彙總（基準日 ${a.as_of}）</div>
        <div class="sum-grid">
          ${card('未逾期', a.buckets.not_due)}
          ${card('逾期 1-30 天', a.buckets.d1_30, a.buckets.d1_30 ? 'amber' : '')}
          ${card('逾期 31-60 天', a.buckets.d31_60, a.buckets.d31_60 ? 'amber' : '')}
          ${card('逾期 61-90 天', a.buckets.d61_90, a.buckets.d61_90 ? 'neg' : '')}
          ${card('逾期 90 天以上', a.buckets.d90p, a.buckets.d90p ? 'neg' : '')}
          ${card('待收款總額（含稅）', a.total, 'hl')}
        </div>
        <div class="section-title">各客戶帳齡（依未收金額排序）</div>
        <div class="card" id="agCust">${custTable}</div>
        <div class="section-title">待收款明細（${a.rows.length} 筆）</div>
        <div class="card" id="agDet">${detTable}</div>`;
    } catch (e) { area.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  },
  exportAgingCSV() {
    if (!this._aging) { alert('請先載入報表。'); return; }
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [[q('應收帳齡分析'), q('基準日 ' + this._aging.as_of)].join(','), '', [q('各客戶帳齡')].join(',')];
    const t1 = document.querySelector('#agCust table');
    lines.push(...(t1 ? tableToCsvLines(t1) : []));
    lines.push('', [q('待收款明細')].join(','));
    const t2 = document.querySelector('#agDet table');
    lines.push(...(t2 ? tableToCsvLines(t2) : []));
    downloadCSV(lines, `帳齡分析_${this._aging.as_of}.csv`);
  },

  /* ── 扣繳彙總 (年度，供扣繳憑單申報彙整) ── */
  _wh: null,
  renderWithholding() {
    const thisYear = new Date().getFullYear();
    const years = [];
    for (let y = thisYear; y >= thisYear - 6; y--) years.push(y);
    document.getElementById('rpBody').innerHTML = `
      <div class="toolbar">
        <span class="tb-label">年度</span>
        <select id="whYear">${years.map(y => `<option ${y === thisYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <button class="btn" id="whSearch">查詢</button>
        <button class="btn ghost" id="whCsv" style="margin-left:auto">匯出CSV</button>
      </div>
      <div class="hint" style="margin-bottom:10px">
        彙總年度內「已付款」的個人所得給付（應付款有填所得類別者）與員工薪資/獎金，
        供年初開立扣繳憑單使用；正式申報媒體檔請由記帳士以此表轉檔。
      </div>
      <div id="whArea"><div class="empty">請選擇年度後按「查詢」</div></div>`;
    document.getElementById('whSearch').onclick = () => this.loadWithholding();
    document.getElementById('whCsv').onclick = () => this.exportWhCSV();
    this.loadWithholding();
  },
  async loadWithholding() {
    const year = Number(document.getElementById('whYear').value);
    const area = document.getElementById('whArea');
    area.innerHTML = '<div class="empty">查詢中...</div>';
    try {
      this._wh = await api('/api/accounting/withholding?year=' + year);
      const w = this._wh;
      const t1 = tableHtml([
        { key: 'payee', label: '所得人' },
        { key: 'tax_id', label: '統編' },
        { key: 'income_type', label: '所得類別' },
        { key: 'cnt', label: '筆數', num: true },
        { key: 'total_paid', label: '給付總額', num: true, render: r => money(r.total_paid) },
        { key: 'withholding', label: '扣繳稅額', num: true, render: r => money(r.withholding) },
        { key: 'nhi', label: '二代健保', num: true, render: r => money(r.nhi) },
      ], w.others);
      const t2 = tableHtml([
        { key: 'emp_id', label: '員工代號' },
        { key: 'payee', label: '姓名' },
        { key: 'cnt', label: '筆數', num: true },
        { key: 'total_paid', label: '給付總額(薪資+獎金)', num: true, render: r => money(r.total_paid) },
        { key: 'withholding', label: '扣繳稅額', num: true, render: r => money(r.withholding) },
      ], w.salaries);
      area.innerHTML = `
        <div class="section-title">${w.year} 年（民國 ${w.year - 1911} 年）個人/廠商所得給付</div>
        <div class="card" id="whOther">${t1}</div>
        <div class="section-title">員工薪資所得(50)</div>
        <div class="card" id="whSal">${t2}</div>`;
    } catch (e) { this._wh = null; area.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  },
  exportWhCSV() {
    if (!this._wh) { alert('請先查詢。'); return; }
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [[q('各類所得扣繳彙總'), q(`${this._wh.year} 年 (民國 ${this._wh.year - 1911} 年)`)].join(','), '', [q('個人/廠商所得給付')].join(',')];
    const t1 = document.querySelector('#whOther table');
    lines.push(...(t1 ? tableToCsvLines(t1) : [q('查無資料')]));
    lines.push('', [q('員工薪資所得(50)')].join(','));
    const t2 = document.querySelector('#whSal table');
    lines.push(...(t2 ? tableToCsvLines(t2) : [q('查無資料')]));
    downloadCSV(lines, `扣繳彙總_${this._wh.year}年.csv`);
  },

  /* ── 分頁一：營收結算 (預設今年 1 月 ～ 當月) ── */
  renderRevenue() {
    const thisMonth = new Date().getMonth() + 1;
    document.getElementById('rpBody').innerHTML =
      periodToolbar('rp', 1, thisMonth, '<button class="btn ghost" id="rpCsv" style="margin-left:auto">匯出CSV</button>') +
      `<div class="hint" style="margin-bottom:10px">${ACCT_DATE_HINT}</div>
       <div id="rpArea"><div class="empty">請選擇年份與月份起迄期間後按「查詢」</div></div>`;
    document.getElementById('rpSearch').onclick = () => this.load();
    document.getElementById('rpCsv').onclick = () => this.exportCSV();
    this.load();
  },
  async load() {
    const { year, from, to } = readPeriod('rp');
    if (from > to) { alert('起始月份不可大於結束月份。'); return; }
    const area = document.getElementById('rpArea');
    area.innerHTML = '<div class="empty">查詢中...</div>';
    try {
      this._data = await api(`/api/accounting/report?year=${year}&from=${from}&to=${to}`);
      this.paint();
    } catch (e) {
      this._data = null;
      area.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  },
  // 損益表列 (財務報表型式)：金額負數紅字；pctVal 顯示占營收比
  _finRow(label, value, cls = '', pctVal = null) {
    const amt = (value === null || value === undefined) ? ''
      : `<span class="${Number(value) < 0 ? 'neg-num' : ''}">${money(value)}</span>`;
    return `<tr class="${cls}"><td class="fin-label">${label}</td>
      <td class="num">${amt}</td>
      <td class="num fin-pct">${pctVal === null || pctVal === undefined ? '' : pctVal.toFixed(1) + '%'}</td></tr>`;
  },
  paint() {
    const { period: p, receivables: ar, payables: ap, summary: s, statement: f } = this._data;
    const card = (label, value, cls = '') =>
      `<div class="sum-card ${cls}"><div class="k">${esc(label)}</div><div class="v">${money(value)}</div></div>`;
    const colSum = (rows, key) => rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);
    const R = this._finRow;

    // ── 損益表 ──
    const finTable = `<div class="card fin-card"><table class="fin-table">
      <thead><tr><th>損益表（權責基礎，未稅）</th><th class="num">金額</th><th class="num fin-pct">占營收</th></tr></thead>
      <tbody>
        ${R('營業收入', null, 'fin-sec')}
        ${R('　工程收入（應收款項）', f.revenue)}
        ${f.sales_discount ? R('　減：銷貨折讓', -f.sales_discount) : ''}
        ${R('營業收入淨額', f.net_revenue, 'fin-sub', 100)}
        ${R('營業成本', null, 'fin-sec')}
        ${R('　工程成本（專案應付款項）', -f.cost)}
        ${f.cost_discount ? R('　減：進貨折讓', f.cost_discount) : ''}
        ${R('營業毛利', f.gross, 'fin-sub', f.gross_pct)}
        ${R('營業費用', null, 'fin-sec')}
        ${f.expenses.map(e => R('　' + esc(e.name), -e.amount)).join('')}
        ${f.expenses.length ? '' : R('　（本期無營業費用）', null)}
        ${R('營業費用合計', -f.expense_total, 'fin-sub')}
        ${R('本期損益', f.net_income, 'fin-total', f.net_pct)}
      </tbody></table>
      <div class="hint" style="padding:0 16px 12px">
        附註：銷項稅額 ${money(f.sales_tax)}、進項可扣抵稅額 ${money(f.purchase_tax)}（代收代付性質，不列入損益）；
        費用含薪資/獎金與各費用類別（未掛專案之應付款）。
      </div></div>`;

    const arTable = tableHtml([
      { key: 'acct_date', label: '歸屬日期', render: r => fmtDate(r.acct_date) },
      { key: 'ar_id', label: '收款單號' },
      { key: 'cust_name', label: '客戶' },
      { key: 'proj_name', label: '專案' },
      { key: 'item', label: '項目' },
      { key: 'amount', label: '應收金額', num: true, render: r => money(r.amount) },
      { key: 'tax', label: '稅額', num: true, render: r => money(r.tax) },
      { key: 'discount', label: '折讓金額', num: true, render: r => money(r.discount) },
      { key: 'received_amount', label: '實收金額', num: true, render: r => money(r.received_amount) },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
    ], ar, ['合計', `${ar.length} 筆`, '', '', '',
      money(colSum(ar, 'amount')), money(colSum(ar, 'tax')),
      money(s.ar_discount), money(s.ar_received), '']);

    const apTable = tableHtml([
      { key: 'acct_date', label: '歸屬日期', render: r => fmtDate(r.acct_date) },
      { key: 'ap_id', label: '付款單號' },
      { key: 'vend_name', label: '廠商' },
      { key: 'proj_name', label: '專案' },
      { key: 'item', label: '項目' },
      { key: 'amount', label: '應付金額', num: true, render: r => money(r.amount) },
      { key: 'tax_deduct', label: '抵扣稅額', num: true, render: r => money(r.tax_deduct) },
      { key: 'discount', label: '折讓金額', num: true, render: r => money(r.discount) },
      { key: 'paid_amount', label: '實付金額', num: true, render: r => money(r.paid_amount) },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
    ], ap, ['合計', `${ap.length} 筆`, '', '', '',
      money(s.ap_total), money(s.ap_tax_deduct), money(s.ap_discount), money(s.ap_paid), '']);

    document.getElementById('rpArea').innerHTML = `
      <div class="section-title">結算期間：${p.year} 年 ${p.from} 月 ～ ${p.to} 月</div>
      ${finTable}
      <div class="section-title">現金流量（同期間）</div>
      <div class="sum-grid">
        ${card('實收金額', s.ar_received)}
        ${card('實付金額', s.ap_paid)}
        ${card('淨現金流（實收－實付）', f.net_cash, 'hl ' + (f.net_cash < 0 ? 'neg' : ''))}
        ${card('待收款（含稅）', s.ar_pending, 'amber')}
        ${card('待付款', s.ap_pending, 'amber')}
      </div>
      <div class="section-title">應收帳款明細（${s.ar_count} 筆）</div>
      <div class="card" id="rpAR">${arTable}</div>
      <div class="section-title">應付帳款明細（${s.ap_count} 筆）</div>
      <div class="card" id="rpAP">${apTable}</div>`;
  },
  exportCSV() {
    if (!this._data) { alert('請先查詢報表。'); return; }
    const { period: p, summary: s, statement: f } = this._data;
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const row2 = (a, b) => [q(a), q(b)].join(',');
    const lines = [
      row2('損益表（權責基礎，未稅）', `${p.year} 年 ${p.from} 月 ～ ${p.to} 月`),
      '',
      row2('工程收入(應收款項)', f.revenue),
      row2('減：銷貨折讓', -f.sales_discount),
      row2('營業收入淨額', f.net_revenue),
      row2('工程成本(專案應付款項)', -f.cost),
      row2('減：進貨折讓', f.cost_discount),
      row2('營業毛利', f.gross),
      ...f.expenses.map(e => row2('營業費用－' + e.name, -e.amount)),
      row2('營業費用合計', -f.expense_total),
      row2('本期損益', f.net_income),
      '',
      row2('附註：銷項稅額', f.sales_tax),
      row2('附註：進項可扣抵稅額', f.purchase_tax),
      row2('現金流量：實收金額', s.ar_received),
      row2('現金流量：實付金額', s.ap_paid),
      row2('現金流量：淨現金流', f.net_cash),
      row2('待收款(含稅)', s.ar_pending),
      row2('待付款', s.ap_pending),
      '',
      [q('應收帳款明細')].join(','),
    ];
    const arT = document.querySelector('#rpAR table');
    lines.push(...(arT ? tableToCsvLines(arT) : [q('查無資料')]));
    lines.push('', [q('應付帳款明細')].join(','));
    const apT = document.querySelector('#rpAP table');
    lines.push(...(apT ? tableToCsvLines(apT) : [q('查無資料')]));
    downloadCSV(lines, `公司報表_${p.year}年${p.from}-${p.to}月.csv`);
  },

  /* ── 分頁二：專案獲利 (預設近一個月＝當月) ── */
  renderProfit() {
    const thisMonth = new Date().getMonth() + 1;
    document.getElementById('rpBody').innerHTML =
      periodToolbar('pp', thisMonth, thisMonth, '<button class="btn ghost" id="ppCsv" style="margin-left:auto">匯出CSV</button>') +
      `<div class="hint" style="margin-bottom:10px">
         各專案期間內的應收款項與應付款項合計 (未稅金額)，營收金額 ＝ 應收 － 應付，利潤% ＝ 營收 ÷ 應收 (無應收款以「—」表示)。
         未填專案編號的單據 (營業費用/薪資) 不列入本頁，仍計入「營收結算」。${ACCT_DATE_HINT}
       </div>
       <div id="ppArea"><div class="empty">請選擇年份與月份起迄期間後按「查詢」</div></div>`;
    document.getElementById('ppSearch').onclick = () => this.loadProfit();
    document.getElementById('ppCsv').onclick = () => this.exportProfitCSV();
    this.loadProfit();
  },
  async loadProfit() {
    const { year, from, to } = readPeriod('pp');
    if (from > to) { alert('起始月份不可大於結束月份。'); return; }
    const area = document.getElementById('ppArea');
    area.innerHTML = '<div class="empty">查詢中...</div>';
    try {
      this._proj = await api(`/api/accounting/project-profit?year=${year}&from=${from}&to=${to}`);
      this.paintProfit();
    } catch (e) {
      this._proj = null;
      area.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  },
  paintProfit() {
    const { period: p, rows, summary: s } = this._proj;
    const card = (label, value, cls = '') =>
      `<div class="sum-card ${cls}"><div class="k">${esc(label)}</div><div class="v">${money(value)}</div></div>`;
    const profitCell = (v) => `<span class="${Number(v) < 0 ? 'neg-num' : ''}">${money(v)}</span>`;
    // 利潤% = 營收 ÷ 應收；無應收款時不計算
    const pctCell = (v) => (v === null || v === undefined || v === '') ? '—'
      : `<span class="${Number(v) < 0 ? 'neg-num' : ''}">${Number(v).toFixed(1)}%</span>`;

    const table = tableHtml([
      // 有專案權限才做成連結，否則純文字 (避免點了被擋)
      { key: 'proj_id', label: '專案編號', render: r =>
        (USER.perm_admin || USER.perm_project)
          ? `<a class="link" onclick="MODULES.project.detail('${r.proj_id}')">${esc(r.proj_id)}</a>`
          : esc(r.proj_id) },
      { key: 'proj_name', label: '專案名稱' },
      { key: 'cust_name', label: '客戶' },
      { key: 'proj_status', label: '專案狀態' },
      { key: 'ar_amount', label: '應收款項', num: true, render: r => money(r.ar_amount) },
      { key: 'ap_amount', label: '應付款項', num: true, render: r => money(r.ap_amount) },
      { key: 'profit', label: '營收金額', num: true, render: r => profitCell(r.profit) },
      { key: 'profit_pct', label: '利潤%', num: true, render: r => pctCell(r.profit_pct) },
      { key: 'sys_status', label: '狀態', render: r => r.sys_status ? statusBadge(r.sys_status) : '' },
    ], rows, ['合計', `${s.count} 筆`, '', '',
      money(s.ar_amount), money(s.ap_amount), profitCell(s.profit), pctCell(s.profit_pct), '']);

    document.getElementById('ppArea').innerHTML = `
      <div class="section-title">結算期間：${p.year} 年 ${p.from} 月 ～ ${p.to} 月</div>
      <div class="sum-grid">
        ${card('應收款項合計', s.ar_amount)}
        ${card('應付款項合計', s.ap_amount)}
        ${card('營收金額（應收－應付）', s.profit, 'hl ' + (s.profit < 0 ? 'neg' : ''))}
        <div class="sum-card ${s.profit_pct < 0 ? 'neg' : ''}"><div class="k">利潤%（營收÷應收）</div>
          <div class="v">${pctCell(s.profit_pct)}</div></div>
      </div>
      <div class="card" id="ppTable">${table}</div>`;
  },
  exportProfitCSV() {
    if (!this._proj) { alert('請先查詢報表。'); return; }
    const { period: p } = this._proj;
    const table = document.querySelector('#ppTable table');
    if (!table) { alert('目前沒有可匯出的明細。'); return; }
    const lines = [`"專案獲利","${p.year} 年 ${p.from} 月 ～ ${p.to} 月"`, '', ...tableToCsvLines(table)];
    downloadCSV(lines, `專案獲利_${p.year}年${p.from}-${p.to}月.csv`);
  },

  /* ── 分頁三：營業稅申報 401 (每 2 個月一期，依發票日期) ── */
  _vat: null,
  renderVat() {
    const now = new Date();
    const thisYear = now.getFullYear();
    const curTerm = Math.ceil((now.getMonth() + 1) / 2);
    const years = [];
    for (let y = thisYear + 1; y >= thisYear - 6; y--) years.push(y);
    const termOpts = [1, 2, 3, 4, 5, 6].map(t =>
      `<option value="${t}" ${t === curTerm ? 'selected' : ''}>第${t}期（${t * 2 - 1}-${t * 2}月）</option>`).join('');
    document.getElementById('rpBody').innerHTML = `
      <div class="toolbar">
        <span class="tb-label">年份</span>
        <select id="vtYear">${years.map(y => `<option ${y === thisYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <span class="tb-label">期別</span>
        <select id="vtTerm">${termOpts}</select>
        <button class="btn" id="vtSearch">查詢</button>
        <button class="btn ghost" id="vtCsv" style="margin-left:auto">匯出CSV</button>
      </div>
      <div class="hint" style="margin-bottom:10px">
        依「發票日期」歸期：銷項＝應收款有發票號碼者（作廢發票列出但不計金額）；進項＝憑證類別為「三聯式發票／電子發票(含統編)」者。
        未填發票日期的單據不會納入，請先補齊。金額供對帳參考，申報請以記帳士核算為準。
      </div>
      <div id="vtArea"><div class="empty">請選擇期別後按「查詢」</div></div>`;
    document.getElementById('vtSearch').onclick = () => this.loadVat();
    document.getElementById('vtCsv').onclick = () => this.exportVatCSV();
    this.loadVat();
  },
  async loadVat() {
    const year = Number(document.getElementById('vtYear').value);
    const term = Number(document.getElementById('vtTerm').value);
    const area = document.getElementById('vtArea');
    area.innerHTML = '<div class="empty">查詢中...</div>';
    try {
      this._vat = await api(`/api/accounting/vat-return?year=${year}&term=${term}`);
      this.paintVat();
    } catch (e) { this._vat = null; area.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  },
  paintVat() {
    const { period: p, sales, purchases, summary: s } = this._vat;
    const card = (label, value, cls = '') =>
      `<div class="sum-card ${cls}"><div class="k">${esc(label)}</div><div class="v">${money(value)}</div></div>`;
    const salesTable = tableHtml([
      { key: 'invoice_date', label: '發票日期', render: r => fmtDate(r.invoice_date) },
      { key: 'invoice_no', label: '發票號碼' },
      { key: 'ar_id', label: '收款單號' },
      { key: 'cust_name', label: '買受人' },
      { key: 'item', label: '項目' },
      { key: 'amount', label: '銷售額', num: true, render: r => r.invoice_void ? '—' : money(r.amount) },
      { key: 'tax', label: '稅額', num: true, render: r => r.invoice_void ? '—' : money(r.tax) },
      { key: '_v', label: '狀態', render: r => r.invoice_void ? '<span class="badge red">作廢</span>' : '<span class="badge green">開立</span>' },
    ], sales, ['合計', `${s.sales_count} 筆${s.void_count ? '（另作廢 ' + s.void_count + ' 筆）' : ''}`, '', '', '',
      money(s.sales_amount), money(s.sales_tax), '']);
    const purTable = tableHtml([
      { key: 'invoice_date', label: '發票日期', render: r => fmtDate(r.invoice_date) },
      { key: 'invoice_no', label: '發票號碼' },
      { key: 'doc_type', label: '憑證類別' },
      { key: 'ap_id', label: '付款單號' },
      { key: 'payee_name', label: '營業人/對象' },
      { key: 'item', label: '項目', render: r => esc(r.item || r.expense_category || '') },
      { key: 'amount', label: '金額', num: true, render: r => money(r.amount) },
      { key: 'tax_deduct', label: '可扣抵稅額', num: true, render: r => money(r.tax_deduct) },
    ], purchases, ['合計', `${s.purchase_count} 筆`, '', '', '', '',
      money(s.purchase_amount), money(s.purchase_tax)]);
    document.getElementById('vtArea').innerHTML = `
      <div class="section-title">申報期別：${p.year} 年（民國 ${p.roc_year} 年）第 ${p.term} 期（${p.months}）</div>
      <div class="sum-grid">
        ${card('銷項銷售額', s.sales_amount)}
        ${card('銷項稅額', s.sales_tax)}
        ${card('進項金額（可扣抵）', s.purchase_amount)}
        ${card('進項稅額', s.purchase_tax)}
        ${card(s.net_tax >= 0 ? '應納稅額（銷項－進項）' : '溢付稅額（銷項－進項）', s.net_tax, 'hl ' + (s.net_tax < 0 ? 'neg' : ''))}
      </div>
      ${s.other_purchase_count ? `<div class="hint" style="color:var(--warn);margin-bottom:10px">
        本期另有 ${s.other_purchase_count} 筆不可扣抵或未選憑證類別的應付憑證，未列入進項。</div>` : ''}
      <div class="section-title">銷項發票明細（${s.sales_count + s.void_count} 筆）</div>
      <div class="card" id="vtSales">${salesTable}</div>
      <div class="section-title">進項憑證明細（${s.purchase_count} 筆）</div>
      <div class="card" id="vtPur">${purTable}</div>`;
  },
  exportVatCSV() {
    if (!this._vat) { alert('請先查詢報表。'); return; }
    const { period: p, summary: s } = this._vat;
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [
      [q('營業稅申報(401)彙總'), q(`${p.year} 年(民國 ${p.roc_year} 年) 第 ${p.term} 期(${p.months})`)].join(','),
      '',
      [q('銷項銷售額'), q(s.sales_amount)].join(','),
      [q('銷項稅額'), q(s.sales_tax)].join(','),
      [q('進項金額(可扣抵)'), q(s.purchase_amount)].join(','),
      [q('進項稅額'), q(s.purchase_tax)].join(','),
      [q(s.net_tax >= 0 ? '應納稅額' : '溢付稅額'), q(s.net_tax)].join(','),
      '', [q('銷項發票明細')].join(','),
    ];
    const st = document.querySelector('#vtSales table');
    lines.push(...(st ? tableToCsvLines(st) : [q('查無資料')]));
    lines.push('', [q('進項憑證明細')].join(','));
    const pt = document.querySelector('#vtPur table');
    lines.push(...(pt ? tableToCsvLines(pt) : [q('查無資料')]));
    downloadCSV(lines, `營業稅401_${p.year}年第${p.term}期.csv`);
  },
};

// 員工薪資維護：實發金額 ＝ 應發 − 勞保自付 − 健保自付 − 所得稅扣繳
function calcSalaryNet() {
  const f = document.getElementById('modalForm');
  if (!f || !f.querySelector('[name=paid_amount]')) return;
  const n = (name) => Math.round(Number(f.querySelector(`[name=${name}]`)?.value)) || 0;
  f.querySelector('[name=paid_amount]').value =
    (window.__salGross || 0) - n('labor_ins') - n('health_ins') - n('salary_tax');
}

/* ── 帳號管理 ─────────────────────────────────────────── */
const PERM_LIST = [
  ['perm_admin', '系統管理者'], ['perm_customer', '客戶基本資料表'], ['perm_quote', '報價單'],
  ['perm_project', '專案管理資料表'], ['perm_vendor', '廠商基本資料表'], ['perm_payable', '應付款項'],
  ['perm_receivable', '應收款項'], ['perm_accounting', '會計'], ['perm_inventory', '庫存管理'],
];
MODULES.account = {
  title: '帳號管理', perm: 'perm_admin',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 員工代號 / 姓名 / 職務' });
    setTopAction('＋ 新增帳號', () => this.form());
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async load(q) {
    const rows = await api('/api/accounts?q=' + encodeURIComponent(q || ''));
    document.getElementById('listArea').innerHTML = pagedTable([
      { key: 'emp_id', label: '員工代號', render: r => `<a class="link" onclick="MODULES.account.detail('${r.emp_id}')">${esc(r.emp_id)}</a>` },
      { key: 'name', label: '姓名' },
      { key: 'title', label: '職務名稱' },
      { key: 'salary', label: '薪資', num: true, render: r => money(r.salary) },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
      { key: 'last_login', label: '最後登入', render: r => fmtDT(r.last_login) },
      { key: 'note', label: '備註' },
      { key: '_', label: '操作', render: r => `<div class="row-actions">
          <button class="btn sm" onclick="MODULES.account.form('${r.emp_id}')">修改</button>
          <button class="btn danger sm" onclick="MODULES.account.remove('${r.emp_id}')">刪除</button>
        </div>` },
    ], rows);
  },
  async detail(id) {
    const a = await api('/api/accounts/' + id);
    const perms = PERM_LIST.filter(([k]) => a[k]).map(([, l]) => l).join('、') || '（無）';
    openModal('帳號明細 ' + a.emp_id, `<dl class="dl">
      <dt>員工代號</dt><dd>${esc(a.emp_id)}</dd>
      <dt>姓名</dt><dd>${esc(a.name)}</dd>
      <dt>職務名稱</dt><dd>${esc(a.title)}</dd>
      <dt>薪資</dt><dd>${money(a.salary)}</dd>
      <dt>入職日期</dt><dd>${fmtDate(a.hire_date)}</dd>
      <dt>離職日期</dt><dd>${fmtDate(a.resign_date)}</dd>
      <dt>最後登入</dt><dd>${fmtDT(a.last_login)}</dd>
      <dt>狀態</dt><dd>${statusBadge(a.status)}</dd>
      <dt>權限</dt><dd>${esc(perms)}</dd>
      <dt>備註</dt><dd>${esc(a.note)}</dd>
    </dl>${a.status === '鎖住' ? '<div class="hint" style="margin-top:12px;color:var(--danger)">此帳號目前被鎖住,如需解鎖請按「修改」將狀態改為「正常」。</div>' : ''}`,
      `<button class="btn ghost" onclick="closeModal()">關閉</button>
      <button class="btn" onclick="MODULES.account.form('${a.emp_id}')">修改</button>
      <button class="btn danger" onclick="MODULES.account.remove('${a.emp_id}')">刪除</button>`);
  },
  async form(id) {
    const a = id ? await api('/api/accounts/' + id) : {};
    const permFields = PERM_LIST.map(([k, l]) => ({ name: k, label: '', type: 'checkbox', checkLabel: l, value: a[k] }));
    openForm({
      title: id ? '修改帳號 ' + id : '新增帳號',
      fields: [
        { name: 'name', label: '姓名', required: true, value: a.name },
        { name: 'title', label: '職務名稱', value: a.title },
        { name: 'salary', label: '薪資', type: 'number', step: '1', value: (id ? a.salary : 28000) },
        { name: 'password', label: '密碼', type: 'password', required: !id, hint: id ? '留空表示不變更' : '新帳號必填', value: '' },
        { name: 'hire_date', label: '入職日期', type: 'date', value: fmtDate(a.hire_date) },
        { name: 'resign_date', label: '離職日期', type: 'date', value: fmtDate(a.resign_date) },
        { name: 'status', label: '狀態', type: 'select', options: ['正常', '已離職', '鎖住'].map(s => `<option ${a.status === s ? 'selected' : ''}>${s}</option>`).join(''), hint: '被鎖住的帳號改為「正常」即完成解鎖(並歸零錯誤次數)' },
        ...permFields,
      ],
      extraHtml: `<div class="hint">勾選權限欄位 = 該帳號可使用該功能（"V"）。</div>`,
      onSubmit: async (v) => {
        if (!v.password) delete v.password;
        if (id) await api('/api/accounts/' + id, { method: 'PUT', body: v });
        else await api('/api/accounts', { method: 'POST', body: v });
        MODULES.account.render();
      },
    });
  },
  remove(id) {
    confirmDelete('確定刪除帳號 ' + id + '？', async () => {
      try { await api('/api/accounts/' + id, { method: 'DELETE' }); closeModal(); MODULES.account.render(); }
      catch (e) { alert(e.message); }
    });
  },
};

/* ── 門禁帳號 (僅系統管理者)：系統登入頁之前的外層關卡 ── */
MODULES.gate = {
  title: '門禁帳號', perm: 'perm_admin',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 門禁帳號 / 名稱 / 備註' });
    document.getElementById('content').insertAdjacentHTML('afterbegin', '<div id="gateStatus"></div>');
    setTopAction('＋ 新增門禁帳號', () => this.form());
    this.loadStatus();
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async loadStatus() {
    const s = await api('/api/gate/settings');
    const state = s.env_off ? '<span class="badge amber">已由 GATE_OFF 暫時略過</span>'
      : s.active ? '<span class="badge green">已開啟</span>'
      : '<span class="badge gray">未開啟</span>';
    document.getElementById('gateStatus').innerHTML = `<div class="card" style="padding:16px 18px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <b>門禁狀態</b>${state}
        <span class="hint">啟用中的門禁帳號：${s.active_count} 個</span>
        <span style="margin-left:auto">${s.enabled
          ? '<button class="btn danger sm" onclick="MODULES.gate.disable()">關閉門禁</button>'
          : '<button class="btn sm" onclick="MODULES.gate.enable()">開啟門禁</button>'}</span>
      </div>
      <div class="hint" style="margin-top:8px;line-height:1.7">開啟後，任何人都必須先在「門禁登入頁」輸入門禁帳號密碼，才看得到系統登入頁。
        門禁帳號與系統帳號分開，可以全公司共用一組，也可以每人一組。<br>
        同一門禁帳號連續錯誤 5 次會暫停 15 分鐘；停用、刪除或重設密碼後，正在使用該帳號的人會立即被請出。</div>
    </div>`;
  },
  async load(q) {
    const rows = await api('/api/gate/accounts?q=' + encodeURIComponent(q || ''));
    document.getElementById('listArea').innerHTML = pagedTable([
      { key: 'gate_id', label: '門禁帳號', render: r => `<a class="link" onclick="MODULES.gate.detail('${esc(r.gate_id)}')">${esc(r.gate_id)}</a>` },
      { key: 'name', label: '名稱' },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) + (r.locked ? ' <span class="badge red">暫停中</span>' : '') },
      { key: 'last_login', label: '最後登入', render: r => fmtDT(r.last_login) },
      { key: 'note', label: '備註' },
      { key: '_', label: '操作', render: r => `<div class="row-actions">
          <button class="btn sm" onclick="MODULES.gate.form('${esc(r.gate_id)}')">修改</button>
          <button class="btn danger sm" onclick="MODULES.gate.remove('${esc(r.gate_id)}')">刪除</button>
        </div>` },
    ], rows);
  },
  async detail(id) {
    const g = await api('/api/gate/accounts/' + encodeURIComponent(id));
    openModal('門禁帳號 ' + g.gate_id, `<dl class="dl">
      <dt>門禁帳號</dt><dd>${esc(g.gate_id)}</dd>
      <dt>名稱</dt><dd>${esc(g.name)}</dd>
      <dt>狀態</dt><dd>${statusBadge(g.status)}${g.locked ? ' <span class="badge red">錯誤次數過多，暫停中</span>' : ''}</dd>
      <dt>最後登入</dt><dd>${fmtDT(g.last_login)}</dd>
      <dt>密碼變更時間</dt><dd>${fmtDT(g.password_changed_at)}</dd>
      <dt>建立時間</dt><dd>${fmtDT(g.created_at)}</dd>
      <dt>備註</dt><dd>${esc(g.note)}</dd>
    </dl>`,
      `<button class="btn ghost" onclick="closeModal()">關閉</button>
      <button class="btn" onclick="MODULES.gate.form('${esc(g.gate_id)}')">修改</button>
      <button class="btn danger" onclick="MODULES.gate.remove('${esc(g.gate_id)}')">刪除</button>`);
  },
  async form(id) {
    const g = id ? await api('/api/gate/accounts/' + encodeURIComponent(id)) : {};
    const fields = [
      id ? { name: 'gate_id', label: '門禁帳號（不可修改）', type: 'locked', value: g.gate_id, display: g.gate_id }
        : { name: 'gate_id', label: '門禁帳號', required: true, hint: '3～32 個英文、數字或 _ . -' },
      { name: 'name', label: '名稱', required: true, value: g.name, hint: '例如：總公司共用、王小明' },
      { name: 'password', label: id ? '重設密碼' : '密碼', type: 'password', required: !id,
        hint: id ? '留空表示不變更；重設後正在使用的人會被請出' : '至少 8 個字元' },
      { name: 'status', label: '狀態', type: 'select', options: ['啟用', '停用'].map(s => `<option ${(g.status || '啟用') === s ? 'selected' : ''}>${s}</option>`).join('') },
      { name: 'note', label: '備註', type: 'textarea', full: true, value: g.note },
    ];
    if (g.locked) fields.push({ name: 'unlock', label: '', type: 'checkbox', checkLabel: '解除暫停（錯誤次數過多）', value: true });
    openForm({
      title: id ? '修改門禁帳號 ' + id : '新增門禁帳號',
      fields,
      onSubmit: async (v) => {
        if (!v.password) delete v.password;
        if (id) await api('/api/gate/accounts/' + encodeURIComponent(id), { method: 'PUT', body: v });
        else await api('/api/gate/accounts', { method: 'POST', body: v });
        MODULES.gate.render();
      },
    });
  },
  remove(id) {
    confirmDelete('確定刪除門禁帳號 ' + id + '？', async () => {
      try { await api('/api/gate/accounts/' + encodeURIComponent(id), { method: 'DELETE' }); closeModal(); MODULES.gate.render(); }
      catch (e) { alert(e.message); }
    });
  },
  // 開啟門禁前先確認一組門禁帳號密碼，避免開了之後自己也進不來
  async enable() {
    const rows = (await api('/api/gate/accounts?q=')).filter(r => r.status === '啟用');
    if (!rows.length) { alert('請先新增至少一個「啟用」的門禁帳號，再開啟門禁。'); return; }
    openForm({
      title: '開啟門禁',
      topHtml: '<div class="hint" style="margin-bottom:12px">請輸入一組門禁帳號的密碼，確認開啟後進得來。<br>開啟後，目前其他已登入的人下次操作時會先被導到門禁登入頁。</div>',
      fields: [
        { name: 'gate_id', label: '門禁帳號', type: 'select', options: options(rows, 'gate_id', 'gate_id', rows[0].gate_id, false) },
        { name: 'password', label: '門禁密碼', type: 'password', required: true },
      ],
      onSubmit: async (v) => {
        await api('/api/gate/settings', { method: 'PUT', body: { enabled: true, gate_id: v.gate_id, password: v.password } });
        alert('門禁已開啟。');
        MODULES.gate.render();
      },
    });
  },
  async disable() {
    if (!confirm('確定關閉門禁？關閉後任何人都能直接看到系統登入頁。')) return;
    try { await api('/api/gate/settings', { method: 'PUT', body: { enabled: false } }); MODULES.gate.render(); }
    catch (e) { alert(e.message); }
  },
};

/* ── 項目維護 (與「會計維護」相同權限：會計) ────────── */
const OPTION_EDITORS = [
  { cat: 'vendor_business', title: '廠商資料－營業項目', hint: '廠商「營業項目」複選清單' },
  { cat: 'vendor_payment', title: '廠商資料－結帳方式', hint: '廠商「結帳方式」單選清單' },
  { cat: 'receivable_item', title: '應收款項－項目', hint: '應收款項「項目」下拉清單' },
  { cat: 'receivable_receive_method', title: '應收款項－收款方式', hint: '應收款項「收款方式」下拉清單' },
  { cat: 'payable_item', title: '應付款項－項目', hint: '應付款項「項目」下拉清單' },
  { cat: 'payable_pay_method', title: '應付款項－付款方式', hint: '應付款項「付款方式」下拉清單' },
  { cat: 'expense_category', title: '應付款項－費用類別', hint: '非專案營業費用 (房租/水電…) 的類別清單' },
  { cat: 'project_status', title: '專案管理－專案狀態', hint: '專案「專案狀態」下拉清單' },
];
MODULES.sysmaint = {
  title: '項目維護', perm: 'perm_accounting',
  _data: {}, _meta: {},
  // 第一層：可維護的清單目錄，點進去才顯示內容
  render() {
    clearTopAction();
    document.getElementById('content').innerHTML = `
      <div class="hint" style="margin-bottom:16px">選擇要維護的清單，點「維護」進入後可新增／修改／刪除。</div>
      <div class="card"><table>
        <thead><tr><th>可維護清單</th><th>說明</th><th></th></tr></thead>
        <tbody>${OPTION_EDITORS.map(e => `<tr>
          <td><a class="link" onclick="MODULES.sysmaint.open('${e.cat}')">${esc(e.title)}</a></td>
          <td>${esc(e.hint)}</td>
          <td class="right"><button class="btn sm" onclick="MODULES.sysmaint.open('${e.cat}')">維護</button></td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  },
  // 第二層：進入某清單的編輯畫面
  async open(cat) {
    const e = OPTION_EDITORS.find(x => x.cat === cat);
    const values = await api('/api/options/' + cat);
    this._data[cat] = values.slice();
    this._meta[cat] = e;
    document.getElementById('content').innerHTML = `
      <div class="toolbar"><button class="btn ghost" onclick="MODULES.sysmaint.render()">← 返回清單目錄</button></div>
      <div id="opt_${cat}"></div>`;
    this.paint(cat);
  },
  paint(cat) {
    const e = this._meta[cat];
    const values = this._data[cat];
    const rows = values.length
      ? values.map((v, i) => `<tr>
          <td><input value="${esc(v)}" oninput="MODULES.sysmaint.edit('${cat}',${i},this.value)"
              style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px"></td>
          <td class="right"><button class="btn danger sm" onclick="MODULES.sysmaint.del('${cat}',${i})">刪除</button></td></tr>`).join('')
      : `<tr><td colspan="2" class="empty">尚無選項，請於下方新增</td></tr>`;
    document.getElementById('opt_' + cat).innerHTML = `
      <div class="section-title">${esc(e.title)}</div>
      <div class="card" style="padding:14px">
        <div class="hint" style="margin-bottom:8px">${esc(e.hint)}。可直接在欄位內修改文字。修改／新增／刪除後請按「儲存」。</div>
        <table class="subtable"><tbody>${rows}</tbody></table>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <input id="add_${cat}" placeholder="輸入新選項..." style="flex:1;min-width:180px;padding:8px 10px;border:1px solid var(--border);border-radius:8px"
            onkeydown="if(event.key==='Enter'){event.preventDefault();MODULES.sysmaint.add('${cat}');}">
          <button class="btn ghost" onclick="MODULES.sysmaint.add('${cat}')">＋ 新增</button>
          <button class="btn" onclick="MODULES.sysmaint.save('${cat}')">儲存</button>
        </div>
      </div>`;
  },
  edit(cat, i, val) { this._data[cat][i] = val; },   // 就地修改，不重繪以保留游標
  add(cat) {
    const inp = document.getElementById('add_' + cat);
    const v = inp.value.trim();
    if (!v) return;
    if (this._data[cat].some(x => x.trim() === v)) { alert('「' + v + '」已存在。'); return; }
    this._data[cat].push(v);
    this.paint(cat);
  },
  del(cat, i) { this._data[cat].splice(i, 1); this.paint(cat); },
  async save(cat) {
    // 去除空白與重複
    const clean = [];
    for (const v of this._data[cat].map(s => String(s).trim())) {
      if (v && !clean.includes(v)) clean.push(v);
    }
    try {
      await api('/api/options/' + cat, { method: 'PUT', body: { values: clean } });
      this._data[cat] = clean;
      this.paint(cat);
      alert('「' + this._meta[cat].title + '」已儲存。');
    } catch (e) { alert(e.message); }
  },
};

/* ── 首頁 (所有登入者皆可看；圖上各區塊可點選對應功能) ── */
// 依 home.png (1315x1196) 各卡片位置換算的百分比熱區
const HOME_SPOTS = [
  { key: 'customer',   l: 8.2,  t: 11.5, w: 36.5, h: 16.8 },   // 客戶資料
  { key: 'vendor',     l: 55.0, t: 11.5, w: 36.0, h: 16.8 },   // 廠商資料
  { key: 'quote',      l: 32.0, t: 34.0, w: 35.5, h: 14.5 },   // 報價資料
  { key: 'project',    l: 23.8, t: 51.5, w: 52.5, h: 18.2 },   // 專案管理
  { key: 'receivable', l: 8.2,  t: 75.5, w: 33.0, h: 16.0 },   // 應收帳款
  { key: 'payable',    l: 57.0, t: 75.5, w: 32.0, h: 16.0 },   // 應付帳款
];
// 從首頁圖點選功能：有權限才進入
function goFromHome(key) {
  if (canSee(key)) go(key);
  else alert('您的帳號沒有「' + (MENU.find(m => m[0] === key)?.[1] || '') + '」的權限，請聯絡系統管理者。');
}
MODULES.home = {
  title: '', always: true,
  render() {
    clearTopAction();
    document.getElementById('content').innerHTML =
      `<div id="homeReminders"></div>
      <div class="home-wrap"><div class="home-map">
        <img src="/img/home.png" alt="專案管理系統流程" class="home-img">
        ${HOME_SPOTS.map(s => `<a class="home-spot" title="前往${esc(MENU.find(m => m[0] === s.key)?.[1] || '')}"
          style="left:${s.l}%;top:${s.t}%;width:${s.w}%;height:${s.h}%"
          onclick="goFromHome('${s.key}')"></a>`).join('')}
      </div></div>`;
    this.loadReminders();
  },
  // 待辦提醒：依權限顯示 應收/應付到期、支票、階段逾期、驗收中、保固到期
  async loadReminders() {
    const box = document.getElementById('homeReminders');
    try {
      const r = await api('/api/reminders');
      const groups = [];
      const item = (icon, text, key) =>
        `<a class="rem-item" onclick="goFromHome('${key}')">${icon} ${text}</a>`;
      const d = (v) => fmtDate(v) || '—';
      const m = (v) => (v === null || v === undefined) ? '' : '，' + money(v) + ' 元';
      if (canSee('receivable')) {
        r.ar_overdue.forEach(x => groups.push(item('🔴', `應收逾期：${esc(x.name || '')}「${esc(x.item || '')}」應收日 ${d(x.due_date)}${m(x.amt)}`, 'receivable')));
        r.ar_soon.forEach(x => groups.push(item('🟡', `應收將到期：${esc(x.name || '')}「${esc(x.item || '')}」${d(x.due_date)}${m(x.amt)}`, 'receivable')));
      }
      if (canSee('payable')) {
        r.ap_overdue.forEach(x => groups.push(item('🔴', `應付逾期：${esc(x.name || '')}「${esc(x.item || '')}」應付日 ${d(x.due_date)}${m(x.amt)}`, 'payable')));
        r.ap_soon.forEach(x => groups.push(item('🟡', `應付將到期：${esc(x.name || '')}「${esc(x.item || '')}」${d(x.due_date)}${m(x.amt)}`, 'payable')));
        r.check_due.forEach(x => groups.push(item('🟠', `支票到期：${esc(x.name || '')} 票號 ${esc(x.item || '')} 到期 ${d(x.due_date)}${m(x.amt)}`, 'payable')));
      }
      if (canSee('project')) {
        r.stage_overdue.forEach(x => groups.push(item('🔴', `階段逾期：${esc(x.name || '')}「${esc(x.item || '')}」預定 ${d(x.due_date)}`, 'project')));
        r.accepting.forEach(x => groups.push(item('🔵', `驗收中：${esc(x.name || '')}（${esc(x.id)}）`, 'project')));
        r.warranty_due.forEach(x => groups.push(item('🟠', `保固將到期：${esc(x.name || '')} 到期 ${d(x.due_date)}`, 'project')));
      }
      if (!groups.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<div class="card rem-card">
        <div class="rem-head">📌 待辦提醒（${groups.length} 項）</div>
        <div class="rem-list">${groups.join('')}</div></div>`;
    } catch { box.innerHTML = ''; }
  },
};

/* ── 系統還原 (僅系統管理者，危險操作，多重保護) ────── */
function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}
MODULES.restore = {
  title: '系統還原', perm: 'perm_admin',
  render() {
    clearTopAction();
    document.getElementById('content').innerHTML = `
      <div class="card" style="padding:22px;max-width:660px">
        <div style="color:var(--danger);font-weight:700;font-size:17px;margin-bottom:10px">⚠️ 系統還原（危險操作）</div>
        <div class="hint" style="line-height:1.7;margin-bottom:16px">
          還原會<b style="color:var(--danger)">清空目前所有資料</b>，換成你選擇的備份檔內容。<br>
          備份「之後」新增或修改的資料將<b>全部遺失且無法復原</b>。<br>
          為安全起見，按下還原前系統會<b>自動下載一份「目前資料」的備份</b>到你的電腦(檔名 before-restore_…)，萬一還錯檔可用它救回。
        </div>
        <div class="field"><label>1. 選擇要還原的備份檔（.json）</label>
          <input type="file" id="restoreFile" accept="application/json,.json"></div>
        <div class="field"><label>2. 請輸入「確定還原」四個字以確認</label>
          <input type="text" id="restoreConfirm" placeholder="確定還原"></div>
        <button class="btn danger" id="restoreBtn">執行還原</button>
        <div class="hint" id="restoreMsg" style="margin-top:12px"></div>
      </div>`;
    document.getElementById('restoreBtn').onclick = () => this.doRestore();
  },
  async doRestore() {
    const fileInput = document.getElementById('restoreFile');
    const confirmTxt = document.getElementById('restoreConfirm').value.trim();
    const msg = document.getElementById('restoreMsg');
    if (confirmTxt !== '確定還原') { alert('請輸入「確定還原」四個字以確認。'); return; }
    if (!fileInput.files.length) { alert('請先選擇要還原的備份檔。'); return; }
    if (!window.confirm('最後確認：這會清空目前所有資料，並還原到備份檔的狀態。確定要執行嗎？')) return;
    const btn = document.getElementById('restoreBtn');
    btn.disabled = true; btn.textContent = '處理中...';
    try {
      msg.textContent = '① 正在下載「目前資料」備份到你的電腦…';
      const cur = await api('/api/admin/export');
      downloadJSON(cur, 'before-restore_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json');
      msg.textContent = '② 正在讀取備份檔…';
      const data = JSON.parse(await fileInput.files[0].text());
      msg.textContent = '③ 正在還原資料庫…';
      await api('/api/admin/restore', { method: 'POST', body: { confirm: confirmTxt, data } });
      alert('✅ 還原完成！系統將登出，請用「備份當時」的帳號密碼重新登入。');
      await api('/api/logout', { method: 'POST' });
      location.href = '/';
    } catch (e) {
      msg.textContent = '';
      alert('還原失敗：' + e.message);
      btn.disabled = false; btn.textContent = '執行還原';
    }
  },
};

/* ── 備份設定 (僅系統管理者)：自動備份的週期、時間、保留份數與備份位置 ── */
MODULES.backup = {
  title: '備份設定', perm: 'perm_admin',
  DOW: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
  async render() {
    clearTopAction();
    document.getElementById('content').innerHTML = '<div class="hint">載入中…</div>';
    const info = await api('/api/backup/settings');
    this.draw(info);
  },
  draw(info) {
    const s = info.settings, st = info.state;
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const state = !s.enabled ? '<span class="badge gray">未啟用</span>'
      : st.running ? '<span class="badge amber">備份執行中</span>'
      : '<span class="badge green">已啟用</span>';
    const last = !st.last_at ? '<span class="hint">尚未備份過</span>'
      : `<span class="badge ${st.last_ok ? 'green' : 'red'}">${st.last_ok ? '成功' : '失敗'}</span> ${esc(st.last_at)}
         <div class="hint" style="margin-top:4px">${esc(st.last_msg)}</div>`;
    const gdrive = info.gdrive_configured
      ? '<span class="badge green">已設定</span> <span class="hint">沿用 .env / Render 環境變數的 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、GOOGLE_REFRESH_TOKEN、GOOGLE_FOLDER_ID</span>'
      : '<span class="badge amber">未設定</span> <span class="hint">請先依自學講義第 6 章取得四個值，填進 .env（本機）或 Render 的 Environment（線上版）後重新啟動</span>';
    document.getElementById('content').innerHTML = `
      <div class="card" style="padding:18px 22px;max-width:760px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <b>自動備份</b>${state}
          ${s.enabled && st.next_at ? `<span class="hint">下次預定：${esc(st.next_at)}</span>` : ''}
          <span style="margin-left:auto;display:flex;gap:8px">
            <button class="btn sm" id="bkRunBtn">立即備份</button>
            <button class="btn ghost sm" id="bkTestBtn">測試雲端硬碟連線</button>
          </span>
        </div>
        <div style="margin-top:12px"><b style="font-size:13px">上次備份：</b>${last}</div>
        <div class="hint" id="bkMsg" style="margin-top:8px"></div>
      </div>

      <div class="card" style="padding:18px 22px;max-width:760px">
        <form id="bkForm"><div class="form-grid">
          <div class="field full"><label style="font-weight:600;display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" name="enabled" style="width:18px;height:18px;margin:0" ${s.enabled ? 'checked' : ''}> 啟用自動備份</label></div>
          <div class="field"><label>週期</label>
            <select name="freq" onchange="MODULES.backup.freqChanged(this.value)">${opt([['daily', '每天'], ['weekly', '每週'], ['monthly', '每月']], s.freq)}</select></div>
          <div class="field" id="bkDow" style="${s.freq === 'weekly' ? '' : 'display:none'}"><label>星期幾</label>
            <select name="dow">${opt(this.DOW.map((l, i) => [i, l]), s.dow)}</select></div>
          <div class="field" id="bkDom" style="${s.freq === 'monthly' ? '' : 'display:none'}"><label>每月幾號</label>
            <select name="dom">${opt(Array.from({ length: 28 }, (_, i) => [i + 1, (i + 1) + ' 號']), s.dom)}</select>
            <div class="hint">最多到 28 號，避免小月沒有 29～31 號而跳過</div></div>
          <div class="field"><label>時間</label><input type="time" name="time" value="${esc(s.time)}" required>
            <div class="hint">伺服器時間（${esc(info.timezone || '本機時區')}），現在 ${esc(info.server_now)}</div></div>
          <div class="field"><label>保留份數</label><input type="number" name="keep" min="1" max="100" value="${esc(s.keep)}" required>
            <div class="hint">超過的舊備份自動刪除</div></div>
          <div class="field"><label>備份位置</label>
            <select name="dest" onchange="MODULES.backup.destChanged(this.value)">${opt([['gdrive', 'Google 雲端硬碟（線上版請選這個）'], ['local', '這台電腦的資料夾（只限本機版）']], s.dest)}</select></div>
          <div class="field full" id="bkGdrive" style="${s.dest === 'gdrive' ? '' : 'display:none'}"><label>Google 雲端硬碟設定</label>${gdrive}</div>
          <div class="field full" id="bkLocal" style="${s.dest === 'local' ? '' : 'display:none'}"><label>資料夾路徑</label>
            <input type="text" name="local_dir" value="${esc(s.local_dir)}" placeholder="例如 D:\\pms備份，或 Google 雲端硬碟桌面版的同步資料夾">
            <div class="hint">${info.on_render ? '<b style="color:var(--danger)">你正在線上版（Render）：主機硬碟重新部署就會清空，請改選 Google 雲端硬碟。</b>' : '資料夾不存在會自動建立。填 Google 雲端硬碟桌面版的同步資料夾，就會自動同步到雲端，不用申請任何金鑰。'}</div></div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:6px">
          <button class="btn" type="submit" id="bkSaveBtn">儲存設定</button>
        </div></form>
        <div class="hint" style="margin-top:14px;line-height:1.7">
          備份內容與「系統還原」頁使用的匯出檔相同（不含結案附件的實體檔案），需要時到「系統還原」選擇備份檔即可還原。<br>
          系統每分鐘檢查一次時間；若當時電腦沒開或線上版主機正在休眠，會在下次啟動或被喚醒時<b>自動補做一次</b>。
          線上版建議把時間設在上班時段內（自學講義步驟 7-4 的防休眠時段）。<br>
          ${info.external_enabled
            ? `也可以用 cron-job.org 等外部服務定時打開 <code>${esc(location.origin)}/api/backup/trigger?key=（你設定的 BACKUP_KEY）</code> 來觸發備份。`
            : '若想改用 cron-job.org 等外部服務定時觸發，請設定環境變數 BACKUP_KEY（見 .env.example）。'}
        </div>
      </div>`;
    document.getElementById('bkForm').onsubmit = (e) => { e.preventDefault(); this.save(e.target); };
    document.getElementById('bkRunBtn').onclick = () => this.runNow();
    document.getElementById('bkTestBtn').onclick = () => this.test();
  },
  freqChanged(v) {
    document.getElementById('bkDow').style.display = v === 'weekly' ? '' : 'none';
    document.getElementById('bkDom').style.display = v === 'monthly' ? '' : 'none';
  },
  destChanged(v) {
    document.getElementById('bkGdrive').style.display = v === 'gdrive' ? '' : 'none';
    document.getElementById('bkLocal').style.display = v === 'local' ? '' : 'none';
  },
  async save(form) {
    const fd = new FormData(form);
    const body = {
      enabled: fd.get('enabled') === 'on', freq: fd.get('freq'), dow: Number(fd.get('dow')), dom: Number(fd.get('dom')),
      time: fd.get('time'), keep: Number(fd.get('keep')), dest: fd.get('dest'), local_dir: (fd.get('local_dir') || '').trim(),
    };
    const btn = document.getElementById('bkSaveBtn');
    btn.disabled = true; btn.textContent = '儲存中...';
    try {
      const info = await api('/api/backup/settings', { method: 'PUT', body });
      this.draw(info);
      document.getElementById('bkMsg').textContent = '✅ 設定已儲存' + (info.settings.enabled ? '，下次預定：' + info.state.next_at : '。');
    } catch (e) {
      alert(e.message);
      btn.disabled = false; btn.textContent = '儲存設定';
    }
  },
  async runNow() {
    const btn = document.getElementById('bkRunBtn');
    const msg = document.getElementById('bkMsg');
    btn.disabled = true; btn.textContent = '備份中...'; msg.textContent = '正在依目前「已儲存」的設定執行備份…';
    try {
      const info = await api('/api/backup/run', { method: 'POST' });
      this.draw(info);
      document.getElementById('bkMsg').textContent = '✅ 備份完成。';
    } catch (e) {
      msg.textContent = '';
      alert('備份失敗：' + e.message);
      btn.disabled = false; btn.textContent = '立即備份';
    }
  },
  async test() {
    const btn = document.getElementById('bkTestBtn');
    const msg = document.getElementById('bkMsg');
    btn.disabled = true; btn.textContent = '測試中...';
    try {
      const r = await api('/api/backup/test', { method: 'POST' });
      msg.textContent = `✅ 連線成功。資料夾內已有 ${r.count} 份備份${r.latest ? '，最新：' + r.latest : ''}。`;
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
    }
    btn.disabled = false; btn.textContent = '測試雲端硬碟連線';
  },
};

/* ── 庫存管理 (perm_inventory)：入庫單 / 領料單 / 料號基本資料 / 庫存報表 ──
   目前庫存 = 期初數量 + 入庫合計 − 領料合計，由後端依單據即時計算。 */
MODULES.inventory = {
  title: '庫存管理', perm: 'perm_inventory',
  _tab: 'si',
  render() {
    document.getElementById('topActions').innerHTML = `
      <button class="btn ghost" onclick="MODULES.inventory.report()">庫存報表</button>
      <button class="btn ghost" onclick="MODULES.inventory.outForm()">＋ 領料單</button>
      <button class="btn" onclick="MODULES.inventory.inForm()">＋ 入庫單</button>`;
    document.getElementById('content').innerHTML = `
      <div class="tabs">
        <button class="tab" id="tabSI" onclick="MODULES.inventory.tab('si')">入庫單</button>
        <button class="tab" id="tabSO" onclick="MODULES.inventory.tab('so')">領料單</button>
      </div>
      <div class="toolbar">
        <input class="search" id="invSearch" placeholder="搜尋 料號 / 品名 / 規格 / 廠商名稱 / 單號">
        <button class="btn" id="invSearchBtn">搜尋</button>
        <button class="btn ghost" id="exportCsvBtn" style="margin-left:auto">匯出CSV</button>
      </div>
      <div class="hint" id="invHint" style="margin-bottom:10px"></div>
      <div class="card"><div id="listArea"><div class="empty">載入中...</div></div></div>`;
    document.getElementById('invSearchBtn').onclick = () => this.load(document.getElementById('invSearch').value.trim());
    document.getElementById('invSearch').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
    document.getElementById('exportCsvBtn').onclick = () => exportListCSV();
    this.tab(this._tab || 'si');
  },
  tab(which) {
    this._tab = which;
    document.getElementById('tabSI').classList.toggle('active', which === 'si');
    document.getElementById('tabSO').classList.toggle('active', which === 'so');
    document.getElementById('invHint').textContent = which === 'si'
      ? '預設顯示近一個月的入庫單，依日期遞減；搜尋關鍵字將涵蓋所有期間。'
      : '預設顯示近一個月的領料單，依日期遞減；搜尋關鍵字將涵蓋所有期間。';
    this.load(document.getElementById('invSearch').value.trim());
  },
  async load(q) {
    const isIn = this._tab === 'si';
    const rows = await api(`/api/inventory/${this._tab}?q=` + encodeURIComponent(q || ''));
    const cols = [
      { key: 'doc_id', label: isIn ? '入庫單號' : '領料單號', render: r => `<a class="link" onclick="MODULES.inventory.${isIn ? 'inForm' : 'outForm'}('${r.doc_id}')">${esc(r.doc_id)}</a>` },
      { key: 'doc_date', label: '日期', render: r => fmtDate(r.doc_date) },
      { key: 'mat_id', label: '料號' },
      { key: 'name', label: '品名' },
      { key: 'spec', label: '規格' },
      { key: 'vend_name', label: '廠商' },
      { key: 'qty', label: '數量', num: true, render: r => money(r.qty) },
      { key: 'unit_price', label: '單價', num: true, render: r => money(r.unit_price) },
      { key: 'amount', label: '金額', num: true, render: r => money(Math.round(r.qty * r.unit_price)) },
    ];
    if (!isIn) cols.push({ key: 'proj_id', label: '專案', render: r => r.proj_id ? `${esc(r.proj_id)} ${esc(r.proj_name || '')}` : '' });
    cols.push({ key: 'emp_name', label: isIn ? '入庫人員' : '領料人員' });
    cols.push({ key: 'note', label: '備註' });
    cols.push({ key: '_', label: '操作', render: r => `<div class="row-actions">
        <button class="btn sm" onclick="MODULES.inventory.${isIn ? 'inForm' : 'outForm'}('${r.doc_id}')">修改</button>
        <button class="btn danger sm" onclick="MODULES.inventory.removeDoc('${this._tab}','${r.doc_id}')">刪除</button></div>` });
    const total = rows.reduce((t, r) => t + Math.round(r.qty * r.unit_price), 0);
    const footer = cols.map(c => c.key === 'amount' ? money(total) : (c.key === 'unit_price' ? '合計' : ''));
    document.getElementById('listArea').innerHTML = rows.length ? pagedTable(cols, rows, footer) : '<div class="empty">查無資料</div>';
  },

  /* ── 入庫單 / 領料單 表單 (共用) ── */
  inForm(id, preset) { return this.docForm('si', id, preset); },
  outForm(id, preset) { return this.docForm('so', id, preset); },
  async docForm(kind, id, preset = {}) {
    const isIn = kind === 'si';
    const d = id ? await api(`/api/inventory/${kind}/${id}`) : {};
    const [emps, mats] = [await getLookup('employees'), await api('/api/inventory/materials')];
    const projs = isIn ? [] : await getLookup('projects');
    window.__invMats = mats;                          // 供 invMatChanged 查詢
    const v = { ...d, ...preset };
    const mat = mats.find(m => m.mat_id === v.mat_id);
    const dl = `<datalist id="invMatList">${mats.map(m => `<option value="${esc(m.mat_id)}">${esc(m.name)} ${esc(m.spec || '')}</option>`).join('')}</datalist>`;
    const fields = [
      { name: 'doc_date', label: '日期', type: 'date', required: true, value: fmtDate(v.doc_date) || localISO() },
      { name: 'mat_id', label: '料號', required: true, type: 'text', value: v.mat_id || '', list: 'invMatList', onchange: 'invMatChanged(this)',
        hint: isIn ? '輸入料號，或按「查詢」搜尋料號／品名／廠商；查不到可直接新增料號' : '輸入料號，或按「查詢」搜尋料號／品名／廠商' },
      { name: '_name', label: '品名', value: mat ? mat.name : '', readonly: true },
      { name: '_spec', label: '規格', value: mat ? (mat.spec || '') : '', readonly: true },
      { name: '_vend', label: '廠商', value: mat ? (mat.vend_name || '') : '', readonly: true },
      { name: '_stock', label: '目前庫存', value: mat ? money(mat.stock) : '', readonly: true },
      { name: 'qty', label: '數量', type: 'number', step: '1', required: true, value: v.qty !== undefined ? Math.round(v.qty) : '' },
      { name: 'unit_price', label: '單價', type: 'number', step: '1', value: v.unit_price !== undefined ? Math.round(v.unit_price) : (mat ? Math.round(mat.unit_price) : ''), hint: '預設帶料號基本資料的單價，可修改' },
    ];
    if (!isIn) fields.push({ name: 'proj_id', label: '專案編號', type: 'select', options: options(projs, 'proj_id', 'proj_name', v.proj_id) });
    fields.push({ name: 'emp_id', label: isIn ? '入庫人員' : '領料人員', type: 'select', options: options(emps, 'emp_id', 'name', v.emp_id || USER.emp_id, false) });
    fields.push({ name: 'note', label: '備註', type: 'textarea', full: true, value: v.note });
    openForm({
      title: (id ? '修改' : '新增') + (isIn ? '入庫單' : '領料單') + (id ? ' ' + id : ''),
      topHtml: dl + `<div id="invMatBar" class="hint" style="margin-bottom:10px">${mat ? '' : '請先輸入料號。'}</div>`,
      fields,
      onSubmit: async (val) => {
        for (const k of Object.keys(val)) if (k.startsWith('_')) delete val[k];
        if (isIn) val.in_date = val.doc_date; else val.out_date = val.doc_date;
        if (id) await api(`/api/inventory/${kind}/${id}`, { method: 'PUT', body: val });
        else await api(`/api/inventory/${kind}`, { method: 'POST', body: val });
        MODULES.inventory._tab = kind;
        MODULES.inventory.render();
      },
    });
    // 料號欄位接上 datalist (openForm 的一般欄位沒有 list 屬性，這裡補上)
    const inp = document.querySelector('#modalForm [name=mat_id]');
    if (inp) {
      inp.setAttribute('list', 'invMatList'); inp.setAttribute('autocomplete', 'off');
      const row = document.createElement('div'); row.className = 'input-row';
      inp.parentNode.insertBefore(row, inp); row.appendChild(inp);
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn ghost'; btn.textContent = '查詢';
      btn.onclick = () => openMatPicker({ allowCreate: isIn, initial: inp.value.trim() });
      row.appendChild(btn);
    }
    window.__invFormCtx = { kind, id };
  },
  // 從入庫/領料表單按「新增料號」：先記住目前填的內容，建完料號再回來
  newMaterialFromDoc() {
    const f = document.getElementById('modalForm');
    const fd = new FormData(f);
    const preset = {};
    for (const [k, val] of fd.entries()) if (!k.startsWith('_')) preset[k] = val;
    const ctx = window.__invFormCtx || { kind: 'si' };
    const typed = preset.mat_id; delete preset.mat_id;
    this.matForm(null, {
      presetName: /^MA\d{5}$/i.test(typed || '') ? '' : (typed || ''),
      after: (m) => this.docForm(ctx.kind, ctx.id, { ...preset, mat_id: m.mat_id, unit_price: preset.unit_price || Math.round(m.unit_price) }),
    });
  },
  removeDoc(kind, id) {
    confirmDelete(`確定刪除${kind === 'si' ? '入庫單' : '領料單'} ${id}？庫存會跟著重算。`, async () => {
      try { await api(`/api/inventory/${kind}/${id}`, { method: 'DELETE' }); closeModal(); MODULES.inventory.render(); }
      catch (e) { alert(e.message); }
    });
  },

  /* ── 料號基本資料 ── */
  async matForm(id, opts = {}) {
    const m = id ? await api('/api/inventory/materials/' + id) : {};
    const p = opts.preset || {};                      // 從「新增廠商」回來時，保留先前填的內容
    const vends = await api('/api/lookups/vendors'); // 不吃快取：剛新增的廠商要出現在下拉
    const emps = await getLookup('employees');
    openForm({
      title: id ? '修改料號 ' + id : '新增料號',
      fields: [
        id ? { name: 'mat_id', label: '料號（不可修改）', type: 'locked', value: m.mat_id, display: m.mat_id }
           : { name: '_mat_id', label: '料號', value: '儲存後自動產生（MA + 5 碼流水號）', readonly: true },
        { name: 'name', label: '品名', required: true, value: p.name ?? (m.name || opts.presetName || '') },
        { name: 'spec', label: '規格', value: p.spec ?? m.spec },
        { name: 'vend_id', label: '廠商', type: 'select', options: options(vends, 'vend_id', 'company_name', p.vend_id ?? m.vend_id),
          hint: '可從下拉選，或按「查詢」搜尋公司名稱／業務／統編；查不到可直接新增廠商' },
        { name: 'init_qty', label: id ? '期初數量' : '數量（期初）', type: 'number', step: '1', value: p.init_qty ?? (id ? Math.round(m.init_qty) : 0),
          hint: '建檔當下的數量；之後的增減請用入庫單、領料單' },
        { name: 'unit_price', label: '單價', type: 'number', step: '1', value: p.unit_price ?? (id ? Math.round(m.unit_price) : 0) },
        { name: 'maintainer', label: '維護窗口', type: 'select', options: options(emps, 'emp_id', 'name', p.maintainer || m.maintainer || USER.emp_id, false) },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: p.note ?? m.note },
      ],
      extraHtml: id ? `<div class="hint">目前庫存 ${money(m.stock)}（期初 ${money(m.init_qty)} ＋ 入庫 ${money(m.in_qty)} － 領料 ${money(m.out_qty)}）</div>` : '',
      onSubmit: async (v) => {
        delete v._mat_id;
        let saved;
        if (id) { await api('/api/inventory/materials/' + id, { method: 'PUT', body: v }); saved = { mat_id: id, ...v }; }
        else saved = await api('/api/inventory/materials', { method: 'POST', body: v });
        if (opts.after) { closeModal(); await opts.after(saved); }
        else if (opts.backToReport) { closeModal(); MODULES.inventory.report(); }
        else MODULES.inventory.render();
      },
    });
    // 廠商欄位旁加「查詢」按鈕 (另開廠商查詢視窗)
    const vs = document.querySelector('#modalForm [name=vend_id]');
    if (vs) {
      const row = document.createElement('div'); row.className = 'input-row';
      vs.parentNode.insertBefore(row, vs); row.appendChild(vs);
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn ghost'; btn.textContent = '查詢';
      btn.onclick = () => openVendPicker({ initial: '' });
      row.appendChild(btn);
    }
    window.__matFormCtx = { id, opts };
  },
  // 從料號表單按「新增廠商」：記住目前填的內容，建完廠商回到料號表單並選好該廠商
  newVendorFromMat(keyword) {
    const f = document.getElementById('modalForm');
    const preset = {};
    if (f) { const fd = new FormData(f); for (const [k, v] of fd.entries()) if (!k.startsWith('_') && k !== 'mat_id') preset[k] = v; }
    const ctx = window.__matFormCtx || { id: null, opts: {} };
    MODULES.vendor.form(null, {
      presetName: keyword || '',
      after: (v) => this.matForm(ctx.id, { ...ctx.opts, preset: { ...preset, vend_id: v.vend_id } }),
    });
  },
  removeMaterial(id) {
    confirmDelete('確定刪除料號 ' + id + '？', async () => {
      try { await api('/api/inventory/materials/' + id, { method: 'DELETE' }); MODULES.inventory.report(); }
      catch (e) { alert(e.message); }
    });
  },

  /* ── 庫存報表 (盤點用) ── */
  async report() {
    const r = await api('/api/inventory/report');
    window.__invReport = r;
    const rows = r.rows.map(m => `<tr>
      <td>${esc(m.mat_id)}</td><td>${esc(m.name)}</td><td>${esc(m.spec)}</td><td>${esc(m.vend_name)}</td>
      <td class="num">${money(m.unit_price)}</td><td class="num">${money(m.init_qty)}</td>
      <td class="num">${money(m.in_qty)}</td><td class="num">${money(m.out_qty)}</td>
      <td class="num"><b>${money(m.stock)}</b></td><td class="num">${money(Math.round(m.stock * m.unit_price))}</td>
      <td></td><td></td>
      <td><div class="row-actions"><button class="btn sm" onclick="MODULES.inventory.matForm('${m.mat_id}', { backToReport: true })">修改</button>
        <button class="btn danger sm" onclick="MODULES.inventory.removeMaterial('${m.mat_id}')">刪除</button></div></td></tr>`).join('')
      || '<tr><td colspan="13" class="empty">尚無料號。新增入庫單時可建立料號。</td></tr>';
    openModal(`庫存報表（${r.as_of}）`, `
      <div class="detail-actions">
        <span class="hint" style="margin-right:auto">共 ${r.summary.count} 個料號，庫存金額 ${money(r.summary.total_value)}（目前庫存 × 單價）。「盤點數量」「差異」留白供現場填寫。</span>
        <button class="btn ghost" onclick="MODULES.inventory.matForm(null, { backToReport: true })">＋ 新增料號</button>
        <button class="btn ghost" onclick="MODULES.inventory.reportExcel()">匯出Excel</button>
        <button class="btn" onclick="MODULES.inventory.reportPrint()">列印</button>
      </div>
      <div class="subtable-wrap"><table class="subtable" id="invReportTable"><thead><tr>
        <th>料號</th><th>品名</th><th>規格</th><th>廠商</th><th class="num">單價</th><th class="num">期初</th>
        <th class="num">入庫</th><th class="num">領料</th><th class="num">目前庫存</th><th class="num">庫存金額</th>
        <th>盤點數量</th><th>差異</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`,
      `<button class="btn ghost" onclick="closeModal()">關閉</button>`);
  },
  async reportExcel() {
    try {
      const [X, r] = [await loadXLSX(), window.__invReport || await api('/api/inventory/report')];
      const aoa = [['庫存盤點表', r.as_of], [],
        ['料號', '品名', '規格', '廠商', '單價', '期初', '入庫', '領料', '目前庫存', '庫存金額', '盤點數量', '差異', '備註']];
      r.rows.forEach(m => aoa.push([m.mat_id, m.name, m.spec || '', m.vend_name || '', Math.round(m.unit_price), Math.round(m.init_qty),
        Math.round(m.in_qty), Math.round(m.out_qty), Math.round(m.stock), Math.round(m.stock * m.unit_price), null, null, m.note || '']));
      const ws = X.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [10, 22, 16, 18, 9, 7, 7, 7, 9, 11, 9, 7, 20].map(w => ({ wch: w }));
      const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, '庫存盤點表');
      X.writeFile(wb, `庫存盤點表_${r.as_of}.xlsx`);
    } catch (e) { alert(e.message); }
  },
  reportPrint() {
    const r = window.__invReport; if (!r) return;
    const rows = r.rows.map(m => `<tr><td>${esc(m.mat_id)}</td><td>${esc(m.name)}</td><td>${esc(m.spec)}</td><td>${esc(m.vend_name)}</td>
      <td class="r">${money(m.unit_price)}</td><td class="r">${money(m.in_qty)}</td><td class="r">${money(m.out_qty)}</td>
      <td class="r"><b>${money(m.stock)}</b></td><td style="width:70px"></td><td style="width:60px"></td><td></td></tr>`).join('');
    printHtml(`<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>庫存盤點表_${esc(r.as_of)}</title><style>
      *{font-family:"Microsoft JhengHei","Segoe UI",sans-serif;box-sizing:border-box;} body{margin:0;color:#222;} .wrap{padding:20px;}
      h1{font-size:20px;margin:0 0 4px;} .sub{color:#666;font-size:12px;margin-bottom:12px;}
      table{border-collapse:collapse;width:100%;font-size:12px;} th,td{border:1px solid #bbb;padding:5px 7px;} thead th{background:#eef6d8;}
      td.r{text-align:right;} .foot{margin-top:18px;font-size:12px;display:flex;gap:40px;}
      @page{margin:14mm;} @media print{thead{display:table-header-group;} tr{page-break-inside:avoid;}}
      </style></head><body onload="setTimeout(function(){window.focus();window.print();},250)"><div class="wrap">
      <h1>庫存盤點表</h1><div class="sub">基準日：${esc(r.as_of)}　料號 ${r.summary.count} 個　庫存金額 ${money(r.summary.total_value)}</div>
      <table><thead><tr><th>料號</th><th>品名</th><th>規格</th><th>廠商</th><th>單價</th><th>入庫</th><th>領料</th><th>帳面庫存</th><th>盤點數量</th><th>差異</th><th>備註</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="foot"><span>盤點人：＿＿＿＿＿＿</span><span>複核：＿＿＿＿＿＿</span><span>日期：＿＿＿＿＿＿</span></div>
      </div></body></html>`);
  },
};
// 入庫/領料表單：料號改變時帶出品名/規格/廠商/庫存/單價；查無料號時顯示「新增料號」
function invMatChanged(inp) {
  const f = inp.form; const id = inp.value.trim().toUpperCase(); inp.value = id;
  const m = (window.__invMats || []).find(x => x.mat_id === id);
  const set = (n, v) => { const el = f.querySelector(`[name=${n}]`); if (el) el.value = v; };
  const bar = document.getElementById('invMatBar');
  if (m) {
    set('_name', m.name); set('_spec', m.spec || ''); set('_vend', m.vend_name || ''); set('_stock', money(m.stock));
    const up = f.querySelector('[name=unit_price]'); if (up && !up.value) up.value = Math.round(m.unit_price);
    if (bar) bar.innerHTML = '';
  } else {
    set('_name', ''); set('_spec', ''); set('_vend', ''); set('_stock', '');
    const canCreate = (window.__invFormCtx || {}).kind !== 'so';
    if (bar) bar.innerHTML = id
      ? `<span style="color:var(--danger)">查無料號「${esc(id)}」。</span> <button type="button" class="btn sm" onclick="openMatPicker({ allowCreate: ${canCreate}, initial: '${esc(id)}' })">查詢</button>`
        + (canCreate ? ` <button type="button" class="btn sm" onclick="MODULES.inventory.newMaterialFromDoc()">＋ 新增料號</button>` : '')
      : '請先輸入料號，或按「查詢」。';
  }
}


/* ── 料號查詢視窗 (疊在入庫/領料表單上面，表單內容不會不見) ──
   搜尋 料號/品名/規格/廠商 → 點「選擇」帶回表單；入庫單查不到時可「＋ 新增料號」 */
function openMatPicker(opts = {}) {
  closeMatPicker();
  const allowCreate = !!opts.allowCreate;
  const mask = document.createElement('div');
  mask.id = 'matPickerMask'; mask.className = 'picker-mask';
  mask.innerHTML = `<div class="picker" role="dialog" aria-label="查詢料號">
    <div class="modal-head"><h3>查詢料號</h3><button class="close-x" type="button" onclick="closeMatPicker()">&times;</button></div>
    <div class="picker-body">
      <div class="toolbar" style="margin-bottom:10px">
        <input class="search" id="matPickerQ" placeholder="料號 / 品名 / 規格 / 廠商名稱" value="${esc(opts.initial || '')}">
        <button class="btn" type="button" onclick="matPickerSearch()">搜尋</button>
        ${allowCreate ? '<button class="btn ghost" type="button" style="margin-left:auto" onclick="matPickerCreate()">＋ 新增料號</button>' : ''}
      </div>
      <div class="hint" id="matPickerHint" style="margin-bottom:8px">搜尋框空白直接按「搜尋」＝列出全部料號；點「選擇」帶回表單。</div>
      <div class="card" style="padding:0"><div id="matPickerList"><div class="empty">載入中...</div></div></div>
    </div></div>`;
  mask.onclick = (e) => { if (e.target === mask) closeMatPicker(); };
  document.body.appendChild(mask);
  window.__matPicker = { allowCreate, rows: [] };
  const q = document.getElementById('matPickerQ');
  q.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); matPickerSearch(); }
    if (e.key === 'Escape') closeMatPicker();
  });
  q.focus(); q.select();
  matPickerSearch();
}
function closeMatPicker() { const m = document.getElementById('matPickerMask'); if (m) m.remove(); }
async function matPickerSearch() {
  const qEl = document.getElementById('matPickerQ'), list = document.getElementById('matPickerList'), hint = document.getElementById('matPickerHint');
  if (!qEl || !list) return;
  const q = qEl.value.trim();
  list.innerHTML = '<div class="empty">查詢中...</div>';
  try {
    const rows = await api('/api/inventory/materials?q=' + encodeURIComponent(q));
    window.__matPicker.rows = rows;
    if (!rows.length) {
      if (hint) hint.textContent = '';
      list.innerHTML = `<div class="empty">查無「${esc(q)}」的料號。${window.__matPicker.allowCreate
        ? '可按右上「＋ 新增料號」建立（品名會先帶入這個關鍵字）。' : '請換個關鍵字；新料號請從「入庫單」建立。'}</div>`;
      return;
    }
    if (hint) hint.textContent = `找到 ${rows.length} 筆` + (rows.length > 200 ? '，只顯示前 200 筆，請縮小關鍵字' : '') + '。點「選擇」帶回表單。';
    list.innerHTML = `<table><thead><tr><th>料號</th><th>品名</th><th>規格</th><th>廠商</th><th class="num">目前庫存</th><th class="num">單價</th><th></th></tr></thead>
      <tbody>${rows.slice(0, 200).map(m => `<tr>
        <td>${esc(m.mat_id)}</td><td>${esc(m.name)}</td><td>${esc(m.spec)}</td><td>${esc(m.vend_name)}</td>
        <td class="num">${money(m.stock)}</td><td class="num">${money(m.unit_price)}</td>
        <td><button type="button" class="btn sm" onclick="matPickerPick('${esc(m.mat_id)}')">選擇</button></td></tr>`).join('')}</tbody></table>`;
  } catch (e) { list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function matPickerPick(id) {
  // 把查到的料號補進表單的快取，invMatChanged 才帶得出品名/庫存
  const picked = (window.__matPicker?.rows || []).find(m => m.mat_id === id);
  if (picked) { window.__invMats = window.__invMats || []; if (!window.__invMats.some(m => m.mat_id === id)) window.__invMats.push(picked); }
  closeMatPicker();
  const inp = document.querySelector('#modalForm [name=mat_id]');
  if (!inp) return;
  inp.value = id; invMatChanged(inp);
  const qty = document.querySelector('#modalForm [name=qty]'); if (qty) qty.focus();
}
function matPickerCreate() {
  const q = (document.getElementById('matPickerQ')?.value || '').trim();
  closeMatPicker();
  const inp = document.querySelector('#modalForm [name=mat_id]');
  if (inp && q && !/^MA\d{5}$/i.test(q)) inp.value = q;     // 關鍵字當作品名預填 (newMaterialFromDoc 會處理)
  MODULES.inventory.newMaterialFromDoc();
}


/* ── 廠商查詢視窗 (料號表單用)：搜尋 編號/公司/業務/手機/統編/營業項目 → 選擇帶回；查無可新增廠商 ── */
function openVendPicker(opts = {}) {
  closeVendPicker();
  const canCreate = !!(USER.perm_admin || USER.perm_vendor);
  const mask = document.createElement('div');
  mask.id = 'vendPickerMask'; mask.className = 'picker-mask';
  mask.innerHTML = `<div class="picker" role="dialog" aria-label="查詢廠商">
    <div class="modal-head"><h3>查詢廠商</h3><button class="close-x" type="button" onclick="closeVendPicker()">&times;</button></div>
    <div class="picker-body">
      <div class="toolbar" style="margin-bottom:10px">
        <input class="search" id="vendPickerQ" placeholder="廠商編號 / 公司名稱 / 業務 / 手機 / 統編 / 營業項目" value="${esc(opts.initial || '')}">
        <button class="btn" type="button" onclick="vendPickerSearch()">搜尋</button>
        <button class="btn ghost" type="button" style="margin-left:auto" onclick="vendPickerCreate()">＋ 新增廠商</button>
      </div>
      <div class="hint" id="vendPickerHint" style="margin-bottom:8px">搜尋框空白直接按「搜尋」＝列出全部廠商；點「選擇」帶回表單。${canCreate ? '' : '（新增廠商需要「廠商基本資料表」權限）'}</div>
      <div class="card" style="padding:0"><div id="vendPickerList"><div class="empty">載入中...</div></div></div>
    </div></div>`;
  mask.onclick = (e) => { if (e.target === mask) closeVendPicker(); };
  document.body.appendChild(mask);
  window.__vendPicker = { rows: [] };
  const q = document.getElementById('vendPickerQ');
  q.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); vendPickerSearch(); }
    if (e.key === 'Escape') closeVendPicker();
  });
  q.focus(); q.select();
  vendPickerSearch();
}
function closeVendPicker() { const m = document.getElementById('vendPickerMask'); if (m) m.remove(); }
async function vendPickerSearch() {
  const qEl = document.getElementById('vendPickerQ'), list = document.getElementById('vendPickerList'), hint = document.getElementById('vendPickerHint');
  if (!qEl || !list) return;
  const q = qEl.value.trim();
  list.innerHTML = '<div class="empty">查詢中...</div>';
  try {
    const rows = await api('/api/lookups/vendors?q=' + encodeURIComponent(q));
    window.__vendPicker.rows = rows;
    if (!rows.length) {
      if (hint) hint.textContent = '';
      list.innerHTML = `<div class="empty">查無「${esc(q)}」的廠商。可按右上「＋ 新增廠商」建立（公司名稱會先帶入這個關鍵字）。</div>`;
      return;
    }
    if (hint) hint.textContent = `找到 ${rows.length} 家` + (rows.length > 200 ? '，只顯示前 200 家，請縮小關鍵字' : '') + '。點「選擇」帶回表單。';
    list.innerHTML = `<table><thead><tr><th>廠商編號</th><th>公司名稱</th><th>業務</th><th>手機</th><th>統編</th><th>營業項目</th><th>結帳方式</th><th></th></tr></thead>
      <tbody>${rows.slice(0, 200).map(v => `<tr>
        <td>${esc(v.vend_id)}</td><td>${esc(v.company_name)}</td><td>${esc(v.sales_name)}</td><td>${esc(v.mobile)}</td>
        <td>${esc(v.tax_id)}</td><td>${esc(v.business_item)}</td><td>${esc(v.payment_method)}</td>
        <td><button type="button" class="btn sm" onclick="vendPickerPick('${esc(v.vend_id)}')">選擇</button></td></tr>`).join('')}</tbody></table>`;
  } catch (e) { list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function vendPickerPick(id) {
  const v = (window.__vendPicker?.rows || []).find(x => x.vend_id === id);
  closeVendPicker();
  const sel = document.querySelector('#modalForm [name=vend_id]');
  if (!sel) return;
  if (![...sel.options].some(o => o.value === id)) {           // 剛新增、還不在下拉清單裡的廠商
    const o = document.createElement('option'); o.value = id; o.textContent = `${id} ${v ? v.company_name : ''}`; sel.appendChild(o);
  }
  sel.value = id;
}
function vendPickerCreate() {
  const q = (document.getElementById('vendPickerQ')?.value || '').trim();
  closeVendPicker();
  if (!(USER.perm_admin || USER.perm_vendor)) { alert('新增廠商需要「廠商基本資料表」權限，請請有權限的同事到「廠商資料」建立。'); return; }
  if (document.querySelector('#modalForm [name=_asset_id], #modalForm [name=asset_id]')) MODULES.asset.newVendorFromAsset(q);
  else MODULES.inventory.newVendorFromMat(q);
}

/* ── 資產管理 (perm_accounting)：資產設備基本資料 ───────── */
MODULES.asset = {
  title: '資產管理', perm: 'perm_accounting',
  render() {
    renderListPage({ searchable: true, placeholder: '搜尋 品名 / 廠商 / 資產編號 / 規格 / 部門 / 管理人',
      defaultHint: '預設列出全部資產，依資產編號遞減；有填報廢日期的會標示「已報廢」。' });
    setTopAction('＋ 新增資產', () => this.form());
    this.load('');
    document.getElementById('searchBtn').onclick = () => this.load(document.getElementById('searchInput').value.trim());
    document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.load(e.target.value.trim()); });
  },
  async load(q) {
    const rows = await api('/api/assets?q=' + encodeURIComponent(q || ''));
    const total = rows.reduce((t, r) => t + Math.round(Number(r.amount) || 0), 0);
    const cols = [
      { key: 'asset_id', label: '資產編號', render: r => `<a class="link" onclick="MODULES.asset.detail('${r.asset_id}')">${esc(r.asset_id)}</a>` },
      { key: 'name', label: '品名' },
      { key: 'vend_name', label: '廠商' },
      { key: 'spec', label: '規格' },
      { key: 'dept', label: '部門' },
      { key: 'manager_name', label: '管理人' },
      { key: 'purchase_date', label: '購入日期', render: r => fmtDate(r.purchase_date) },
      { key: 'scrap_date', label: '報廢日期', render: r => fmtDate(r.scrap_date) },
      { key: 'amount', label: '金額', num: true, render: r => money(r.amount) },
      { key: 'status', label: '狀態', render: r => statusBadge(r.status) },
      { key: '_', label: '操作', render: r => `<div class="row-actions">
          <button class="btn sm" onclick="MODULES.asset.form('${r.asset_id}')">修改</button>
          <button class="btn danger sm" onclick="MODULES.asset.remove('${r.asset_id}')">刪除</button></div>` },
    ];
    const footer = cols.map(c => c.key === 'amount' ? money(total) : (c.key === 'scrap_date' ? '合計' : ''));
    document.getElementById('listArea').innerHTML = rows.length ? pagedTable(cols, rows, footer) : '<div class="empty">查無資料</div>';
  },
  async detail(id) {
    const a = await api('/api/assets/' + id);
    openModal('資產明細 ' + a.asset_id, `<dl class="dl">
      <dt>資產編號</dt><dd>${esc(a.asset_id)}</dd>
      <dt>品名</dt><dd>${esc(a.name)}</dd>
      <dt>廠商</dt><dd>${esc(a.vend_id || '')} ${esc(a.vend_name || '')}</dd>
      <dt>規格</dt><dd>${esc(a.spec)}</dd>
      <dt>部門</dt><dd>${esc(a.dept)}</dd>
      <dt>管理人</dt><dd>${esc(a.manager_name || a.manager || '')}</dd>
      <dt>購入日期</dt><dd>${fmtDate(a.purchase_date)}</dd>
      <dt>報廢日期</dt><dd>${fmtDate(a.scrap_date)}</dd>
      <dt>金額</dt><dd>${money(a.amount)}</dd>
      <dt>狀態</dt><dd>${statusBadge(a.status)}</dd>
      <dt>備註</dt><dd>${esc(a.note)}</dd>
      <dt>建檔人</dt><dd>${esc(a.created_by_name || a.created_by || '')}</dd>
    </dl>`,
      `<button class="btn ghost" onclick="closeModal()">關閉</button>
      <button class="btn" onclick="MODULES.asset.form('${a.asset_id}')">修改</button>
      <button class="btn danger" onclick="MODULES.asset.remove('${a.asset_id}')">刪除</button>`);
  },
  async form(id) {
    const a = id ? await api('/api/assets/' + id) : {};
    const vends = await api('/api/lookups/vendors');     // 不吃快取：剛新增的廠商要出現在下拉
    const emps = await getLookup('employees');
    openForm({
      title: id ? '修改資產 ' + id : '新增資產',
      fields: [
        id ? { name: 'asset_id', label: '資產編號（不可修改）', type: 'locked', value: a.asset_id, display: a.asset_id }
           : { name: '_asset_id', label: '資產編號', value: '儲存後自動產生（CA + 5 碼流水號）', readonly: true },
        { name: 'name', label: '品名', required: true, value: a.name },
        { name: 'vend_id', label: '廠商', type: 'select', options: options(vends, 'vend_id', 'company_name', a.vend_id),
          hint: '可從下拉選，或按「查詢」搜尋公司名稱／業務／統編；查不到可直接新增廠商' },
        { name: 'spec', label: '規格', value: a.spec },
        { name: 'dept', label: '部門', value: a.dept },
        { name: 'manager', label: '管理人', type: 'select', options: options(emps, 'emp_id', 'name', a.manager || USER.emp_id) },
        { name: 'purchase_date', label: '購入日期', type: 'date', value: fmtDate(a.purchase_date) || (id ? '' : localISO()) },
        { name: 'scrap_date', label: '報廢日期', type: 'date', value: fmtDate(a.scrap_date), hint: '有填就視為已報廢' },
        { name: 'amount', label: '金額', type: 'number', step: '1', value: a.amount !== undefined ? Math.round(a.amount) : '' },
        { name: 'note', label: '備註', type: 'textarea', full: true, value: a.note },
      ],
      onSubmit: async (v) => {
        delete v._asset_id;
        if (id) await api('/api/assets/' + id, { method: 'PUT', body: v });
        else await api('/api/assets', { method: 'POST', body: v });
        MODULES.asset.render();
      },
    });
    // 廠商欄位旁加「查詢」(沿用料號表單的廠商查詢視窗)
    const vs = document.querySelector('#modalForm [name=vend_id]');
    if (vs) {
      const row = document.createElement('div'); row.className = 'input-row';
      vs.parentNode.insertBefore(row, vs); row.appendChild(vs);
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn ghost'; btn.textContent = '查詢';
      btn.onclick = () => openVendPicker({ initial: '' });
      row.appendChild(btn);
    }
    window.__assetFormCtx = { id };
  },
  // 從資產表單按「新增廠商」：記住目前填的內容，建完廠商回來並選好
  newVendorFromAsset(keyword) {
    const f = document.getElementById('modalForm');
    const preset = {};
    if (f) { const fd = new FormData(f); for (const [k, v] of fd.entries()) if (!k.startsWith('_') && k !== 'asset_id') preset[k] = v; }
    const ctx = window.__assetFormCtx || { id: null };
    MODULES.vendor.form(null, {
      presetName: keyword || '',
      after: async (v) => {
        await this.form(ctx.id);
        const form = document.getElementById('modalForm');
        for (const [k, val] of Object.entries(preset)) { const el = form.querySelector(`[name=${k}]`); if (el && k !== 'vend_id') el.value = val; }
        const sel = form.querySelector('[name=vend_id]');
        if (sel && ![...sel.options].some(o => o.value === v.vend_id)) { const o = document.createElement('option'); o.value = v.vend_id; o.textContent = `${v.vend_id} ${v.company_name}`; sel.appendChild(o); }
        if (sel) sel.value = v.vend_id;
      },
    });
  },
  remove(id) {
    confirmDelete('確定刪除資產 ' + id + '？', async () => {
      try { await api('/api/assets/' + id, { method: 'DELETE' }); closeModal(); MODULES.asset.render(); }
      catch (e) { alert(e.message); }
    });
  },
};

/* ── 導覽 / 啟動 ─────────────────────────────────────── */
// 「系統說明」(home) 不在左側選單：登入後為預設頁，點 LOGO 可回到該頁
const MENU = [
  ['customer', '客戶資料'], ['vendor', '廠商資料'], ['quote', '報價資料'],
  ['project', '專案管理'], ['repair', '維修工單'], ['inventory', '庫存管理'],
  ['receivable', '應收款項'], ['payable', '應付款項'],
  ['accounting', '會計維護'], ['acctreport', '公司報表'], ['asset', '資產管理'],
  ['account', '帳號管理'], ['gate', '門禁帳號'], ['sysmaint', '項目維護'],
  ['audit', '操作紀錄'], ['backup', '備份設定'], ['restore', '系統還原'],
];
function setTopAction(label, fn) {
  const el = document.getElementById('topActions');
  el.innerHTML = `<button class="btn" id="topActionBtn">${esc(label)}</button>`;
  document.getElementById('topActionBtn').onclick = fn;
}
function clearTopAction() { document.getElementById('topActions').innerHTML = ''; }

// 變更密碼：輸入舊密碼 + 兩次新密碼，成功後自動登出回登入頁
function openChangePassword() {
  openForm({
    title: '變更密碼',
    fields: [
      { name: 'old_password', label: '舊密碼', type: 'password', required: true },
      { name: 'new_password', label: '新密碼', type: 'password', required: true },
      { name: 'new_password2', label: '確認新密碼', type: 'password', required: true },
    ],
    onSubmit: async (v) => {
      if (v.new_password !== v.new_password2) throw new Error('兩次輸入的新密碼不一致。');
      if (v.old_password === v.new_password) throw new Error('新密碼不可與舊密碼相同。');
      await api('/api/change-password', { method: 'POST', body: { old_password: v.old_password, new_password: v.new_password } });
      alert('密碼已變更，請使用新密碼重新登入。');
      await api('/api/logout', { method: 'POST' });
      location.href = '/';
    },
  });
}

function go(key) {
  const mod = MODULES[key];
  if (!mod) return;
  document.querySelector('.sidebar')?.classList.remove('open');   // 手機版：切頁時收起選單
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.key === key));
  document.getElementById('pageTitle').textContent = mod.title;
  // 系統說明(首頁)：隱藏上方標題列、內容不留白
  document.querySelector('.main').classList.toggle('home-view', key === 'home');
  clearTopAction();
  mod.render();
}

async function boot() {
  try {
    const { user } = await api('/api/me');
    USER = user;
  } catch { location.href = '/'; return; }

  document.getElementById('uName').textContent = USER.name + ' (' + USER.emp_id + ')';
  document.getElementById('changePwBtn').onclick = openChangePassword;

  // 系統管理者擁有全部功能；其他人依各自權限顯示選單
  const nav = document.getElementById('nav');
  const visible = MENU.filter(([key]) => canSee(key));
  nav.innerHTML = visible.map(([key, label]) =>
    `<a href="#" data-key="${key}" onclick="go('${key}');return false;"><span>${esc(label)}</span></a>`).join('');

  document.getElementById('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = '/'; };

  go('home');   // 登入後預設顯示系統說明頁 (點 LOGO 可隨時回到此頁)
}
// 是否有權限使用某功能 (首頁熱區與選單共用)
function canSee(key) {
  return MODULES[key].always || USER.perm_admin || USER[MODULES[key].perm];
}
boot();
