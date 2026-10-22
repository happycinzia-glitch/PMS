/* ── 備份設定 / 立即備份 / 外部觸發 (設定與手動備份僅系統管理者) ── */
const express = require('express');
const crypto = require('crypto');
const { requirePerm, str } = require('../util');
const backup = require('../backup');

const router = express.Router();
const perm = requirePerm('perm_admin');

const TIME_RULE = /^([01]\d|2[0-3]):[0-5]\d$/;

function status() {
  const s = backup.getSettings();
  const st = backup.getState();
  return {
    settings: s,
    state: st,
    gdrive_configured: backup.gdriveConfigured(),
    external_enabled: !!process.env.BACKUP_KEY,
    on_render: !!process.env.RENDER,          // Render 主機會自動設定這個環境變數
    server_now: backup.localDT(),
    timezone: process.env.TZ || '',
  };
}

router.get('/backup/settings', perm, (req, res) => res.json(status()));

router.put('/backup/settings', perm, (req, res) => {
  const b = req.body || {};
  const s = { ...backup.getSettings() };
  s.enabled = b.enabled === true;
  s.freq = ['daily', 'weekly', 'monthly'].includes(b.freq) ? b.freq : 'weekly';
  s.dow = Math.min(Math.max(Number(b.dow) || 0, 0), 6);
  s.dom = Math.min(Math.max(Number(b.dom) || 1, 1), 28);
  s.time = TIME_RULE.test(str(b.time)) ? str(b.time) : '18:00';
  s.keep = Math.min(Math.max(Number(b.keep) || 12, 1), 100);
  s.dest = b.dest === 'local' ? 'local' : 'gdrive';
  s.local_dir = str(b.local_dir);

  if (s.dest === 'local' && !s.local_dir) {
    return res.status(400).json({ error: '備份位置選「這台電腦的資料夾」時，請填寫資料夾路徑。' });
  }
  if (s.dest === 'gdrive' && s.enabled && !backup.gdriveConfigured()) {
    return res.status(400).json({ error: '尚未設定 Google 雲端硬碟的四個環境變數 (GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、GOOGLE_REFRESH_TOKEN、GOOGLE_FOLDER_ID)，無法啟用自動備份。請先完成自學講義第 6 章。' });
  }
  backup.setSetting('backup', s);
  backup.reschedule();
  res.json({ ok: true, ...status() });
});

// 立即備份 (依目前儲存的設定決定備份位置)
router.post('/backup/run', perm, async (req, res) => {
  try {
    const r = await backup.runBackup('手動');
    res.json({ ok: true, ...r, ...status() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 測試 Google 雲端硬碟連線
router.post('/backup/test', perm, async (req, res) => {
  try { res.json(await backup.gdriveTest()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* 外部觸發：給 cron-job.org 之類的排程服務用，不需登入，
   但必須設定環境變數 BACKUP_KEY 且網址的 key 參數相符。
   (門禁開啟時也放行，見 gate.js 的 OPEN_PATHS) */
router.get('/backup/trigger', async (req, res) => {
  const key = process.env.BACKUP_KEY;
  const given = str(req.query.key);
  const same = key && given.length === key.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!same) return res.status(403).json({ error: '未設定 BACKUP_KEY 或 key 不正確。' });
  try {
    const r = await backup.runBackup('外部觸發');
    res.json({ ok: true, file: r.last_file, at: r.last_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
