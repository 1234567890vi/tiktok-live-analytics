// =============================================================================
//  app.js — TikTok Live Analytics Tracker — Frontend WebSocket Client
// =============================================================================
'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const WS_BASE       = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const MAX_COMMENTS  = 200;
const MAX_GIFTS     = 100;
const COMBO_SHOW_MS = 2500;   // ms the combo popup stays visible
const TOAST_DURATION = 4000;  // ms

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws              = null;
let autoScroll      = true;
let giftCount       = 0;
let commentCount    = 0;
let comboTimer      = null;
let currentUsername = '';

// ---------------------------------------------------------------------------
// DOM refs — cached once on load
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);

const DOM = {
  usernameInput:   $('usernameInput'),
  startBtn:        $('startBtn'),
  stopBtn:         $('stopBtn'),
  statusBadge:     $('statusBadge'),
  statusDot:       $('statusDot'),
  statusText:      $('statusText'),
  roomInfo:        $('roomInfo'),
  roomIdDisplay:   $('roomIdDisplay'),

  // KPIs
  kpiViewers:  $('kpiViewers'),
  kpiLikes:    $('kpiLikes'),
  kpiLps:      $('kpiLps'),
  kpiDiamonds: $('kpiDiamonds'),
  kpiUsd:      $('kpiUsd'),
  kpiNet:      $('kpiNet'),
  kpiComments: $('kpiComments'),

  // PK Arena
  pkSection:        $('pkSection'),
  pkBattleType:     $('pkBattleType'),
  pkStatusBadge:    $('pkStatusBadge'),
  pkRoundNum:       $('pkRoundNum'),
  pkHostWins:       $('pkHostWins'),
  pkOppWins:        $('pkOppWins'),
  pkHostAvatar:     $('pkHostAvatar'),
  pkHostNick:       $('pkHostNick'),
  pkHostName:       $('pkHostName'),
  pkTeammateCard:   $('pkTeammateCard'),
  pkTeammateAvatar: $('pkTeammateAvatar'),
  pkTeammateNick:   $('pkTeammateNick'),
  pkTeammateName:   $('pkTeammateName'),
  pkHostScore:      $('pkHostScore'),
  pkHostMvps:       $('pkHostMvps'),
  pkScoreDiff:      $('pkScoreDiff'),
  pkOppAvatar1:     $('pkOppAvatar1'),
  pkOppNick1:       $('pkOppNick1'),
  pkOppName1:       $('pkOppName1'),
  pkOppCard2:       $('pkOppCard2'),
  pkOppAvatar2:     $('pkOppAvatar2'),
  pkOppNick2:       $('pkOppNick2'),
  pkOppName2:       $('pkOppName2'),
  pkOppScore:       $('pkOppScore'),
  pkOppMvps:        $('pkOppMvps'),
  pkHostBar:        $('pkHostBar'),
  pkOpponentBar:    $('pkOpponentBar'),
  pkHostPct:        $('pkHostPct'),
  pkOppPct:         $('pkOppPct'),

  // Feeds
  commentsFeed:    $('commentsFeed'),
  giftFeed:        $('giftFeed'),
  leaderboardList: $('leaderboardList'),
  likersRow:       $('likersRow'),
  commentCount:    $('commentCount'),
  giftCount:       $('giftCount'),
  toggleScrollBtn: $('toggleScrollBtn'),
  scrollIcon:      $('scrollIcon'),

  // Revenue summary
  lbTotalDiamonds: $('lbTotalDiamonds'),
  lbGrossUsd:      $('lbGrossUsd'),
  lbNetUsd:        $('lbNetUsd'),

  // Combo popup
  comboPopup:        $('comboPopup'),
  comboGiftIcon:     $('comboGiftIcon'),
  comboCountDisplay: $('comboCountDisplay'),
  comboGiftName:     $('comboGiftName'),

  toastContainer: $('toastContainer'),

  // Header Logo for owner secret click
  appLogo: $('appLogo'),

  // Sidebar & Navigation
  sidebarToggleBtn:    $('sidebarToggleBtn'),
  sidebarBtnText:      $('sidebarBtnText'),
  sidebarBackdrop:     $('sidebarBackdrop'),
  mainSidebar:         $('mainSidebar'),
  closeSidebarBtn:     $('closeSidebarBtn'),
  adminSidebarSection: $('adminSidebarSection'),

  // Language buttons
  langArBtn: $('langArBtn'),
  langEnBtn: $('langEnBtn'),

  // Theme buttons
  themeDarkBtn:  $('themeDarkBtn'),
  themeLightBtn: $('themeLightBtn'),
  themeOledBtn:  $('themeOledBtn'),

  // Admin Modal
  openAdminModalBtn:     $('openAdminModalBtn'),
  adminModal:            $('adminModal'),
  closeAdminModalBtn:    $('closeAdminModalBtn'),
  adminLoginSection:     $('adminLoginSection'),
  adminDashboardSection: $('adminDashboardSection'),
  adminPasswordInput:    $('adminPasswordInput'),
  adminLoginBtn:         $('adminLoginBtn'),
  adminLoginError:       $('adminLoginError'),
  admActiveUsers:        $('admActiveUsers'),
  admTotalVisits:        $('admTotalVisits'),
  admServerUptime:       $('admServerUptime'),
  adminTableBody:        $('adminTableBody'),
  adminRefreshBtn:       $('adminRefreshBtn'),
  adminLogoutBtn:        $('adminLogoutBtn'),

  // Advanced User Controls & Tabs
  btnToggleTracking:   $('btnToggleTracking'),
  textToggleTracking:  $('textToggleTracking'),
  btnClearHistory:     $('btnClearHistory'),
  tabBtnSessions:      $('tabBtnSessions'),
  tabBtnBanned:        $('tabBtnBanned'),
  tabBtnBroadcast:     $('tabBtnBroadcast'),
  tabViewSessions:     $('tabViewSessions'),
  tabViewBanned:       $('tabViewBanned'),
  tabViewBroadcast:    $('tabViewBroadcast'),
  badgeBannedCount:    $('badgeBannedCount'),
  bannedInputTarget:   $('bannedInputTarget'),
  btnSubmitBan:        $('btnSubmitBan'),
  bannedTableBody:     $('bannedTableBody'),
  broadcastMsgInput:   $('broadcastMsgInput'),
  btnSubmitBroadcast:  $('btnSubmitBroadcast'),
  broadcastResult:     $('broadcastResult'),
  tabBtnApiSettings:   $('tabBtnApiSettings'),
  tabViewApiSettings:  $('tabViewApiSettings'),
  badgeSignKeyStatus:  $('badgeSignKeyStatus'),
  inputSignApiKey:     $('inputSignApiKey'),
  btnSaveSignApiKey:   $('btnSaveSignApiKey'),
  currentSignKeyText:  $('currentSignKeyText'),
};

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function setStatus(state, text) {
  document.body.classList.remove('status-idle', 'status-connecting', 'status-online', 'status-offline');
  document.body.classList.add(`status-${state}`);
  DOM.statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------
function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtUsd(n) {
  if (n == null || isNaN(n)) return '0.00';
  return Number(n).toFixed(2);
}

// ---------------------------------------------------------------------------
// KPI bump animation
// ---------------------------------------------------------------------------
function bumpKpi(el, newVal, formatter = fmt) {
  if (!el) return;
  const str = formatter(newVal);
  if (el.textContent !== str) {
    el.textContent = str;
    el.classList.remove('bump');
    void el.offsetWidth; // force reflow
    el.classList.add('bump');
  }
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
function toast(message, type = 'info', duration = TOAST_DURATION) {
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.textContent = message;
  DOM.toastContainer.prepend(div);
  setTimeout(() => {
    div.style.animation = 'toast-out 0.3s ease-out forwards';
    setTimeout(() => div.remove(), 310);
  }, duration);
}

// ---------------------------------------------------------------------------
// Avatar helper — with liker-specific class support
// ---------------------------------------------------------------------------
function avatarEl(url, alt, extraClass = '') {
  const img = document.createElement('img');
  img.alt = alt || '';
  if (extraClass) img.className = extraClass;
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(alt || '?')}&background=6366f1&color=fff&size=40`;
  img.onerror = () => { img.src = fallback; };
  img.src = url || fallback;
  return img;
}

// ---------------------------------------------------------------------------
// Clear placeholder text inside a feed container
// ---------------------------------------------------------------------------
function clearPlaceholder(container, selector = '.text-gray-600') {
  const ph = container.querySelector(selector);
  if (ph) ph.remove();
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
function addComment(data) {
  clearPlaceholder(DOM.commentsFeed);

  const entry = document.createElement('div');
  entry.className = 'comment-entry';

  const av = avatarEl(data.avatar_url, data.nickname, 'comment-avatar');

  const body    = document.createElement('div');
  body.className = 'comment-body';

  const nameRow = document.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:center;gap:4px;flex-wrap:wrap;';

  const name = document.createElement('span');
  name.className   = 'comment-name';
  name.textContent = data.nickname || 'Unknown';

  const handle = document.createElement('span');
  handle.className   = 'comment-handle';
  handle.textContent = data.unique_id ? `@${data.unique_id}` : '';

  nameRow.append(name, handle);

  if (data.user_level > 0) {
    const badge = document.createElement('span');
    badge.className   = 'comment-badge';
    badge.textContent = `Lv.${data.user_level}`;
    nameRow.appendChild(badge);
  }

  const msg = document.createElement('div');
  msg.className   = 'comment-text';
  msg.textContent = data.comment_text || data.text || '';

  body.append(nameRow, msg);
  entry.append(av, body);

  // Maintain max buffer size
  while (DOM.commentsFeed.children.length >= MAX_COMMENTS) {
    DOM.commentsFeed.firstChild.remove();
  }
  DOM.commentsFeed.appendChild(entry);

  if (autoScroll) {
    DOM.commentsFeed.scrollTop = DOM.commentsFeed.scrollHeight;
  }

  commentCount++;
  DOM.commentCount.textContent = fmt(commentCount);
  bumpKpi(DOM.kpiComments, commentCount);
}

// ---------------------------------------------------------------------------
// Gifts
// ---------------------------------------------------------------------------
function addGift(data) {
  clearPlaceholder(DOM.giftFeed);

  const txn      = data.transaction || {};
  const user     = data.user || {};
  const giftName = txn.gift_name     || 'Gift';
  const iconUrl  = txn.gift_icon_url || '';
  const combo    = data.repeat_count || txn.repeat_count || 1;
  const unitDiamonds = (data.diamond_unit_cost !== undefined && data.diamond_unit_cost !== null)
    ? data.diamond_unit_cost
    : (txn.diamond_unit_cost || (combo > 0 && txn.total_value ? Math.round(txn.total_value / combo) : (txn.total_value || 0)));

  const totalComboDiamonds = (data.combo_diamonds !== undefined && data.combo_diamonds !== null)
    ? data.combo_diamonds
    : (unitDiamonds * combo);

  const usdEst = (data.combo_usd !== undefined && data.combo_usd !== null)
    ? Number(data.combo_usd).toFixed(2)
    : (totalComboDiamonds * 0.005).toFixed(2);

  const isStreak = !!data.streak_active;

  const card = document.createElement('div');
  card.className = `gift-card${isStreak ? ' streak-active' : ''}`;

  // Avatar + mini gift icon
  const avDiv = document.createElement('div');
  avDiv.style.cssText = 'position:relative;flex-shrink:0;';

  const userAv = avatarEl(user.avatar_url, user.nickname, 'comment-avatar');
  userAv.style.cssText = 'width:38px;height:38px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.2);';

  if (iconUrl) {
    const giftMini = document.createElement('img');
    giftMini.src = iconUrl;
    giftMini.alt = giftName;
    giftMini.style.cssText = 'position:absolute;bottom:-4px;right:-4px;width:20px;height:20px;object-fit:contain;filter:drop-shadow(0 0 4px rgba(0,0,0,0.8));';
    giftMini.onerror = () => { giftMini.remove(); };
    avDiv.append(userAv, giftMini);
  } else {
    avDiv.appendChild(userAv);
  }

  // Info block
  const info = document.createElement('div');
  info.className = 'gift-info';

  const senderRow = document.createElement('div');
  senderRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';

  const sender = document.createElement('span');
  sender.className   = 'gift-sender';
  sender.textContent = user.nickname || user.unique_id || 'Someone';

  const handle = document.createElement('span');
  handle.className   = 'comment-handle';
  handle.textContent = user.unique_id ? `@${user.unique_id}` : '';

  senderRow.append(sender, handle);

  // Recipient Team Badge (معه أو ضده)
  if (data.recipient_side === 'opponent') {
    const recBadge = document.createElement('span');
    recBadge.className = 'gift-recipient-badge badge-opponent';
    recBadge.textContent = `🔴 للخصم (@${data.recipient_name || 'الخصم'})`;
    senderRow.appendChild(recBadge);
  } else if (data.recipient_side === 'host' || data.is_battle_gift) {
    const recBadge = document.createElement('span');
    recBadge.className = 'gift-recipient-badge badge-host';
    recBadge.textContent = `🔵 لفريقنا (@${data.recipient_name || 'فريقنا'})`;
    senderRow.appendChild(recBadge);
  }

  const nameLine = document.createElement('div');
  nameLine.className   = 'gift-name';
  nameLine.textContent = giftName;

  const detailsLine = document.createElement('div');
  detailsLine.className = 'gift-details';
  detailsLine.innerHTML = `
    <span class="gift-unit-pill" title="سعر الهدية الواحدة">💎 ${fmt(unitDiamonds)}</span>
    ${combo > 1 ? `<span class="gift-total-pill" title="إجمالي الكومبو">المجموع: 💎 ${fmt(totalComboDiamonds)}</span>` : ''}
    <span class="gift-usd-pill" title="القيمة التقريبية بالدولار">≈ $${usdEst}</span>
  `;

  info.append(senderRow, nameLine, detailsLine);

  // Combo counter
  const comboDiv = document.createElement('div');
  comboDiv.className   = 'gift-combo';
  comboDiv.textContent = `x${combo}`;

  card.append(avDiv, info, comboDiv);

  while (DOM.giftFeed.children.length >= MAX_GIFTS) {
    DOM.giftFeed.firstChild.remove();
  }
  DOM.giftFeed.prepend(card);

  if (data.total_gifts != null && data.total_gifts > 0) {
    giftCount = Math.max(giftCount + 1, data.total_gifts);
  } else {
    giftCount++;
  }
  DOM.giftCount.textContent = `${fmt(giftCount)} gifts`;

  // Show combo burst popup for streaks >= 5
  if (combo >= 5) showComboBurst(giftName, iconUrl || '🎁', combo);

  // Update revenue KPIs
  if (data.total_diamonds !== undefined) {
    bumpKpi(DOM.kpiDiamonds, data.total_diamonds);
    bumpKpi(DOM.kpiUsd, data.estimated_usd, fmtUsd);
    bumpKpi(DOM.kpiNet, data.net_payout_usd, fmtUsd);
    DOM.lbTotalDiamonds.textContent = fmt(data.total_diamonds);
    DOM.lbGrossUsd.textContent      = fmtUsd(data.estimated_usd);
    DOM.lbNetUsd.textContent        = fmtUsd(data.net_payout_usd);
  }
}

// ---------------------------------------------------------------------------
// Combo burst popup
// ---------------------------------------------------------------------------
function showComboBurst(name, iconUrlOrEmoji, count) {
  if (comboTimer) { clearTimeout(comboTimer); comboTimer = null; }

  DOM.comboCountDisplay.textContent = `x${count}`;
  DOM.comboGiftName.textContent     = name;

  if (iconUrlOrEmoji && iconUrlOrEmoji.startsWith('http')) {
    DOM.comboGiftIcon.innerHTML = `<img src="${iconUrlOrEmoji}" style="width:64px;height:64px;object-fit:contain;display:block;margin:0 auto;" alt="${name}" />`;
  } else {
    DOM.comboGiftIcon.textContent = iconUrlOrEmoji || '🎁';
  }

  DOM.comboPopup.classList.remove('hidden');

  // Safe null-checked animation reset
  const burst = DOM.comboPopup.querySelector('.combo-burst');
  if (burst) {
    burst.style.animation = 'none';
    void DOM.comboPopup.offsetWidth;   // force reflow
    burst.style.animation = '';
  }

  comboTimer = setTimeout(() => {
    DOM.comboPopup.classList.add('hidden');
    comboTimer = null;
  }, COMBO_SHOW_MS);
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
function updateLeaderboard(supporters) {
  if (!supporters || supporters.length === 0) return;
  clearPlaceholder(DOM.leaderboardList);

  const topDiamonds = supporters[0]?.total_diamonds || 1;
  const fragment    = document.createDocumentFragment();

  supporters.forEach((sup, idx) => {
    const entry = document.createElement('div');
    entry.className = 'lb-entry';

    const rank = document.createElement('div');
    rank.className   = `lb-rank ${['gold', 'silver', 'bronze'][idx] || 'other'}`;
    rank.textContent = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;

    const av = avatarEl(sup.avatar_url, sup.nickname, 'lb-avatar');

    const info = document.createElement('div');
    info.className = 'lb-info';

    const nameEl = document.createElement('div');
    nameEl.className   = 'lb-name';
    nameEl.textContent = sup.nickname || sup.unique_id || 'Anon';
    nameEl.title       = sup.nickname || '';

    const diamondsEl = document.createElement('div');
    diamondsEl.className   = 'lb-diamonds';
    diamondsEl.textContent = `💎 ${fmt(sup.total_diamonds)}`;

    info.append(nameEl, diamondsEl);

    const barWrap = document.createElement('div');
    barWrap.className = 'lb-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'lb-bar';
    const pct = topDiamonds > 0 ? Math.round((sup.total_diamonds / topDiamonds) * 100) : 0;
    bar.style.width = `${pct}%`;
    barWrap.appendChild(bar);

    entry.append(rank, av, info, barWrap);
    fragment.appendChild(entry);
  });

  DOM.leaderboardList.innerHTML = '';
  DOM.leaderboardList.appendChild(fragment);
}

// ---------------------------------------------------------------------------
// Likers
// ---------------------------------------------------------------------------
let _likersData = {};

function updateLiker(data) {
  if (!data.user_id) return;
  const prev = _likersData[data.user_id];
  _likersData[data.user_id] = {
    user_id:    data.user_id,
    unique_id:  data.unique_id,
    nickname:   data.nickname,
    avatar_url: data.avatar_url,
    like_count: (prev?.like_count || 0) + (data.like_count || 0),
  };
  renderLikers();
}

function renderLikers(fromSnapshot = null) {
  const source = fromSnapshot
    || Object.values(_likersData).sort((a, b) => b.like_count - a.like_count).slice(0, 10);
  if (source.length === 0) return;

  clearPlaceholder(DOM.likersRow, 'p');
  const fragment = document.createDocumentFragment();

  source.forEach(r => {
    const pill = document.createElement('div');
    pill.className = 'liker-pill';

    // Fixed: use 'liker-avatar' class for proper sizing
    const av   = avatarEl(r.avatar_url, r.nickname, 'liker-avatar');

    const name = document.createElement('div');
    name.className   = 'liker-name';
    name.textContent = r.nickname || r.unique_id || 'Anon';
    name.title       = r.nickname || '';

    const count = document.createElement('div');
    count.className   = 'liker-count';
    count.textContent = `❤️ ${fmt(r.like_count)}`;

    pill.append(av, name, count);
    fragment.appendChild(pill);
  });

  DOM.likersRow.innerHTML = '';
  DOM.likersRow.appendChild(fragment);
}

// ---------------------------------------------------------------------------
// PK Battle
// ---------------------------------------------------------------------------
function updatePK(pkData, eventType) {
  if (!pkData) return;

  const isActive     = !!pkData.is_active;
  const status       = pkData.status || (isActive ? 'ACTIVE' : 'IDLE');
  const battleType   = pkData.battle_type || '1v1';
  const hostScore    = pkData.host_points || 0;
  const oppScore     = pkData.opponent_points || 0;
  const hostWins     = pkData.host_wins || 0;
  const oppWins      = pkData.opponent_wins || 0;
  const roundNum     = pkData.round_number || 1;

  if (DOM.pkBattleType) DOM.pkBattleType.textContent = battleType;
  if (DOM.pkRoundNum)   DOM.pkRoundNum.textContent   = roundNum;
  if (DOM.pkHostWins)   DOM.pkHostWins.textContent   = hostWins;
  if (DOM.pkOppWins)    DOM.pkOppWins.textContent    = oppWins;
  if (DOM.pkHostScore)  DOM.pkHostScore.textContent  = fmt(hostScore);
  if (DOM.pkOppScore)   DOM.pkOppScore.textContent   = fmt(oppScore);

  // Status Badge
  if (DOM.pkStatusBadge) {
    if (status === 'ACTIVE' || (isActive && status !== 'PUNISH')) {
      DOM.pkStatusBadge.textContent = '🔴 جولة جارية';
      DOM.pkStatusBadge.className   = 'px-3 py-1 rounded-full text-xs font-bold bg-red-950 text-red-300 border border-red-700 animate-pulse';
      DOM.pkSection?.classList.add('pk-active');
    } else if (status === 'PUNISH') {
      DOM.pkStatusBadge.textContent = '⏱️ وقت الحكم';
      DOM.pkStatusBadge.className   = 'px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300 border border-amber-700 animate-pulse';
      DOM.pkSection?.classList.add('pk-active');
    } else if (status === 'ENDED' || eventType === 'ended') {
      DOM.pkStatusBadge.textContent = '🏆 انتهت الجولة';
      DOM.pkStatusBadge.className   = 'px-3 py-1 rounded-full text-xs font-bold bg-emerald-950 text-emerald-300 border border-emerald-700';
      DOM.pkSection?.classList.remove('pk-active');
    } else {
      DOM.pkStatusBadge.textContent = '⏸️ في انتظار جولة';
      DOM.pkStatusBadge.className   = 'px-3 py-1 rounded-full text-xs font-bold bg-gray-800 text-gray-400 border border-gray-700';
      DOM.pkSection?.classList.remove('pk-active');
    }
  }

  // Populate Host Side (معه)
  const hostAnchors = pkData.host_anchors || [];
  if (hostAnchors.length > 0) {
    const h0 = hostAnchors[0];
    if (DOM.pkHostNick)   DOM.pkHostNick.textContent   = h0.nickname || h0.unique_id || 'المضيف';
    if (DOM.pkHostName)   DOM.pkHostName.textContent   = h0.unique_id ? `@${h0.unique_id}` : '';
    if (DOM.pkHostAvatar && h0.avatar_url) DOM.pkHostAvatar.src = h0.avatar_url;

    // Teammate (if 2v2)
    if (hostAnchors.length > 1) {
      const h1 = hostAnchors[1];
      if (DOM.pkTeammateCard) DOM.pkTeammateCard.classList.remove('hidden');
      if (DOM.pkTeammateNick) DOM.pkTeammateNick.textContent = h1.nickname || h1.unique_id || 'الحليف';
      if (DOM.pkTeammateName) DOM.pkTeammateName.textContent = h1.unique_id ? `@${h1.unique_id}` : '';
      if (DOM.pkTeammateAvatar && h1.avatar_url) DOM.pkTeammateAvatar.src = h1.avatar_url;
    } else if (DOM.pkTeammateCard) {
      DOM.pkTeammateCard.classList.add('hidden');
    }
  } else if (pkData.host_username) {
    if (DOM.pkHostName) DOM.pkHostName.textContent = `@${pkData.host_username}`;
    if (DOM.pkHostNick) DOM.pkHostNick.textContent = pkData.host_username;
  }

  // Populate Opponent Side (ضده)
  const oppAnchors = pkData.opponent_anchors || [];
  if (oppAnchors.length > 0) {
    const op0 = oppAnchors[0];
    if (DOM.pkOppNick1)   DOM.pkOppNick1.textContent   = op0.nickname || op0.unique_id || 'الخصم';
    if (DOM.pkOppName1)   DOM.pkOppName1.textContent   = op0.unique_id ? `@${op0.unique_id}` : '';
    if (DOM.pkOppAvatar1 && op0.avatar_url) DOM.pkOppAvatar1.src = op0.avatar_url;

    // Opponent 2 (if 2v2)
    if (oppAnchors.length > 1) {
      const op1 = oppAnchors[1];
      if (DOM.pkOppCard2)   DOM.pkOppCard2.classList.remove('hidden');
      if (DOM.pkOppNick2)   DOM.pkOppNick2.textContent   = op1.nickname || op1.unique_id || 'الخصم الثاني';
      if (DOM.pkOppName2)   DOM.pkOppName2.textContent   = op1.unique_id ? `@${op1.unique_id}` : '';
      if (DOM.pkOppAvatar2 && op1.avatar_url) DOM.pkOppAvatar2.src = op1.avatar_url;
    } else if (DOM.pkOppCard2) {
      DOM.pkOppCard2.classList.add('hidden');
    }
  } else if (pkData.opponent_username) {
    if (DOM.pkOppName1) DOM.pkOppName1.textContent = `@${pkData.opponent_username}`;
    if (DOM.pkOppNick1) DOM.pkOppNick1.textContent = pkData.opponent_username;
  }

  // Render Host MVPs (كبار الداعمين لفريقنا)
  renderPkMvps(DOM.pkHostMvps, pkData.host_armies, 'host-score');

  // Render Opponent MVPs (كبار الداعمين للخصم)
  renderPkMvps(DOM.pkOppMvps, pkData.opponent_armies, 'opp-score');

  // Tug of war ratios & Score Diff
  const total   = (hostScore + oppScore) || 1;
  const hostPct = hostScore === 0 && oppScore === 0 ? 50 : Math.round((hostScore / total) * 100);
  const oppPct  = 100 - hostPct;

  if (DOM.pkHostBar)     DOM.pkHostBar.style.width     = `${hostPct}%`;
  if (DOM.pkOpponentBar) DOM.pkOpponentBar.style.width = `${oppPct}%`;
  if (DOM.pkHostPct)     DOM.pkHostPct.textContent     = `${hostPct}%`;
  if (DOM.pkOppPct)      DOM.pkOppPct.textContent      = `${oppPct}%`;

  if (DOM.pkScoreDiff) {
    const diff = hostScore - oppScore;
    if (diff > 0) {
      DOM.pkScoreDiff.textContent = `+${fmt(diff)} متقدم 🔥`;
      DOM.pkScoreDiff.className   = 'text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 border border-blue-600 whitespace-nowrap shadow-[0_0_8px_rgba(37,99,235,0.4)]';
    } else if (diff < 0) {
      DOM.pkScoreDiff.textContent = `${fmt(diff)} متأخر ⚠️`;
      DOM.pkScoreDiff.className   = 'text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-red-900/60 text-red-300 border border-red-600 whitespace-nowrap shadow-[0_0_8px_rgba(220,38,38,0.4)]';
    } else {
      DOM.pkScoreDiff.textContent = 'تعادل ⚖️';
      DOM.pkScoreDiff.className   = 'text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-gray-800 text-gray-300 border border-gray-700 whitespace-nowrap';
    }
  }

  if (eventType === 'ended' || status === 'ENDED') {
    const winnerName = hostScore >= oppScore
      ? (hostAnchors[0]?.nickname || pkData.host_username || 'فريقنا')
      : (oppAnchors[0]?.nickname || pkData.opponent_username || 'الخصم');
    toast(`⚔️ انتهت الجولة ${roundNum}! الفائز: ${winnerName}`, 'info', 6000);
  }
}

function renderPkMvps(container, armies, scoreClass) {
  if (!container) return;
  if (!armies || armies.length === 0) {
    container.innerHTML = '<span class="text-xs text-gray-500 italic">في انتظار الداعمين...</span>';
    return;
  }
  container.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉'];
  armies.slice(0, 3).forEach((item, idx) => {
    const pill = document.createElement('div');
    pill.className = 'pk-mvp-pill';
    pill.title = `${item.nickname || 'داعـم'}: ${item.score || 0} نقطة`;

    const medal = document.createElement('span');
    medal.className = 'text-[11px]';
    medal.textContent = medals[idx] || `#${idx + 1}`;

    const av = document.createElement('img');
    av.className = 'pk-mvp-avatar';
    av.src = item.avatar_url || 'https://placehold.co/50x50/334155/white?text=User';
    av.alt = item.nickname || 'User';
    av.onerror = () => { av.src = 'https://placehold.co/50x50/334155/white?text=User'; };

    const name = document.createElement('span');
    name.className = 'pk-mvp-name';
    name.textContent = item.nickname || 'داعـم';

    const score = document.createElement('span');
    score.className = `pk-mvp-score ${scoreClass}`;
    score.textContent = fmt(item.score || 0);

    pill.append(medal, av, name, score);
    container.appendChild(pill);
  });
}

// ---------------------------------------------------------------------------
// Dashboard snapshot
// ---------------------------------------------------------------------------
function applySnapshot(data) {
  if (!data) return;

  bumpKpi(DOM.kpiViewers,  data.viewer_count);
  bumpKpi(DOM.kpiLikes,    data.total_likes);
  bumpKpi(DOM.kpiComments, data.total_comments);
  bumpKpi(DOM.kpiDiamonds, data.total_diamonds);
  bumpKpi(DOM.kpiUsd,      data.estimated_usd,  fmtUsd);
  bumpKpi(DOM.kpiNet,      data.net_payout_usd, fmtUsd);

  DOM.kpiLps.textContent = ((data.likes_per_second) || 0).toFixed(1);

  DOM.lbTotalDiamonds.textContent = fmt(data.total_diamonds  || 0);
  DOM.lbGrossUsd.textContent      = fmtUsd(data.estimated_usd  || 0);
  DOM.lbNetUsd.textContent        = fmtUsd(data.net_payout_usd || 0);

  if (data.total_gifts != null && data.total_gifts > 0) {
    giftCount = Math.max(giftCount, data.total_gifts);
    DOM.giftCount.textContent = `${fmt(giftCount)} gifts`;
  }

  if (data.pk_state)       updatePK(data.pk_state, 'snapshot');
  if (data.top_supporters) updateLeaderboard(data.top_supporters);
  if (data.top_likers)     renderLikers(data.top_likers);
}

// ---------------------------------------------------------------------------
// WebSocket connection management
// ---------------------------------------------------------------------------
function connectWs(username) {
  if (ws) {
    ws.close(1000, 'new session');
    ws = null;
  }

  currentUsername = username.replace(/^@/, '');
  const url = `${WS_BASE}/ws/track/${encodeURIComponent(currentUsername)}`;
  setStatus('connecting', `Connecting to @${currentUsername}…`);

  ws = new WebSocket(url);

  ws.onopen = () => { /* wait for server 'connected' message */ };

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    const { type } = msg;

    switch (type) {
      case 'connecting':
        setStatus('connecting', msg.message || 'Connecting…');
        break;

      case 'reconnecting':
        setStatus('connecting', `🔄 ${msg.message || 'Reconnecting…'}`);
        toast(msg.message || 'جاري محاولة الاتصال...', 'warning', 3500);
        break;

      case 'connected':
        setStatus('online', `🟢 Live — @${msg.username}`);
        DOM.roomInfo.classList.remove('hidden');
        DOM.roomIdDisplay.textContent = msg.room_id || '—';
        DOM.stopBtn.classList.remove('hidden');
        DOM.startBtn.classList.add('hidden');
        toast(`✅ Connected to @${msg.username}`, 'success');
        break;

      case 'disconnected':
        setStatus('offline', msg.message || 'Disconnected');
        DOM.stopBtn.classList.add('hidden');
        DOM.startBtn.classList.remove('hidden');
        toast(`🔴 ${msg.message || 'Stream ended'}`, 'warning', 6000);
        if (ws) {
          try { ws.close(); } catch (_) {}
          ws = null;
        }
        break;

      case 'error':
        setStatus('offline', msg.message || 'Error');
        DOM.stopBtn.classList.add('hidden');
        DOM.startBtn.classList.remove('hidden');
        toast(`⚠️ ${msg.message}${msg.detail ? ': ' + msg.detail : ''}`, 'error', 9000);
        if (ws) {
          try { ws.close(); } catch (_) {}
          ws = null;
        }
        break;

      case 'snapshot':
        applySnapshot(msg.data);
        break;

      case 'comment':
        addComment(msg.data);
        break;

      case 'like':
        if (msg.data) {
          bumpKpi(DOM.kpiLikes, msg.data.total_likes || 0);
          DOM.kpiLps.textContent = ((msg.data.likes_per_second) || 0).toFixed(1);
          updateLiker(msg.data);
        }
        break;

      case 'viewers':
        if (msg.data) {
          if (msg.data.viewer_count != null) {
            bumpKpi(DOM.kpiViewers, msg.data.viewer_count);
          }
          if (msg.data.total_diamonds != null && msg.data.total_diamonds > 0) {
            bumpKpi(DOM.kpiDiamonds, msg.data.total_diamonds);
            bumpKpi(DOM.kpiUsd, msg.data.estimated_usd, fmtUsd);
            bumpKpi(DOM.kpiNet, msg.data.net_payout_usd, fmtUsd);
            DOM.lbTotalDiamonds.textContent = fmt(msg.data.total_diamonds);
            DOM.lbGrossUsd.textContent      = fmtUsd(msg.data.estimated_usd);
            DOM.lbNetUsd.textContent        = fmtUsd(msg.data.net_payout_usd);
          }
        }
        if (msg.leaderboard) updateLeaderboard(msg.leaderboard);
        break;

      case 'gift':
        addGift(msg.data);
        if (msg.leaderboard) updateLeaderboard(msg.leaderboard);
        break;

      case 'pk_battle':
        updatePK(msg.data, msg.event);
        break;

      case 'heartbeat':
        // silent keep-alive
        break;

      case 'admin_announcement':
        toast(`📢 تنبيه من الإدارة: ${msg.message || ''}`, 'warning', 9000);
        break;

      default:
        console.debug('[WS] Unknown message type:', type, msg);
    }
  };

  ws.onerror = () => {
    setStatus('offline', 'Connection error');
    toast('⚠️ WebSocket error. Check console.', 'error');
  };

  ws.onclose = (evt) => {
    console.log('[WS] Closed', evt.code, evt.reason);
    if (evt.code !== 1000 && evt.code !== 1001) {
      setStatus('offline', 'Disconnected');
      toast(`🔌 Connection lost (code ${evt.code})`, 'warning');
    }
    DOM.stopBtn.classList.add('hidden');
    DOM.startBtn.classList.remove('hidden');
    ws = null;
  };
}

function disconnectWs() {
  if (ws) {
    const _ws = ws;     // capture before nulling
    ws = null;          // null first so onclose sees ws===null
    if (_ws.readyState === WebSocket.OPEN) {
      try { _ws.send(JSON.stringify({ action: 'disconnect' })); } catch (_) {}
    }
    _ws.close(1000, 'user disconnected');
  }
  setStatus('idle', 'Idle');
  DOM.stopBtn.classList.add('hidden');
  DOM.startBtn.classList.remove('hidden');
  DOM.roomInfo.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Internationalization (i18n)
// ---------------------------------------------------------------------------
let currentLang  = localStorage.getItem('tt_lang') || 'ar';
let currentTheme = localStorage.getItem('tt_theme') || 'dark';
let adminRefreshInterval = null;
let lastAdminData = null;

const I18N = {
  ar: {
    appBrand: "راصد تيك توك",
    sidebarBtn: "القائمة والإعدادات",
    sidebarTitle: "لوحة التحكم والإعدادات",
    usernamePlaceholder: "اسم المستخدم بدون @",
    startBtn: "بدء التتبع",
    stopBtn: "قطع الاتصال",
    statusIdle: "خامل",
    statusConnecting: "جارٍ الاتصال...",
    statusOnline: "متصل بالبث المباشر",
    statusOffline: "البث متوقف",
    room: "الغرفة",
    kpiViewers: "المشاهدون المباشرون",
    kpiLikes: "إجمالي الإعجابات",
    kpiDiamonds: "ألماسات البث المباشرة",
    kpiDiamondsSub: "ألماسات البث الكاملة",
    kpiComments: "إجمالي التعليقات",
    pkTitle: "ساحة الجولة المباشرة",
    pkSubtitle: "تتبع دقيق للمتنافسين (معه وضده)، الداعمين، ونقاط الجولة",
    pkWaiting: "⏸️ في انتظار جولة",
    pkRound: "الجولة",
    pkHostWins: "🔵 فوزنا:",
    pkOppWins: "🔴 الخصم:",
    pkOurTeam: "🔵 فريقنا (معه)",
    pkHostLabel: "المضيف وحلفاؤه",
    pkHostPoints: "نقاط فريقنا:",
    pkHostTopSupporters: "🛡️ كبار الداعمين في الجولة (فريقنا):",
    pkOppTeam: "🔴 الخصم (ضده)",
    pkOppLabel: "المنافسون",
    pkOppPoints: "نقاط الخصم:",
    pkOppTopSupporters: "⚔️ كبار الداعمين للخصم:",
    pkTie: "تعادل ⚖️",
    pkClash: "⚡ تصادم النقاط ⚡",
    commentsFeedTitle: "Live Comments",
    commentsFeedSub: "التعليقات",
    giftFeedTitle: "Gift Alerts",
    giftFeedSub: "الهدايا",
    leaderboardTitle: "Top Supporters",
    leaderboardSub: "حساب الدعم",
    lbDiamondsLabel: "إجمالي ألماسات البث (Diamonds)",
    lbGrossLabel: "القيمة الإجمالية (Gross USD)",
    lbNetLabel: "صافي صاحب البث (Net Payout)",
    likersTitle: "Top Likers",
    likersSub: "المعجبون",
    labelLang: "اللغة (Language)",
    labelTheme: "مظهر الصفحة (Theme)",
    themeDark: "الوضع الليلي (Dark Cyber)",
    themeLight: "الوضع النهاري (Clean Light)",
    themeOled: "أسود مطلق (Midnight OLED)",
    labelAdmin: "لوحة أدمن خاصة بي",
    descAdmin: "عرض عدد المستخدمين، سجل الحسابات المبحوث عنها، مع مدة الاستخدام الفعلي لكل جلسة.",
    openAdminBtn: "فتح لوحة الأدمن",
    admTitle: "لوحة الأدمن الخاصة",
    admSubtitle: "مراقبة المستخدمين، الحسابات المستهدفة ومدة الاستخدام الفعلي",
    admAuthTitle: "تسجيل الدخول للوحة الأدمن",
    admAuthSubtitle: "أدخل كلمة المرور الخاصة بك للوصول إلى السجلات والإحصائيات",
    admActiveNow: "المستخدمون النشطون الآن",
    admTotalVisits: "إجمالي عمليات التتبع",
    admUptime: "مدة تشغيل السيرفر",
    admTableTitle: "سجل الحسابات المبحوث عنها ومدة الاستخدام",
    refresh: "تحديث",
    logout: "خروج",
    thUser: "الحساب المستهدف (Target)",
    thStatus: "الحالة (Status)",
    thStart: "وقت البدء (Start Time)",
    thDuration: "مدة الاستخدام (Duration)",
    thDiamonds: "ألماسات مسجلة (Diamonds)",
    noRecords: "لا توجد سجلات حالياً",
    statusActive: "نشط الآن",
    statusCompleted: "مكتمل",
    loginError: "⚠️ كلمة المرور غير صحيحة!",
    enterPasswordToast: "يرجى إدخال كلمة المرور",
  },
  en: {
    appBrand: "Live Tracker",
    sidebarBtn: "Menu & Settings",
    sidebarTitle: "Dashboard & Settings",
    usernamePlaceholder: "username",
    startBtn: "Start Tracking",
    stopBtn: "Disconnect",
    statusIdle: "Idle",
    statusConnecting: "Connecting...",
    statusOnline: "Live Connected",
    statusOffline: "Stream Offline",
    room: "Room",
    kpiViewers: "Live Viewers",
    kpiLikes: "Total Likes",
    kpiDiamonds: "Live Diamonds",
    kpiDiamondsSub: "Total Stream Diamonds",
    kpiComments: "Total Comments",
    pkTitle: "Live PK Battle Arena",
    pkSubtitle: "Real-time tracking of battle contenders, supporters & scores",
    pkWaiting: "⏸️ Waiting for PK battle",
    pkRound: "Round",
    pkHostWins: "🔵 Our Wins:",
    pkOppWins: "🔴 Rival Wins:",
    pkOurTeam: "🔵 Our Team (With)",
    pkHostLabel: "Host & Allies",
    pkHostPoints: "Our Team Points:",
    pkHostTopSupporters: "🛡️ Top Supporters (Our Team):",
    pkOppTeam: "🔴 Opponent (Against)",
    pkOppLabel: "Rival Contenders",
    pkOppPoints: "Opponent Points:",
    pkOppTopSupporters: "⚔️ Top Opponent Supporters:",
    pkTie: "Tie ⚖️",
    pkClash: "⚡ Points Clash ⚡",
    commentsFeedTitle: "Live Comments",
    commentsFeedSub: "Comments",
    giftFeedTitle: "Gift Alerts",
    giftFeedSub: "Gifts",
    leaderboardTitle: "Top Supporters",
    leaderboardSub: "Supporters",
    lbDiamondsLabel: "Total Stream Diamonds",
    lbGrossLabel: "Gross USD Value",
    lbNetLabel: "Net Creator Payout",
    likersTitle: "Top Likers",
    likersSub: "Likers",
    labelLang: "Language",
    labelTheme: "Page Theme & Appearance",
    themeDark: "Dark Cyber Mode",
    themeLight: "Clean Light Mode",
    themeOled: "Midnight OLED Mode",
    labelAdmin: "Dedicated Admin Panel",
    descAdmin: "View active users, searched TikTok targets, and exact live session durations.",
    openAdminBtn: "Open Admin Dashboard",
    admTitle: "Dedicated Admin Dashboard",
    admSubtitle: "Real-time user monitoring, searched targets & usage duration",
    admAuthTitle: "Admin Dashboard Login",
    admAuthSubtitle: "Enter your administrator password to view usage logs and analytics",
    admActiveNow: "Active Tracking Users Now",
    admTotalVisits: "Total Tracked Sessions",
    admUptime: "Server Uptime",
    admTableTitle: "Searched Accounts & Usage Durations Log",
    refresh: "Refresh",
    logout: "Logout",
    thUser: "Searched Target",
    thStatus: "Status",
    thStart: "Start Time",
    thDuration: "Usage Duration",
    thDiamonds: "Logged Diamonds",
    noRecords: "No session logs found yet",
    statusActive: "Active Now",
    statusCompleted: "Completed",
    loginError: "⚠️ Invalid password!",
    enterPasswordToast: "Please enter your admin password",
  }
};

function formatDuration(sec, lang = 'ar') {
  if (sec == null || sec < 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (lang === 'ar') {
    if (h > 0) return `${h} س و ${m} د و ${s} ث`;
    if (m > 0) return `${m} د و ${s} ث`;
    return `${s} ثانية`;
  } else {
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
}

function formatUptime(sec, lang = 'ar') {
  if (sec == null || sec < 0) return '0s';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (lang === 'ar') {
    if (d > 0) return `${d} يوم ${h} س ${m} د`;
    if (h > 0) return `${h} ساعة ${m} د`;
    if (m > 0) return `${m} دقيقة ${s} ث`;
    return `${s} ثانية`;
  } else {
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
}

function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('tt_lang', lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang === 'ar' ? 'rtl' : 'ltr');

  const t = I18N[lang] || I18N.ar;

  // Header & Controls
  if ($('appBrandText')) $('appBrandText').textContent = t.appBrand;
  if ($('sidebarBtnText')) $('sidebarBtnText').textContent = t.sidebarBtn;
  if (DOM.usernameInput) DOM.usernameInput.placeholder = t.usernamePlaceholder;
  if (DOM.startBtn) DOM.startBtn.textContent = t.startBtn;
  if (DOM.stopBtn) DOM.stopBtn.textContent = t.stopBtn;

  // Sidebar Controls
  if ($('sidebarTitle')) $('sidebarTitle').textContent = t.sidebarTitle;
  if ($('labelLang')) $('labelLang').textContent = t.labelLang;
  if ($('labelTheme')) $('labelTheme').textContent = t.labelTheme;
  if ($('themeDarkText')) $('themeDarkText').textContent = t.themeDark;
  if ($('themeLightText')) $('themeLightText').textContent = t.themeLight;
  if ($('themeOledText')) $('themeOledText').textContent = t.themeOled;
  if ($('labelAdmin')) $('labelAdmin').textContent = t.labelAdmin;
  if ($('descAdmin')) $('descAdmin').textContent = t.descAdmin;
  if ($('btnOpenAdminText')) $('btnOpenAdminText').textContent = t.openAdminBtn;

  // Admin Modal Controls
  if ($('admModalTitle')) $('admModalTitle').textContent = t.admTitle;
  if ($('admModalSubtitle')) $('admModalSubtitle').textContent = t.admSubtitle;
  if ($('admAuthTitle')) $('admAuthTitle').textContent = t.admAuthTitle;
  if ($('admAuthSubtitle')) $('admAuthSubtitle').textContent = t.admAuthSubtitle;
  if ($('admLabelActive')) $('admLabelActive').textContent = t.admActiveNow;
  if ($('admLabelTotal')) $('admLabelTotal').textContent = t.admTotalVisits;
  if ($('admLabelUptime')) $('admLabelUptime').textContent = t.admUptime;
  if ($('admTableTitle')) $('admTableTitle').textContent = t.admTableTitle;
  if ($('admBtnRefresh')) $('admBtnRefresh').textContent = t.refresh;
  if ($('admBtnLogout')) $('admBtnLogout').textContent = t.logout;
  if ($('thUser')) $('thUser').textContent = t.thUser;
  if ($('thStatus')) $('thStatus').textContent = t.thStatus;
  if ($('thStart')) $('thStart').textContent = t.thStart;
  if ($('thDuration')) $('thDuration').textContent = t.thDuration;
  if ($('thDiamonds')) $('thDiamonds').textContent = t.thDiamonds;

  // Active button styling
  if (DOM.langArBtn && DOM.langEnBtn) {
    if (lang === 'ar') {
      DOM.langArBtn.className = 'flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold border transition active:scale-95 bg-pink-600/20 border-pink-500 text-pink-300';
      DOM.langEnBtn.className = 'flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold border transition active:scale-95 bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-800';
    } else {
      DOM.langEnBtn.className = 'flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold border transition active:scale-95 bg-pink-600/20 border-pink-500 text-pink-300';
      DOM.langArBtn.className = 'flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold border transition active:scale-95 bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-800';
    }
  }

  // Re-render admin table if data is present
  if (lastAdminData) {
    renderAdminTable(lastAdminData);
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('tt_theme', theme);

  document.documentElement.classList.remove('theme-dark', 'theme-light', 'theme-oled');
  if (theme === 'light') {
    document.documentElement.classList.add('theme-light');
  } else if (theme === 'oled') {
    document.documentElement.classList.add('theme-oled');
  } else {
    document.documentElement.classList.add('theme-dark');
  }

  const themes = [
    { name: 'dark', btn: DOM.themeDarkBtn },
    { name: 'light', btn: DOM.themeLightBtn },
    { name: 'oled', btn: DOM.themeOledBtn },
  ];

  themes.forEach(item => {
    if (!item.btn) return;
    const check = item.btn.querySelector('.theme-check');
    if (item.name === theme) {
      item.btn.className = 'w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-bold border transition text-start bg-pink-600/20 border-pink-500 text-pink-300';
      if (check) check.classList.remove('hidden');
    } else {
      item.btn.className = 'w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-bold border transition text-start bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-800';
      if (check) check.classList.add('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// Sidebar Management
// ---------------------------------------------------------------------------
function openSidebar() {
  if (DOM.mainSidebar) DOM.mainSidebar.classList.add('sidebar-open');
  if (DOM.sidebarBackdrop) {
    DOM.sidebarBackdrop.classList.remove('hidden');
    void DOM.sidebarBackdrop.offsetWidth;
    DOM.sidebarBackdrop.classList.add('active');
  }
}

function closeSidebar() {
  if (DOM.mainSidebar) DOM.mainSidebar.classList.remove('sidebar-open');
  if (DOM.sidebarBackdrop) {
    DOM.sidebarBackdrop.classList.remove('active');
    setTimeout(() => DOM.sidebarBackdrop?.classList.add('hidden'), 250);
  }
}

// ---------------------------------------------------------------------------
// Admin Dashboard Management
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Admin Dashboard & User Control Management (Owner Only)
// ---------------------------------------------------------------------------
let currentTrackingEnabled = true;
let currentAdminTab = 'sessions';

function openAdminModal() {
  closeSidebar();
  if (DOM.adminModal) DOM.adminModal.classList.remove('hidden');
  const token = sessionStorage.getItem('tt_admin_token');
  if (token) {
    showAdminDashboard();
    loadAdminStats();
    startAdminRefresh();
  } else {
    showAdminLogin();
  }
}

function closeAdminModal() {
  if (DOM.adminModal) DOM.adminModal.classList.add('hidden');
  stopAdminRefresh();
}

function showAdminLogin() {
  if (DOM.adminLoginSection) DOM.adminLoginSection.classList.remove('hidden');
  if (DOM.adminDashboardSection) DOM.adminDashboardSection.classList.add('hidden');
  if (DOM.adminSidebarSection) DOM.adminSidebarSection.classList.add('hidden');
  if (DOM.adminPasswordInput) {
    DOM.adminPasswordInput.value = '';
    DOM.adminPasswordInput.focus();
  }
  if (DOM.adminLoginError) DOM.adminLoginError.classList.add('hidden');
}

function showAdminDashboard() {
  if (DOM.adminLoginSection) DOM.adminLoginSection.classList.add('hidden');
  if (DOM.adminDashboardSection) DOM.adminDashboardSection.classList.remove('hidden');
  // Display admin controls in sidebar exclusively for the authenticated owner
  if (DOM.adminSidebarSection) DOM.adminSidebarSection.classList.remove('hidden');
}

function switchAdminTab(tab) {
  currentAdminTab = tab;
  const isSessions = tab === 'sessions';
  const isBanned   = tab === 'banned';
  const isBcast    = tab === 'broadcast';
  const isApi      = tab === 'api_settings';

  if (DOM.tabViewSessions) DOM.tabViewSessions.classList.toggle('hidden', !isSessions);
  if (DOM.tabViewBanned) DOM.tabViewBanned.classList.toggle('hidden', !isBanned);
  if (DOM.tabViewBroadcast) DOM.tabViewBroadcast.classList.toggle('hidden', !isBcast);
  if (DOM.tabViewApiSettings) DOM.tabViewApiSettings.classList.toggle('hidden', !isApi);

  const activeTabClass = 'px-4 py-2.5 text-xs font-bold border-b-2 border-purple-500 text-purple-300 transition flex items-center gap-2';
  const inactiveTabClass = 'px-4 py-2.5 text-xs font-bold border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition flex items-center gap-2';

  if (DOM.tabBtnSessions) DOM.tabBtnSessions.className = isSessions ? activeTabClass : inactiveTabClass;
  if (DOM.tabBtnBanned) DOM.tabBtnBanned.className = isBanned ? activeTabClass : inactiveTabClass;
  if (DOM.tabBtnBroadcast) DOM.tabBtnBroadcast.className = isBcast ? activeTabClass : inactiveTabClass;
  if (DOM.tabBtnApiSettings) DOM.tabBtnApiSettings.className = isApi ? activeTabClass : inactiveTabClass;
}

async function handleAdminLogin() {
  const pwd = DOM.adminPasswordInput ? DOM.adminPasswordInput.value.trim() : '';
  const t = I18N[currentLang] || I18N.ar;
  if (!pwd) {
    toast(t.enterPasswordToast, 'warning');
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
      showAdminDashboard();
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

async function loadAdminStats() {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) {
    showAdminLogin();
    return;
  }

  try {
    const res = await fetch(`/api/admin/stats?token=${encodeURIComponent(token)}`);
    if (res.status === 401) {
      sessionStorage.removeItem('tt_admin_token');
      stopAdminRefresh();
      showAdminLogin();
      return;
    }
    const data = await res.json();
    if (data.status === 'ok') {
      lastAdminData = data;
      if (DOM.admActiveUsers) DOM.admActiveUsers.textContent = data.active_users_count ?? 0;
      if (DOM.admTotalVisits) DOM.admTotalVisits.textContent = data.total_connections ?? 0;
      if (DOM.admServerUptime) DOM.admServerUptime.textContent = formatUptime(data.server_uptime_seconds ?? 0, currentLang);
      
      // Update global tracking switch UI
      currentTrackingEnabled = !!data.tracking_enabled;
      updateTrackingSwitchUI(currentTrackingEnabled);

      // Render search history & active users with control buttons
      renderAdminTable(data);

      // Render banned targets
      renderBannedTable(data.banned_targets || []);

      // Render Sign API status
      if (DOM.badgeSignKeyStatus) {
        if (data.has_sign_api_key) {
          DOM.badgeSignKeyStatus.textContent = 'مضبوط ✅';
          DOM.badgeSignKeyStatus.className = 'text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 font-bold';
        } else {
          DOM.badgeSignKeyStatus.textContent = 'غير مضبوط ⚠️';
          DOM.badgeSignKeyStatus.className = 'text-[10px] px-1.5 py-0.2 rounded-full bg-amber-950/80 text-amber-300 border border-amber-700/60 font-bold';
        }
      }
      if (DOM.currentSignKeyText) {
        DOM.currentSignKeyText.textContent = data.has_sign_api_key ? `مفعّل (${data.sign_api_key_masked || 'Active'})` : 'غير مضبوط (يستخدم الحساب المشترك العام)';
        DOM.currentSignKeyText.className = data.has_sign_api_key ? 'font-mono text-emerald-400 font-bold' : 'font-mono text-amber-400';
      }
    }
  } catch (err) {
    console.error('Failed to load admin stats:', err);
  }
}

function updateTrackingSwitchUI(enabled) {
  if (!DOM.btnToggleTracking || !DOM.textToggleTracking) return;
  if (enabled) {
    DOM.btnToggleTracking.className = 'px-3 py-1.5 rounded-lg text-xs font-bold border transition flex items-center gap-1.5 bg-emerald-950/60 border-emerald-600/50 text-emerald-300 hover:bg-emerald-900/60';
    DOM.textToggleTracking.textContent = currentLang === 'ar' ? '🟢 التتبع: يعمل (نشط)' : '🟢 Tracking: Active';
  } else {
    DOM.btnToggleTracking.className = 'px-3 py-1.5 rounded-lg text-xs font-bold border transition flex items-center gap-1.5 bg-red-950/60 border-red-600/50 text-red-300 hover:bg-red-900/60';
    DOM.textToggleTracking.textContent = currentLang === 'ar' ? '🔴 التتبع: معطل (صيانة)' : '🔴 Tracking: Frozen';
  }
}

function renderAdminTable(data) {
  if (!DOM.adminTableBody) return;
  DOM.adminTableBody.innerHTML = '';
  const t = I18N[currentLang] || I18N.ar;
  const history = data.search_history || [];

  if (history.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'p-4 text-center text-gray-500';
    td.textContent = t.noRecords;
    tr.appendChild(td);
    DOM.adminTableBody.appendChild(tr);
    return;
  }

  history.forEach(item => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-800/40 transition';

    // 1. Target username (Strictly textContent to prevent XSS)
    const tdUser = document.createElement('td');
    tdUser.className = 'p-3 font-mono font-bold text-pink-400';
    tdUser.textContent = '@' + (item.username || 'unknown');

    // 2. Status Badge
    const tdStatus = document.createElement('td');
    tdStatus.className = 'p-3';
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

    // 3. Start Time
    const tdStart = document.createElement('td');
    tdStart.className = 'p-3 font-mono text-gray-400';
    const dateObj = new Date((item.started_at || 0) * 1000);
    tdStart.textContent = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // 4. Usage Duration
    const tdDuration = document.createElement('td');
    tdDuration.className = 'p-3 font-mono font-bold text-indigo-300';
    tdDuration.textContent = formatDuration(item.duration_seconds || 0, currentLang);

    // 5. Total Diamonds
    const tdDiamonds = document.createElement('td');
    tdDiamonds.className = 'p-3 font-mono font-bold text-yellow-400';
    tdDiamonds.textContent = `💎 ${fmt(item.total_diamonds || 0)}`;

    // 6. Action Controls (Kick & Ban)
    const tdActions = document.createElement('td');
    tdActions.className = 'p-3';
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'flex items-center gap-1.5';

    if (item.status === 'active') {
      // Kick Button
      const kickBtn = document.createElement('button');
      kickBtn.className = 'px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-bold text-[10px] transition active:scale-95 shadow flex items-center gap-1';
      kickBtn.textContent = currentLang === 'ar' ? '🔴 قطع الاتصال' : '🔴 Kick';
      kickBtn.onclick = () => handleAdminKick(item.username);
      actionsWrap.appendChild(kickBtn);
    }

    // Ban Button
    const banBtn = document.createElement('button');
    banBtn.className = 'px-2.5 py-1 rounded bg-gray-800 hover:bg-red-900/60 border border-red-800/40 text-red-300 font-bold text-[10px] transition active:scale-95 flex items-center gap-1';
    banBtn.textContent = currentLang === 'ar' ? '🚫 حظر' : '🚫 Ban';
    banBtn.onclick = () => handleAdminBan(item.username);
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
  if (DOM.badgeBannedCount) DOM.badgeBannedCount.textContent = bannedList.length;

  if (bannedList.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'p-4 text-center text-gray-500';
    td.textContent = currentLang === 'ar' ? 'لا توجد حسابات محظورة حالياً' : 'No banned accounts';
    tr.appendChild(td);
    DOM.bannedTableBody.appendChild(tr);
    return;
  }

  bannedList.forEach(target => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-800/40 transition';

    // 1. Target
    const tdUser = document.createElement('td');
    tdUser.className = 'p-3 font-mono font-bold text-red-400';
    tdUser.textContent = '@' + target;

    // 2. Status
    const tdStatus = document.createElement('td');
    tdStatus.className = 'p-3';
    const badge = document.createElement('span');
    badge.className = 'px-2 py-0.5 rounded-full bg-red-950/80 border border-red-700/60 text-red-300 text-[10px] font-bold';
    badge.textContent = currentLang === 'ar' ? 'محظور من التتبع' : 'Blocked from Tracking';
    tdStatus.appendChild(badge);

    // 3. Unban Action
    const tdAction = document.createElement('td');
    tdAction.className = 'p-3';
    const unbanBtn = document.createElement('button');
    unbanBtn.className = 'px-3 py-1 rounded-lg bg-emerald-950/60 hover:bg-emerald-900 border border-emerald-600/50 text-emerald-300 font-bold text-xs transition active:scale-95 flex items-center gap-1';
    unbanBtn.textContent = currentLang === 'ar' ? '✅ إلغاء الحظر' : '✅ Unban';
    unbanBtn.onclick = () => handleAdminUnban(target);
    tdAction.appendChild(unbanBtn);

    tr.appendChild(tdUser);
    tr.appendChild(tdStatus);
    tr.appendChild(tdAction);

    DOM.bannedTableBody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Action Handlers: Kick, Ban, Unban, Toggle, Broadcast, Clear
// ---------------------------------------------------------------------------
async function handleAdminKick(username) {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  if (!confirm(currentLang === 'ar' ? `هل أنت متأكد من قطع اتصال جلسة @${username} فوراً؟` : `Kick tracking session for @${username}?`)) return;

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

async function handleAdminBan(username) {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  if (!confirm(currentLang === 'ar' ? `هل تريد حظر @${username} ومنع أي شخص من تتبعه؟` : `Ban @${username} from being tracked?`)) return;

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

async function handleAdminUnban(username) {
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

async function handleClearHistory() {
  const token = sessionStorage.getItem('tt_admin_token');
  if (!token) return;
  if (!confirm(currentLang === 'ar' ? 'هل تريد مسح سجلات التتبع السابقة المكتملة؟' : 'Clear completed tracking history?')) return;

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

async function handleAdminLogout() {
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
  showAdminLogin();
  toast(currentLang === 'ar' ? '👋 تم تسجيل الخروج من لوحة الأدمن' : '👋 Admin session logged out', 'info');
}

// ---------------------------------------------------------------------------
// UI Event Listeners
// ---------------------------------------------------------------------------
DOM.startBtn.addEventListener('click', () => {
  const username = DOM.usernameInput.value.trim();
  if (!username) {
    toast(currentLang === 'ar' ? 'يرجى إدخال اسم مستخدم تيك توك' : 'Please enter a TikTok @username', 'warning');
    DOM.usernameInput.focus();
    return;
  }

  // Reset feeds
  DOM.commentsFeed.innerHTML    = '<div class="flex items-center justify-center h-full text-gray-600 text-sm">Loading...</div>';
  DOM.giftFeed.innerHTML        = '<div class="flex items-center justify-center h-full text-gray-600 text-sm">Loading...</div>';
  DOM.leaderboardList.innerHTML = '<div class="flex items-center justify-center h-full text-gray-600 text-sm">Loading...</div>';
  DOM.likersRow.innerHTML       = '<p class="text-gray-600 text-sm">Loading...</p>';
  commentCount = 0;
  giftCount    = 0;
  _likersData  = {};
  DOM.commentCount.textContent = '0';
  DOM.giftCount.textContent    = '0 gifts';

  connectWs(username);
});

DOM.stopBtn.addEventListener('click', () => {
  disconnectWs();
  toast(currentLang === 'ar' ? '⏹️ تم إيقاف التتبع' : '⏹️ Tracking stopped', 'info');
});

DOM.usernameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') DOM.startBtn.click();
});

DOM.toggleScrollBtn.addEventListener('click', () => {
  autoScroll = !autoScroll;
  DOM.scrollIcon.textContent = autoScroll ? '⬇️' : '⏸️';
  if (autoScroll) DOM.commentsFeed.scrollTop = DOM.commentsFeed.scrollHeight;
});

// Pause auto-scroll when user manually scrolls up
DOM.commentsFeed.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = DOM.commentsFeed;
  const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
  if (!isAtBottom && autoScroll) {
    autoScroll = false;
    DOM.scrollIcon.textContent = '⏸️';
  } else if (isAtBottom && !autoScroll) {
    autoScroll = true;
    DOM.scrollIcon.textContent = '⬇️';
  }
});

// Sidebar drawer triggers
if (DOM.sidebarToggleBtn) DOM.sidebarToggleBtn.addEventListener('click', openSidebar);
if (DOM.closeSidebarBtn) DOM.closeSidebarBtn.addEventListener('click', closeSidebar);
if (DOM.sidebarBackdrop) DOM.sidebarBackdrop.addEventListener('click', () => {
  closeSidebar();
  closeAdminModal();
});

// Language buttons
if (DOM.langArBtn) DOM.langArBtn.addEventListener('click', () => applyLanguage('ar'));
if (DOM.langEnBtn) DOM.langEnBtn.addEventListener('click', () => applyLanguage('en'));

// Theme buttons
if (DOM.themeDarkBtn) DOM.themeDarkBtn.addEventListener('click', () => applyTheme('dark'));
if (DOM.themeLightBtn) DOM.themeLightBtn.addEventListener('click', () => applyTheme('light'));
if (DOM.themeOledBtn) DOM.themeOledBtn.addEventListener('click', () => applyTheme('oled'));

// Admin modal triggers
if (DOM.openAdminModalBtn) DOM.openAdminModalBtn.addEventListener('click', openAdminModal);
if (DOM.closeAdminModalBtn) DOM.closeAdminModalBtn.addEventListener('click', closeAdminModal);
if (DOM.adminLoginBtn) DOM.adminLoginBtn.addEventListener('click', handleAdminLogin);
if (DOM.adminPasswordInput) DOM.adminPasswordInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleAdminLogin();
});
if (DOM.adminRefreshBtn) DOM.adminRefreshBtn.addEventListener('click', loadAdminStats);
if (DOM.adminLogoutBtn) DOM.adminLogoutBtn.addEventListener('click', handleAdminLogout);

// Admin Control Toolbar triggers
if (DOM.btnToggleTracking) DOM.btnToggleTracking.addEventListener('click', handleToggleTracking);
if (DOM.btnClearHistory) DOM.btnClearHistory.addEventListener('click', handleClearHistory);

// Admin Tabs Triggers
if (DOM.tabBtnSessions) DOM.tabBtnSessions.addEventListener('click', () => switchAdminTab('sessions'));
if (DOM.tabBtnBanned) DOM.tabBtnBanned.addEventListener('click', () => switchAdminTab('banned'));
if (DOM.tabBtnBroadcast) DOM.tabBtnBroadcast.addEventListener('click', () => switchAdminTab('broadcast'));
if (DOM.tabBtnApiSettings) DOM.tabBtnApiSettings.addEventListener('click', () => switchAdminTab('api_settings'));
if (DOM.btnSaveSignApiKey) DOM.btnSaveSignApiKey.addEventListener('click', handleSaveSignApiKey);
if (DOM.inputSignApiKey) DOM.inputSignApiKey.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleSaveSignApiKey();
});

// Banned Manager Triggers
if (DOM.btnSubmitBan) DOM.btnSubmitBan.addEventListener('click', () => {
  const target = DOM.bannedInputTarget ? DOM.bannedInputTarget.value.trim() : '';
  if (target) {
    handleAdminBan(target);
    DOM.bannedInputTarget.value = '';
  }
});
if (DOM.bannedInputTarget) DOM.bannedInputTarget.addEventListener('keydown', e => {
  if (e.key === 'Enter' && DOM.btnSubmitBan) DOM.btnSubmitBan.click();
});

// Broadcast Trigger
if (DOM.btnSubmitBroadcast) DOM.btnSubmitBroadcast.addEventListener('click', handleSendBroadcast);

// ---------------------------------------------------------------------------
// Secret Owner Entry Triggers (إظهار اللوحة للمالك فقط)
// ---------------------------------------------------------------------------
// 1. Triple-click on the top TT Logo
let logoClicks = 0;
let logoClickTimer = null;
if (DOM.appLogo) {
  DOM.appLogo.addEventListener('click', () => {
    logoClicks++;
    if (logoClicks >= 3) {
      logoClicks = 0;
      clearTimeout(logoClickTimer);
      openAdminModal();
      toast(currentLang === 'ar' ? '🔐 تم فتح وصول المالك إلى لوحة الإدارة' : '🔐 Owner admin panel unlocked', 'info');
    } else {
      clearTimeout(logoClickTimer);
      logoClickTimer = setTimeout(() => { logoClicks = 0; }, 1200);
    }
  });
}

// 2. Keyboard shortcut: Ctrl + Shift + A or Alt + A
document.addEventListener('keydown', e => {
  if ((e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) ||
      (e.altKey && (e.key === 'A' || e.key === 'a'))) {
    e.preventDefault();
    openAdminModal();
  }
});

// Close on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeSidebar();
    closeAdminModal();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
applyLanguage(currentLang);
applyTheme(currentTheme);
setStatus('idle', I18N[currentLang]?.statusIdle || 'Idle');

// Check if authenticated owner from previous session
if (sessionStorage.getItem('tt_admin_token')) {
  if (DOM.adminSidebarSection) DOM.adminSidebarSection.classList.remove('hidden');
}

// Direct URL entry: /admin or ?admin=1
if (window.location.pathname.endsWith('/admin') || window.location.search.includes('admin=1')) {
  openAdminModal();
}

console.log('🎯 TikTok Live Analytics Tracker loaded with Owner Controls & Security.');
