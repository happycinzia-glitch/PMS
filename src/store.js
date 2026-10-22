/* ============================================================
   資料儲存層
   - 沒設定 DATABASE_URL：單一 JSON 檔 data/db.json，寫入時原子替換 (先寫 .tmp 再 rename)
   - 有設定 DATABASE_URL：PostgreSQL (Neon)，每類資料各一張資料表，第一次連線時自動建立
   兩種模式都把資料放在記憶體裡供各路由同步讀寫，差別只在「落地」到哪裡。
   資料庫模式下，server.js 會等 settle() 確認寫入完成才回應寫入類請求。
   ============================================================ */
const fs = require('fs');
const path = require('path');

// 預設 data/，可用 PMS_DATA_DIR 指向別的位置 (測試或多套帳號分開存放)
const DATA_DIR = process.env.PMS_DATA_DIR
  ? path.resolve(process.env.PMS_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const FILE_DIR = path.join(DATA_DIR, 'files');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const USE_PG = !!DATABASE_URL;

// 匯出/還原會直接使用這些名稱，順序即為 export 的鍵順序。資料庫模式下也是資料表名稱。
const TABLES = [
  'accounts', 'customers', 'vendors',
  'projects', 'project_stages', 'project_changes', 'project_logs', 'project_files',
  'quotes', 'quote_items', 'receivables', 'payables', 'repairs',
  'options', 'audit',
  'gate_accounts', 'settings',
  'materials', 'stock_in', 'stock_out',   // 庫存管理：料號 / 入庫單 / 領料單
  'assets',                               // 資產管理
];
const META_TABLE = 'pms_meta';            // 資料庫模式：存流水號 (seq)

function emptyDb() {
  const db = { seq: {} };
  for (const t of TABLES) db[t] = [];
  return db;
}

let db = null;
let dirty = false;
let timer = null;

/* ── 寫入版本：每次 commit +1，寫進資料庫後更新 savedVersion ──
   settle() 用它判斷「到目前為止的修改」是否都已落地。 */
let version = 0;
let savedVersion = 0;
let writing = null;      // 進行中的資料庫寫入 (同一時間只有一筆)
let saved = {};          // 各表最後一次寫進資料庫的 JSON，用來只寫有變動的表
let discarded = [];      // [from, to, reason]：寫入失敗而被取消的版本區間 (from 不含、to 含)

/* 資料庫的寫入代數：每寫一次 +1。本機版和線上版 (Render) 連同一個資料庫時，
   兩邊各自把資料放在記憶體裡，若不檢查，後寫的一方會把另一方剛存的整張表蓋掉。
   寫入前比對代數，不同就代表另一處寫過：這次不寫，改重新載入最新資料。 */
let gen = 0;
let checkedAt = 0;       // 上次確認代數的時間 (讀取時最多每 10 秒確認一次)

/* ── PostgreSQL 連線 ─────────────────────────────────────── */
let pool = null;

function pgPool() {
  if (pool) return pool;
  let Pool;
  try { ({ Pool } = require('pg')); } catch {
    throw new Error('找不到資料庫套件 pg。請在系統資料夾執行 npm install 後再啟動。');
  }
  // sslmode / channel_binding 自己處理：pg 遇到 sslmode=require 會印出一段嚇人的英文警告，
  // 實際上它本來就會驗證憑證，這裡直接明確開啟 SSL，效果相同。
  let url;
  try { url = new URL(DATABASE_URL); } catch {
    throw new Error('DATABASE_URL 格式不正確，請從 Neon 用 Copy 按鈕重新複製整串連線字串。');
  }
  const sslmode = url.searchParams.get('sslmode');
  const channelBinding = url.searchParams.get('channel_binding') === 'require';
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  pool = new Pool({
    connectionString: url.toString(),
    ssl: sslmode === 'disable' || (local && !sslmode) ? false : true,
    enableChannelBinding: channelBinding,
    max: 4,
    connectionTimeoutMillis: 20000,   // Neon 休眠中醒來需要幾秒
    idleTimeoutMillis: 30000,
  });
  // Neon 休眠時會切斷閒置連線；不接住這個事件整個程式會當掉
  pool.on('error', (err) => console.error('  資料庫閒置連線中斷 (會自動重連)：', err.message));
  return pool;
}

const qi = (name) => '"' + name + '"';

async function ensureSchema(client) {
  for (const t of TABLES) {
    // pos 保留原本的排列順序；data 是整筆資料 (各表欄位不同，用 jsonb 存放才不必逐表對應欄位)
    await client.query(`CREATE TABLE IF NOT EXISTS ${qi(t)} (pos integer PRIMARY KEY, data jsonb NOT NULL)`);
  }
  await client.query(`CREATE TABLE IF NOT EXISTS ${qi(META_TABLE)} (key text PRIMARY KEY, value jsonb NOT NULL)`);
  await client.query(`INSERT INTO ${qi(META_TABLE)} (key, value) VALUES ('gen', '0') ON CONFLICT (key) DO NOTHING`);
}

async function readGen(client) {
  const r = await client.query(`SELECT value FROM ${qi(META_TABLE)} WHERE key = 'gen'`);
  return Number(r.rows[0] && r.rows[0].value) || 0;
}

async function loadPg() {
  const client = await pgPool().connect();
  try {
    await ensureSchema(client);
    const next = emptyDb();
    for (const t of TABLES) {
      const r = await client.query(`SELECT data FROM ${qi(t)} ORDER BY pos`);
      next[t] = r.rows.map(x => x.data);
    }
    const m = await client.query(`SELECT value FROM ${qi(META_TABLE)} WHERE key = 'seq'`);
    next.seq = (m.rows[0] && typeof m.rows[0].value === 'object') ? m.rows[0].value : {};
    return { data: next, gen: await readGen(client) };
  } finally {
    client.release();
  }
}

// 換成剛從資料庫讀到的內容
function adopt(loaded) {
  db = loaded.data;
  saved = snapshot(db);
  gen = loaded.gen;
  checkedAt = Date.now();
}

function snapshot(d) {
  const s = {};
  for (const t of TABLES) s[t] = JSON.stringify(d[t]);
  s.seq = JSON.stringify(d.seq);
  return s;
}

async function writePg() {
  const v = version;
  dirty = false;
  // 先同步把要寫的內容序列化 (之後的 await 期間其他請求改到的資料留給下一輪)
  const now = snapshot(db);
  const changed = TABLES.filter(t => now[t] !== saved[t]);
  const seqChanged = now.seq !== saved.seq;
  if (changed.length || seqChanged) {
    let client;
    try {
      client = await pgPool().connect();
    } catch (err) {
      discardUnsaved();
      throw err;
    }
    let nextGen;
    try {
      await client.query('BEGIN');
      // 鎖住代數那一列：同時間只有一處能寫，也順便確認沒有別處先寫過
      const g = await client.query(`SELECT value FROM ${qi(META_TABLE)} WHERE key = 'gen' FOR UPDATE`);
      const cur = Number(g.rows[0] && g.rows[0].value) || 0;
      if (cur !== gen) {
        const e = new Error('資料已被另一處 (另一台電腦或線上版) 修改過。');
        e.code = 'PMS_CONFLICT';
        throw e;
      }
      nextGen = cur + 1;
      for (const t of changed) {
        await client.query(`DELETE FROM ${qi(t)}`);
        await client.query(
          `INSERT INTO ${qi(t)} (pos, data)
           SELECT ord, value FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(value, ord)`,
          [now[t]]);
      }
      if (seqChanged) {
        await client.query(
          `INSERT INTO ${qi(META_TABLE)} (key, value) VALUES ('seq', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [now.seq]);
      }
      await client.query(`UPDATE ${qi(META_TABLE)} SET value = $1::jsonb WHERE key = 'gen'`, [String(nextGen)]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const conflict = err.code === 'PMS_CONFLICT';
      client.release(!conflict);   // 出錯的連線不放回連線池，下次重新連
      if (conflict) await reloadAfterConflict();
      else discardUnsaved('db');
      throw err;
    }
    client.release();
    for (const t of changed) saved[t] = now[t];
    saved.seq = now.seq;
    gen = nextGen;
    checkedAt = Date.now();
  }
  if (v > savedVersion) savedVersion = v;
}

function markDiscarded(from, reason) {
  discarded.push([from, version, reason]);
  if (discarded.length > 100) discarded.shift();
  savedVersion = version;
  dirty = false;
}

/* 寫入失敗 (或連不上資料庫)：把記憶體裡還沒存進去的修改全部取消，還原成資料庫裡的內容。
   這樣使用者看到「沒有儲存」就是真的沒存，不會等資料庫恢復後又被偷偷寫進去，
   造成重新輸入一次就變成兩筆。 */
function discardUnsaved(reason) {
  const from = savedVersion;
  for (const t of TABLES) if (JSON.stringify(db[t]) !== saved[t]) db[t] = JSON.parse(saved[t]);
  if (JSON.stringify(db.seq) !== saved.seq) db.seq = JSON.parse(saved.seq);
  markDiscarded(from, reason);
}

// 別處先寫過：取消這邊還沒存的修改，換成資料庫裡的最新內容
async function reloadAfterConflict() {
  const from = savedVersion;
  try {
    adopt(await loadPg());
  } catch {
    discardUnsaved('db');
    return;
  }
  markDiscarded(from, 'conflict');
}

/* 處理請求前確認資料庫有沒有被別處改過：讀取最多每 10 秒查一次，寫入 (force) 每次都查。
   只在有人使用時才查，不會讓 Neon 一直醒著。
   自己有修改還沒寫完時不重新載入，交給寫入時的代數檢查處理。 */
async function refresh(force = false) {
  if (!USE_PG || !db || (!force && Date.now() - checkedAt < 10000)) return;
  checkedAt = Date.now();
  if (writing || savedVersion < version) return;
  try {
    const client = await pgPool().connect();
    let loaded = null;
    const v = version;
    try {
      if (await readGen(client) !== gen) {
        client.release();
        loaded = await loadPg();
      } else client.release();
    } catch (err) { client.release(true); throw err; }
    if (loaded && version === v && !writing) adopt(loaded);
  } catch (err) {
    console.error('  檢查資料庫是否有更新失敗：', err.message);
  }
}

/* ── 載入 ─────────────────────────────────────────────────
   JSON 模式同步完成；資料庫模式回傳 Promise，server.js 會 await。 */
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FILE_DIR, { recursive: true });
  if (USE_PG) {
    return loadPg().then((loaded) => { adopt(loaded); return db; });
  }
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const t of TABLES) if (!Array.isArray(db[t])) db[t] = [];
    if (!db.seq) db.seq = {};
  } else {
    db = emptyDb();
    flush();
  }
  return db;
}

function get() {
  if (!db) {
    if (USE_PG) throw new Error('資料庫尚未載入完成。');
    load();
  }
  return db;
}

// 寫入合併：50ms 內的多次變更只寫一次
function commit() {
  dirty = true;
  version++;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    // 背景寫入失敗時，等下一次 commit 或 settle() 重試，錯誤由 settle() 回報給使用者
    flush().catch(err => console.error('  資料庫寫入失敗：', err.message));
  }, 50);
}

// JSON 模式同步寫檔；資料庫模式回傳 Promise (同一時間只有一筆寫入在跑)
function flush() {
  if (!db) return Promise.resolve();
  if (USE_PG) {
    if (!writing) writing = writePg().finally(() => { writing = null; });
    return writing;
  }
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  dirty = false;
  return Promise.resolve();
}

/* 等到「呼叫當下為止」的所有修改都寫進資料庫 (JSON 模式立即完成)。
   since 是請求開始時的 currentVersion()：這段期間的修改若因寫入失敗被取消，就丟出錯誤。 */
async function settle(since = 0) {
  if (!USE_PG) return;
  const target = version;
  while (savedVersion < target) {
    // 進行中的那一輪可能沒包含最新修改，等它結束再寫一輪；失敗時 discardUnsaved 會讓迴圈結束
    if (writing) await writing.catch(() => {});
    else await flush().catch(() => {});
  }
  const hit = discarded.find(([from, to]) => to > since && from < target);
  if (hit) {
    const e = new Error(hit[2] === 'conflict' ? '資料已被另一處修改，這次的修改已取消。' : '寫入資料庫失敗，修改已取消。');
    e.code = hit[2] === 'conflict' ? 'PMS_CONFLICT' : 'PMS_DB';
    throw e;
  }
}

const currentVersion = () => version;

// 程式結束前確保資料落地
process.on('exit', () => { if (dirty && !USE_PG) flush(); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!USE_PG) { if (dirty) flush(); process.exit(0); }
    // Render 重新部署時會送 SIGTERM：最多等 8 秒把資料寫完
    const bye = setTimeout(() => process.exit(0), 8000);
    settle().catch(err => console.error('  結束前寫入失敗：', err.message))
      .finally(() => { clearTimeout(bye); process.exit(0); });
  });
}

// 啟動畫面顯示資料存在哪裡 (不顯示密碼)
function describe() {
  if (!USE_PG) return DATA_FILE;
  try {
    const u = new URL(DATABASE_URL);
    return `PostgreSQL 資料庫 ${u.hostname}${u.pathname}`;
  } catch { return 'PostgreSQL 資料庫'; }
}

/* ── 流水號 ────────────────────────────────────────────── */
// 子表用的整數 PK
function nextInt(name) {
  const d = get();
  d.seq[name] = (Number(d.seq[name]) || 0) + 1;
  return d.seq[name];
}

// 單據編號：前綴 + 補零流水號 (掃描現有資料取最大值，還原備份後仍可正確接續)
function nextCode(table, field, prefix, width = 4) {
  const d = get();
  const re = new RegExp('^' + prefix + '(\\d{' + width + '})');
  let max = 0;
  for (const row of d[table]) {
    const m = re.exec(String(row[field] || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return prefix + String(max + 1).padStart(width, '0');
}

/* ── 查詢小工具 ────────────────────────────────────────── */
const all = (t) => get()[t];
const find = (t, field, value) => get()[t].find(r => String(r[field]) === String(value));
const where = (t, fn) => get()[t].filter(fn);

function insert(t, row) {
  get()[t].push(row);
  commit();
  return row;
}

function update(t, field, value, patch) {
  const row = find(t, field, value);
  if (!row) return null;
  Object.assign(row, patch);
  commit();
  return row;
}

function remove(t, fn) {
  const d = get();
  const before = d[t].length;
  d[t] = d[t].filter(r => !fn(r));
  if (d[t].length !== before) commit();
  return before - d[t].length;
}

// 系統還原：整個資料庫換成備份內容
function replaceAll(data) {
  const next = emptyDb();
  for (const t of TABLES) if (Array.isArray(data[t])) next[t] = data[t];
  next.seq = (data.seq && typeof data.seq === 'object') ? data.seq : {};
  db = next;
  version++;
  flush().catch(err => console.error('  資料庫寫入失敗：', err.message));
  return db;
}

// 關閉資料庫連線 (匯入工具用完要呼叫，否則程式不會結束)
async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = {
  TABLES, DATA_DIR, DATA_FILE, FILE_DIR, USE_PG,
  load, get, commit, flush, settle, refresh, currentVersion, describe, close,
  nextInt, nextCode,
  all, find, where, insert, update, remove, replaceAll,
};
