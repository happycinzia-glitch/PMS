/* ── 專案管理資料表 (含 進度階段 / 追加減帳 / 日誌 / 結案附件) ── */
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('../store');
const {
  requirePerm, str, num, numOrNull, date, matches, nowISO, today,
  empName, custName, vendName,
} = require('../util');

const router = express.Router();
const perm = requirePerm('perm_project');
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 單檔上限 10MB

const EDITABLE = ['proj_name', 'cust_id', 'owner', 'addr', 'proj_status', 'status', 'note'];

function projectBody(src) {
  const out = {};
  for (const k of EDITABLE) if (k in src) out[k] = str(src[k]);
  for (const k of ['start_date', 'end_date', 'warranty']) if (k in src) out[k] = date(src[k]);
  if ('contract_amount' in src) out.contract_amount = numOrNull(src.contract_amount);
  return out;
}

const stagesOf = (id) => store.all('project_stages')
  .filter(s => s.proj_id === id).sort((a, b) => (a.seq_no || 0) - (b.seq_no || 0));

function decorate(p) {
  const stages = stagesOf(p.proj_id);
  return {
    ...p,
    cust_name: custName(p.cust_id),
    owner_name: empName(p.owner),
    created_by_name: empName(p.created_by),
    sales_name: empName(p.created_by),      // 清單「業務姓名」＝填表人
    stage_total: stages.length,
    stage_done: stages.filter(s => s.actual_end).length,
  };
}

/* ── 清單 ──
   無關鍵字：一般員工只看「自己負責且進行中」；系統管理者看全部「進行中」(不限負責人)，依開工日期遞減
   有關鍵字：涵蓋所有專案 (含結案)，比對專案名稱 */
router.get('/projects', perm, (req, res) => {
  const q = str(req.query.q);
  const me = req.session.user.emp_id;
  let rows = store.all('projects');
  if (q) {
    rows = rows.filter(p => matches(p, ['proj_id', 'proj_name', 'addr'], q));
  } else {
    rows = req.session.user.perm_admin
      ? rows.filter(p => p.status === '進行中')
      : rows.filter(p => p.owner === me && p.status === '進行中');
  }
  rows = rows.slice().sort((a, b) => str(b.start_date).localeCompare(str(a.start_date))
    || b.proj_id.localeCompare(a.proj_id));
  res.json(rows.map(decorate));
});

/* ── 明細 (含所有子表單) ── */
router.get('/projects/:id', perm, (req, res) => {
  const p = store.find('projects', 'proj_id', req.params.id);
  if (!p) return res.status(404).json({ error: '查無此專案。' });
  const id = p.proj_id;

  const changes = store.all('project_changes').filter(c => c.proj_id === id)
    .sort((a, b) => str(b.co_date).localeCompare(str(a.co_date)) || b.change_id - a.change_id)
    .map(c => ({ ...c, created_by_name: empName(c.created_by) }));

  const logs = store.all('project_logs').filter(l => l.proj_id === id)
    .sort((a, b) => str(b.log_date).localeCompare(str(a.log_date)) || b.log_id - a.log_id)
    .map(l => ({ ...l, created_by_name: empName(l.created_by) }));

  const receivables = store.all('receivables').filter(r => r.proj_id === id)
    .sort((a, b) => a.ar_id.localeCompare(b.ar_id));

  const payables = store.all('payables').filter(a => a.proj_id === id && !a.emp_id)
    .sort((a, b) => a.ap_id.localeCompare(b.ap_id))
    .map(a => ({ ...a, vend_name: vendName(a.vend_id) }));

  const repairs = store.all('repairs').filter(r => r.proj_id === id)
    .sort((a, b) => str(b.reported_date).localeCompare(str(a.reported_date)))
    .map(r => ({ ...r, assignee_name: empName(r.assignee) }));

  res.json({ ...decorate(p), stages: stagesOf(id), changes, logs, receivables, payables, repairs });
});

/* ── 新增：可依「分幾個階段」自動建立進度階段 ── */
router.post('/projects', perm, (req, res) => {
  const v = projectBody(req.body || {});
  if (!v.proj_name) return res.status(400).json({ error: '請填寫專案名稱。' });

  const row = {
    proj_id: store.nextCode('projects', 'proj_id', 'P'),
    proj_name: v.proj_name,
    cust_id: v.cust_id || '',
    owner: v.owner || req.session.user.emp_id,
    start_date: v.start_date || today(),
    end_date: v.end_date || null,
    warranty: null,
    addr: v.addr || '',
    proj_status: '準備進場',
    status: '進行中',
    contract_amount: null,
    note: v.note || '',
    created_by: req.session.user.emp_id,
    created_at: nowISO(), updated_at: nowISO(),
  };
  store.all('projects').push(row);

  const count = Math.max(0, Math.min(8, num(req.body?.stage_count)));
  if (count > 0) autoCreateStages(row, count);
  store.commit();
  res.json(decorate(row));
});

// 以「專案狀態」清單命名，並平均分配預定完成日期 (無完工日則每階段 14 天)
function autoCreateStages(proj, count) {
  const names = store.all('options')
    .filter(o => o.category === 'project_status')
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map(o => o.value);

  const start = Date.parse(proj.start_date || today());
  const end = proj.end_date ? Date.parse(proj.end_date) : null;
  const stepMs = end && end > start ? (end - start) / count : 14 * 86400000;

  for (let i = 0; i < count; i++) {
    store.all('project_stages').push({
      stage_id: store.nextInt('project_stages'),
      proj_id: proj.proj_id,
      seq_no: i + 1,
      stage_name: names[i] || `階段 ${i + 1}`,
      planned_end: new Date(start + stepMs * (i + 1)).toISOString().slice(0, 10),
      actual_end: null,
      note: '',
    });
  }
}

/* ── 修改：專案名稱與客戶不可異動 ── */
router.put('/projects/:id', perm, (req, res) => {
  const p = store.find('projects', 'proj_id', req.params.id);
  if (!p) return res.status(404).json({ error: '查無此專案。' });
  const v = projectBody(req.body || {});
  delete v.proj_name;
  delete v.cust_id;
  Object.assign(p, v, { updated_at: nowISO() });
  store.commit();
  res.json(decorate(p));
});

/* ── 刪除：連同階段/變更單/日誌/附件一併移除 ── */
router.delete('/projects/:id', perm, (req, res) => {
  const id = req.params.id;
  if (!store.find('projects', 'proj_id', id)) return res.status(404).json({ error: '查無此專案。' });

  const blockers = [
    ['receivables', '應收款項'], ['payables', '應付款項'],
  ].filter(([t]) => store.all(t).some(r => r.proj_id === id)).map(([, label]) => label);
  if (blockers.length) return res.status(400).json({ error: `此專案已有「${blockers.join('、')}」，無法刪除。` });

  for (const f of store.all('project_files').filter(f => f.proj_id === id)) removeFile(f);
  store.remove('project_files', f => f.proj_id === id);
  store.remove('project_stages', s => s.proj_id === id);
  store.remove('project_changes', c => c.proj_id === id);
  store.remove('project_logs', l => l.proj_id === id);
  store.remove('repairs', r => r.proj_id === id);
  store.remove('projects', p => p.proj_id === id);
  res.json({ ok: true });
});

/* ── 進度階段 ── */
router.post('/projects/:id/stages', perm, (req, res) => {
  if (!store.find('projects', 'proj_id', req.params.id)) return res.status(404).json({ error: '查無此專案。' });
  const b = req.body || {};
  if (!str(b.stage_name)) return res.status(400).json({ error: '請填寫階段名稱。' });
  const row = {
    stage_id: store.nextInt('project_stages'),
    proj_id: req.params.id,
    seq_no: num(b.seq_no) || stagesOf(req.params.id).length + 1,
    stage_name: str(b.stage_name),
    planned_end: date(b.planned_end),
    actual_end: date(b.actual_end),
    note: str(b.note),
  };
  store.all('project_stages').push(row);
  resequence(req.params.id, row.stage_id);
  store.commit();
  res.json(row);
});

router.put('/projects/:id/stages/:sid', perm, (req, res) => {
  const s = store.all('project_stages')
    .find(x => x.proj_id === req.params.id && String(x.stage_id) === req.params.sid);
  if (!s) return res.status(404).json({ error: '查無此階段。' });
  const b = req.body || {};
  const oldSeq = s.seq_no;
  Object.assign(s, {
    seq_no: num(b.seq_no) || s.seq_no,
    stage_name: str(b.stage_name) || s.stage_name,
    planned_end: date(b.planned_end),
    actual_end: date(b.actual_end),
    note: str(b.note),
  });
  resequence(req.params.id, s.stage_id, oldSeq);
  store.commit();
  res.json(s);
});

router.delete('/projects/:id/stages/:sid', perm, (req, res) => {
  const n = store.remove('project_stages',
    x => x.proj_id === req.params.id && String(x.stage_id) === req.params.sid);
  if (!n) return res.status(404).json({ error: '查無此階段。' });
  resequence(req.params.id);
  store.commit();
  res.json({ ok: true });
});

// 依 seq_no 重新排序後編號 1,2,3…；剛異動的那筆往前移(或新增)時插到同號之前，往後移時插到同號之後
function resequence(projId, movedId = null, oldSeq = null) {
  const list = store.all('project_stages').filter(s => s.proj_id === projId);
  const keyOf = (s) => {
    if (String(s.stage_id) !== String(movedId)) return s.seq_no;
    return oldSeq !== null && s.seq_no > oldSeq ? s.seq_no + 0.5 : s.seq_no - 0.5;
  };
  list.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka - kb || a.stage_id - b.stage_id;
  });
  list.forEach((s, i) => { s.seq_no = i + 1; });
}

/* ── 追加減帳 (變更單)：金額 正=追加、負=減帳 ── */
router.post('/projects/:id/changes', perm, (req, res) => {
  if (!store.find('projects', 'proj_id', req.params.id)) return res.status(404).json({ error: '查無此專案。' });
  const b = req.body || {};
  if (!str(b.description)) return res.status(400).json({ error: '請填寫變更說明。' });
  const row = {
    change_id: store.nextInt('project_changes'),
    proj_id: req.params.id,
    co_date: date(b.co_date) || today(),
    amount: num(b.amount),
    description: str(b.description),
    status: str(b.status) || '已確認',
    note: str(b.note),
    created_by: req.session.user.emp_id,
    created_at: nowISO(),
  };
  store.insert('project_changes', row);
  res.json(row);
});

router.put('/projects/:id/changes/:cid', perm, (req, res) => {
  const c = store.all('project_changes')
    .find(x => x.proj_id === req.params.id && String(x.change_id) === req.params.cid);
  if (!c) return res.status(404).json({ error: '查無此變更單。' });
  const b = req.body || {};
  Object.assign(c, {
    co_date: date(b.co_date) || c.co_date,
    amount: num(b.amount),
    description: str(b.description) || c.description,
    status: str(b.status) || c.status,
    note: str(b.note),
  });
  store.commit();
  res.json(c);
});

router.delete('/projects/:id/changes/:cid', perm, (req, res) => {
  const n = store.remove('project_changes',
    x => x.proj_id === req.params.id && String(x.change_id) === req.params.cid);
  if (!n) return res.status(404).json({ error: '查無此變更單。' });
  res.json({ ok: true });
});

/* ── 專案日誌 ── */
router.post('/projects/:id/logs', perm, (req, res) => {
  if (!store.find('projects', 'proj_id', req.params.id)) return res.status(404).json({ error: '查無此專案。' });
  const b = req.body || {};
  const row = {
    log_id: store.nextInt('project_logs'),
    proj_id: req.params.id,
    log_date: date(b.log_date) || today(),
    progress: str(b.progress),
    note: str(b.note),
    created_by: req.session.user.emp_id,
    created_at: nowISO(),
  };
  store.insert('project_logs', row);
  res.json(row);
});

router.delete('/projects/:id/logs/:logId', perm, (req, res) => {
  const n = store.remove('project_logs',
    x => x.proj_id === req.params.id && String(x.log_id) === req.params.logId);
  if (!n) return res.status(404).json({ error: '查無此日誌。' });
  res.json({ ok: true });
});

/* ── 結案附件 ──
   原站存於公司 Google Drive；本機版改存 data/files/<專案編號>/
   規則相同：僅「結案」專案可上傳、下載與刪除限系統管理者。 */
const fileDir = (projId) => path.join(store.FILE_DIR, projId);
function removeFile(f) {
  try { fs.unlinkSync(path.join(fileDir(f.proj_id), f.stored_name)); } catch { /* 檔案已不存在 */ }
}

router.get('/projects/:id/files', perm, (req, res) => {
  if (!store.find('projects', 'proj_id', req.params.id)) return res.status(404).json({ error: '查無此專案。' });
  const files = store.all('project_files')
    .filter(f => f.proj_id === req.params.id)
    .sort((a, b) => str(b.uploaded_at).localeCompare(str(a.uploaded_at)))
    .map(f => ({
      file_id: f.file_id, orig_name: f.orig_name, size_bytes: f.size_bytes,
      uploaded_by: f.uploaded_by, uploaded_by_name: empName(f.uploaded_by), uploaded_at: f.uploaded_at,
    }));
  res.json({ files, can_download: !!req.session.user.perm_admin, drive_ready: true });
});

router.post('/projects/:id/files', perm, (req, res) => {
  const p = store.find('projects', 'proj_id', req.params.id);
  if (!p) return res.status(404).json({ error: '查無此專案。' });
  if (!['結案', '已結案'].includes(p.status)) {
    return res.status(400).json({ error: '專案系統狀態為「結案」後才能上傳附件。' });
  }
  const name = str(req.body?.name);
  const b64 = String(req.body?.data || '');
  if (!name || !b64) return res.status(400).json({ error: '請選擇要上傳的檔案。' });

  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return res.status(400).json({ error: '檔案內容為空或格式不正確。' });
  if (buf.length > MAX_FILE_BYTES) return res.status(400).json({ error: '單檔上限 10MB。' });

  const file_id = store.nextInt('project_files');
  const stored_name = `${file_id}_${name.replace(/[\\/:*?"<>|]/g, '_')}`;
  fs.mkdirSync(fileDir(p.proj_id), { recursive: true });
  fs.writeFileSync(path.join(fileDir(p.proj_id), stored_name), buf);

  const row = {
    file_id, proj_id: p.proj_id, orig_name: name, stored_name,
    mime: str(req.body?.mime) || 'application/octet-stream',
    size_bytes: buf.length,
    uploaded_by: req.session.user.emp_id, uploaded_at: nowISO(),
  };
  store.insert('project_files', row);
  res.json({ ok: true, file_id });
});

router.get('/projects/:id/files/:fid/download', perm, (req, res) => {
  if (!req.session.user.perm_admin) return res.status(403).json({ error: '僅系統管理者可下載附件。' });
  const f = store.all('project_files')
    .find(x => x.proj_id === req.params.id && String(x.file_id) === req.params.fid);
  if (!f) return res.status(404).json({ error: '查無此附件。' });
  const full = path.join(fileDir(f.proj_id), f.stored_name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '檔案已遺失。' });
  res.type(f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(f.orig_name)}`);
  fs.createReadStream(full).pipe(res);
});

router.delete('/projects/:id/files/:fid', perm, (req, res) => {
  if (!req.session.user.perm_admin) return res.status(403).json({ error: '僅系統管理者可刪除附件。' });
  const f = store.all('project_files')
    .find(x => x.proj_id === req.params.id && String(x.file_id) === req.params.fid);
  if (!f) return res.status(404).json({ error: '查無此附件。' });
  removeFile(f);
  store.remove('project_files', x => x.file_id === f.file_id);
  res.json({ ok: true });
});

module.exports = router;
