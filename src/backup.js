/* ============================================================
   自動備份
   - 系統管理者在「備份設定」頁設定週期、時間、保留份數與備份位置
   - 伺服器每分鐘檢查一次是否到時間；錯過的時段 (電腦沒開、主機休眠)
     會在下次啟動或被喚醒時補做一次
   - 備份位置：Google 雲端硬碟 (線上版唯一可用) 或這台電腦的資料夾 (本機版)
   - Google 雲端硬碟用內建 fetch 直接呼叫 Drive API，不需安裝任何套件；
     金鑰沿用 .env 的 GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN / FOLDER_ID
   ============================================================ */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { nowISO, str } = require('./util');

const FILE_PREFIX = 'pms備份_';
const DEFAULTS = {
  enabled: false,
  freq: 'weekly',        // daily | weekly | monthly
  dow: 5,                // weekly：星期幾 (0=日 … 6=六)
  dom: 1,                // monthly：每月幾號 (1~28)
  time: '18:00',         // HH:MM (伺服器時區，預設台灣時間)
  keep: 12,              // 保留份數
  dest: 'gdrive',        // gdrive | local
  local_dir: '',         // dest=local 時的資料夾
};

/* ── settings 表存取 (與門禁共用同一張表：{ key, value }) ── */
function getSetting(key) { return store.find('settings', 'key', key)?.value; }
function setSetting(key, value) {
  const row = store.find('settings', 'key', key);
  if (row) row.value = value;
  else store.all('settings').push({ key, value });
  store.commit();
}
function getSettings() { return { ...DEFAULTS, ...(getSetting('backup') || {}) }; }
function getState() { return { ...(getSetting('backup_state') || {}) }; }
function saveState(patch) { setSetting('backup_state', { ...getState(), ...patch }); }

/* ── 時間 ── */
const pad = (n) => String(n).padStart(2, '0');
// 本機時間字串 2026-10-20 18:00 (顯示用，與設定的時間同一個時區)
const localDT = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;

// 依設定算出 from 之後的下一次執行時間
function nextRunAfter(s, from = new Date()) {
  const [hh, mm] = String(s.time || '18:00').split(':').map(Number);
  const d = new Date(from);
  d.setHours(hh, mm, 0, 0);
  if (s.freq === 'daily') {
    if (d <= from) d.setDate(d.getDate() + 1);
  } else if (s.freq === 'monthly') {
    const dom = Math.min(Math.max(Number(s.dom) || 1, 1), 28);
    d.setDate(dom);
    if (d <= from) { d.setMonth(d.getMonth() + 1, dom); }
  } else {  // weekly
    const dow = Math.min(Math.max(Number(s.dow) || 0, 0), 6);
    d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
    if (d <= from) d.setDate(d.getDate() + 7);
  }
  return d;
}

/* ── 備份內容 (與「系統還原」頁的匯出格式相同) ── */
function exportData() {
  const db = store.get();
  const data = { exported_at: nowISO(), version: 1 };
  for (const t of store.TABLES) data[t] = db[t];
  data.seq = db.seq;
  return data;
}

/* ── Google 雲端硬碟 ── */
const G = () => ({
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  folder: process.env.GOOGLE_FOLDER_ID,
});
const gdriveConfigured = () => Object.values(G()).every(v => !!v);

async function gdriveToken() {
  const g = G();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: g.client_id, client_secret: g.client_secret,
      refresh_token: g.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Google 授權失敗：' + (j.error_description || j.error || res.status) + '。請檢查 GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN 是否正確。');
  return j.access_token;
}

async function gdriveApi(token, url, opt = {}) {
  const res = await fetch(url, { ...opt, headers: { Authorization: 'Bearer ' + token, ...(opt.headers || {}) } });
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google 雲端硬碟錯誤：' + (j.error?.message || res.status));
  return j;
}

async function gdriveList(token) {
  const q = `'${G().folder}' in parents and name contains '${FILE_PREFIX}' and trashed=false`;
  const url = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
    q, orderBy: 'name desc', pageSize: '200', fields: 'files(id,name,createdTime,size)',
  });
  return (await gdriveApi(token, url)).files || [];
}

async function gdriveUpload(token, name, content) {
  const boundary = 'pms' + Date.now();
  const meta = JSON.stringify({ name, parents: [G().folder], mimeType: 'application/json' });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  return gdriveApi(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
  });
}

const gdriveDelete = (token, id) =>
  gdriveApi(token, 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id), { method: 'DELETE' });

// 測試連線：拿 token 並列出資料夾內的備份檔
async function gdriveTest() {
  if (!gdriveConfigured()) throw new Error('尚未設定 Google 雲端硬碟的四個環境變數。');
  const token = await gdriveToken();
  const files = await gdriveList(token);
  return { ok: true, count: files.length, latest: files[0]?.name || '' };
}

/* ── 本機資料夾 ── */
function localDir(s) {
  const dir = str(s.local_dir);
  if (!dir) throw new Error('請填寫備份資料夾路徑。');
  return path.resolve(dir);
}

/* ── 執行備份 ── */
let running = false;
async function runBackup(trigger = '手動') {
  if (running) throw new Error('備份正在執行中，請稍候。');
  running = true;
  saveState({ running: true });
  const s = getSettings();
  const name = FILE_PREFIX + fileStamp() + '.json';
  const content = JSON.stringify(exportData(), null, 2);
  const keep = Math.min(Math.max(Number(s.keep) || 12, 1), 100);
  try {
    let where;
    if (s.dest === 'local') {
      const dir = localDir(s);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, name + '.tmp');
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, path.join(dir, name));
      const old = fs.readdirSync(dir)
        .filter(f => f.startsWith(FILE_PREFIX) && f.endsWith('.json'))
        .sort().reverse().slice(keep);
      for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* 忽略 */ } }
      where = dir;
    } else {
      if (!gdriveConfigured()) throw new Error('尚未設定 Google 雲端硬碟的四個環境變數，無法上傳。');
      const token = await gdriveToken();
      await gdriveUpload(token, name, content);
      const old = (await gdriveList(token)).slice(keep);
      for (const f of old) { try { await gdriveDelete(token, f.id); } catch { /* 忽略 */ } }
      where = 'Google 雲端硬碟';
    }
    const result = { running: false, last_at: localDT(), last_ok: true, last_file: name,
      last_msg: `${trigger}備份成功：${name} → ${where}（${(content.length / 1024).toFixed(0)} KB）` };
    saveState(result);
    console.log('  [備份] ' + result.last_msg);
    return result;
  } catch (e) {
    const result = { running: false, last_at: localDT(), last_ok: false, last_file: '', last_msg: `${trigger}備份失敗：${e.message}` };
    saveState(result);
    console.error('  [備份] ' + result.last_msg);
    throw e;
  } finally {
    running = false;
  }
}

/* ── 排程器：每分鐘檢查一次 ── */
function reschedule() {
  const s = getSettings();
  saveState({ next_at: s.enabled ? localDT(nextRunAfter(s)) : '' });
}

async function tick() {
  const s = getSettings();
  if (!s.enabled || running) return;
  const st = getState();
  if (!st.next_at) return reschedule();
  // next_at 是本機時間字串，直接用本機時間比較
  if (localDT() < st.next_at) return;
  try { await runBackup('排程'); } catch { /* 已記錄在 last_msg */ }
  reschedule();
}

function start() {
  // 啟動時先把「執行中」殘留狀態清掉 (上次可能在備份途中被關閉)
  if (getState().running) saveState({ running: false });
  running = false;
  if (getSettings().enabled && !getState().next_at) reschedule();
  setInterval(() => { tick().catch(e => console.error('  [備份] 排程錯誤：' + e.message)); }, 60 * 1000).unref();
}

module.exports = {
  DEFAULTS, FILE_PREFIX,
  getSettings, getState, setSetting, saveState, reschedule,
  nextRunAfter, localDT, exportData,
  gdriveConfigured, gdriveTest, runBackup, start,
};
