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
let lastPkStatus    = 'IDLE';
let lastRoundNum    = 0;

// ---------------------------------------------------------------------------
// Pure Web Audio Synthesizer (Zero External Dependencies, Instant Audio)
// ---------------------------------------------------------------------------
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// User-gesture audio unlock
['click', 'touchstart', 'keydown'].forEach(evt => {
  window.addEventListener(evt, () => getAudioContext(), { once: true, passive: true });
});

// Sound 1: Battle Start Fanfare (Triumphant brass fanfare)
function playBattleStartSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = [
      { f: 329.63, start: 0.00, dur: 0.14 },
      { f: 415.30, start: 0.12, dur: 0.14 },
      { f: 493.88, start: 0.24, dur: 0.16 },
      { f: 659.25, start: 0.40, dur: 0.45 },
    ];
    notes.forEach(({ f, start, dur }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, now + start);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1400, now + start);

      gain.gain.setValueAtTime(0.001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.22, now + start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    });
  } catch (err) {
    console.debug('[Audio] Fanfare error:', err);
  }
}

// Sound 2: VIP / Big Gift Chime (Sparkling magical arpeggio)
function playBigGiftSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = [587.33, 739.99, 880.00, 1174.66, 1479.98];
    notes.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + (idx * 0.06));

      gain.gain.setValueAtTime(0.001, now + (idx * 0.06));
      gain.gain.exponentialRampToValueAtTime(0.18, now + (idx * 0.06) + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (idx * 0.06) + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + (idx * 0.06));
      osc.stop(now + (idx * 0.06) + 0.36);
    });
  } catch (err) {
    console.debug('[Audio] Big gift sound error:', err);
  }
}

// Sound 3: Item Card Activated (Punchy power-up tone)
function playItemCardSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.25);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch (err) {
    console.debug('[Audio] Item card sound error:', err);
  }
}


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

  // Admin Link
  linkOpenAdmin: $('linkOpenAdmin'),

  // Live Video Player
  liveVideoSection:       $('liveVideoSection'),
  playerTitle:            $('playerTitle'),
  videoLiveBadge:         $('videoLiveBadge'),
  videoStreamerInfo:      $('videoStreamerInfo'),
  videoQualityWrapper:    $('videoQualityWrapper'),
  videoQualitySelect:     $('videoQualitySelect'),
  btnVideoRefresh:        $('btnVideoRefresh'),
  videoRefreshIcon:       $('videoRefreshIcon'),
  btnVideoMute:           $('btnVideoMute'),
  videoMuteIcon:          $('videoMuteIcon'),
  videoMuteText:          $('videoMuteText'),
  btnVideoPip:            $('btnVideoPip'),
  btnVideoFullscreen:     $('btnVideoFullscreen'),
  btnVideoAspect:         $('btnVideoAspect'),
  videoAspectIcon:        $('videoAspectIcon'),
  btnVideoExternal:       $('btnVideoExternal'),
  btnToggleVideoCollapse: $('btnToggleVideoCollapse'),
  videoCollapseIcon:      $('videoCollapseIcon'),
  videoCollapseText:      $('videoCollapseText'),
  liveVideoContainer:     $('liveVideoContainer'),
  liveVideoElement:       $('liveVideoElement'),
  liveIframeElement:      $('liveIframeElement'),
  videoBufferingIndicator: $('videoBufferingIndicator'),
  videoPlaceholder:       $('videoPlaceholder'),
  videoPlaceholderTitle:  $('videoPlaceholderTitle'),
  videoPlaceholderDesc:   $('videoPlaceholderDesc'),
  btnLaunchDemoVideo:     $('btnLaunchDemoVideo'),
  videoSpyAlert:          $('videoSpyAlert'),
  videoSpyAlertText:      $('videoSpyAlertText'),
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
// ---------------------------------------------------------------------------
// KPI bump animation — layout-friendly without forced synchronous reflow
// ---------------------------------------------------------------------------
function bumpKpi(el, newVal, formatter = fmt) {
  if (!el) return;
  const str = formatter(newVal);
  if (el.textContent !== str) {
    el.textContent = str;
    if (!el.classList.contains('bump')) {
      el.classList.add('bump');
      setTimeout(() => el.classList.remove('bump'), 250);
    }
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
// High-Performance Batched DOM Rendering (requestAnimationFrame)
// ---------------------------------------------------------------------------
const commentQueue = [];
const giftQueue    = [];
let batchRafScheduled = false;

function scheduleBatchRender() {
  if (batchRafScheduled) return;
  batchRafScheduled = true;
  requestAnimationFrame(flushBatchRenders);
}

function flushBatchRenders() {
  batchRafScheduled = false;

  // 1. Batch append comments
  if (commentQueue.length > 0) {
    clearPlaceholder(DOM.commentsFeed);
    const frag = document.createDocumentFragment();
    const batch = commentQueue.splice(0, commentQueue.length);
    for (let i = 0; i < batch.length; i++) {
      frag.appendChild(createCommentNode(batch[i]));
    }
    DOM.commentsFeed.appendChild(frag);

    // Prune oldest comments in single pass
    while (DOM.commentsFeed.children.length > MAX_COMMENTS) {
      DOM.commentsFeed.removeChild(DOM.commentsFeed.firstChild);
    }

    if (autoScroll) {
      DOM.commentsFeed.scrollTop = DOM.commentsFeed.scrollHeight;
    }
    DOM.commentCount.textContent = fmt(commentCount);
    bumpKpi(DOM.kpiComments, commentCount);
  }

  // 2. Batch prepend gifts (newest first)
  if (giftQueue.length > 0) {
    clearPlaceholder(DOM.giftFeed);
    const frag = document.createDocumentFragment();
    const batch = giftQueue.splice(0, giftQueue.length);
    // Reverse batch so newest gift ends up at the top
    for (let i = batch.length - 1; i >= 0; i--) {
      frag.appendChild(createGiftNode(batch[i]));
    }
    DOM.giftFeed.prepend(frag);

    // Prune oldest gifts from bottom in single pass
    while (DOM.giftFeed.children.length > MAX_GIFTS) {
      DOM.giftFeed.removeChild(DOM.giftFeed.lastChild);
    }
    DOM.giftCount.textContent = `${fmt(giftCount)} gifts`;
  }
}

// ---------------------------------------------------------------------------
// DOM Node Factories
// ---------------------------------------------------------------------------
function createCommentNode(data) {
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
  return entry;
}

function createGiftNode(data) {
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
  card.className = `gift-card${isStreak ? ' streak-active' : ''}${totalComboDiamonds >= 1000 || unitDiamonds >= 1000 ? ' vip-gift' : ''}`;
  card.dataset.userKey = String(user.user_id || user.unique_id || '');
  card.dataset.giftKey = String(txn.gift_id || giftName || '');
  card.dataset.streakActive = isStreak ? '1' : '0';

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

  // Hidden Supporter Unmasking Display (كشف هوية الداعم المخفي)
  const isHidden = !!(data.is_hidden || user.is_hidden || data.identity?.is_hidden);
  const isUnmasked = !!(data.is_unmasked || user.is_unmasked || data.identity?.is_unmasked);
  const revealedUsername = data.revealed_username || user.revealed_username || data.identity?.revealed_username || '';
  const revealedNickname = data.revealed_nickname || user.revealed_nickname || data.identity?.revealed_nickname || '';

  if (isHidden) {
    card.classList.add('hidden-supporter-glow');
    const unmaskDiv = document.createElement('div');
    if (isUnmasked && revealedUsername) {
      unmaskDiv.className = 'unmask-badge unmask-revealed';
      unmaskDiv.innerHTML = `
        <span>🕵️</span>
        <span>داعم مخفي: كشف الهوية <span class="unmask-handle">@${revealedUsername}</span>${revealedNickname && revealedNickname !== revealedUsername ? ` (${revealedNickname})` : ''}</span>
      `;
      triggerSpyAlert(`🕵️ تم كشف هوية داعم مخفي: @${revealedUsername} (${fmt(totalComboDiamonds)} 💎)`);
    } else {
      const shortId = (user.user_id ? String(user.user_id).slice(-6) : 'anon');
      unmaskDiv.className = 'unmask-badge unmask-pending';
      unmaskDiv.innerHTML = `
        <span>🕵️</span>
        <span>داعم مخفي (معرف النظام: #${shortId})</span>
      `;
    }
    info.appendChild(unmaskDiv);
  }

  // Combo counter
  const comboDiv = document.createElement('div');
  comboDiv.className   = 'gift-combo';
  comboDiv.textContent = `x${combo}`;

  card.append(avDiv, info, comboDiv);
  return card;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
function addComment(data) {
  commentCount++;
  commentQueue.push(data);
  if (commentQueue.length > 250) {
    commentQueue.splice(0, commentQueue.length - 250);
  }
  scheduleBatchRender();
}

// ---------------------------------------------------------------------------
// Gifts
// ---------------------------------------------------------------------------
function addGift(data) {
  if (data.total_gifts != null && data.total_gifts > 0) {
    giftCount = Math.max(giftCount + 1, data.total_gifts);
  } else {
    giftCount++;
  }

  const txn      = data.transaction || {};
  const user     = data.user || {};
  const giftName = txn.gift_name     || 'Gift';
  const iconUrl  = txn.gift_icon_url || '';
  const combo    = data.repeat_count || txn.repeat_count || 1;
  const isStreak = !!data.streak_active;

  const unitDiamonds = (data.diamond_unit_cost !== undefined && data.diamond_unit_cost !== null)
    ? data.diamond_unit_cost
    : (txn.diamond_unit_cost || (combo > 0 && txn.total_value ? Math.round(txn.total_value / combo) : (txn.total_value || 0)));

  const totalComboDiamonds = (data.combo_diamonds !== undefined && data.combo_diamonds !== null)
    ? data.combo_diamonds
    : (unitDiamonds * combo);

  const usdEst = (data.combo_usd !== undefined && data.combo_usd !== null)
    ? Number(data.combo_usd).toFixed(2)
    : (totalComboDiamonds * 0.005).toFixed(2);

  // VIP sound chime for legendary gifts (>= 1000 diamonds)
  if (totalComboDiamonds >= 1000 || unitDiamonds >= 1000) {
    playBigGiftSound();
  }

  // Show combo burst popup for streaks >= 5
  if (combo >= 5) showComboBurst(giftName, iconUrl || '🎁', combo);

  // Update revenue KPIs immediately
  if (data.total_diamonds !== undefined) {
    bumpKpi(DOM.kpiDiamonds, data.total_diamonds);
    bumpKpi(DOM.kpiUsd, data.estimated_usd, fmtUsd);
    bumpKpi(DOM.kpiNet, data.net_payout_usd, fmtUsd);
    DOM.lbTotalDiamonds.textContent = fmt(data.total_diamonds);
    DOM.lbGrossUsd.textContent      = fmtUsd(data.estimated_usd);
    DOM.lbNetUsd.textContent        = fmtUsd(data.net_payout_usd);
  }

  // In-place streak upgrade (zero delay, prevents DOM flooding on long streaks)
  const userKey = String(user.user_id || user.unique_id || '');
  const giftKey = String(txn.gift_id || giftName || '');
  const topCard = DOM.giftFeed ? DOM.giftFeed.firstElementChild : null;
  if (topCard && topCard.dataset && topCard.dataset.userKey === userKey && topCard.dataset.giftKey === giftKey && topCard.dataset.streakActive === '1') {
    topCard.dataset.streakActive = isStreak ? '1' : '0';
    if (!isStreak) topCard.classList.remove('streak-active');

    const comboDiv = topCard.querySelector('.gift-combo');
    if (comboDiv) {
      comboDiv.textContent = `x${combo}`;
      comboDiv.classList.remove('combo-bounce');
      void comboDiv.offsetWidth;
      comboDiv.classList.add('combo-bounce');
    }

    const detailsLine = topCard.querySelector('.gift-details');
    if (detailsLine) {
      detailsLine.innerHTML = `
        <span class="gift-unit-pill" title="سعر الهدية الواحدة">💎 ${fmt(unitDiamonds)}</span>
        ${combo > 1 ? `<span class="gift-total-pill" title="إجمالي الكومبو">المجموع: 💎 ${fmt(totalComboDiamonds)}</span>` : ''}
        <span class="gift-usd-pill" title="القيمة التقريبية بالدولار">≈ $${usdEst}</span>
      `;
    }

    if (totalComboDiamonds >= 1000 || unitDiamonds >= 1000) {
      topCard.classList.add('vip-gift');
    }

    DOM.giftCount.textContent = `${fmt(giftCount)} gifts`;
    return;
  }

  giftQueue.push(data);
  if (giftQueue.length > 150) {
    giftQueue.splice(0, giftQueue.length - 150);
  }
  scheduleBatchRender();
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
    nameEl.className   = 'lb-name flex items-center gap-1.5 flex-wrap';

    if (sup.is_hidden) {
      if (sup.is_unmasked && sup.revealed_username) {
        nameEl.innerHTML = `
          <span class="text-emerald-400 font-bold">@${sup.revealed_username}</span>
          <span class="lb-spy-tag revealed" title="داعم مخفي تم كشف هويته!">🕵️ كشف: @${sup.revealed_username}</span>
        `;
        nameEl.title = `داعم مخفي: الاسم المستعار (${sup.nickname}) — الهوية الحقيقية: @${sup.revealed_username}`;
      } else {
        nameEl.innerHTML = `
          <span>${sup.nickname || 'مستخدم مخفي'}</span>
          <span class="lb-spy-tag pending" title="داعم مخفي">🕵️ مخفي</span>
        `;
        nameEl.title = `داعم مخفي (معرف #${sup.user_id ? String(sup.user_id).slice(-6) : 'anon'})`;
      }
    } else {
      nameEl.textContent = sup.nickname || sup.unique_id || 'Anon';
      nameEl.title       = sup.nickname || '';
    }

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

  // Instant Round Start Detection & Synchronization
  const isNewRound =
    (eventType === 'start') ||
    (lastPkStatus !== 'ACTIVE' && (status === 'ACTIVE' || isActive)) ||
    ((status === 'ACTIVE' || isActive) && roundNum > lastRoundNum && lastRoundNum !== 0);

  if (isNewRound) {
    playBattleStartSound();
    if (DOM.pkSection) {
      DOM.pkSection.classList.remove('round-start-flash');
      void DOM.pkSection.offsetWidth;
      DOM.pkSection.classList.add('round-start-flash');
      setTimeout(() => DOM.pkSection?.classList.remove('round-start-flash'), 2000);
      try { DOM.pkSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    }
    toast(`⚔️ بدأت جولة جديدة الآن! (الجولة ${roundNum}) 🔥 احشدوا الدعم!`, 'warning', 6000);
  }

  lastPkStatus = status;
  lastRoundNum = roundNum;

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
  if (data.stream_video)   loadVideoStream(data.stream_video);
}

// ---------------------------------------------------------------------------
// Live Video Player Controller (مشغل البث المرئي المباشر)
// ---------------------------------------------------------------------------
// Live Video Stream Player (HLS / Low Latency / Ultra Smooth)
// ---------------------------------------------------------------------------
let hlsInstance = null;
let isVideoMuted = true;
let isVideoPortrait = false;
let isVideoCollapsed = false;
let currentStreamData = null;

function getProxiedStreamUrl(url) {
  if (!url) return '';
  if (url.startsWith('/api/stream_proxy')) return url;
  const lower = url.toLowerCase();
  const isTikTokCdn = lower.includes('tiktokcdn.com') ||
                      lower.includes('byteoversea.com') ||
                      lower.includes('ibytedtos.com') ||
                      lower.includes('bytedance.net') ||
                      lower.includes('tiktok.com');
  if (isTikTokCdn) {
    return `/api/stream_proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function setupVideoBufferingListeners(video) {
  if (!video || video._hasBufferingListeners) return;
  video._hasBufferingListeners = true;

  video.addEventListener('waiting', () => {
    DOM.videoBufferingIndicator?.classList.remove('hidden');
  });
  video.addEventListener('stalled', () => {
    DOM.videoBufferingIndicator?.classList.remove('hidden');
  });
  video.addEventListener('playing', () => {
    DOM.videoBufferingIndicator?.classList.add('hidden');
  });
  video.addEventListener('canplay', () => {
    DOM.videoBufferingIndicator?.classList.add('hidden');
  });
  video.addEventListener('pause', () => {
    DOM.videoBufferingIndicator?.classList.add('hidden');
  });
}

function populateVideoQualities(streamData) {
  if (!DOM.videoQualitySelect || !DOM.videoQualityWrapper) return;
  const qualities = streamData.qualities || {};
  const keys = Object.keys(qualities).filter(k => qualities[k]?.hls);

  if (keys.length === 0) {
    DOM.videoQualityWrapper.classList.add('hidden');
    return;
  }

  DOM.videoQualitySelect.innerHTML = '';
  const optAuto = document.createElement('option');
  optAuto.value = 'auto';
  optAuto.textContent = '⚡ تلقائي (سلس)';
  DOM.videoQualitySelect.appendChild(optAuto);

  const labels = {
    hd: '💎 HD (عالية)',
    sd: '🚀 SD (سلسة وسريعة)',
    ld: '📱 خفيفة (توفير)',
    origin: '🎬 الأصلية (Full)',
    uhd: '🌟 فائقة (UHD)',
  };

  keys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = labels[k] || `دقة (${k.toUpperCase()})`;
    DOM.videoQualitySelect.appendChild(opt);
  });

  DOM.videoQualityWrapper.classList.remove('hidden');
}

function resyncLiveStream() {
  if (DOM.videoRefreshIcon) DOM.videoRefreshIcon.classList.add('animate-spin');
  setTimeout(() => {
    DOM.videoRefreshIcon?.classList.remove('animate-spin');
  }, 1000);

  if (hlsInstance) {
    try {
      hlsInstance.startLoad();
      if (DOM.liveVideoElement && DOM.liveVideoElement.buffered && DOM.liveVideoElement.buffered.length > 0) {
        const liveEdge = DOM.liveVideoElement.buffered.end(DOM.liveVideoElement.buffered.length - 1);
        DOM.liveVideoElement.currentTime = Math.max(0, liveEdge - 1.5);
      }
      DOM.liveVideoElement.play().catch(() => {});
    } catch (err) {
      console.debug('[Video] Re-sync error:', err);
    }
  } else if (DOM.liveVideoElement) {
    DOM.liveVideoElement.load();
    DOM.liveVideoElement.play().catch(() => {});
  }
}

function initLiveVideoPlayer() {
  if (!DOM.liveVideoElement) return;

  setupVideoBufferingListeners(DOM.liveVideoElement);

  // Toggle Mute / Unmute
  DOM.btnVideoMute?.addEventListener('click', () => {
    isVideoMuted = !DOM.liveVideoElement.muted;
    DOM.liveVideoElement.muted = isVideoMuted;
    if (DOM.videoMuteIcon) DOM.videoMuteIcon.textContent = isVideoMuted ? '🔇' : '🔊';
    if (DOM.videoMuteText) DOM.videoMuteText.textContent = isVideoMuted ? 'صامت' : 'مسموع';
  });

  // Re-sync Button
  DOM.btnVideoRefresh?.addEventListener('click', () => {
    resyncLiveStream();
  });

  // Quality Switcher
  DOM.videoQualitySelect?.addEventListener('change', (e) => {
    const chosen = e.target.value;
    if (currentStreamData) {
      loadVideoStream(currentStreamData, chosen);
    }
  });

  // Toggle Picture-in-Picture
  DOM.btnVideoPip?.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (DOM.liveVideoElement && document.pictureInPictureEnabled) {
        await DOM.liveVideoElement.requestPictureInPicture();
      }
    } catch (err) {
      console.debug('[Video] PiP error:', err);
    }
  });

  // Toggle Fullscreen
  DOM.btnVideoFullscreen?.addEventListener('click', () => {
    const el = DOM.liveVideoContainer || DOM.liveVideoElement;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  });

  // Toggle Aspect Ratio (Portrait / Landscape)
  DOM.btnVideoAspect?.addEventListener('click', () => {
    isVideoPortrait = !isVideoPortrait;
    if (isVideoPortrait) {
      DOM.liveVideoElement.classList.remove('aspect-landscape');
      DOM.liveVideoElement.classList.add('aspect-portrait');
      if (DOM.videoAspectIcon) DOM.videoAspectIcon.textContent = '🖥️';
    } else {
      DOM.liveVideoElement.classList.remove('aspect-portrait');
      DOM.liveVideoElement.classList.add('aspect-landscape');
      if (DOM.videoAspectIcon) DOM.videoAspectIcon.textContent = '📱';
    }
  });

  // Collapse / Expand Toggle
  DOM.btnToggleVideoCollapse?.addEventListener('click', () => {
    isVideoCollapsed = !isVideoCollapsed;
    if (isVideoCollapsed) {
      DOM.liveVideoContainer.classList.add('video-collapsed');
      if (DOM.videoCollapseIcon) DOM.videoCollapseIcon.textContent = '🔽';
      if (DOM.videoCollapseText) DOM.videoCollapseText.textContent = 'تكبير';
    } else {
      DOM.liveVideoContainer.classList.remove('video-collapsed');
      if (DOM.videoCollapseIcon) DOM.videoCollapseIcon.textContent = '🔼';
      if (DOM.videoCollapseText) DOM.videoCollapseText.textContent = 'تصغير';
    }
  });

  // Demo Video Launch Button
  DOM.btnLaunchDemoVideo?.addEventListener('click', () => {
    loadDemoVideoStream();
  });
}

function loadVideoStream(streamData, chosenQuality = 'auto') {
  if (!streamData) return;
  currentStreamData = streamData;

  const qualities = streamData.qualities || {};
  let targetHls = streamData.hls_url || streamData.best_hls_url || '';

  if (chosenQuality !== 'auto' && qualities[chosenQuality] && qualities[chosenQuality].hls) {
    targetHls = qualities[chosenQuality].hls;
  }

  const webUrl = streamData.web_url || `https://www.tiktok.com/@${currentUsername}/live`;

  if (DOM.videoStreamerInfo) {
    DOM.videoStreamerInfo.textContent = `🔴 بث تيك توك المباشر للحساب @${streamData.username || currentUsername}`;
  }
  if (DOM.videoLiveBadge) {
    DOM.videoLiveBadge.classList.remove('hidden');
  }
  if (DOM.btnVideoExternal) {
    DOM.btnVideoExternal.href = webUrl;
    DOM.btnVideoExternal.classList.remove('hidden');
  }

  populateVideoQualities(streamData);
  if (chosenQuality !== 'auto' && DOM.videoQualitySelect) {
    DOM.videoQualitySelect.value = chosenQuality;
  }

  // If no HLS direct stream is provided but TikTok embed or room_id is present:
  if (!targetHls) {
    const embedSrc = streamData.embed_url || streamData.iframe_url || '';
    if (embedSrc && DOM.liveIframeElement) {
      if (DOM.videoPlaceholder) DOM.videoPlaceholder.classList.add('hidden');
      DOM.liveVideoElement?.classList.add('hidden');
      DOM.liveIframeElement.src = embedSrc;
      DOM.liveIframeElement.classList.remove('hidden');
      return;
    }

    // Otherwise show helpful prompt
    if (DOM.videoPlaceholder) DOM.videoPlaceholder.classList.remove('hidden');
    if (DOM.videoPlaceholderTitle) DOM.videoPlaceholderTitle.textContent = `البث المباشر نشط (@${streamData.username || currentUsername})`;
    if (DOM.videoPlaceholderDesc) {
      DOM.videoPlaceholderDesc.innerHTML = `تم ربط إحصائيات البث المباشر بنجاح. يمكنك أيضاً مشاهدة الفيديو مباشرة عبر تيك توك: <a href="${webUrl}" target="_blank" class="text-pink-400 font-bold underline">فتح على تيك توك ↗</a>`;
    }
    return;
  }

  // Hide placeholder & iframe, show video element
  if (DOM.videoPlaceholder) DOM.videoPlaceholder.classList.add('hidden');
  if (DOM.liveIframeElement) {
    DOM.liveIframeElement.classList.add('hidden');
    DOM.liveIframeElement.removeAttribute('src');
  }
  DOM.liveVideoElement?.classList.remove('hidden');
  setupVideoBufferingListeners(DOM.liveVideoElement);
  DOM.liveVideoElement.muted = isVideoMuted;

  // Cleanup previous HLS instance
  if (hlsInstance) {
    try { hlsInstance.destroy(); } catch (_) {}
    hlsInstance = null;
  }

  const finalStreamUrl = getProxiedStreamUrl(targetHls);

  // Setup HLS.js with ultra-smooth live stream settings
  if (window.Hls && window.Hls.isSupported()) {
    hlsInstance = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,          // Standard buffer prevents micro-freezes & stuttering
      liveSyncDurationCount: 3,       // 3 segments (~4-6s buffer) eliminates stuttering completely
      liveMaxLatencyDurationCount: 8, // Prevents falling too far behind
      maxLiveSyncPlaybackRate: 1.12,  // Gentle catch up
      liveDurationInfinity: true,
      backBufferLength: 30,
      maxBufferLength: 20,
      maxMaxBufferLength: 40,
      maxBufferSize: 50 * 1000 * 1000,
      startFragPrefetch: true,        // Pre-downloads next video segment ahead of time for seamless transition
      manifestLoadingTimeOut: 12000,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 500,
      levelLoadingTimeOut: 12000,
      levelLoadingMaxRetry: 6,
      fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 500,
      testBandwidth: true,
    });

    hlsInstance.loadSource(finalStreamUrl);
    hlsInstance.attachMedia(DOM.liveVideoElement);

    hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
      DOM.liveVideoElement.play().catch(() => {
        // Autoplay policy: fallback to muted
        DOM.liveVideoElement.muted = true;
        isVideoMuted = true;
        if (DOM.videoMuteIcon) DOM.videoMuteIcon.textContent = '🔇';
        if (DOM.videoMuteText) DOM.videoMuteText.textContent = 'صامت';
        DOM.liveVideoElement.play().catch(() => {});
      });
    });

    hlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case window.Hls.ErrorTypes.NETWORK_ERROR:
            console.warn('[HLS] Network error encountered, recovering...', data);
            hlsInstance.startLoad();
            break;
          case window.Hls.ErrorTypes.MEDIA_ERROR:
            console.warn('[HLS] Media error encountered, recovering...', data);
            hlsInstance.recoverMediaError();
            break;
          default:
            console.error('[HLS] Unrecoverable error:', data);
            // If proxy or stream died, fallback to embed or alternate quality
            if (streamData.embed_url && DOM.liveIframeElement) {
              DOM.liveVideoElement?.classList.add('hidden');
              DOM.liveIframeElement.src = streamData.embed_url;
              DOM.liveIframeElement.classList.remove('hidden');
            }
            break;
        }
      }
    });
  } else if (DOM.liveVideoElement.canPlayType('application/vnd.apple.mpegurl')) {
    // Native Safari / iOS HLS
    DOM.liveVideoElement.src = finalStreamUrl;
    DOM.liveVideoElement.play().catch(() => {
      DOM.liveVideoElement.muted = true;
      DOM.liveVideoElement.play().catch(() => {});
    });
  }
}

function loadDemoVideoStream() {
  if (DOM.videoPlaceholder) DOM.videoPlaceholder.classList.add('hidden');
  if (DOM.videoLiveBadge) DOM.videoLiveBadge.classList.remove('hidden');
  if (DOM.videoStreamerInfo) DOM.videoStreamerInfo.textContent = '🎮 بث تجريبي حي (Live Stream Demo)';

  // High-reliability public HLS test stream
  const demoHls = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  loadVideoStream({
    username: 'demo_streamer',
    hls_url: demoHls,
    web_url: 'https://www.tiktok.com',
  });
  toast('📺 تم تشغيل البث المرئي التجريبي بسلاسة!', 'success');
}

function triggerSpyAlert(text) {
  if (!DOM.videoSpyAlert) return;
  if (DOM.videoSpyAlertText) DOM.videoSpyAlertText.textContent = text;
  DOM.videoSpyAlert.classList.remove('hidden');
  clearTimeout(DOM.videoSpyAlert._timer);
  DOM.videoSpyAlert._timer = setTimeout(() => {
    DOM.videoSpyAlert?.classList.add('hidden');
  }, 6000);
}

// ---------------------------------------------------------------------------
// Helper: Extract and sanitize TikTok username from handle, URL, or pasted text
// ---------------------------------------------------------------------------
function extractTikTokUsername(raw) {
  if (!raw) return '';
  // Strip unicode directional marks and invisible spaces
  let s = String(raw).replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();
  // Check if full TikTok URL (e.g. https://www.tiktok.com/@username/live)
  const urlMatch = s.match(/tiktok\.com\/@([a-zA-Z0-9_.-]+)/i);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1].replace(/\/+$/, '');
  }
  // Remove leading @ and trailing path or query
  s = s.replace(/^@+/, '').split('?')[0].split('/')[0].trim();
  return s;
}

// ---------------------------------------------------------------------------
// WebSocket connection management
// ---------------------------------------------------------------------------
function connectWs(username) {
  stopDemoSimulation();
  if (ws) {
    ws.close(1000, 'new session');
    ws = null;
  }

  currentUsername = extractTikTokUsername(username);
  if (!currentUsername) return;

  const url = `${WS_BASE}/ws/track/${encodeURIComponent(currentUsername)}`;
  setStatus('connecting', currentLang === 'ar' ? `جاري الاتصال بـ @${currentUsername}...` : `Connecting to @${currentUsername}…`);

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
        if (DOM.videoPlaceholder) DOM.videoPlaceholder.classList.remove('hidden');
        if (DOM.videoLiveBadge) DOM.videoLiveBadge.classList.add('hidden');
        if (DOM.videoBufferingIndicator) DOM.videoBufferingIndicator.classList.add('hidden');
        if (DOM.videoQualityWrapper) DOM.videoQualityWrapper.classList.add('hidden');
        if (hlsInstance) { try { hlsInstance.destroy(); } catch (_) {} hlsInstance = null; }
        if (DOM.liveVideoElement) { DOM.liveVideoElement.pause(); DOM.liveVideoElement.removeAttribute('src'); DOM.liveVideoElement.load(); }
        if (DOM.liveIframeElement) { DOM.liveIframeElement.classList.add('hidden'); DOM.liveIframeElement.removeAttribute('src'); }
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
        if (DOM.videoPlaceholder) DOM.videoPlaceholder.classList.remove('hidden');
        if (DOM.videoLiveBadge) DOM.videoLiveBadge.classList.add('hidden');
        if (DOM.videoBufferingIndicator) DOM.videoBufferingIndicator.classList.add('hidden');
        if (DOM.videoQualityWrapper) DOM.videoQualityWrapper.classList.add('hidden');
        if (hlsInstance) { try { hlsInstance.destroy(); } catch (_) {} hlsInstance = null; }
        if (DOM.liveVideoElement) { DOM.liveVideoElement.pause(); DOM.liveVideoElement.removeAttribute('src'); DOM.liveVideoElement.load(); }
        if (DOM.liveIframeElement) { DOM.liveIframeElement.classList.add('hidden'); DOM.liveIframeElement.removeAttribute('src'); }
        toast(`⚠️ ${msg.message}${msg.detail ? ': ' + msg.detail : ''}`, 'error', 9000);
        if (ws) {
          try { ws.close(); } catch (_) {}
          ws = null;
        }
        break;

      case 'stream_video':
        loadVideoStream(msg.data);
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

      case 'pk_item_card':
        playItemCardSound();
        if (DOM.pkSection) {
          DOM.pkSection.classList.add('item-card-active');
          setTimeout(() => DOM.pkSection?.classList.remove('item-card-active'), 5000);
        }
        toast(`🥊 [كرت سحري]: ${msg.data?.card_name || 'كرت مضاعفة'} — ${msg.data?.description || ''}`, 'warning', 7000);
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
  stopDemoSimulation();
  commentQueue.length = 0;
  giftQueue.length = 0;
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
    appBrand: "TIKTOK VRF",
    sidebarBtn: "القائمة والإعدادات",
    sidebarTitle: "TIKTOK VRF — لوحة التحكم",
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
    appBrand: "TIKTOK VRF",
    sidebarBtn: "Menu & Settings",
    sidebarTitle: "TIKTOK VRF — Dashboard",
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
// UI Event Listeners
// ---------------------------------------------------------------------------
DOM.startBtn.addEventListener('click', () => {
  const rawInput = DOM.usernameInput.value.trim();
  if (!rawInput) {
    toast(currentLang === 'ar' ? 'يرجى إدخال اسم مستخدم تيك توك' : 'Please enter a TikTok @username', 'warning');
    DOM.usernameInput.focus();
    return;
  }

  const cleanUser = extractTikTokUsername(rawInput);
  if (!cleanUser) {
    toast(currentLang === 'ar' ? 'يرجى إدخال اسم مستخدم صالح' : 'Please enter a valid TikTok username', 'warning');
    DOM.usernameInput.focus();
    return;
  }

  // Check if user accidentally entered Arabic characters (display name instead of handle)
  if (/[\u0600-\u06FF]/.test(cleanUser)) {
    toast(
      currentLang === 'ar'
        ? '⚠️ تنبيه: يرجى إدخال اسم المعرّف الإنجليزي (المكتوب تحت الصورة الشخصية، مثل kingmauritan) وليس الاسم المعروض بالعربية.'
        : '⚠️ Please enter the English TikTok @username, not the Arabic display name.',
      'error',
      8000
    );
    DOM.usernameInput.focus();
    return;
  }

  // Reflect clean username in the UI input box
  DOM.usernameInput.value = cleanUser;

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

  connectWs(cleanUser);
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
if (DOM.sidebarBackdrop) DOM.sidebarBackdrop.addEventListener('click', closeSidebar);

// Language buttons
if (DOM.langArBtn) DOM.langArBtn.addEventListener('click', () => applyLanguage('ar'));
if (DOM.langEnBtn) DOM.langEnBtn.addEventListener('click', () => applyLanguage('en'));

// Theme buttons
if (DOM.themeDarkBtn) DOM.themeDarkBtn.addEventListener('click', () => applyTheme('dark'));
if (DOM.themeLightBtn) DOM.themeLightBtn.addEventListener('click', () => applyTheme('light'));
if (DOM.themeOledBtn) DOM.themeOledBtn.addEventListener('click', () => applyTheme('oled'));

// ---------------------------------------------------------------------------
// Secret Owner Entry Triggers (الانتقال إلى لوحة التحكم للمالك)
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
      window.location.href = '/admin';
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
    window.location.href = '/admin';
  }
});

// Close sidebar on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeSidebar();
  }
});

// ---------------------------------------------------------------------------
// Live Interactive Demo Mode (وضع المحاكاة التجريبية التفاعلي)
// ---------------------------------------------------------------------------
let isDemoMode = false;
let demoTimer = null;
let demoLikes = 14200;
let demoViewers = 3120;
let demoDiamonds = 5890;
let demoHostScore = 2400;
let demoOppScore = 1850;

const DEMO_USERS = [
  { name: 'محمد السعيد', handle: 'mohamed_saeed', avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&crop=faces' },
  { name: 'سارة الأحمد', handle: 'sara_ahmed', avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop&crop=faces' },
  { name: 'خالد الكويتي VIP', handle: 'khaled_q8', avatar: 'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=100&h=100&fit=crop&crop=faces' },
  { name: 'Fatima Zahra 🇲🇦', handle: 'fz_morocco', avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=100&h=100&fit=crop&crop=faces' },
  { name: 'عمر التميمي 🇸🇦', handle: 'omar_tamimi', avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=faces' },
  { name: 'Al-Anood 💎', handle: 'alanood_vip', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces' },
  { name: 'أبو فهد العتيبي 🦁', handle: 'abu_fahad', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&h=100&fit=crop&crop=faces' },
  { name: 'Jessica Miller', handle: 'jess_live', avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100&h=100&fit=crop&crop=faces' }
];

const DEMO_COMMENTS = [
  'ما شاء الله بث رائع ومميز! 🔥',
  'أقوى دعم لأحلى مضيف 👏❤️',
  'كفوووووو يا وحش استمر 💪',
  'Great stream, keep it up! 🚀',
  'منور البث يا بطل 🌟',
  'شدوا الهمة في الجولة يا شباب ⚔️',
  'تحياتي لك من السعودية 🇸🇦',
  'أحلى تحية ومتابعة من المغرب 🇲🇦',
  'روعة يا غالي متابعك من البداية 👑',
  'تكبييييس يا جماعة لا يوقف التكبيس! 👆❤️',
  'والله تستاهل كل خير 🌹',
  'Awesome PK battle today! ⚡'
];

const DEMO_GIFTS = [
  { name: 'Rose', diamonds: 1, icon: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_rose.png~tplv-obj.png' },
  { name: 'TikTok Heart', diamonds: 5, icon: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_tiktok.png~tplv-obj.png' },
  { name: 'Sunglasses', diamonds: 199, icon: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sunglasses.png~tplv-obj.png' },
  { name: 'Galaxy', diamonds: 1000, icon: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_galaxy.png~tplv-obj.png' },
  { name: 'Fire', diamonds: 10, icon: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_fire.png~tplv-obj.png' },
  { name: 'Lion', diamonds: 29999, icon: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_lion.png~tplv-obj.png' }
];

function startDemoSimulation() {
  if (ws) {
    ws.close(1000, 'starting demo');
    ws = null;
  }
  isDemoMode = true;
  DOM.usernameInput.value = 'demo_live_stream';
  setStatus('online', currentLang === 'ar' ? '🟢 متصل (وضع المحاكاة التجريبية)' : '🟢 Online (Demo Simulation)');
  DOM.startBtn.classList.add('hidden');
  DOM.stopBtn.classList.remove('hidden');
  DOM.roomInfo.classList.remove('hidden');
  DOM.roomIdDisplay.textContent = 'DEMO-778899';

  // Clear feed placeholders
  DOM.commentsFeed.innerHTML = '';
  DOM.giftFeed.innerHTML = '';
  DOM.leaderboardList.innerHTML = '';
  DOM.likersRow.innerHTML = '';
  commentCount = 0;
  giftCount = 0;
  _likersData = {};
  demoDiamonds = 5890;
  demoLikes = 14200;
  demoViewers = 3120;
  demoHostScore = 2400;
  demoOppScore = 1850;

  toast(currentLang === 'ar' ? '🎮 تم تشغيل وضع المحاكاة التجريبية الحية!' : '🎮 Demo simulation mode activated!', 'success');

  // Push an initial set of mock data
  for (let i = 0; i < 3; i++) {
    const user = DEMO_USERS[i % DEMO_USERS.length];
    addComment({
      user: { nickname: user.name, unique_id: user.handle, avatar_url: user.avatar },
      comment: DEMO_COMMENTS[i % DEMO_COMMENTS.length],
      is_moderator: i === 0,
    });
  }

  // Update initial KPIs
  bumpKpi(DOM.kpiViewers, demoViewers);
  bumpKpi(DOM.kpiLikes, demoLikes);
  bumpKpi(DOM.kpiDiamonds, demoDiamonds);
  bumpKpi(DOM.kpiUsd, (demoDiamonds * 0.005).toFixed(2), fmtUsd);
  bumpKpi(DOM.kpiNet, (demoDiamonds * 0.005 * 0.5).toFixed(2), fmtUsd);
  DOM.lbTotalDiamonds.textContent = fmt(demoDiamonds);
  DOM.lbGrossUsd.textContent = fmtUsd(demoDiamonds * 0.005);
  DOM.lbNetUsd.textContent = fmtUsd(demoDiamonds * 0.005 * 0.5);

  let tick = 0;
  clearInterval(demoTimer);
  demoTimer = setInterval(() => {
    if (!isDemoMode) {
      clearInterval(demoTimer);
      return;
    }
    tick++;

    // 1. Likes and viewers bump every tick
    demoLikes += Math.floor(Math.random() * 25) + 10;
    demoViewers += Math.floor(Math.random() * 11) - 5;
    bumpKpi(DOM.kpiLikes, demoLikes);
    bumpKpi(DOM.kpiViewers, Math.max(100, demoViewers));
    if (DOM.kpiLps) DOM.kpiLps.textContent = (Math.random() * 8 + 12).toFixed(1);

    // 2. Incoming comment every ~1.5s
    if (tick % 2 === 0) {
      const u = DEMO_USERS[Math.floor(Math.random() * DEMO_USERS.length)];
      const c = DEMO_COMMENTS[Math.floor(Math.random() * DEMO_COMMENTS.length)];
      addComment({
        user: { nickname: u.name, unique_id: u.handle, avatar_url: u.avatar },
        comment: c,
        is_subscriber: Math.random() > 0.6,
      });
    }

    // 3. Incoming gift every ~3s
    if (tick % 3 === 0) {
      const u = DEMO_USERS[Math.floor(Math.random() * DEMO_USERS.length)];
      const g = DEMO_GIFTS[Math.floor(Math.random() * DEMO_GIFTS.length)];
      const repeat = Math.floor(Math.random() * 5) + 1;
      const addedDiamonds = g.diamonds * repeat;
      demoDiamonds += addedDiamonds;

      addGift({
        user: { nickname: u.name, unique_id: u.handle, avatar_url: u.avatar },
        transaction: {
          gift_name: g.name,
          gift_icon_url: g.icon,
          diamond_unit_cost: g.diamonds,
          repeat_count: repeat,
          total_value: addedDiamonds,
        },
        recipient_side: Math.random() > 0.4 ? 'host' : 'opponent',
        recipient_name: 'المضيف',
      });

      if (g.diamonds >= 100 || repeat >= 5) {
        showComboBurst(g.name, g.icon, repeat);
      }

      // Update diamond KPIs
      bumpKpi(DOM.kpiDiamonds, demoDiamonds);
      bumpKpi(DOM.kpiUsd, (demoDiamonds * 0.005).toFixed(2), fmtUsd);
      bumpKpi(DOM.kpiNet, (demoDiamonds * 0.005 * 0.5).toFixed(2), fmtUsd);
      DOM.lbTotalDiamonds.textContent = fmt(demoDiamonds);
      DOM.lbGrossUsd.textContent = fmtUsd(demoDiamonds * 0.005);
      DOM.lbNetUsd.textContent = fmtUsd(demoDiamonds * 0.005 * 0.5);

      // Update PK points
      if (Math.random() > 0.35) {
        demoHostScore += addedDiamonds;
      } else {
        demoOppScore += addedDiamonds;
      }
      updatePK({
        is_active: true,
        status: 'ACTIVE',
        battle_type: '1v1',
        round: 1,
        host_points: demoHostScore,
        opponent_points: demoOppScore,
      }, 'points_update');
    }

    // 3.5. Incoming hidden supporter gift with unmasking every ~7 ticks
    if (tick % 7 === 0) {
      const isUnmasked = Math.random() > 0.2;
      const addedVal = 10000;
      demoDiamonds += addedVal;
      addGift({
        user: {
          user_id: '8899776655',
          nickname: 'مستخدم TikTok',
          unique_id: '',
          avatar_url: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&crop=faces',
          is_hidden: true,
          is_unmasked: isUnmasked,
          revealed_username: 'algerian_whale',
          revealed_nickname: 'حوت الجزائر 🇩🇿',
        },
        transaction: {
          gift_name: 'Interstellar Galaxy',
          gift_icon_url: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_galaxy.png~tplv-obj.png',
          diamond_unit_cost: 10000,
          repeat_count: 1,
          total_value: addedVal,
        },
        is_hidden: true,
        is_unmasked: isUnmasked,
        revealed_username: 'algerian_whale',
        revealed_nickname: 'حوت الجزائر 🇩🇿',
        recipient_side: 'host',
        recipient_name: 'المضيف',
      });
      bumpKpi(DOM.kpiDiamonds, demoDiamonds);
      bumpKpi(DOM.kpiUsd, (demoDiamonds * 0.005).toFixed(2), fmtUsd);
      bumpKpi(DOM.kpiNet, (demoDiamonds * 0.005 * 0.5).toFixed(2), fmtUsd);
    }

    // 4. Random liker every 4 ticks
    if (tick % 4 === 0) {
      const u = DEMO_USERS[Math.floor(Math.random() * DEMO_USERS.length)];
      updateLiker({
        user_id: u.handle,
        unique_id: u.handle,
        nickname: u.name,
        avatar_url: u.avatar,
        like_count: Math.floor(Math.random() * 50) + 10,
      });
    }
  }, 1000);

  // Auto-start video player in demo mode
  loadDemoVideoStream();
}

function stopDemoSimulation() {
  if (isDemoMode) {
    isDemoMode = false;
    clearInterval(demoTimer);
    demoTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Quick Stream & Demo Triggers
// ---------------------------------------------------------------------------
const btnDemoMode = $('btnDemoMode');
if (btnDemoMode) {
  btnDemoMode.addEventListener('click', startDemoSimulation);
}

document.querySelectorAll('.quick-stream-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const user = btn.getAttribute('data-user');
    if (user) {
      stopDemoSimulation();
      DOM.usernameInput.value = user;
      DOM.startBtn.click();
    }
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
initLiveVideoPlayer();
applyLanguage(currentLang);
applyTheme(currentTheme);
setStatus('idle', I18N[currentLang]?.statusIdle || 'Idle');

// Show admin shortcut in sidebar if authenticated owner from previous session
if (sessionStorage.getItem('tt_admin_token')) {
  if (DOM.adminSidebarSection) DOM.adminSidebarSection.classList.remove('hidden');
}

console.log('🎯 TIKTOK VRF initialized successfully.');

