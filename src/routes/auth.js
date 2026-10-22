/* ── 登入 / 登出 / 變更密碼 ─────────────────────────── */
const express = require('express');
const store = require('../store');
const { hashPassword, verifyPassword, nowISO, requireLogin } = require('../util');

const router = express.Router();
const MAX_FAIL = 5;   // 連續錯誤 5 次鎖住帳號

// 回給前端的使用者資訊 (不含密碼)
function publicUser(a) {
  return {
    emp_id: a.emp_id, name: a.name, title: a.title, status: a.status,
    perm_admin: !!a.perm_admin, perm_customer: !!a.perm_customer, perm_quote: !!a.perm_quote,
    perm_project: !!a.perm_project, perm_vendor: !!a.perm_vendor, perm_payable: !!a.perm_payable,
    perm_receivable: !!a.perm_receivable, perm_accounting: !!a.perm_accounting,
    perm_inventory: !!a.perm_inventory,
  };
}

/* 每次請求都從資料庫重新載入權限與狀態：
   管理者調整權限或停用帳號後立即生效，不必等對方重新登入。 */
router.use((req, res, next) => {
  if (!req.session?.user) return next();
  const a = store.find('accounts', 'emp_id', req.session.user.emp_id);
  if (!a || a.status !== '正常') {
    delete req.session.user;              // 只登出系統，保留門禁通行證
    return res.status(401).json({ error: '帳號已停用或被鎖住，請聯絡系統管理者。' });
  }
  req.session.user = publicUser(a);
  next();
});

router.post('/login', (req, res) => {
  const emp_id = String(req.body?.emp_id || '').trim();
  const password = String(req.body?.password || '');
  if (!emp_id || !password) return res.status(400).json({ error: '請輸入員工代號與密碼。' });

  const a = store.find('accounts', 'emp_id', emp_id);
  if (!a) return res.status(401).json({ error: '員工代號或密碼錯誤。' });
  if (a.status === '鎖住') return res.status(403).json({ error: '此帳號已被鎖住，請聯絡系統管理者解鎖。' });
  if (a.status === '已離職') return res.status(403).json({ error: '此帳號已離職，無法登入。' });

  if (!verifyPassword(password, a.password)) {
    a.fail_count = (Number(a.fail_count) || 0) + 1;
    const left = MAX_FAIL - a.fail_count;
    if (a.fail_count >= MAX_FAIL) a.status = '鎖住';
    store.commit();
    return res.status(401).json({
      error: a.status === '鎖住'
        ? `密碼錯誤 ${MAX_FAIL} 次，帳號已鎖住，請聯絡系統管理者解鎖。`
        : `員工代號或密碼錯誤。(再錯 ${left} 次將鎖住帳號)`,
    });
  }

  a.fail_count = 0;
  a.last_login = nowISO();
  store.commit();
  req.session.user = publicUser(a);
  res.json({ user: req.session.user });
});

router.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: '尚未登入或登入逾時，請重新登入。' });
  res.json({ user: req.session.user });
});

// 只登出系統帳號；門禁通行證保留，回到系統登入頁即可換人登入 (離開門禁請用 /api/gate/logout)
router.post('/logout', (req, res) => {
  delete req.session.user;
  req.session.save(() => res.json({ ok: true }));
});

router.post('/change-password', requireLogin, (req, res) => {
  const oldPw = String(req.body?.old_password || '');
  const newPw = String(req.body?.new_password || '');
  if (!oldPw || !newPw) return res.status(400).json({ error: '請輸入舊密碼與新密碼。' });
  if (newPw.length < 4) return res.status(400).json({ error: '新密碼至少 4 個字元。' });
  if (oldPw === newPw) return res.status(400).json({ error: '新密碼不可與舊密碼相同。' });

  const a = store.find('accounts', 'emp_id', req.session.user.emp_id);
  if (!a || !verifyPassword(oldPw, a.password)) return res.status(400).json({ error: '舊密碼不正確。' });

  a.password = hashPassword(newPw);
  a.updated_at = nowISO();
  store.commit();
  res.json({ ok: true });
});

module.exports = router;
module.exports.publicUser = publicUser;
