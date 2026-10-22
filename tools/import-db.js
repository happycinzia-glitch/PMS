/* ============================================================
   把本機的 data/db.json (或系統還原用的備份 .json) 匯入 Neon 資料庫
   用法 (先關閉系統，並確認 .env 已填好 DATABASE_URL)：
     node tools/import-db.js                    匯入 data/db.json
     node tools/import-db.js 備份檔.json        匯入指定的檔案
   資料庫裡已經有資料時會停下來，確定要覆蓋請在最後加上 --force
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('../src/env').loadDotEnv(path.join(ROOT, '.env'));
const store = require('../src/store');

function fail(msg) {
  console.error('\n  ' + msg + '\n');
  process.exit(1);
}

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const file = path.resolve(args.find(a => a !== '--force') || path.join(ROOT, 'data', 'db.json'));

  if (!store.USE_PG) fail('沒有設定 DATABASE_URL。請先在 .env 填好 Neon 的連線字串 (自學講義步驟 5-4)。');
  if (!fs.existsSync(file)) fail('找不到要匯入的檔案：' + file);

  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    fail('檔案不是正確的 JSON：' + e.message);
  }
  if (!data || !Array.isArray(data.accounts)) fail('檔案格式不正確 (缺少帳號資料)：' + file);
  if (!data.accounts.some(a => a.perm_admin && a.status === '正常' && a.password)) {
    fail('檔案中沒有任何「正常」狀態的系統管理者帳號，匯入後將無法登入，已中止。');
  }

  console.log('  連線到 ' + store.describe() + ' …');
  const current = await store.load();
  const existing = store.TABLES.reduce((n, t) => n + current[t].length, 0);
  if (existing && !force) {
    await store.close();
    fail(`資料庫裡已經有 ${existing} 筆資料。確定要用 ${path.basename(file)} 整個覆蓋，請在指令最後加上 --force`);
  }

  store.replaceAll(data);
  await store.settle();

  console.log('\n  匯入完成：' + file);
  for (const t of store.TABLES) {
    const n = store.all(t).length;
    if (n) console.log(`    ${t.padEnd(16)} ${n} 筆`);
  }
  console.log('\n  接著重新啟動系統 (啟動系統.bat)，登入確認資料都在。\n');
  await store.close();
})().catch(async (err) => {
  await store.close().catch(() => {});
  fail('匯入失敗：' + err.message);
});
