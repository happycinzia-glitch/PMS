/* ============================================================
   首次啟動時建立預設管理者帳號與各項下拉清單預設值
   ============================================================ */
const store = require('./store');
const { hashPassword, nowISO } = require('./util');

// 「項目維護」八組清單的預設內容
const DEFAULT_OPTIONS = {
  vendor_business: ['拆除工程', '泥作工程', '水電工程', '木作工程', '油漆工程', '系統櫃',
    '輕隔間工程', '地板工程', '壁紙工程', '門窗工程', '鐵件工程', '冷氣工程',
    '窗簾工程', '保護工程', '清潔工程', '設計服務'],
  vendor_payment: ['現金', '月結30天', '月結60天', '月結90天', '貨到付款', '訂金50%尾款50%'],
  receivable_item: ['訂金', '第一期款', '第二期款', '第三期款', '尾款', '保留款', '追加款', '設計費', '丈量費'],
  receivable_receive_method: ['現金', '匯款', '支票', '轉帳', '信用卡'],
  payable_item: ['工程款', '材料款', '訂金', '期中款', '尾款', '追加款', '設計費', '運費'],
  payable_pay_method: ['現金', '匯款', '支票', '轉帳'],
  expense_category: ['房租', '水電費', '電話費', '網路費', '文具用品', '交通費', '交際費',
    '保險費', '稅捐規費', '廣告費', '修繕費', '薪資', '獎金', '勞健保', '雜項支出'],
  project_status: ['準備進場', '拆除工程', '水電工程', '泥作工程', '木作工程',
    '油漆工程', '系統櫃安裝', '清潔工程', '驗收中', '已完工'],
};

// 預設管理者。只有在資料庫「完全沒有帳號」時才會建立一次。
// 首次登入後請立刻用左下角「變更密碼」改掉，或先設定環境變數 ADMIN_PASSWORD 再啟動。
const ADMIN_ID = process.env.ADMIN_ID || 'Admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin0000';
const ADMIN_NAME = process.env.ADMIN_NAME || '系統管理員';

function seed() {
  const db = store.get();
  let changed = false;

  if (!db.accounts.length) {
    db.accounts.push({
      emp_id: ADMIN_ID,
      name: ADMIN_NAME,
      title: '系統管理員',
      salary: 0,
      password: hashPassword(ADMIN_PASSWORD),
      hire_date: null,
      resign_date: null,
      last_login: null,
      status: '正常',
      fail_count: 0,
      perm_admin: true, perm_customer: true, perm_quote: true, perm_project: true,
      perm_vendor: true, perm_payable: true, perm_receivable: true, perm_accounting: true,
      perm_inventory: true,
      note: '',
      created_at: nowISO(), updated_at: nowISO(),
    });
    changed = true;
    console.log(`  已建立預設管理者帳號：${ADMIN_ID}`);
    if (ADMIN_PASSWORD === 'Admin0000') {
      console.log('');
      console.log('  ****************************************************');
      console.log(`  *  預設密碼為 Admin0000，請登入後立即變更密碼！   *`);
      console.log('  ****************************************************');
    }
  }

  for (const [category, values] of Object.entries(DEFAULT_OPTIONS)) {
    if (db.options.some(o => o.category === category)) continue;
    values.forEach((value, i) => db.options.push({ category, value, seq: i + 1 }));
    changed = true;
  }

  // 資料庫模式下 flush 回傳 Promise，server.js 會等它寫完才開始服務
  if (changed) return store.flush();
}

module.exports = { seed, DEFAULT_OPTIONS };
