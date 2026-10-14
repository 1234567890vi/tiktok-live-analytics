/**
 * admin.js — Dedicated Owner Administration Dashboard Script
 * Handles authentication, live tracking sessions, kick/ban controls,
 * broadcast announcements, and EulerStream SIGN_API_KEY management.
 */

'use strict';

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------
const I18N = {
  ar: {
    navTitle: 'لوحة الإدارة والتحكم',
    navSubtitle: 'TikTok Live Analytics Platform',
    btnBackToTracker: 'منصة التتبع المباشر',
    navLogoutText: 'خروج',
    admAuthTitle: 'تسجيل دخول المالك',
    admAuthSubtitle: 'لوحة التحكم مخصصة لمالك الموقع فقط لإدارة جلسات التتبع، حظر الحسابات وضبط مزود التوقيع.',
    admBtnLoginSubmit: 'تسجيل الدخول للوحة التحكم',
    labelServiceStatus: 'حالة خدمة التتبع:',
    trackingActive: '🟢 التتبع: يعمل (نشط)',
    trackingFrozen: '🔴 التتبع: معطل (صيانة)',
    textClearHistory: 'مسح السجل المكتمل',
    admBtnRefresh: 'تحديث فوري',
    admBtnLogout: 'تسجيل الخروج',
    tabTitleSessions: 'المستخدمون والجلسات المباشرة',
    tabTitleBanned: 'قائمة الحظر والمنع',
    tabTitleBroadcast: 'إرسال إشعار جماعي',
    tabTitleApiSettings: 'مفتاح التوقيع (Sign API)',
    admLabelActive: 'المستخدمون النشطون الآن',
    admLabelTotal: 'إجمالي عمليات التتبع',
    admLabelUptime: 'مدة تشغيل السيرفر',
    admTableTitle: 'سجل الحسابات المبحوث عنها، مدة الاستخدام، والتحكم الفوري',
    thUser: 'الحساب المستهدف (Target)',
    thStatus: 'الحالة (Status)',
    thStart: 'وقت البدء (Start Time)',
    thDuration: 'مدة الاستخدام (Duration)',
    thDiamonds: 'ألماسات مسجلة (Diamonds)',
    thActions: 'إجراءات التحكم (Actions)',
    bannedBoxTitle: 'إضافة حساب تيك توك إلى قائمة الحظر',
    bannedBoxSubtitle: 'الحسابات المحظورة لن يتمكن أي مستخدم في الموقع من تتبعها أو فتح بثها، وسيتم قطع اتصالها فوراً إذا كانت قيد التتبع.',
    btnSubmitBanText: 'حظر هذا الحساب',
    bannedTableTitle: 'قائمة الحسابات المحظورة حالياً',
    bcastTitle: 'إرسال إشعار تنبيهي جماعي لجميع المتصلين',
    bcastSubtitle: 'سيظهر هذا التنبيه فوراً كإشعار منبثق (Toast) على شاشات جميع المستخدمين الذين يتتبعون بثوثاً حالياً.',
    bcastLabel: 'نص الرسالة التنبيهية:',
    btnSubmitBroadcastText: 'إرسال الإشعار لجميع المستخدمين الآن',
    apiKeyTitle: 'إعداد مفتاح مزود التوقيع (EulerStream API Key)',
    apiKeySubtitle: 'لتفادي حظر الـ IP المشترك وضمان تتبع مباشر بدون انقطاع',
    labelApiKey: 'مفتاح SIGN_API_KEY:',
    btnSaveSignApiKeyText: 'حفظ المفتاح',
    labelCurrentStatus: 'الحالة الحالية:',
    statusActive: 'نشط الآن',
    statusCompleted: 'مكتمل',
    noRecords: 'لا توجد سجلات تتبع حالياً',
    noBanned: 'لا توجد حسابات محظورة حالياً',
    btnKick: '🔴 قطع الاتصال',
    btnBan: '🚫 حظر',
    btnUnban: '✅ إلغاء الحظر',
    confirmKick: 'هل أنت متأكد من قطع اتصال جلسة @{user} فوراً؟',
    confirmBan: 'هل تريد حظر @{user} ومنع أي شخص من تتبعه؟',
    confirmClear: 'هل تريد مسح سجلات التتبع السابقة المكتملة؟',
  },
  en: {
    navTitle: 'Admin Dashboard',
    navSubtitle: 'TikTok Live Analytics Platform',
    btnBackToTracker: 'Live Tracker',
    navLogoutText: 'Logout',
    admAuthTitle: 'Owner Login',
    admAuthSubtitle: 'This dashboard is reserved for the site owner to manage active sessions, bans, and signature providers.',
    admBtnLoginSubmit: 'Login to Admin Panel',
    labelServiceStatus: 'Tracking Service Status:',
    trackingActive: '🟢 Tracking: Active',
    trackingFrozen: '🔴 Tracking: Frozen (Maintenance)',
    textClearHistory: 'Clear Completed History',
    admBtnRefresh: 'Refresh Now',
    admBtnLogout: 'Logout',
    tabTitleSessions: 'Live Sessions & Users',
    tabTitleBanned: 'Banned Accounts',
    tabTitleBroadcast: 'Broadcast Announcement',
    tabTitleApiSettings: 'Signature Key (Sign API)',
    admLabelActive: 'Active Users Now',
    admLabelTotal: 'Total Tracking Visits',
    admLabelUptime: 'Server Uptime',
    admTableTitle: 'Tracked Accounts, Duration, & Immediate Controls',
    thUser: 'Target Username',
    thStatus: 'Status',
    thStart: 'Start Time',
    thDuration: 'Duration',
    thDiamonds: 'Diamonds',
    thActions: 'Actions',
    bannedBoxTitle: 'Add TikTok Account to Ban List',
    bannedBoxSubtitle: 'Banned accounts cannot be tracked by any user, and will be immediately terminated if active.',
    btnSubmitBanText: 'Ban Account',
    bannedTableTitle: 'Currently Banned Accounts',
    bcastTitle: 'Send Broadcast Announcement to All Connected Users',
    bcastSubtitle: 'This alert will pop up immediately on screens of all users currently tracking live streams.',
    bcastLabel: 'Announcement Message:',
    btnSubmitBroadcastText: 'Broadcast Alert to All Users Now',
    apiKeyTitle: 'EulerStream Signature API Key Setup',
    apiKeySubtitle: 'Prevent shared-IP rate limiting and ensure stable uninterrupted tracking',
    labelApiKey: 'SIGN_API_KEY:',
    btnSaveSignApiKeyText: 'Save Key',
    labelCurrentStatus: 'Current Status:',
    statusActive: 'Active Now',
    statusCompleted: 'Completed',
    noRecords: 'No tracking records found',
    noBanned: 'No banned accounts',
    btnKick: '🔴 Kick',
    btnBan: '🚫 Ban',
    btnUnban: '✅ Unban',
    confirmKick: 'Are you sure you want to kick tracking session for @{user}?',
    confirmBan: 'Ban @{user} from being tracked platform-wide?',
    confirmClear: 'Clear all past completed tracking records?',
  }
};

let currentLang = localStorage.getItem('tt_tracker_lang') || 'ar';
let adminRefreshInterval = null;
let currentTrackingEnabled = true;

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const DOM = {
  // Navigation
  navTitle:          $('navTitle'),
  navSubtitle:       $('navSubtitle'),
  btnBackToTracker:  $('btnBackToTracker'),
  navLogoutBtn:      $('navLogoutBtn'),
  navLogoutText:     $('navLogoutText'),
  langArBtn:         $('langArBtn'),
  langEnBtn:         $('langEnBtn'),

  // Login view
  adminLoginSection: $('adminLoginSection'),
  admAuthTitle:      $('admAuthTitle'),
  admAuthSubtitle:   $('admAuthSubtitle'),
  adminPasswordInput:$('adminPasswordInput'),
  adminLoginBtn:     $('adminLoginBtn'),
  admBtnLoginSubmit: $('admBtnLoginSubmit'),
  adminLoginError:   $('adminLoginError'),

  // Dashboard view
  adminDashboardSection: $('adminDashboardSection'),
  labelServiceStatus:    $('labelServiceStatus'),
  btnToggleTracking:     $('btnToggleTracking'),
  textToggleTracking:    $('textToggleTracking'),
  btnClearHistory:       $('btnClearHistory'),
  textClearHistory:      $('textClearHistory'),
  adminRefreshBtn:       $('adminRefreshBtn'),
  admBtnRefresh:         $('admBtnRefresh'),
  adminLogoutBtn:        $('adminLogoutBtn'),
  admBtnLogout:          $('admBtnLogout'),

  // Tabs
  tabBtnSessions:        $('tabBtnSessions'),
  tabBtnBanned:          $('tabBtnBanned'),
  tabBtnBroadcast:       $('tabBtnBroadcast'),
  tabBtnApiSettings:     $('tabBtnApiSettings'),
  tabTitleSessions:      $('tabTitleSessions'),
  tabTitleBanned:        $('tabTitleBanned'),
  tabTitleBroadcast:     $('tabTitleBroadcast'),
  tabTitleApiSettings:   $('tabTitleApiSettings'),
  badgeBannedCount:      $('badgeBannedCount'),
  badgeSignKeyStatus:    $('badgeSignKeyStatus'),

  // Tab 1 Views
  tabViewSessions:       $('tabViewSessions'),
  admLabelActive:        $('admLabelActive'),
  admLabelTotal:         $('admLabelTotal'),
  admLabelUptime:        $('admLabelUptime'),
  admActiveUsers:        $('admActiveUsers'),
  admTotalVisits:        $('admTotalVisits'),
  admServerUptime:       $('admServerUptime'),
  admTableTitle:         $('admTableTitle'),
  thUser:                $('thUser'),
  thStatus:              $('thStatus'),
  thStart:               $('thStart'),
  thDuration:            $('thDuration'),
  thDiamonds:            $('thDiamonds'),
  thActions:             $('thActions'),
  adminTableBody:        $('adminTableBody'),

  // Tab 2 Views
  tabViewBanned:         $('tabViewBanned'),
  bannedBoxTitle:        $('bannedBoxTitle'),
  bannedBoxSubtitle:     $('bannedBoxSubtitle'),
  bannedInputTarget:     $('bannedInputTarget'),
  btnSubmitBan:          $('btnSubmitBan'),
  btnSubmitBanText:      $('btnSubmitBanText'),
  bannedTableTitle:      $('bannedTableTitle'),
  bannedTableBody:       $('bannedTableBody'),

  // Tab 3 Views
  tabViewBroadcast:      $('tabViewBroadcast'),
  bcastTitle:            $('bcastTitle'),
  bcastSubtitle:         $('bcastSubtitle'),
  bcastLabel:            $('bcastLabel'),
  broadcastMsgInput:     $('broadcastMsgInput'),
  btnSubmitBroadcast:    $('btnSubmitBroadcast'),
  btnSubmitBroadcastText:$('btnSubmitBroadcastText'),
  broadcastResult:       $('broadcastResult'),

  // Tab 4 Views
  tabViewApiSettings:    $('tabViewApiSettings'),
  apiKeyTitle:           $('apiKeyTitle'),
  apiKeySubtitle:        $('apiKeySubtitle'),
  labelApiKey:           $('labelApiKey'),
  inputSignApiKey:       $('inputSignApiKey'),
  btnSaveSignApiKey:     $('btnSaveSignApiKey'),
  btnSaveSignApiKeyText: $('btnSaveSignApiKeyText'),
  labelCurrentStatus:    $('labelCurrentStatus'),
  currentSignKeyText:    $('currentSignKeyText'),

  // Tab 5 Views (Telegram)
  tabBtnTelegram:         $('tabBtnTelegram'),
  tabTitleTelegram:       $('tabTitleTelegram'),
  badgeTelegramStatus:    $('badgeTelegramStatus'),
  tabViewTelegram:        $('tabViewTelegram'),
  tgLiveStatusBadge:      $('tgLiveStatusBadge'),
  btnTelegramTest:        $('btnTelegramTest'),
  textBtnTelegramTest:    $('textBtnTelegramTest'),
  btnTelegramSendReport:  $('btnTelegramSendReport'),
  textBtnTelegramReport:  $('textBtnTelegramReport'),
  inputTelegramToken:     $('inputTelegramToken'),
  inputTelegramChatId:    $('inputTelegramChatId'),
  checkNotifyStreamStart: $('checkNotifyStreamStart'),
  checkNotifyStreamEnd:   $('checkNotifyStreamEnd'),
  selectPeriodicReport:   $('selectPeriodicReport'),
  btnSaveTelegramSettings:$('btnSaveTelegramSettings'),

  // Toast
  toastContainer:        $('toastContainer'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(num) {
  if (num === undefined || num === null) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function formatDuration(seconds, lang = 'ar') {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return lang === 'ar' ? `${s} ثانية` : `${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h === 0) return lang === 'ar' ? `${m} دقيقة ${s} ث` : `${m}m ${s}s`;
  return lang === 'ar' ? `${h} س ${remM} د` : `${h}h ${remM}m`;
}

function formatUptime(seconds, lang = 'ar') {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return lang === 'ar' ? `${d}ي ${h}س ${m}د` : `${d}d ${h}h ${m}m`;
  if (h > 0) return lang === 'ar' ? `${h}س ${m}د ${s}ث` : `${h}h ${m}m ${s}s`;
  return lang === 'ar' ? `${m}د ${s}ث` : `${m}m ${s}s`;
}

function toast(msg, type = 'info', duration = 4000) {
  if (!DOM.toastContainer) return;
  const colors = {
    info:    'bg-gray-800/90 border-gray-700 text-white',
    success: 'bg-emerald-950/90 border-emerald-700 text-emerald-200',
    error:   'bg-red-950/90 border-red-700 text-red-200',
    warning: 'bg-amber-950/90 border-amber-700 text-amber-200',
  };
  const div = document.createElement('div');
  div.className = `p-3.5 rounded-xl border text-xs shadow-xl backdrop-blur-md pointer-events-auto transition-all transform translate-y-2 opacity-0 ${colors[type] || colors.info}`;
  div.textContent = msg;
  DOM.toastContainer.appendChild(div);

  requestAnimationFrame(() => {
    div.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    div.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => div.remove(), 300);
  }, duration);
}

// ---------------------------------------------------------------------------
// Language Management
// ---------------------------------------------------------------------------
function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('tt_tracker_lang', lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

  const t = I18N[lang] || I18N.ar;

  // Language buttons
  if (DOM.langArBtn && DOM.langEnBtn) {
    if (lang === 'ar') {
      DOM.langArBtn.className = 'px-2.5 py-1 rounded-lg font-bold transition bg-purple-600 text-white';
      DOM.langEnBtn.className = 'px-2.5 py-1 rounded-lg font-bold transition text-gray-400 hover:text-white';
    } else {
      DOM.langArBtn.className = 'px-2.5 py-1 rounded-lg font-bold transition text-gray-400 hover:text-white';
      DOM.langEnBtn.className = 'px-2.5 py-1 rounded-lg font-bold transition bg-purple-600 text-white';
    }
  }

  // Update text nodes
  const textMapping = [
    [DOM.navTitle, t.navTitle],
    [DOM.navSubtitle, t.navSubtitle],
    [DOM.btnBackToTracker, t.btnBackToTracker],
    [DOM.navLogoutText, t.navLogoutText],
    [DOM.admAuthTitle, t.admAuthTitle],
    [DOM.admAuthSubtitle, t.admAuthSubtitle],
    [DOM.admBtnLoginSubmit, t.admBtnLoginSubmit],
    [DOM.labelServiceStatus, t.labelServiceStatus],
    [DOM.textClearHistory, t.textClearHistory],
    [DOM.admBtnRefresh, t.admBtnRefresh],
    [DOM.admBtnLogout, t.admBtnLogout],
    [DOM.tabTitleSessions, t.tabTitleSessions],
    [DOM.tabTitleBanned, t.tabTitleBanned],
    [DOM.tabTitleBroadcast, t.tabTitleBroadcast],
    [DOM.tabTitleApiSettings, t.tabTitleApiSettings],
    [DOM.admLabelActive, t.admLabelActive],
    [DOM.admLabelTotal, t.admLabelTotal],
    [DOM.admLabelUptime, t.admLabelUptime],
    [DOM.admTableTitle, t.admTableTitle],
    [DOM.thUser, t.thUser],
    [DOM.thStatus, t.thStatus],
    [DOM.thStart, t.thStart],
    [DOM.thDuration, t.thDuration],
    [DOM.thDiamonds, t.thDiamonds],
    [DOM.thActions, t.thActions],
    [DOM.bannedBoxTitle, t.bannedBoxTitle],
    [DOM.bannedBoxSubtitle, t.bannedBoxSubtitle],
    [DOM.btnSubmitBanText, t.btnSubmitBanText],
    [DOM.bannedTableTitle, t.bannedTableTitle],
    [DOM.bcastTitle, t.bcastTitle],
    [DOM.bcastSubtitle, t.bcastSubtitle],
    [DOM.bcastLabel, t.bcastLabel],
    [DOM.btnSubmitBroadcastText, t.btnSubmitBroadcastText],
    [DOM.apiKeyTitle, t.apiKeyTitle],
    [DOM.apiKeySubtitle, t.apiKeySubtitle],
    [DOM.labelApiKey, t.labelApiKey],
    [DOM.btnSaveSignApiKeyText, t.btnSaveSignApiKeyText],
    [DOM.labelCurrentStatus, t.labelCurrentStatus],
  ];

  for (const [el, val] of textMapping) {
    if (el) el.textContent = val;
  }

  updateTrackingSwitchUI(currentTrackingEnabled);
}

// ---------------------------------------------------------------------------
// View Switching: Login vs Dashboard
// ---------------------------------------------------------------------------
function showLogin() {
  if (DOM.adminLoginSection) DOM.adminLoginSection.classList.remove('hidden');
  if (DOM.adminDashboardSection) DOM.adminDashboardSection.classList.add('hidden');
  if (DOM.navLogoutBtn) DOM.navLogoutBtn.classList.add('hidden');
  if (DOM.adminPasswordInput) {
    DOM.adminPasswordInput.value = '';
    DOM.adminPasswordInput.focus();
  }
}

function showDashboard() {
  if (DOM.adminLoginSection) DOM.adminLoginSection.classList.add('hidden');
  if (DOM.adminDashboardSection) DOM.adminDashboardSection.classList.remove('hidden');
  if (DOM.navLogoutBtn) DOM.navLogoutBtn.classList.remove('hidden');
}

function switchAdminTab(tab) {
  const isSessions = tab === 'sessions';
  const isBanned   = tab === 'banned';
  const isBcast    = tab === 'broadcast';
  const isApi      = tab === 'api_settings';
  const isTelegram = tab === 'telegram';

  if (DOM.tabViewSessions) DOM.tabViewSessions.classList.toggle('hidden', !isSessions);
  if (DOM.tabViewBanned) DOM.tabViewBanned.classList.toggle('hidden', !isBanned);
  if (DOM.tabViewBroadcast) DOM.tabViewBroadcast.classList.toggle('hidden', !isBcast);
  if (DOM.tabViewApiSettings) DOM.tabViewApiSettings.classList.toggle('hidden', !isApi);
  if (DOM.tabViewTelegram) DOM.tabViewTelegram.classList.toggle('hidden', !isTelegram);

  const activeTabClass = 'px-4 py-3 text-xs sm:text-sm font-bold border-b-2 border-purple-500 text-purple-300 transition flex items-center gap-2 whitespace-nowrap';
  const inactiveTabClass = 'px-4 py-3 text-xs sm:text-sm font-bold border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition flex items-center gap-2 whitespace-nowrap';

  if (DOM.tabBtnSessions) DOM.tabBtnSessions.className = isSessions ? activeTabClass : inactiveTabClass;
  if (DOM.tabBtnBanned) DOM.tabBtnBanned.className = isBanned ? activeTabClass : inactiveTabClass;
  if (DOM.tabBtnBroadcast) DOM.tabBtnBroadcast.className = isBcast ? activeTabClass : inactiveTabClass;
  if (DOM.tabBtnApiSettings) DOM.tabBtnApiSettings.className = isApi ? activeTabClass : inactiveTabClass;
  if (DOM.tabBtnTelegram) DOM.tabBtnTelegram.className = isTelegram ? activeTabClass : inactiveTabClass;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
async function handleLogin() {
  const pwd = DOM.adminPasswordInput ? DOM.adminPasswordInput.value.trim() : '';
  if (!pwd) {
    toast(currentLang === 'ar' ? 'يرجى إدخال كلمة المرور' : 'Please enter admin password', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok' && data.token) {
      sessionStorage.setItem('tt_admin_token', data.token);
      if (DOM.adminLoginError) DOM.adminLoginError.classList.add('hidden');
      showDashboard();
      await loadAdminStats();
      startAdminRefresh();
      toast(currentLang === 'ar' ? '👑 مرحباً بك يا مالك الموقع! تم تسجيل الدخول بنجاح' : '👑 Welcome Owner! Authentication successful', 'success');
    } else {
      if (DOM.adminLoginError) DOM.adminLoginError.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Admin login error:', err);
    toast('Login error: ' + err.message, 'error');
  }
}

async function handleLogout() {
  const token = sessionStorage.getItem('tt_admin_token');
  if (token) {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
    } catch (_) {}
    sessionStorage.removeItem('tt_admin_token');
  }
  stopAdminRefresh();
  showLogin();
  toast(currentLang === 'ar' ? '👋 تم تسجيل الخروج بنجاح' : '👋 Logged out successfully', 'info');
}

// ---------------------------------------------------------------------------
// Statistics & Data Loading
// ---------------------------------------------------------------------------
async function loadAdminStats() {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) {
    showLogin();
    return;
  }

  try {
    const res = await fetch(`/api/admin/stats?token=${encodeURIComponent(token)}`);
    if (res.status === 401) {
      sessionStorage.removeItem('tt_admin_token');
      stopAdminRefresh();
      showLogin();
      return;
    }
    const data = await res.json();
    if (data.status === 'ok') {
      if (DOM.admActiveUsers) DOM.admActiveUsers.textContent = data.active_users_count ?? 0;
      if (DOM.admTotalVisits) DOM.admTotalVisits.textContent = data.total_connections ?? 0;
      if (DOM.admServerUptime) DOM.admServerUptime.textContent = formatUptime(data.server_uptime_seconds ?? 0, currentLang);

      // Tracking switch
      currentTrackingEnabled = !!data.tracking_enabled;
      updateTrackingSwitchUI(currentTrackingEnabled);

      // Render tables
      renderAdminTable(data.search_history || []);
      renderBannedTable(data.banned_targets || []);

      // Sign API status
      if (DOM.badgeSignKeyStatus) {
        if (data.has_sign_api_key) {
          DOM.badgeSignKeyStatus.textContent = currentLang === 'ar' ? 'مضبوط ✅' : 'Configured ✅';
          DOM.badgeSignKeyStatus.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 font-bold';
        } else {
          DOM.badgeSignKeyStatus.textContent = currentLang === 'ar' ? 'غير مضبوط ⚠️' : 'Not Set ⚠️';
          DOM.badgeSignKeyStatus.className = 'text-[10px] px-2 py-0.5 rounded-full bg-amber-950/80 text-amber-300 border border-amber-700/60 font-bold';
        }
      }
      if (DOM.currentSignKeyText) {
        DOM.currentSignKeyText.textContent = data.has_sign_api_key
          ? (data.sign_api_key_masked || 'Active')
          : (currentLang === 'ar' ? 'غير مضبوط (يستخدم الـ IP المشترك)' : 'Not set (using shared IP fallback)');
        DOM.currentSignKeyText.className = data.has_sign_api_key ? 'font-mono text-emerald-400 font-bold' : 'font-mono text-amber-400';
      }

      // Telegram status
      if (data.telegram) {
        updateTelegramUI(data.telegram);
      }
    }
  } catch (err) {
    console.error('Failed to load admin stats:', err);
  }
}

function updateTrackingSwitchUI(enabled) {
  if (!DOM.btnToggleTracking || !DOM.textToggleTracking) return;
  const t = I18N[currentLang] || I18N.ar;
  if (enabled) {
    DOM.btnToggleTracking.className = 'px-3.5 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-2 bg-emerald-950/60 border-emerald-600/50 text-emerald-300 hover:bg-emerald-900/60 shadow';
    DOM.textToggleTracking.textContent = t.trackingActive;
  } else {
    DOM.btnToggleTracking.className = 'px-3.5 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-2 bg-red-950/60 border-red-600/50 text-red-300 hover:bg-red-900/60 shadow';
    DOM.textToggleTracking.textContent = t.trackingFrozen;
  }
}

function renderAdminTable(history) {
  if (!DOM.adminTableBody) return;
  DOM.adminTableBody.innerHTML = '';
  const t = I18N[currentLang] || I18N.ar;

  if (history.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'p-6 text-center text-gray-500 font-sans';
    td.textContent = t.noRecords;
    tr.appendChild(td);
    DOM.adminTableBody.appendChild(tr);
    return;
  }

  history.forEach(item => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-800/40 transition';

    // 1. Target
    const tdUser = document.createElement('td');
    tdUser.className = 'p-3.5 font-mono font-bold text-pink-400 text-start';
    tdUser.textContent = '@' + (item.username || 'unknown');

    // 2. Status
    const tdStatus = document.createElement('td');
    tdStatus.className = 'p-3.5 text-start';
    const badge = document.createElement('span');
    if (item.status === 'active') {
      badge.className = 'admin-badge-active';
      const ping = document.createElement('span');
      ping.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping';
      badge.appendChild(ping);
      const spanText = document.createElement('span');
      spanText.textContent = t.statusActive;
      badge.appendChild(spanText);
    } else if (item.status === 'kicked') {
      badge.className = 'px-2 py-0.5 rounded-full bg-red-950/60 border border-red-700/50 text-red-300 font-bold text-[10px]';
      badge.textContent = currentLang === 'ar' ? 'مقطوع (Kicked)' : 'Kicked by Admin';
    } else if (item.status === 'banned') {
      badge.className = 'px-2 py-0.5 rounded-full bg-red-900/80 border border-red-500 text-red-200 font-bold text-[10px]';
      badge.textContent = currentLang === 'ar' ? 'محظور (Banned)' : 'Banned';
    } else {
      badge.className = 'admin-badge-completed';
      badge.textContent = t.statusCompleted;
    }
    tdStatus.appendChild(badge);

    // 3. Start time
    const tdStart = document.createElement('td');
    tdStart.className = 'p-3.5 font-mono text-gray-400 text-start';
    const dateObj = new Date((item.started_at || 0) * 1000);
    tdStart.textContent = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // 4. Duration
    const tdDuration = document.createElement('td');
    tdDuration.className = 'p-3.5 font-mono font-bold text-indigo-300 text-start';
    tdDuration.textContent = formatDuration(item.duration_seconds || 0, currentLang);

    // 5. Diamonds
    const tdDiamonds = document.createElement('td');
    tdDiamonds.className = 'p-3.5 font-mono font-bold text-yellow-400 text-start';
    tdDiamonds.textContent = `💎 ${fmt(item.total_diamonds || 0)}`;

    // 6. Actions
    const tdActions = document.createElement('td');
    tdActions.className = 'p-3.5 text-start';
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'flex items-center gap-1.5';

    if (item.status === 'active') {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold text-[11px] transition active:scale-95 shadow flex items-center gap-1';
      kickBtn.textContent = t.btnKick;
      kickBtn.onclick = () => handleKick(item.username);
      actionsWrap.appendChild(kickBtn);
    }

    const banBtn = document.createElement('button');
    banBtn.className = 'px-2.5 py-1 rounded-lg bg-gray-800 hover:bg-red-900/60 border border-red-800/40 text-red-300 font-bold text-[11px] transition active:scale-95 flex items-center gap-1';
    banBtn.textContent = t.btnBan;
    banBtn.onclick = () => handleBan(item.username);
    actionsWrap.appendChild(banBtn);

    tdActions.appendChild(actionsWrap);

    tr.appendChild(tdUser);
    tr.appendChild(tdStatus);
    tr.appendChild(tdStart);
    tr.appendChild(tdDuration);
    tr.appendChild(tdDiamonds);
    tr.appendChild(tdActions);

    DOM.adminTableBody.appendChild(tr);
  });
}

function renderBannedTable(bannedList) {
  if (!DOM.bannedTableBody) return;
  DOM.bannedTableBody.innerHTML = '';
  const t = I18N[currentLang] || I18N.ar;
  if (DOM.badgeBannedCount) DOM.badgeBannedCount.textContent = bannedList.length;

  if (bannedList.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'p-6 text-center text-gray-500 font-sans';
    td.textContent = t.noBanned;
    tr.appendChild(td);
    DOM.bannedTableBody.appendChild(tr);
    return;
  }

  bannedList.forEach(target => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-800/40 transition';

    // 1. Target
    const tdUser = document.createElement('td');
    tdUser.className = 'p-3.5 font-mono font-bold text-red-400 text-start';
    tdUser.textContent = '@' + target;

    // 2. Status
    const tdStatus = document.createElement('td');
    tdStatus.className = 'p-3.5 text-start';
    const badge = document.createElement('span');
    badge.className = 'px-2.5 py-0.5 rounded-full bg-red-950/80 border border-red-700/60 text-red-300 text-[10px] font-bold';
    badge.textContent = currentLang === 'ar' ? 'محظور من التتبع' : 'Blocked from Tracking';
    tdStatus.appendChild(badge);

    // 3. Unban Action
    const tdAction = document.createElement('td');
    tdAction.className = 'p-3.5 text-start';
    const unbanBtn = document.createElement('button');
    unbanBtn.className = 'px-3 py-1 rounded-lg bg-emerald-950/60 hover:bg-emerald-900 border border-emerald-600/50 text-emerald-300 font-bold text-xs transition active:scale-95 flex items-center gap-1';
    unbanBtn.textContent = t.btnUnban;
    unbanBtn.onclick = () => handleUnban(target);
    tdAction.appendChild(unbanBtn);

    tr.appendChild(tdUser);
    tr.appendChild(tdStatus);
    tr.appendChild(tdAction);

    DOM.bannedTableBody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Actions: Kick, Ban, Unban, Toggle, Broadcast, Clear, Save Key
// ---------------------------------------------------------------------------
async function handleKick(username) {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  const t = I18N[currentLang] || I18N.ar;
  if (!confirm(t.confirmKick.replace('{user}', username))) return;

  try {
    const res = await fetch('/api/admin/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, token })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? `🔴 تم قطع اتصال جلسة @${username} بنجاح` : `🔴 Session for @${username} terminated`, 'info');
      await loadAdminStats();
    } else {
      toast('Failed to kick session: ' + (data.message || 'error'), 'error');
    }
  } catch (err) {
    console.error('Kick error:', err);
  }
}

async function handleBan(username) {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  const t = I18N[currentLang] || I18N.ar;
  if (!confirm(t.confirmBan.replace('{user}', username))) return;

  try {
    const res = await fetch('/api/admin/ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, token })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? `🚫 تم حظر @${username} بنجاح` : `🚫 Account @${username} banned`, 'warning');
      await loadAdminStats();
    } else {
      toast('Failed to ban: ' + (data.message || 'error'), 'error');
    }
  } catch (err) {
    console.error('Ban error:', err);
  }
}

async function handleUnban(username) {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;

  try {
    const res = await fetch('/api/admin/unban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, token })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? `✅ تم إلغاء حظر @${username}` : `✅ Unbanned @${username}`, 'success');
      await loadAdminStats();
    } else {
      toast('Failed to unban: ' + (data.message || 'error'), 'error');
    }
  } catch (err) {
    console.error('Unban error:', err);
  }
}

async function handleToggleTracking() {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  const newSetting = !currentTrackingEnabled;

  try {
    const res = await fetch('/api/admin/toggle-tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newSetting, token })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      currentTrackingEnabled = !!data.tracking_enabled;
      updateTrackingSwitchUI(currentTrackingEnabled);
      toast(currentTrackingEnabled 
        ? (currentLang === 'ar' ? '🟢 تم تفعيل التتبع لجميع المستخدمين' : '🟢 Global tracking enabled') 
        : (currentLang === 'ar' ? '🔴 تم تعطيل التتبع مؤقتاً (وضع الصيانة)' : '🔴 Global tracking frozen (Maintenance)'),
        'info'
      );
    }
  } catch (err) {
    console.error('Toggle tracking error:', err);
  }
}

async function handleClearHistory() {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  const t = I18N[currentLang] || I18N.ar;
  if (!confirm(t.confirmClear)) return;

  try {
    const res = await fetch('/api/admin/clear-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? '🗑️ تم مسح السجل المكتمل بنجاح' : '🗑️ Completed history cleared', 'info');
      await loadAdminStats();
    }
  } catch (err) {
    console.error('Clear history error:', err);
  }
}

async function handleSendBroadcast() {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  const msg = DOM.broadcastMsgInput ? DOM.broadcastMsgInput.value.trim() : '';
  if (!msg) {
    toast(currentLang === 'ar' ? 'يرجى كتابة نص الإشعار' : 'Please type announcement text', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, token })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? `📢 تم إرسال الإشعار بنجاح إلى (${data.recipients_count}) جلسة متصلة` : `📢 Broadcast sent to (${data.recipients_count}) sessions`, 'success');
      if (DOM.broadcastMsgInput) DOM.broadcastMsgInput.value = '';
      if (DOM.broadcastResult) {
        DOM.broadcastResult.textContent = currentLang === 'ar' ? `تم تسليم الإشعار بنجاح إلى ${data.recipients_count} مستخدم متصل.` : `Delivered to ${data.recipients_count} active users.`;
        DOM.broadcastResult.classList.remove('hidden');
        setTimeout(() => DOM.broadcastResult?.classList.add('hidden'), 5000);
      }
    }
  } catch (err) {
    console.error('Broadcast error:', err);
  }
}

async function handleSaveSignApiKey() {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  const key = DOM.inputSignApiKey ? DOM.inputSignApiKey.value.trim() : '';
  try {
    const res = await fetch('/api/admin/set-sign-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sign_api_key: key, token })
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? '🔑 تم حفظ وتحديث مفتاح التوقيع بنجاح!' : '🔑 Sign API key updated successfully!', 'success');
      if (DOM.inputSignApiKey) DOM.inputSignApiKey.value = '';
      await loadAdminStats();
    } else {
      toast('Failed to save key: ' + (data.message || 'error'), 'error');
    }
  } catch (err) {
    console.error('Save sign key error:', err);
    toast('Error saving key', 'error');
  }
}

// ---------------------------------------------------------------------------
// Telegram Bot Management
// ---------------------------------------------------------------------------
function updateTelegramUI(tg) {
  if (DOM.badgeTelegramStatus) {
    if (tg.enabled && tg.has_token) {
      DOM.badgeTelegramStatus.textContent = currentLang === 'ar' ? 'نشط ✅' : 'Active ✅';
      DOM.badgeTelegramStatus.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 font-bold';
    } else {
      DOM.badgeTelegramStatus.textContent = currentLang === 'ar' ? 'معطل ⚠️' : 'Disabled ⚠️';
      DOM.badgeTelegramStatus.className = 'text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 font-bold';
    }
  }

  if (DOM.tgLiveStatusBadge) {
    if (tg.enabled && tg.has_token) {
      DOM.tgLiveStatusBadge.textContent = currentLang === 'ar' ? '🟢 متصل وجاهز' : '🟢 Connected';
      DOM.tgLiveStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 font-bold font-mono';
    } else {
      DOM.tgLiveStatusBadge.textContent = currentLang === 'ar' ? '⚪ غير متصل' : '⚪ Disconnected';
      DOM.tgLiveStatusBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 font-normal font-mono';
    }
  }

  // Populate inputs if user hasn't focused them
  if (DOM.inputTelegramChatId && !DOM.inputTelegramChatId.matches(':focus') && tg.chat_id) {
    DOM.inputTelegramChatId.value = tg.chat_id;
  }
  if (DOM.inputTelegramToken && !DOM.inputTelegramToken.matches(':focus') && tg.bot_token_masked) {
    DOM.inputTelegramToken.placeholder = `محفوظ: ${tg.bot_token_masked}`;
  }
  if (DOM.checkNotifyStreamStart && !DOM.checkNotifyStreamStart.matches(':focus')) {
    DOM.checkNotifyStreamStart.checked = tg.notify_on_new_stream !== false;
  }
  if (DOM.checkNotifyStreamEnd && !DOM.checkNotifyStreamEnd.matches(':focus')) {
    DOM.checkNotifyStreamEnd.checked = tg.notify_on_stream_end !== false;
  }
  if (DOM.selectPeriodicReport && !DOM.selectPeriodicReport.matches(':focus') && tg.periodic_report_hours !== undefined) {
    DOM.selectPeriodicReport.value = String(tg.periodic_report_hours);
  }
}

async function handleSaveTelegramSettings() {
  const token = getAdminToken();
  if (!token) return;

  const botToken = DOM.inputTelegramToken ? DOM.inputTelegramToken.value.trim() : '';
  const chatId = DOM.inputTelegramChatId ? DOM.inputTelegramChatId.value.trim() : '';
  const notifyStart = DOM.checkNotifyStreamStart ? DOM.checkNotifyStreamStart.checked : true;
  const notifyEnd = DOM.checkNotifyStreamEnd ? DOM.checkNotifyStreamEnd.checked : true;
  const periodic = DOM.selectPeriodicReport ? parseInt(DOM.selectPeriodicReport.value, 10) : 0;

  try {
    const body = {
      chat_id: chatId,
      notify_on_new_stream: notifyStart,
      notify_on_stream_end: notifyEnd,
      periodic_report_hours: periodic,
      enabled: Boolean(chatId && (botToken || (DOM.inputTelegramToken && DOM.inputTelegramToken.placeholder.includes('محفوظ')))),
    };
    if (botToken) {
      body.bot_token = botToken;
    }

    const res = await fetch('/api/admin/telegram/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? '✅ تم حفظ إعدادات تلغرام وتفعيل الخدمة بنجاح!' : '✅ Telegram settings saved!', 'success');
      if (DOM.inputTelegramToken) DOM.inputTelegramToken.value = '';
      if (data.settings) updateTelegramUI(data.settings);
    } else {
      toast(data.message || 'فشل حفظ الإعدادات', 'error');
    }
  } catch (err) {
    toast(`خطأ: ${err.message}`, 'error');
  }
}

async function handleTestTelegram() {
  const token = getAdminToken();
  if (!token) return;

  toast(currentLang === 'ar' ? 'جاري فحص الاتصال وإرسال رسالة تجريبية...' : 'Testing connection...', 'info');

  try {
    const res = await fetch('/api/admin/telegram/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? '🎉 تم إرسال الرسالة التجريبية إلى تلغرام بنجاح!' : '🎉 Test message sent successfully!', 'success');
    } else {
      toast(data.message || 'فشل فحص الاتصال', 'error');
    }
  } catch (err) {
    toast(`خطأ: ${err.message}`, 'error');
  }
}

async function handleSendTelegramReport() {
  const token = getAdminToken();
  if (!token) return;

  toast(currentLang === 'ar' ? 'جاري تجميع الإحصائيات وإرسال التقرير...' : 'Sending report...', 'info');

  try {
    const res = await fetch('/api/admin/telegram/send-report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      toast(currentLang === 'ar' ? '📊 تم إرسال التقرير الإحصائي إلى محادثة تلغرام بنجاح!' : '📊 Report sent successfully!', 'success');
    } else {
      toast(data.message || 'فشل إرسال التقرير', 'error');
    }
  } catch (err) {
    toast(`خطأ: ${err.message}`, 'error');
  }
}

function startAdminRefresh() {
  stopAdminRefresh();
  adminRefreshInterval = setInterval(() => {
    loadAdminStats();
  }, 3000);
}

function stopAdminRefresh() {
  if (adminRefreshInterval) {
    clearInterval(adminRefreshInterval);
    adminRefreshInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------
if (DOM.langArBtn) DOM.langArBtn.addEventListener('click', () => applyLanguage('ar'));
if (DOM.langEnBtn) DOM.langEnBtn.addEventListener('click', () => applyLanguage('en'));

if (DOM.adminLoginBtn) DOM.adminLoginBtn.addEventListener('click', handleLogin);
if (DOM.adminPasswordInput) DOM.adminPasswordInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleLogin();
});

if (DOM.navLogoutBtn) DOM.navLogoutBtn.addEventListener('click', handleLogout);
if (DOM.adminLogoutBtn) DOM.adminLogoutBtn.addEventListener('click', handleLogout);
if (DOM.adminRefreshBtn) DOM.adminRefreshBtn.addEventListener('click', loadAdminStats);

if (DOM.btnToggleTracking) DOM.btnToggleTracking.addEventListener('click', handleToggleTracking);
if (DOM.btnClearHistory) DOM.btnClearHistory.addEventListener('click', handleClearHistory);

if (DOM.tabBtnSessions) DOM.tabBtnSessions.addEventListener('click', () => switchAdminTab('sessions'));
if (DOM.tabBtnBanned) DOM.tabBtnBanned.addEventListener('click', () => switchAdminTab('banned'));
if (DOM.tabBtnBroadcast) DOM.tabBtnBroadcast.addEventListener('click', () => switchAdminTab('broadcast'));
if (DOM.tabBtnApiSettings) DOM.tabBtnApiSettings.addEventListener('click', () => switchAdminTab('api_settings'));
if (DOM.tabBtnTelegram) DOM.tabBtnTelegram.addEventListener('click', () => switchAdminTab('telegram'));

if (DOM.btnSaveTelegramSettings) DOM.btnSaveTelegramSettings.addEventListener('click', handleSaveTelegramSettings);
if (DOM.btnTelegramTest) DOM.btnTelegramTest.addEventListener('click', handleTestTelegram);
if (DOM.btnTelegramSendReport) DOM.btnTelegramSendReport.addEventListener('click', handleSendTelegramReport);

if (DOM.btnSubmitBan) DOM.btnSubmitBan.addEventListener('click', () => {
  const target = DOM.bannedInputTarget ? DOM.bannedInputTarget.value.trim() : '';
  if (target) {
    handleBan(target);
    DOM.bannedInputTarget.value = '';
  }
});
if (DOM.bannedInputTarget) DOM.bannedInputTarget.addEventListener('keydown', e => {
  if (e.key === 'Enter' && DOM.btnSubmitBan) DOM.btnSubmitBan.click();
});

if (DOM.btnSubmitBroadcast) DOM.btnSubmitBroadcast.addEventListener('click', handleSendBroadcast);

if (DOM.btnSaveSignApiKey) DOM.btnSaveSignApiKey.addEventListener('click', handleSaveSignApiKey);
if (DOM.inputSignApiKey) DOM.inputSignApiKey.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleSaveSignApiKey();
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
applyLanguage(currentLang);

const existingToken = sessionStorage.getItem('tt_admin_token');
if (existingToken) {
  showDashboard();
  loadAdminStats();
  startAdminRefresh();
} else {
  showLogin();
}

console.log('👑 TikTok Live Analytics Tracker Owner Admin Panel initialized.');
