/* ── 載入 .env 設定檔（如果有的話）──
   不使用額外套件。必須在載入 store / seed 之前執行，因為它們會讀取環境變數。
   刻意自己解析而不用 Node 內建的 loadEnvFile，原因是：
   Windows 的記事本存檔常會加上 BOM，會讓「第一個」變數的名稱多出隱藏字元
   而靜默失效——初學者幾乎不可能查出這種問題。 */
const fs = require('fs');

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  text = text.replace(/^﻿/, '');                    // 去掉記事本可能加上的 BOM
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;               // 空行與註解
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (val.length > 1 && ((val[0] === '"' && val.endsWith('"')) ||
                           (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);                            // 去掉成對引號
    }
    // 真正的環境變數（例如 Render 上設定的）優先，.env 不覆蓋它
    if (val !== '' && process.env[key] === undefined) { process.env[key] = val; count++; }
  }
  console.log(`  已載入 .env 設定（${count} 項）`);
  return true;
}

module.exports = { loadDotEnv };
