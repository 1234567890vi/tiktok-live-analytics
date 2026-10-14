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
        setStatus('offline', 'Disconnected');
        DOM.stopBtn.classList.add('hidden');
        DOM.startBtn.classList.remove('hidden');
        toast(`🔴 Stream ended for @${msg.username}`, 'warning');
        break;

      case 'error':
        setStatus('offline', 'Error');
        DOM.stopBtn.classList.add('hidden');
        DOM.startBtn.classList.remove('hidden');
        toast(`❌ ${msg.message}: ${msg.detail || ''}`, 'error', 7000);
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
// UI event listeners
// ---------------------------------------------------------------------------
DOM.startBtn.addEventListener('click', () => {
  const username = DOM.usernameInput.value.trim();
  if (!username) {
    toast('Please enter a TikTok @username', 'warning');
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
  toast('⏹️ Tracking stopped', 'info');
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

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
setStatus('idle', 'Idle');
console.log('🎯 TikTok Live Analytics Tracker loaded.');
