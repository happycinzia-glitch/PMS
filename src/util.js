/* ── 共用小工具 ──────────────────────────────────────── */
const crypto = require('crypto');
const store = require('./store');

/* 密碼雜湊：scrypt (Node 內建，不需原生模組) */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* 型別轉換 */
const num = (v) => {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
// 可為 null 的數字 (區分「沒填」與「填 0」)
const numOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};
const str = (v) => (v === null || v === undefined) ? '' : String(v).trim();
// 日期一律存成 YYYY-MM-DD，空值存 null
const date = (v) => {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const bool = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';

// 依本機時區取 YYYY-MM-DD (toISOString 是 UTC，台灣早上 8 點前會變成前一天)
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => localDate();
// 今天往後 (負數為往前) n 天的日期
const daysFromToday = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDate(d); };
const nowISO = () => new Date().toISOString();
// 兩個日期相差幾天 (a - b)
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
// 日期是否落在 year 年 from~to 月之間
function inPeriod(d, year, from, to) {
  if (!d) return false;
  const y = Number(String(d).slice(0, 4));
  const m = Number(String(d).slice(5, 7));
  return y === year && m >= from && m <= to;
}

/* 關鍵字比對：任一欄位含關鍵字即符合 (不分大小寫) */
function matches(row, fields, q) {
  if (!q) return true;
  const k = String(q).toLowerCase();
  return fields.some(f => String(row[f] ?? '').toLowerCase().includes(k));
}

/* 名稱查詢 (清單/明細要顯示的關聯欄位) */
const empName = (id) => store.find('accounts', 'emp_id', id)?.name || '';
const custName = (id) => store.find('customers', 'cust_id', id)?.name || '';
const vendName = (id) => store.find('vendors', 'vend_id', id)?.company_name || '';
const projName = (id) => store.find('projects', 'proj_id', id)?.proj_name || '';

/* 權限：系統管理者擁有全部功能 */
function hasPerm(user, perm) {
  if (!user) return false;
  return !!(user.perm_admin || user[perm]);
}
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: '尚未登入。' });
    if (!hasPerm(req.session.user, perm)) {
      return res.status(403).json({ error: '您的帳號沒有使用此功能的權限，請聯絡系統管理者。' });
    }
    next();
  };
}
function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: '尚未登入或登入逾時，請重新登入。' });
  next();
}

/* 建檔/改檔共用欄位 */
const stamp = (req) => ({ created_by: req.session.user.emp_id, created_at: nowISO(), updated_at: nowISO() });
const touch = () => ({ updated_at: nowISO() });

module.exports = {
  hashPassword, verifyPassword,
  num, numOrNull, str, date, bool,
  localDate, today, daysFromToday, nowISO, daysBetween, inPeriod, matches,
  empName, custName, vendName, projName,
  hasPerm, requirePerm, requireLogin, stamp, touch,
};
