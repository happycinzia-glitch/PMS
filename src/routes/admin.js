/* ── 操作紀錄 / 資料備份匯出 / 系統還原 (僅系統管理者) ── */
const express = require('express');
const store = require('../store');
const { requirePerm, str, matches } = require('../util');
const { exportData } = require('../backup');

const router = express.Router();
const perm = requirePerm('perm_admin');

/* 最近 1000 筆寫入動作 (由 server.js 的稽核中介層寫入) */
router.get('/admin/audit', perm, (req, res) => {
  const q = str(req.query.q);
  const rows = store.all('audit')
    .filter(a => matches(a, ['emp_id', 'emp_name', 'path', 'method'], q))
    .slice().sort((a, b) => str(b.at).localeCompare(str(a.at)));
  res.json(rows);
});

/* 匯出完整備份 (系統還原頁會先自動下載一份現況再執行還原) */
router.get('/admin/export', perm, (req, res) => res.json(exportData()));

/* 還原：清空目前所有資料並換成備份檔內容 */
router.post('/admin/restore', perm, (req, res) => {
  if (str(req.body?.confirm) !== '確定還原') {
    return res.status(400).json({ error: '請輸入「確定還原」四個字以確認。' });
  }
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.accounts)) {
    return res.status(400).json({ error: '備份檔格式不正確 (缺少帳號資料)。' });
  }
  // 還原後若沒有可登入的管理者，系統將無法再進入
  const admins = data.accounts.filter(a => a.perm_admin && a.status === '正常' && a.password);
  if (!admins.length) {
    return res.status(400).json({ error: '備份檔中沒有任何「正常」狀態的系統管理者帳號，還原後將無法登入，已中止。' });
  }

  store.replaceAll(data);
  req.session.destroy(() => {});
  res.json({ ok: true, accounts: data.accounts.length });
});

module.exports = router;
