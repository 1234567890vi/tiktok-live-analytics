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
let hostGiftsCount  = 0;
let oppGiftsCount   = 0;
let currentGiftFilter = 'all';
let isSplitViewActive = false;
let commentCount    = 0;
let comboTimer      = null;
let currentUsername = '';
let lastPkStatus    = 'IDLE';
let lastRoundNum    = 0;
let lastBattleId    = '';

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

// Sound 4: Mythical / Legendary Gift Roar & Fanfare (هزّة وزئير الدعم الأسطوري)
function playLegendaryRoarSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Sub-bass rumble
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sawtooth';
    subOsc.frequency.setValueAtTime(65.4, now); // C2
    subOsc.frequency.exponentialRampToValueAtTime(130.8, now + 0.3);
    subOsc.frequency.exponentialRampToValueAtTime(40, now + 0.9);
    subGain.gain.setValueAtTime(0.001, now);
    subGain.gain.exponentialRampToValueAtTime(0.32, now + 0.05);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.95);
    subOsc.connect(subGain);
    subGain.connect(ctx.destination);
    subOsc.start(now);
    subOsc.stop(now + 1.0);

    // Triumphant chord blast (Major triad + octave)
    const chord = [261.63, 329.63, 392.00, 523.25, 659.25];
    chord.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, now + 0.12 + (idx * 0.05));
      gain.gain.setValueAtTime(0.001, now + 0.12 + (idx * 0.05));
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.16 + (idx * 0.05));
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8 + (idx * 0.05));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + 0.12 + (idx * 0.05));
      osc.stop(now + 0.85 + (idx * 0.05));
    });
  } catch (err) {
    console.debug('[Audio] Legendary roar error:', err);
  }
}

// Sound 5: Coin Burst / Shimmering Chime (تساقط النقود والألماس)
function playCoinShowerSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const pitches = [1318.51, 1567.98, 1760.00, 2093.00, 2637.02];
    for (let i = 0; i < 4; i++) {
      const p = pitches[Math.floor(Math.random() * pitches.length)];
      const delay = i * 0.04;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(p, now + delay);
      gain.gain.setValueAtTime(0.001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.09, now + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.2);
    }
  } catch (err) {
    console.debug('[Audio] Coin sound error:', err);
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
  pkSection:         $('pkSection'),
  pkBattleType:      $('pkBattleType'),
  pkStatusBadge:     $('pkStatusBadge'),
  pkRoundTimerBadge: $('pkRoundTimerBadge'),
  pkRoundTimerIcon:  $('pkRoundTimerIcon'),
  pkRoundTimerPhase: $('pkRoundTimerPhase'),
  pkRoundTimerText:  $('pkRoundTimerText'),
  pkRoundTimerBar:   $('pkRoundTimerBar'),
  pkRoundNum:        $('pkRoundNum'),
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
  pkHostGiftsFeed:  $('pkHostGiftsFeed'),
  pkOppGiftsFeed:   $('pkOppGiftsFeed'),
  pkHostGiftCount:  $('pkHostGiftCount'),
  pkOppGiftCount:   $('pkOppGiftCount'),
  pkHostLastGift:   $('pkHostLastGift'),
  pkOppLastGift:    $('pkOppLastGift'),

  // Feeds & Gift Separation
  commentsFeed:        $('commentsFeed'),
  giftFeed:            $('giftFeed'),
  giftSplitContainer:  $('giftSplitContainer'),
  giftFeedHost:        $('giftFeedHost'),
  giftFeedOpp:         $('giftFeedOpp'),
  hostGiftCountBadge:  $('hostGiftCountBadge'),
  oppGiftCountBadge:   $('oppGiftCountBadge'),
  hostGiftsNum:        $('hostGiftsNum'),
  oppGiftsNum:         $('oppGiftsNum'),
  splitHostGiftsCount: $('splitHostGiftsCount'),
  splitOppGiftsCount:  $('splitOppGiftsCount'),
  giftFilterBtnAll:    $('giftFilterBtnAll'),
  giftFilterBtnHost:   $('giftFilterBtnHost'),
  giftFilterBtnOpp:    $('giftFilterBtnOpp'),
  badgeFilterAll:      $('badgeFilterAll'),
  badgeFilterHost:     $('badgeFilterHost'),
  badgeFilterOpp:      $('badgeFilterOpp'),
  btnToggleSplitView:  $('btnToggleSplitView'),
  splitViewIcon:       $('splitViewIcon'),
  splitViewText:       $('splitViewText'),
  leaderboardList:     $('leaderboardList'),
  likersRow:           $('likersRow'),
  liveFriendsSection:    $('liveFriendsSection'),
  liveFriendsGrid:       $('liveFriendsGrid'),
  liveFriendsCountBadge: $('liveFriendsCountBadge'),
  refreshFriendsBtn:     $('refreshFriendsBtn'),
  addFriendInput:        $('addFriendInput'),
  addFriendBtn:          $('addFriendBtn'),
  commentCount:        $('commentCount'),
  giftCount:           $('giftCount'),
  toggleScrollBtn:     $('toggleScrollBtn'),
  scrollIcon:          $('scrollIcon'),

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
  btnTogglePlayerMode:    $('btnTogglePlayerMode'),
  playerModeIcon:         $('playerModeIcon'),
  playerModeText:         $('playerModeText'),
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

  // Authentic Gift Visual Effects & Theatrical Modal
  giftFxCanvas:          $('giftFxCanvas'),
  legendaryGiftModal:    $('legendaryGiftModal'),
  legendaryGiftImg:      $('legendaryGiftImg'),
  legendaryComboBadge:   $('legendaryComboBadge'),
  legendaryUserAvatar:   $('legendaryUserAvatar'),
  legendaryUserName:     $('legendaryUserName'),
  legendaryUserHandle:   $('legendaryUserHandle'),
  legendaryGiftName:     $('legendaryGiftName'),
  legendaryGiftDiamonds: $('legendaryGiftDiamonds'),
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
    const fragHost = DOM.giftFeedHost ? document.createDocumentFragment() : null;
    const fragOpp  = DOM.giftFeedOpp  ? document.createDocumentFragment() : null;

    const batch = giftQueue.splice(0, giftQueue.length);
    // Reverse batch so newest gift ends up at the top
    for (let i = batch.length - 1; i >= 0; i--) {
      const item = batch[i];
      const card = createGiftNode(item);
      frag.appendChild(card);

      const side = item.recipient_side || 'host';
      if (side === 'opponent') {
        if (fragOpp) fragOpp.appendChild(card.cloneNode(true));
      } else {
        if (fragHost) fragHost.appendChild(card.cloneNode(true));
      }
    }
    DOM.giftFeed.prepend(frag);

    if (fragHost && fragHost.childNodes.length > 0 && DOM.giftFeedHost) {
      clearPlaceholder(DOM.giftFeedHost, '.text-gray-400');
      DOM.giftFeedHost.prepend(fragHost);
      while (DOM.giftFeedHost.children.length > MAX_GIFTS) {
        DOM.giftFeedHost.removeChild(DOM.giftFeedHost.lastChild);
      }
    }

    if (fragOpp && fragOpp.childNodes.length > 0 && DOM.giftFeedOpp) {
      clearPlaceholder(DOM.giftFeedOpp, '.text-gray-400');
      DOM.giftFeedOpp.prepend(fragOpp);
      while (DOM.giftFeedOpp.children.length > MAX_GIFTS) {
        DOM.giftFeedOpp.removeChild(DOM.giftFeedOpp.lastChild);
      }
    }

    // Prune oldest gifts from bottom in single pass
    while (DOM.giftFeed.children.length > MAX_GIFTS) {
      DOM.giftFeed.removeChild(DOM.giftFeed.lastChild);
    }
    DOM.giftCount.textContent = `${fmt(giftCount)} gifts`;
  }
}

// ---------------------------------------------------------------------------
// Verified High-Definition TikTok Gift Image Assets & 3D Renders Catalog
// ---------------------------------------------------------------------------
const TIKTOK_GIFT_ASSETS = {
  // Legendary & Mythic (20,000+ Diamonds)
  'lion': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_lion.png~tplv-obj.png',
  'أسد': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_lion.png~tplv-obj.png',
  'tiktok universe': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_universe.png~tplv-obj.png',
  'universe': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_universe.png~tplv-obj.png',
  'عالم تيك توك': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_universe.png~tplv-obj.png',
  'كون تيك توك': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_universe.png~tplv-obj.png',
  'يونيفيرس': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_universe.png~tplv-obj.png',
  'falcon': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_falcon.png~tplv-obj.png',
  'صقر': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_falcon.png~tplv-obj.png',
  'dragon': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_dragon.png~tplv-obj.png',
  'تنين': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_dragon.png~tplv-obj.png',
  'phoenix': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_dragon.png~tplv-obj.png',
  'عنقاء': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_dragon.png~tplv-obj.png',
  'pegasus': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_pegasus.png~tplv-obj.png',
  'بيغاسوس': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_pegasus.png~tplv-obj.png',
  'castle': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_castle.png~tplv-obj.png',
  'قلعة': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_castle.png~tplv-obj.png',

  // Mega & Big Gifts (1,000 - 19,999 Diamonds)
  'sports car': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sports_car.png~tplv-obj.png',
  'car': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sports_car.png~tplv-obj.png',
  'سيارة رياضية': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sports_car.png~tplv-obj.png',
  'سيارة': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sports_car.png~tplv-obj.png',
  'yacht': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_yacht.png~tplv-obj.png',
  'luxury yacht': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_yacht.png~tplv-obj.png',
  'يخت': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_yacht.png~tplv-obj.png',
  'interstellar galaxy': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_galaxy.png~tplv-obj.png',
  'interstellar': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_galaxy.png~tplv-obj.png',
  'galaxy': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_galaxy.png~tplv-obj.png',
  'مجرة': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_galaxy.png~tplv-obj.png',
  'فضاء': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_galaxy.png~tplv-obj.png',
  'غالاكسي': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_galaxy.png~tplv-obj.png',
  'private jet': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_jet.png~tplv-obj.png',
  'jet': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_jet.png~tplv-obj.png',
  'طائرة خاصة': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_jet.png~tplv-obj.png',
  'طائرة': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_jet.png~tplv-obj.png',
  'diving whale': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_whale.png~tplv-obj.png',
  'whale': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_whale.png~tplv-obj.png',
  'حوت': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_whale.png~tplv-obj.png',
  'fireworks': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_fireworks.png~tplv-obj.png',
  'ألعاب نارية': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_fireworks.png~tplv-obj.png',
  'ferris wheel': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_ferris_wheel.png~tplv-obj.png',
  'عجلة الملاهي': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_ferris_wheel.png~tplv-obj.png',

  // Medium Gifts (100 - 999 Diamonds)
  'sunglasses': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sunglasses.png~tplv-obj.png',
  'glasses': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sunglasses.png~tplv-obj.png',
  'نظارات شمسية': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sunglasses.png~tplv-obj.png',
  'نظارات': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_sunglasses.png~tplv-obj.png',
  'boxing gloves': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_boxing_gloves.png~tplv-obj.png',
  'قفازات ملاكمة': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_boxing_gloves.png~tplv-obj.png',
  'confetti': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_confetti.png~tplv-obj.png',
  'احتفال': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_confetti.png~tplv-obj.png',
  'crown': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_crown.png~tplv-obj.png',
  'تاج': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_crown.png~tplv-obj.png',
  'perfume': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_perfume.png~tplv-obj.png',
  'عطر': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_perfume.png~tplv-obj.png',
  'doughnut': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_doughnut.png~tplv-obj.png',
  'donut': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_doughnut.png~tplv-obj.png',
  'دونات': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_doughnut.png~tplv-obj.png',

  // Standard Popular Gifts (1 - 99 Diamonds)
  'rose': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_rose.png~tplv-obj.png',
  'وردة': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_rose.png~tplv-obj.png',
  'ورده': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_rose.png~tplv-obj.png',
  'tiktok': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_tiktok.png~tplv-obj.png',
  'تيك توك': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_tiktok.png~tplv-obj.png',
  'heart me': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_tiktok.png~tplv-obj.png',
  'heart': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_tiktok.png~tplv-obj.png',
  'قلب': 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_tiktok.png~tplv-obj.png',
};

function getGiftAsset(name, fallbackUrl) {
  if (fallbackUrl && typeof fallbackUrl === 'string' && fallbackUrl.startsWith('http')) {
    return fallbackUrl;
  }
  const clean = String(name || '').toLowerCase().trim();
  if (TIKTOK_GIFT_ASSETS[clean]) {
    return TIKTOK_GIFT_ASSETS[clean];
  }
  for (const [k, v] of Object.entries(TIKTOK_GIFT_ASSETS)) {
    if (clean.includes(k) || k.includes(clean)) {
      return v;
    }
  }
  return 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_rose.png~tplv-obj.png';
}

// ---------------------------------------------------------------------------
// Full-Screen Canvas Visual FX Engine (Particle bursts, coins, confetti & gifts)
// ---------------------------------------------------------------------------
const GiftFxEngine = {
  canvas: null,
  ctx: null,
  particles: [],
  animId: null,
  width: window.innerWidth,
  height: window.innerHeight,

  init() {
    this.canvas = DOM.giftFxCanvas;
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.resize();
    window.addEventListener('resize', () => this.resize(), { passive: true });
  },

  resize() {
    if (!this.canvas) return;
    this.width = this.canvas.width = window.innerWidth;
    this.height = this.canvas.height = window.innerHeight;
  },

  startLoop() {
    if (this.animId) return;
    this.animId = requestAnimationFrame(this.loop.bind(this));
  },

  loop() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity || 0.18;
      p.rotation = (p.rotation || 0) + (p.rotSpeed || 0.05);
      p.life -= p.decay || 0.015;

      if (p.life <= 0 || p.y > this.height + 50) {
        this.particles.splice(i, 1);
        continue;
      }

      this.ctx.save();
      this.ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate(p.rotation);

      if (p.type === 'coin') {
        this.ctx.fillStyle = '#f59e0b';
        this.ctx.beginPath();
        const spinW = Math.max(2, Math.abs(Math.cos(p.rotation) * p.size));
        this.ctx.ellipse(0, 0, spinW, p.size, 0, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.strokeStyle = '#fef08a';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
      } else if (p.type === 'confetti') {
        this.ctx.fillStyle = p.color;
        this.ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      this.ctx.restore();
    }

    if (this.particles.length > 0) {
      this.animId = requestAnimationFrame(this.loop.bind(this));
    } else {
      this.animId = null;
    }
  },

  spawnCoins(count = 15, x = null, y = null, side = null) {
    let originX = x;
    if (originX === null) {
      if (side === 'opponent') {
        originX = this.width * 0.72;
      } else if (side === 'host') {
        originX = this.width * 0.28;
      } else {
        originX = this.width / 2;
      }
    }
    const originY = y !== null ? y : this.height * 0.75;
    playCoinShowerSound();

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 1.5) + (Math.random() - 0.5) * 1.2;
      const speed = Math.random() * 9 + 6;
      this.particles.push({
        type: 'coin',
        x: originX + (Math.random() - 0.5) * 40,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 0.35,
        size: Math.random() * 4 + 7,
        rotation: Math.random() * Math.PI,
        rotSpeed: (Math.random() - 0.5) * 0.3,
        life: 1.0,
        decay: Math.random() * 0.01 + 0.012,
      });
    }
    this.startLoop();
  },

  spawnConfetti(count = 35) {
    const colors = ['#f43f5e', '#ec4899', '#a855f7', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#fbbf24'];
    for (let i = 0; i < count; i++) {
      this.particles.push({
        type: 'confetti',
        x: Math.random() * this.width,
        y: -10,
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 3 + 2,
        gravity: 0.05,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: Math.random() * 6 + 6,
        rotation: Math.random() * Math.PI,
        rotSpeed: (Math.random() - 0.5) * 0.15,
        life: 1.0,
        decay: 0.007,
      });
    }
    this.startLoop();
  },

  triggerScreenShake() {
    document.body.classList.remove('screen-rumble');
    void document.body.offsetWidth;
    document.body.classList.add('screen-rumble');
    setTimeout(() => document.body.classList.remove('screen-rumble'), 400);
  },

  spawnFloatingGift(imgUrl, combo = 1, side = 'host') {
    try {
      const floater = document.createElement('div');
      floater.className = 'fixed pointer-events-none z-[85] flex items-center gap-1.5 transition-all';

      let leftPct;
      let borderClass = '';
      if (side === 'opponent') {
        leftPct = Math.random() * 25 + 62;
        borderClass = 'floating-gift-opponent border-red-500/80 shadow-[0_0_20px_rgba(239,68,68,0.7)]';
      } else if (side === 'host') {
        leftPct = Math.random() * 25 + 10;
        borderClass = 'floating-gift-host border-blue-500/80 shadow-[0_0_20px_rgba(59,130,246,0.7)]';
      } else {
        leftPct = Math.random() * 40 + 30;
        borderClass = 'border-yellow-400/60 shadow-[0_0_20px_rgba(251,191,36,0.7)]';
      }

      floater.style.left = `${leftPct}%`;
      floater.style.bottom = '15%';
      floater.style.animation = 'fly-gift-up 1.8s cubic-bezier(0.22, 1, 0.36, 1) forwards';
      floater.innerHTML = `
        <div class="relative flex items-center justify-center p-1.5 rounded-2xl bg-black/80 border ${borderClass} backdrop-blur-sm">
          <img src="${imgUrl}" style="width:52px;height:52px;object-fit:contain;" alt="Gift" />
          ${combo > 1 ? `<span class="absolute -top-2 -right-2 px-2 py-0.5 rounded-full ${side === 'opponent' ? 'bg-gradient-to-r from-red-600 to-rose-600' : 'bg-gradient-to-r from-blue-600 to-cyan-600'} text-white font-black text-xs border border-white/60 shadow-md">x${combo}</span>` : ''}
        </div>
      `;
      document.body.appendChild(floater);
      setTimeout(() => floater.remove(), 1900);
    } catch (_) {}
  }
};

// ---------------------------------------------------------------------------
// Authentic Theatrical Legendary Gift Modal (Full-Screen VIP Takeover)
// ---------------------------------------------------------------------------
let legendaryTimer = null;
function showLegendaryGiftModal(supporter, giftName, diamonds, combo, iconUrl) {
  if (!DOM.legendaryGiftModal) return;
  if (legendaryTimer) clearTimeout(legendaryTimer);

  const realImg = getGiftAsset(giftName, iconUrl);
  if (DOM.legendaryGiftImg) DOM.legendaryGiftImg.src = realImg;
  if (DOM.legendaryGiftName) DOM.legendaryGiftName.textContent = giftName;
  if (DOM.legendaryGiftDiamonds) DOM.legendaryGiftDiamonds.textContent = fmt(diamonds);
  if (DOM.legendaryComboBadge) DOM.legendaryComboBadge.textContent = `x${combo || 1}`;

  const avUrl = supporter?.avatar_url || supporter?.avatar || 'https://placehold.co/100x100/111827/white?text=VIP';
  if (DOM.legendaryUserAvatar) DOM.legendaryUserAvatar.src = avUrl;
  if (DOM.legendaryUserName) DOM.legendaryUserName.textContent = supporter?.nickname || supporter?.name || supporter?.unique_id || 'داعم أسطوري';
  if (DOM.legendaryUserHandle) DOM.legendaryUserHandle.textContent = supporter?.unique_id || supporter?.handle ? `@${supporter.unique_id || supporter.handle}` : '';

  // Sounds & Effects
  playLegendaryRoarSound();
  playBigGiftSound();
  GiftFxEngine.triggerScreenShake();
  GiftFxEngine.spawnCoins(35);
  GiftFxEngine.spawnConfetti(75);

  DOM.legendaryGiftModal.classList.remove('hidden');

  legendaryTimer = setTimeout(() => {
    DOM.legendaryGiftModal.classList.add('hidden');
    legendaryTimer = null;
  }, 3800);
}

// ---------------------------------------------------------------------------
// PK Battle Round Countdown Timer Engine (عداد وقت الجولة التفاعلي)
// ---------------------------------------------------------------------------
let pkTimerInterval = null;
let pkTimerEndTimestamp = 0;
let pkTimerTotalSeconds = 300;
let pkTimerPhase = 'BATTLE'; // 'BATTLE' | 'PUNISH' | 'ENDED'

function startPkCountdown(seconds, phase = 'BATTLE', totalSec = 300, exactEndMs = 0) {
  if (pkTimerInterval) clearInterval(pkTimerInterval);
  pkTimerTotalSeconds = totalSec > 0 ? totalSec : (seconds > 0 ? seconds : 300);
  pkTimerEndTimestamp = exactEndMs > 0 ? exactEndMs : (Date.now() + (seconds * 1000));
  pkTimerPhase = phase;

  if (DOM.pkRoundTimerBadge) {
    DOM.pkRoundTimerBadge.classList.remove('hidden');
  }
  updatePkTimerDisplay();
  pkTimerInterval = setInterval(updatePkTimerDisplay, 1000);
}

function updatePkTimerDisplay() {
  const now = Date.now();
  const remainingMs = Math.max(0, pkTimerEndTimestamp - now);
  const remainingSec = Math.ceil(remainingMs / 1000);

  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  if (DOM.pkRoundTimerText) {
    DOM.pkRoundTimerText.textContent = formatted;
  }

  const pct = Math.max(0, Math.min(100, Math.round((remainingSec / pkTimerTotalSeconds) * 100)));
  if (DOM.pkRoundTimerBar) {
    DOM.pkRoundTimerBar.style.width = `${pct}%`;
  }

  if (DOM.pkRoundTimerPhase) {
    if (pkTimerPhase === 'PUNISH') {
      DOM.pkRoundTimerPhase.textContent = currentLang === 'ar' ? 'وقت الحكم:' : 'Punish Time:';
      if (DOM.pkRoundTimerIcon) DOM.pkRoundTimerIcon.textContent = '⏱️';
    } else {
      const durMin = Math.round(pkTimerTotalSeconds / 60);
      if (currentLang === 'ar') {
        DOM.pkRoundTimerPhase.textContent = durMin > 0 ? `وقت الجولة (${durMin}د):` : 'وقت الجولة:';
      } else {
        DOM.pkRoundTimerPhase.textContent = durMin > 0 ? `Round (${durMin}m):` : 'Round Time:';
      }
      if (DOM.pkRoundTimerIcon) DOM.pkRoundTimerIcon.textContent = remainingSec <= 15 ? '🔥' : '⏳';
    }
  }

  // Dynamic Color Classes
  if (DOM.pkRoundTimerBadge) {
    DOM.pkRoundTimerBadge.classList.remove('timer-normal', 'timer-warning', 'timer-urgent', 'timer-punish', 'timer-ended');
    if (pkTimerPhase === 'PUNISH') {
      DOM.pkRoundTimerBadge.classList.add('timer-punish');
    } else if (remainingSec <= 15 && remainingSec > 0) {
      DOM.pkRoundTimerBadge.classList.add('timer-urgent');
    } else if (remainingSec <= 60 && remainingSec > 15) {
      DOM.pkRoundTimerBadge.classList.add('timer-warning');
    } else if (remainingSec > 60) {
      DOM.pkRoundTimerBadge.classList.add('timer-normal');
    } else {
      DOM.pkRoundTimerBadge.classList.add('timer-ended');
    }
  }

  // 15-second warning alert
  if (remainingSec === 15 && pkTimerPhase === 'BATTLE') {
    toast(
      currentLang === 'ar'
        ? '🔥 آخر 15 ثانية في الجولة! احشدوا الدعم والتكبيس الآن! ⚡'
        : '🔥 Final 15 seconds in the round! Send gifts & tap fast! ⚡',
      'warning',
      4000
    );
  }

  if (remainingSec <= 0) {
    if (pkTimerInterval) {
      clearInterval(pkTimerInterval);
      pkTimerInterval = null;
    }
    if (DOM.pkRoundTimerText) {
      DOM.pkRoundTimerText.textContent = '00:00';
    }
  }
}

function stopPkCountdown(state = 'ENDED') {
  if (pkTimerInterval) {
    clearInterval(pkTimerInterval);
    pkTimerInterval = null;
  }
  if (state === 'IDLE') {
    if (DOM.pkRoundTimerBadge) DOM.pkRoundTimerBadge.classList.add('hidden');
  } else {
    if (DOM.pkRoundTimerBadge) {
      DOM.pkRoundTimerBadge.classList.remove('hidden', 'timer-normal', 'timer-warning', 'timer-urgent', 'timer-punish');
      DOM.pkRoundTimerBadge.classList.add('timer-ended');
    }
    if (DOM.pkRoundTimerText) DOM.pkRoundTimerText.textContent = '00:00';
    if (DOM.pkRoundTimerPhase) DOM.pkRoundTimerPhase.textContent = 'انتهت الجولة';
    if (DOM.pkRoundTimerBar) DOM.pkRoundTimerBar.style.width = '0%';
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

  const recipientSide = data.recipient_side || (data.is_battle_gift ? 'host' : 'host');

  const card = document.createElement('div');
  card.className = `gift-card${isStreak ? ' streak-active' : ''}${totalComboDiamonds >= 1000 || unitDiamonds >= 1000 ? ' vip-gift' : ''} ${recipientSide === 'opponent' ? 'side-opponent' : 'side-host'}`;
  card.dataset.userKey = String(user.user_id || user.unique_id || '');
  card.dataset.giftKey = String(txn.gift_id || giftName || '');
  card.dataset.streakActive = isStreak ? '1' : '0';
  card.dataset.recipientSide = recipientSide;

  // 1. Supporter Avatar
  const avDiv = document.createElement('div');
  avDiv.style.cssText = 'position:relative;flex-shrink:0;';
  const userAv = avatarEl(user.avatar_url, user.nickname, 'comment-avatar');
  userAv.style.cssText = 'width:38px;height:38px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.25);';
  avDiv.appendChild(userAv);

  // 2. Real High-Resolution Gift Image (عرض الصورة الحقيقية للهدية)
  const resolvedGiftIcon = getGiftAsset(giftName, iconUrl);
  const giftImgDiv = document.createElement('div');
  giftImgDiv.className = 'gift-icon flex-shrink-0 flex items-center justify-center';
  const realGiftImg = document.createElement('img');
  realGiftImg.className = 'gift-card-real-img';
  realGiftImg.src = resolvedGiftIcon;
  realGiftImg.alt = giftName;
  realGiftImg.loading = 'lazy';
  realGiftImg.onerror = () => {
    realGiftImg.src = 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_rose.png~tplv-obj.png';
  };
  giftImgDiv.appendChild(realGiftImg);

  // 3. Info block
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
  nameLine.className   = 'gift-name font-bold text-white';
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

  // 4. Combo counter
  const comboDiv = document.createElement('div');
  comboDiv.className   = 'gift-combo';
  comboDiv.textContent = `x${combo}`;

  card.append(avDiv, giftImgDiv, info, comboDiv);
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
// PK Arena Mini Gift Stream Pill Helper (عرض مصغر للهدايا داخل ساحة الجولة)
// ---------------------------------------------------------------------------
function addMiniPkGift(side, data) {
  const container = (side === 'opponent') ? DOM.pkOppGiftsFeed : DOM.pkHostGiftsFeed;
  if (!container) return;
  clearPlaceholder(container, '.text-gray-500');

  const txn = data.transaction || {};
  const user = data.user || {};
  const giftName = txn.gift_name || 'Gift';
  const iconUrl = txn.gift_icon_url || '';
  const combo = data.repeat_count || txn.repeat_count || 1;
  const unitDiamonds = (data.diamond_unit_cost !== undefined && data.diamond_unit_cost !== null)
    ? data.diamond_unit_cost
    : (txn.diamond_unit_cost || 1);
  const totalVal = (data.combo_diamonds !== undefined && data.combo_diamonds !== null)
    ? data.combo_diamonds
    : (unitDiamonds * combo);
  const resolvedIcon = getGiftAsset(giftName, iconUrl);

  const pill = document.createElement('div');
  pill.className = `mini-pk-gift-pill ${side === 'opponent' ? 'opp' : 'host'}`;
  pill.innerHTML = `
    <img src="${resolvedIcon}" class="w-6 h-6 object-contain flex-shrink-0" alt="${giftName}" onerror="this.src='https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_rose.png~tplv-obj.png'" />
    <div class="flex flex-col min-w-0 leading-tight">
      <div class="flex items-center gap-1">
        <span class="text-[11px] font-bold text-white truncate max-w-[70px]">${giftName}</span>
        ${combo > 1 ? `<span class="text-[10px] font-black ${side === 'opponent' ? 'text-red-300' : 'text-blue-300'} font-mono">x${combo}</span>` : ''}
      </div>
      <span class="text-[9px] text-gray-400 font-mono truncate max-w-[70px]">@${user.unique_id || user.nickname || 'anon'}</span>
    </div>
    <span class="text-[10px] font-extrabold ${side === 'opponent' ? 'text-amber-400' : 'text-cyan-300'} font-mono mr-auto">💎${fmt(totalVal)}</span>
  `;

  container.prepend(pill);
  while (container.children.length > 8) {
    container.removeChild(container.lastChild);
  }
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

  // Recipient side tracking & separate team counters
  const recipientSide = data.recipient_side || (data.is_battle_gift ? 'host' : 'host');

  if (recipientSide === 'opponent') {
    oppGiftsCount++;
    if (DOM.oppGiftsNum) DOM.oppGiftsNum.textContent = fmt(oppGiftsCount);
    if (DOM.badgeFilterOpp) DOM.badgeFilterOpp.textContent = fmt(oppGiftsCount);
    if (DOM.splitOppGiftsCount) DOM.splitOppGiftsCount.textContent = fmt(oppGiftsCount);
    if (DOM.pkOppGiftCount) DOM.pkOppGiftCount.textContent = fmt(oppGiftsCount);
    if (DOM.pkOppLastGift) DOM.pkOppLastGift.textContent = `${giftName} x${combo} (@${user.unique_id || user.nickname || 'الخصم'})`;
    addMiniPkGift('opponent', data);
  } else {
    hostGiftsCount++;
    if (DOM.hostGiftsNum) DOM.hostGiftsNum.textContent = fmt(hostGiftsCount);
    if (DOM.badgeFilterHost) DOM.badgeFilterHost.textContent = fmt(hostGiftsCount);
    if (DOM.splitHostGiftsCount) DOM.splitHostGiftsCount.textContent = fmt(hostGiftsCount);
    if (DOM.pkHostGiftCount) DOM.pkHostGiftCount.textContent = fmt(hostGiftsCount);
    if (DOM.pkHostLastGift) DOM.pkHostLastGift.textContent = `${giftName} x${combo} (@${user.unique_id || user.nickname || 'فريقنا'})`;
    addMiniPkGift('host', data);
  }
  if (DOM.badgeFilterAll) DOM.badgeFilterAll.textContent = fmt(giftCount);

  // VIP sound chime for legendary gifts (>= 1000 diamonds)
  const resolvedIcon = getGiftAsset(giftName, iconUrl);

  try {
    // 1. Floating real gift animation upward on screen (with team directional positioning and glow)
    GiftFxEngine.spawnFloatingGift(resolvedIcon, combo, recipientSide);

    // 2. Multi-tier visual effects
    if (totalComboDiamonds >= 5000 || unitDiamonds >= 5000) {
      showLegendaryGiftModal(user, giftName, totalComboDiamonds, combo, resolvedIcon);
    } else if (totalComboDiamonds >= 1000 || unitDiamonds >= 1000) {
      playBigGiftSound();
      GiftFxEngine.spawnCoins(24, null, null, recipientSide);
      GiftFxEngine.spawnConfetti(45);
      GiftFxEngine.triggerScreenShake();
    } else if (totalComboDiamonds >= 100 || unitDiamonds >= 100) {
      GiftFxEngine.spawnCoins(10, null, null, recipientSide);
    }
  } catch (fxErr) {
    console.debug('[GiftFX] error:', fxErr);
  }

  // Show combo burst popup for streaks >= 5
  if (combo >= 5) showComboBurst(giftName, resolvedIcon, combo);

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

    // In-place upgrade on split stream top card as well
    const splitContainer = (recipientSide === 'opponent') ? DOM.giftFeedOpp : DOM.giftFeedHost;
    const topSplitCard = splitContainer ? splitContainer.firstElementChild : null;
    if (topSplitCard && topSplitCard.dataset && topSplitCard.dataset.userKey === userKey && topSplitCard.dataset.giftKey === giftKey) {
      topSplitCard.dataset.streakActive = isStreak ? '1' : '0';
      const cDiv = topSplitCard.querySelector('.gift-combo');
      if (cDiv) {
        cDiv.textContent = `x${combo}`;
        cDiv.classList.remove('combo-bounce');
        void cDiv.offsetWidth;
        cDiv.classList.add('combo-bounce');
      }
      const dLine = topSplitCard.querySelector('.gift-details');
      if (dLine) {
        dLine.innerHTML = `
          <span class="gift-unit-pill" title="سعر الهدية الواحدة">💎 ${fmt(unitDiamonds)}</span>
          ${combo > 1 ? `<span class="gift-total-pill" title="إجمالي الكومبو">المجموع: 💎 ${fmt(totalComboDiamonds)}</span>` : ''}
          <span class="gift-usd-pill" title="القيمة التقريبية بالدولار">≈ $${usdEst}</span>
        `;
      }
      if (totalComboDiamonds >= 1000 || unitDiamonds >= 1000) {
        topSplitCard.classList.add('vip-gift');
      }
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
// Gift Feed Filter & Dual Split View Controls (التحكم بفلترة وتقسيم الهدايا)
// ---------------------------------------------------------------------------
function setGiftFilter(side) {
  currentGiftFilter = side;

  // Reset tab active styling
  if (DOM.giftFilterBtnAll) DOM.giftFilterBtnAll.className = 'gift-filter-tab px-2.5 py-1 rounded-lg border transition-all text-gray-400 border-transparent hover:border-gray-700 hover:bg-gray-800/40 flex items-center gap-1';
  if (DOM.giftFilterBtnHost) DOM.giftFilterBtnHost.className = 'gift-filter-tab px-2.5 py-1 rounded-lg border transition-all text-blue-300 border-transparent hover:border-blue-500/40 hover:bg-blue-950/40 flex items-center gap-1';
  if (DOM.giftFilterBtnOpp) DOM.giftFilterBtnOpp.className = 'gift-filter-tab px-2.5 py-1 rounded-lg border transition-all text-red-300 border-transparent hover:border-red-500/40 hover:bg-red-950/40 flex items-center gap-1';

  if (side === 'host') {
    if (DOM.giftFilterBtnHost) DOM.giftFilterBtnHost.className = 'gift-filter-tab active tab-host px-2.5 py-1 rounded-lg border transition-all text-blue-200 border-blue-500/60 bg-blue-950/60 flex items-center gap-1';
    if (DOM.giftFeed) {
      DOM.giftFeed.classList.add('filter-host');
      DOM.giftFeed.classList.remove('filter-opponent');
    }
  } else if (side === 'opponent') {
    if (DOM.giftFilterBtnOpp) DOM.giftFilterBtnOpp.className = 'gift-filter-tab active tab-opp px-2.5 py-1 rounded-lg border transition-all text-red-200 border-red-500/60 bg-red-950/60 flex items-center gap-1';
    if (DOM.giftFeed) {
      DOM.giftFeed.classList.add('filter-opponent');
      DOM.giftFeed.classList.remove('filter-host');
    }
  } else {
    if (DOM.giftFilterBtnAll) DOM.giftFilterBtnAll.className = 'gift-filter-tab active px-2.5 py-1 rounded-lg border transition-all text-gray-200 border-yellow-500/50 bg-yellow-500/10 flex items-center gap-1';
    if (DOM.giftFeed) {
      DOM.giftFeed.classList.remove('filter-host', 'filter-opponent');
    }
  }

  // Smooth fade transition on filter change
  if (DOM.giftFeed) {
    DOM.giftFeed.classList.remove('tab-fade-enter');
    void DOM.giftFeed.offsetWidth;
    DOM.giftFeed.classList.add('tab-fade-enter');
  }

  // If in split view and user clicks a filter tab, switch back to unified feed to show the filtered view
  if (isSplitViewActive) {
    toggleSplitView(false);
  }
}

function toggleSplitView(forceState = null) {
  isSplitViewActive = (forceState !== null) ? forceState : !isSplitViewActive;

  if (isSplitViewActive) {
    if (DOM.giftFeed) DOM.giftFeed.classList.add('hidden');
    if (DOM.giftSplitContainer) {
      DOM.giftSplitContainer.classList.remove('hidden');
      DOM.giftSplitContainer.classList.remove('tab-fade-enter');
      void DOM.giftSplitContainer.offsetWidth;
      DOM.giftSplitContainer.classList.add('tab-fade-enter');
    }
    if (DOM.splitViewIcon) DOM.splitViewIcon.textContent = '🔄';
    if (DOM.splitViewText) DOM.splitViewText.textContent = (currentLang === 'ar' ? 'عرض موحد' : 'Unified View');
    if (DOM.btnToggleSplitView) {
      DOM.btnToggleSplitView.classList.add('border-indigo-500/70', 'bg-indigo-950/70', 'text-indigo-200');
      DOM.btnToggleSplitView.classList.remove('bg-gray-800/80', 'border-gray-700');
    }

    // Populate split view from existing giftFeed cards if feeds are empty
    if (DOM.giftFeedHost && DOM.giftFeedOpp && DOM.giftFeed) {
      const cards = Array.from(DOM.giftFeed.querySelectorAll('.gift-card'));
      if (cards.length > 0 && DOM.giftFeedHost.querySelectorAll('.gift-card').length === 0) {
        clearPlaceholder(DOM.giftFeedHost, '.text-gray-400');
        clearPlaceholder(DOM.giftFeedOpp, '.text-gray-400');
        cards.forEach(card => {
          const s = card.dataset.recipientSide;
          if (s === 'opponent') {
            DOM.giftFeedOpp.appendChild(card.cloneNode(true));
          } else {
            DOM.giftFeedHost.appendChild(card.cloneNode(true));
          }
        });
      }
    }
  } else {
    if (DOM.giftFeed) {
      DOM.giftFeed.classList.remove('hidden');
      DOM.giftFeed.classList.remove('tab-fade-enter');
      void DOM.giftFeed.offsetWidth;
      DOM.giftFeed.classList.add('tab-fade-enter');
    }
    if (DOM.giftSplitContainer) DOM.giftSplitContainer.classList.add('hidden');
    if (DOM.splitViewIcon) DOM.splitViewIcon.textContent = '⚖️';
    if (DOM.splitViewText) DOM.splitViewText.textContent = (currentLang === 'ar' ? 'عرض منقسم' : 'Split View');
    if (DOM.btnToggleSplitView) {
      DOM.btnToggleSplitView.classList.remove('border-indigo-500/70', 'bg-indigo-950/70', 'text-indigo-200');
      DOM.btnToggleSplitView.classList.add('bg-gray-800/80', 'border-gray-700');
    }
  }
}

// ---------------------------------------------------------------------------
// Combo burst popup
// ---------------------------------------------------------------------------
function showComboBurst(name, iconUrlOrEmoji, count) {
  if (comboTimer) { clearTimeout(comboTimer); comboTimer = null; }

  DOM.comboCountDisplay.textContent = `x${count}`;
  DOM.comboGiftName.textContent     = name;

  const realIcon = getGiftAsset(name, iconUrlOrEmoji);
  DOM.comboGiftIcon.innerHTML = `<img src="${realIcon}" style="width:68px;height:68px;object-fit:contain;display:block;margin:0 auto;filter:drop-shadow(0 0 10px rgba(251,191,36,0.8));" alt="${name}" onerror="this.src='https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_rose.png~tplv-obj.png'" />`;

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
// Live Friends & Co-Hosts Controller (بثوث الأصدقاء والشركاء المباشرة)
// ---------------------------------------------------------------------------
const DEFAULT_PARTNER_FRIENDS = [
  {
    unique_id: "samfire_55",
    nickname: "سام فاير 🔥",
    avatar_url: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&crop=faces",
    relation: "شريك بث 🤝",
    viewer_count: 1420,
    status: "LIVE"
  },
  {
    unique_id: "king_fahad_pk",
    nickname: "الكينغ أبو فهد 👑",
    avatar_url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=faces",
    relation: "منافس في الجولة 🥊",
    viewer_count: 8950,
    status: "LIVE"
  },
  {
    unique_id: "sara_live_official",
    nickname: "سارة القحطاني 🇸🇦",
    avatar_url: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop&crop=faces",
    relation: "حليف في الجولة ⚔️",
    viewer_count: 3840,
    status: "LIVE"
  },
  {
    unique_id: "dr_layla_stream",
    nickname: "دكتورة ليلى 🩺",
    avatar_url: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=100&h=100&fit=crop&crop=faces",
    relation: "شريك بث 🤝",
    viewer_count: 2150,
    status: "LIVE"
  }
];

let currentLiveFriends = [];
let savedCustomFriends = [];

function loadSavedFriends() {
  try {
    const raw = localStorage.getItem('tt_saved_live_friends');
    if (raw) {
      savedCustomFriends = JSON.parse(raw);
    }
  } catch (e) {
    savedCustomFriends = [];
  }
}

function persistCustomFriends() {
  try {
    localStorage.setItem('tt_saved_live_friends', JSON.stringify(savedCustomFriends));
  } catch (e) {}
}

function renderLiveFriends(serverFriends = null) {
  if (!DOM.liveFriendsGrid) return;

  loadSavedFriends();

  // Merge server-provided friends (PK anchors / co-hosts) with user's custom friends
  let merged = [];
  const serverList = Array.isArray(serverFriends) ? serverFriends : [];
  const seen = new Set();

  // 1. First priority: Server-discovered live battle anchors & co-hosts
  serverList.forEach(f => {
    const k = (f.unique_id || f.key || '').toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      merged.push(f);
    }
  });

  // 2. Second priority: User's custom added friends
  savedCustomFriends.forEach(f => {
    const k = (f.unique_id || f.key || '').toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      merged.push(f);
    }
  });

  // 3. Third priority: If still less than 4, fill with default active partner creators
  if (merged.length < 4) {
    DEFAULT_PARTNER_FRIENDS.forEach(f => {
      const k = f.unique_id.toLowerCase();
      if (k !== (currentUsername || '').toLowerCase() && !seen.has(k)) {
        seen.add(k);
        merged.push(f);
      }
    });
  }

  currentLiveFriends = merged;

  if (DOM.liveFriendsCountBadge) {
    const count = currentLiveFriends.length;
    DOM.liveFriendsCountBadge.textContent = `${count} متصل`;
    DOM.liveFriendsCountBadge.className = 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs px-2.5 py-0.5 rounded-full font-bold shadow-sm';
  }

  const fragment = document.createDocumentFragment();

  currentLiveFriends.forEach((friend) => {
    const card = document.createElement('div');
    card.className = 'friend-live-card';

    const uniqueId = escapeHtml(friend.unique_id || '');
    const nickname = escapeHtml(friend.nickname || uniqueId || 'صانع محتوى');
    const relation = escapeHtml(friend.relation || 'شريك بث 🤝');
    const avatarUrl = friend.avatar_url || 'https://www.tiktok.com/favicon.ico';
    const viewerCount = Number(friend.viewer_count || (Math.floor(Math.random() * 600) + 750));

    let relBadgeClass = 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    if (relation.includes('منافس') || relation.includes('خصم')) {
      relBadgeClass = 'bg-rose-500/15 text-rose-400 border-rose-500/30';
    } else if (relation.includes('حليف') || relation.includes('جولة')) {
      relBadgeClass = 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    } else if (relation.includes('مُتابع') || relation.includes('مُضاف')) {
      relBadgeClass = 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    }

    card.innerHTML = `
      <button class="friend-remove-btn" data-user="${uniqueId}" title="إزالة من القائمة">✕</button>

      <div class="flex items-center gap-3">
        <div class="relative flex-shrink-0">
          <div class="friend-live-ring">
            <img src="${avatarUrl}" alt="${nickname}" class="w-12 h-12 rounded-full object-cover bg-dark-800" onerror="this.src='https://www.tiktok.com/favicon.ico'" />
          </div>
          <div class="friend-live-badge">
            <span class="friend-live-dot"></span>
            <span>LIVE</span>
          </div>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-1 mb-0.5">
            <h3 class="font-bold text-sm text-white truncate" title="${nickname}">${nickname}</h3>
          </div>
          <div class="text-xs text-gray-400 truncate dir-ltr text-right">@${uniqueId}</div>
          <div class="mt-1">
            <span class="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-md border ${relBadgeClass}">
              ${relation}
            </span>
          </div>
        </div>
      </div>

      <div class="friend-viewers-box">
        <div class="flex items-center gap-1.5 text-xs text-gray-300">
          <span class="text-emerald-400 text-sm animate-pulse">👁️</span>
          <span class="font-medium text-gray-300">المشاهدات المباشرة:</span>
        </div>
        <div class="flex items-baseline gap-1">
          <span class="friend-viewers-count">${viewerCount.toLocaleString()}</span>
          <span class="text-[10px] text-emerald-400/80 font-medium">مشاهد</span>
        </div>
      </div>

      <div class="flex items-center gap-2 pt-1 border-t border-white/5">
        <button class="friend-track-btn flex-1" data-user="${uniqueId}" title="بدء تتبع بث هذا الصديق فوراً">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <span>تتبع الآن</span>
        </button>
        <a href="https://www.tiktok.com/@${uniqueId}/live" target="_blank" rel="noopener noreferrer" class="friend-tiktok-btn" title="فتح البث في موقع تيك توك">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path>
          </svg>
          <span>تيك توك</span>
        </a>
      </div>
    `;

    const trackBtn = card.querySelector('.friend-track-btn');
    if (trackBtn) {
      trackBtn.addEventListener('click', () => {
        trackFriendLive(uniqueId);
      });
    }

    const removeBtn = card.querySelector('.friend-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFriendFromList(uniqueId);
      });
    }

    fragment.appendChild(card);
  });

  DOM.liveFriendsGrid.innerHTML = '';
  DOM.liveFriendsGrid.appendChild(fragment);
}

function removeFriendFromList(username) {
  const uLower = (username || '').toLowerCase();
  savedCustomFriends = savedCustomFriends.filter(f => (f.unique_id || '').toLowerCase() !== uLower);
  persistCustomFriends();
  currentLiveFriends = currentLiveFriends.filter(f => (f.unique_id || '').toLowerCase() !== uLower);
  renderLiveFriends(currentLiveFriends);
  toast(`تمت إزالة @${username} من القائمة`, 'info', 2500);
}

function addCustomFriend(username) {
  if (!username) return;
  const clean = username.replace(/^@/, '').trim();
  if (!clean) return;

  loadSavedFriends();
  const exists = savedCustomFriends.some(f => (f.unique_id || '').toLowerCase() === clean.toLowerCase());
  if (exists) {
    toast(`الحساب @${clean} موجود بالفعل في قائمة الأصدقاء`, 'warning', 2500);
    return;
  }

  const newFriend = {
    unique_id: clean,
    nickname: clean,
    avatar_url: `https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&crop=faces`,
    relation: "صديق مُتابع ⭐",
    viewer_count: Math.floor(Math.random() * 2500) + 450,
    status: "LIVE"
  };

  savedCustomFriends.unshift(newFriend);
  persistCustomFriends();

  // If WebSocket is active, notify backend to register and enrich viewer count
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'add_friend', username: clean }));
  }

  renderLiveFriends(currentLiveFriends);
  toast(`✅ تمت إضافة @${clean} إلى قائمة بثوث الأصدقاء الحالية!`, 'success', 3500);
}

function trackFriendLive(username) {
  if (!username) return;
  stopDemoSimulation();
  if (DOM.usernameInput) {
    DOM.usernameInput.value = username.replace(/^@/, '');
  }
  if (DOM.startBtn) {
    DOM.startBtn.click();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast(`جاري بدء تتبع بث الصديق @${username}...`, 'info', 3000);
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
  const battleId     = pkData.battle_id || '';

  // Instant Round Start Detection & Synchronization (بدون أي تأخير)
  const isBattleIdNew    = !!(battleId && lastBattleId && battleId !== lastBattleId);
  const isBecomingActive = (lastPkStatus !== 'ACTIVE' && (status === 'ACTIVE' || isActive));
  const isRoundNumBumped = ((status === 'ACTIVE' || isActive) && roundNum > lastRoundNum && lastRoundNum !== 0);

  const isNewRound =
    (eventType === 'start') ||
    isBattleIdNew ||
    isBecomingActive ||
    isRoundNumBumped;

  if (isNewRound) {
    playBattleStartSound();
    if (DOM.pkSection) {
      DOM.pkSection.classList.remove('round-start-flash');
      void DOM.pkSection.offsetWidth;
      DOM.pkSection.classList.add('round-start-flash');
      setTimeout(() => DOM.pkSection?.classList.remove('round-start-flash'), 2000);
      try { DOM.pkSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    }
    const durMin = Math.round((pkData.duration || 300) / 60);
    const durLabel = durMin > 0 ? (currentLang === 'ar' ? ` (${durMin} دقائق)` : ` (${durMin}m)`) : '';
    toast(
      currentLang === 'ar'
        ? `⚔️ بدأت الجولة ${roundNum} الآن!${durLabel} 🔥 احشدوا الدعم والتكبيس!`
        : `⚔️ Round ${roundNum} started!${durLabel} 🔥 Send gifts & tap!`,
      'warning',
      6000
    );
  }

  if (battleId) {
    lastBattleId = battleId;
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
      DOM.pkStatusBadge.textContent = currentLang === 'ar' ? '🔴 جولة جارية' : '🔴 Battle Active';
      DOM.pkStatusBadge.className   = 'px-3 py-1 rounded-full text-xs font-bold bg-red-950 text-red-300 border border-red-700 animate-pulse';
      DOM.pkSection?.classList.add('pk-active');
    } else if (status === 'PUNISH') {
      DOM.pkStatusBadge.textContent = currentLang === 'ar' ? '⏱️ وقت الحكم' : '⏱️ Punish Time';
      DOM.pkStatusBadge.className   = 'px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300 border border-amber-700 animate-pulse';
      DOM.pkSection?.classList.add('pk-active');
    } else if (status === 'ENDED' || eventType === 'ended') {
      DOM.pkStatusBadge.textContent = currentLang === 'ar' ? '🏆 انتهت الجولة' : '🏆 Round Ended';
      DOM.pkStatusBadge.className   = 'px-3 py-1 rounded-full text-xs font-bold bg-emerald-950 text-emerald-300 border border-emerald-700';
      DOM.pkSection?.classList.remove('pk-active');
    } else {
      DOM.pkStatusBadge.textContent = currentLang === 'ar' ? '⏸️ في انتظار جولة' : '⏸️ Waiting Battle';
      DOM.pkStatusBadge.className   = 'px-3 py-1 rounded-full text-xs font-bold bg-gray-800 text-gray-400 border border-gray-700';
      DOM.pkSection?.classList.remove('pk-active');
    }
  }

  // Synchronize PK Round Countdown Timer (مزامنة عداد وقت الجولة فائق الدقة)
  if (status === 'ACTIVE' || (isActive && status !== 'PUNISH')) {
    const dur = pkData.duration || 300;
    const rem = (pkData.remaining_seconds != null && pkData.remaining_seconds >= 0) ? pkData.remaining_seconds : dur;
    const serverEndTime = (pkData.end_time && pkData.end_time > 0) ? Math.round(pkData.end_time * 1000) : 0;

    if (isNewRound || !pkTimerInterval || pkTimerPhase !== 'BATTLE') {
      startPkCountdown(rem, 'BATTLE', dur, serverEndTime);
    } else if (serverEndTime > 0 && Math.abs(pkTimerEndTimestamp - serverEndTime) > 2000) {
      // Automatic drift correction with server clock
      pkTimerEndTimestamp = serverEndTime;
      pkTimerTotalSeconds = dur;
      updatePkTimerDisplay();
    }
  } else if (status === 'PUNISH') {
    const rem = (pkData.remaining_seconds != null && pkData.remaining_seconds > 0) ? pkData.remaining_seconds : 120;
    if (!pkTimerInterval || pkTimerPhase !== 'PUNISH') {
      startPkCountdown(rem, 'PUNISH', 120);
    }
  } else if (status === 'ENDED' || eventType === 'ended') {
    stopPkCountdown('ENDED');
  } else {
    stopPkCountdown('IDLE');
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
  if (data.live_friends)   renderLiveFriends(data.live_friends);
  if (data.stream_video)   loadVideoStream(data.stream_video);
}

// ---------------------------------------------------------------------------
// Live Video Player Controller (مشغل البث المرئي المباشر)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Live Video Stream Player (HLS / Anti-Stutter Tuning / Direct Fallback)
// ---------------------------------------------------------------------------
let hlsInstance = null;
let isVideoMuted = true;
let isVideoPortrait = false;
let isVideoCollapsed = false;
let currentStreamData = null;
let currentPlayerMode = 'hls'; // 'hls' or 'embed'

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
        DOM.liveVideoElement.currentTime = Math.max(0, liveEdge - 2.0);
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

function switchToIframePlayer() {
  if (!currentStreamData) return;
  currentPlayerMode = 'embed';
  if (hlsInstance) {
    try { hlsInstance.stopLoad(); } catch (_) {}
  }
  if (DOM.liveVideoElement) {
    DOM.liveVideoElement.pause();
    DOM.liveVideoElement.classList.add('hidden');
  }
  if (DOM.videoPlaceholder) DOM.videoPlaceholder.classList.add('hidden');
  if (DOM.videoBufferingIndicator) DOM.videoBufferingIndicator.classList.add('hidden');

  const embedUrl = currentStreamData.embed_url ||
                   currentStreamData.iframe_url ||
                   `https://www.tiktok.com/@${currentStreamData.username || currentUsername}/live`;

  if (DOM.liveIframeElement) {
    DOM.liveIframeElement.src = embedUrl;
    DOM.liveIframeElement.classList.remove('hidden');
  }
  if (DOM.playerModeIcon) DOM.playerModeIcon.textContent = '🌐';
  if (DOM.playerModeText) DOM.playerModeText.textContent = 'مشغل تيك توك المباشر';
  toast('🌐 تم التبديل إلى مشغل تيك توك المباشر (Direct CDN بدون أي تقطيع)', 'success', 5000);
}

function switchToHlsPlayer() {
  if (!currentStreamData) return;
  currentPlayerMode = 'hls';
  if (DOM.liveIframeElement) {
    DOM.liveIframeElement.classList.add('hidden');
    DOM.liveIframeElement.removeAttribute('src');
  }
  DOM.liveVideoElement?.classList.remove('hidden');
  if (DOM.playerModeIcon) DOM.playerModeIcon.textContent = '⚡';
  if (DOM.playerModeText) DOM.playerModeText.textContent = 'مشغل السيرفر';

  if (hlsInstance) {
    try {
      hlsInstance.startLoad();
      DOM.liveVideoElement?.play().catch(() => {});
    } catch (_) {}
  } else {
    loadVideoStream(currentStreamData);
  }
  toast('⚡ تم التبديل إلى مشغل السيرفر السلس', 'info', 4000);
}

function togglePlayerMode() {
  if (currentPlayerMode === 'hls') {
    switchToIframePlayer();
  } else {
    switchToHlsPlayer();
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

  // Toggle Player Mode (Server Stream vs TikTok Direct Embed)
  DOM.btnTogglePlayerMode?.addEventListener('click', () => {
    togglePlayerMode();
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
      DOM.liveIframeElement?.classList.remove('aspect-landscape');
      DOM.liveIframeElement?.classList.add('aspect-portrait');
      if (DOM.videoAspectIcon) DOM.videoAspectIcon.textContent = '🖥️';
    } else {
      DOM.liveVideoElement.classList.remove('aspect-portrait');
      DOM.liveVideoElement.classList.add('aspect-landscape');
      DOM.liveIframeElement?.classList.remove('aspect-portrait');
      DOM.liveIframeElement?.classList.add('aspect-landscape');
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
  if (!streamData || !DOM.liveVideoElement) return;
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

  // If currently in embed mode, update iframe
  if (currentPlayerMode === 'embed') {
    switchToIframePlayer();
    return;
  }

  // If no HLS direct stream is provided but TikTok embed or room_id is present:
  if (!targetHls) {
    const embedSrc = streamData.embed_url || streamData.iframe_url || '';
    if (embedSrc && DOM.liveIframeElement) {
      switchToIframePlayer();
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

  // Setup HLS.js with rock-solid anti-stutter live settings
  if (window.Hls && window.Hls.isSupported()) {
    hlsInstance = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      // 6 segments safety buffer (~10-12s) completely absorbs any network jitters
      liveSyncDurationCount: 6,
      liveMaxLatencyDurationCount: 15,
      // Constant 1.0x rate prevents buffer drain speed-up cycle that causes stuttering!
      maxLiveSyncPlaybackRate: 1.0,
      liveDurationInfinity: true,
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 60 * 1000 * 1000,
      startFragPrefetch: true,        // Pre-download next video segment
      progressive: true,              // Progressive chunk parsing
      nudgeOffset: 0.1,               // Nudge forward past timestamp holes
      nudgeMaxRetry: 5,
      highBufferWatchdogPeriod: 2,
      manifestLoadingTimeOut: 15000,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 500,
      levelLoadingTimeOut: 15000,
      levelLoadingMaxRetry: 6,
      fragLoadingTimeOut: 25000,
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
            switchToIframePlayer();
            break;
        }
      } else if (data.details === 'bufferStalledError') {
        console.debug('[HLS] Buffer stalled, ensuring stream continues loading...');
        hlsInstance.startLoad();
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
  if (!DOM.liveVideoElement) return;
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
  toast('📺 تم تشغيل البث المرئي التجريبي بدون أي تقطيع!', 'success');
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

      case 'live_friends':
        if (Array.isArray(msg.data)) {
          renderLiveFriends(msg.data);
        }
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
  if (DOM.giftFeedHost) DOM.giftFeedHost.innerHTML = '<div class="flex items-center justify-center h-full text-gray-600 text-sm">Loading...</div>';
  if (DOM.giftFeedOpp) DOM.giftFeedOpp.innerHTML = '<div class="flex items-center justify-center h-full text-gray-600 text-sm">Loading...</div>';
  if (DOM.pkHostGiftsFeed) DOM.pkHostGiftsFeed.innerHTML = '<span class="text-xs text-gray-500 italic">ستظهر هدايا فريقنا هنا</span>';
  if (DOM.pkOppGiftsFeed) DOM.pkOppGiftsFeed.innerHTML = '<span class="text-xs text-gray-500 italic">ستظهر هدايا الخصم هنا</span>';
  DOM.leaderboardList.innerHTML = '<div class="flex items-center justify-center h-full text-gray-600 text-sm">Loading...</div>';
  DOM.likersRow.innerHTML       = '<p class="text-gray-600 text-sm">Loading...</p>';
  commentCount = 0;
  giftCount    = 0;
  hostGiftsCount = 0;
  oppGiftsCount  = 0;
  _likersData  = {};
  DOM.commentCount.textContent = '0';
  DOM.giftCount.textContent    = '0 gifts';
  if (DOM.hostGiftsNum) DOM.hostGiftsNum.textContent = '0';
  if (DOM.oppGiftsNum) DOM.oppGiftsNum.textContent = '0';
  if (DOM.badgeFilterAll) DOM.badgeFilterAll.textContent = '0';
  if (DOM.badgeFilterHost) DOM.badgeFilterHost.textContent = '0';
  if (DOM.badgeFilterOpp) DOM.badgeFilterOpp.textContent = '0';
  if (DOM.splitHostGiftsCount) DOM.splitHostGiftsCount.textContent = '0';
  if (DOM.splitOppGiftsCount) DOM.splitOppGiftsCount.textContent = '0';
  if (DOM.pkHostGiftCount) DOM.pkHostGiftCount.textContent = '0';
  if (DOM.pkOppGiftCount) DOM.pkOppGiftCount.textContent = '0';
  if (DOM.pkHostLastGift) DOM.pkHostLastGift.textContent = 'في انتظار الدعم...';
  if (DOM.pkOppLastGift) DOM.pkOppLastGift.textContent = 'في انتظار الدعم...';

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

// Gift Feed Filter Tabs & Split View Listeners
if (DOM.giftFilterBtnAll)  DOM.giftFilterBtnAll.addEventListener('click', () => setGiftFilter('all'));
if (DOM.giftFilterBtnHost) DOM.giftFilterBtnHost.addEventListener('click', () => setGiftFilter('host'));
if (DOM.giftFilterBtnOpp)  DOM.giftFilterBtnOpp.addEventListener('click', () => setGiftFilter('opponent'));
if (DOM.btnToggleSplitView) DOM.btnToggleSplitView.addEventListener('click', () => toggleSplitView());

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

  // Start PK Round Countdown Timer (300s)
  startPkCountdown(300, 'BATTLE');

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

  // Live Friends demo simulation
  const demoFriends = [
    {
      unique_id: "sara_live_official",
      nickname: "سارة القحطاني 🇸🇦",
      avatar_url: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop&crop=faces",
      viewer_count: 3840,
      relation: "حليف في الجولة ⚔️",
      status: "LIVE"
    },
    {
      unique_id: "king_fahad_pk",
      nickname: "الكينغ أبو فهد 👑",
      avatar_url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=faces",
      viewer_count: 9420,
      relation: "منافس في الجولة 🥊",
      status: "LIVE"
    },
    {
      unique_id: "dr_layla_stream",
      nickname: "دكتورة ليلى 🩺",
      avatar_url: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=100&h=100&fit=crop&crop=faces",
      viewer_count: 1250,
      relation: "شريك بث 🤝",
      status: "LIVE"
    },
    {
      unique_id: "captain_majed_live",
      nickname: "كابتن ماجد ⚽",
      avatar_url: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&h=100&fit=crop&crop=faces",
      viewer_count: 5680,
      relation: "منافس في الجولة 🥊",
      status: "LIVE"
    }
  ];
  renderLiveFriends(demoFriends);

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

    // 1.5. Fluctuate demo friends live viewer counts every 3 ticks
    if (tick % 3 === 0 && demoFriends) {
      demoFriends.forEach(f => {
        const delta = Math.floor(Math.random() * 45) - 20;
        f.viewer_count = Math.max(80, f.viewer_count + delta);
      });
      renderLiveFriends(demoFriends);
    }
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

      const isHost = Math.random() > 0.45;
      const recSide = isHost ? 'host' : 'opponent';
      const recName = isHost ? 'فريقنا' : 'الخصم (قيصر_الليل)';

      addGift({
        user: { nickname: u.name, unique_id: u.handle, avatar_url: u.avatar },
        transaction: {
          gift_name: g.name,
          gift_icon_url: g.icon,
          diamond_unit_cost: g.diamonds,
          repeat_count: repeat,
          total_value: addedDiamonds,
        },
        recipient_side: recSide,
        recipient_name: recName,
        is_battle_gift: true
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

      // Update PK points matched to recipient side
      if (recSide === 'host') {
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

    // 3.8. Legendary Lion Support Takeover at tick 10 & 25
    if (tick === 10 || tick === 25) {
      const lionVal = 29999;
      demoDiamonds += lionVal;
      demoHostScore += lionVal;
      addGift({
        user: {
          nickname: 'أبو فهد العتيبي 🦁',
          unique_id: 'abu_fahad',
          avatar_url: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&h=100&fit=crop&crop=faces',
        },
        transaction: {
          gift_name: 'أسد التيك توك (Lion)',
          gift_icon_url: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/gift_lion.png~tplv-obj.png',
          diamond_unit_cost: 29999,
          repeat_count: 1,
          total_value: lionVal,
        },
        recipient_side: 'host',
        recipient_name: 'فريقنا',
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
    stopPkCountdown('IDLE');
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

if (DOM.refreshFriendsBtn) {
  DOM.refreshFriendsBtn.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'refresh_friends' }));
      toast('جاري تحديث قائمة بثوث الأصدقاء...', 'info', 2000);
    } else if (isDemoMode) {
      toast('تم تحديث قائمة بثوث الأصدقاء الحالية!', 'success', 2000);
    } else {
      toast('يرجى بدء التتبع أولاً لتحديث الأصدقاء المتصلين', 'warning', 3000);
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
GiftFxEngine.init();
initLiveVideoPlayer();
applyLanguage(currentLang);
applyTheme(currentTheme);
setStatus('idle', I18N[currentLang]?.statusIdle || 'Idle');

// Init live friends immediately so the section is NEVER empty
renderLiveFriends();

// Wire up add friend button & enter key
if (DOM.addFriendBtn) {
  DOM.addFriendBtn.addEventListener('click', () => {
    if (DOM.addFriendInput && DOM.addFriendInput.value) {
      addCustomFriend(DOM.addFriendInput.value);
      DOM.addFriendInput.value = '';
    }
  });
}
if (DOM.addFriendInput) {
  DOM.addFriendInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (DOM.addFriendInput.value) {
        addCustomFriend(DOM.addFriendInput.value);
        DOM.addFriendInput.value = '';
      }
    }
  });
}

// Show admin shortcut in sidebar if authenticated owner from previous session
if (sessionStorage.getItem('tt_admin_token')) {
  if (DOM.adminSidebarSection) DOM.adminSidebarSection.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════
// TACTILE RESPONSIVENESS, FLUID NAVIGATION & KINETIC SCROLLING (سلاسة فائقة)
// ═══════════════════════════════════════════════════════════════════════════

// 1. Dynamic Tactile Ripple Effect (تموج ضوئي ناعم مع كل ضغطة)
function initTactileRipple() {
  document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('button, a[role="button"], .quick-stream-btn, .gift-filter-tab, .tactile-btn, .friend-track-btn, .friend-tiktok-btn, .kpi-card, .nav-dock-btn');
    if (!target) return;

    target.classList.add('ripple-container');

    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.5;
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;

    const wave = document.createElement('span');
    wave.className = 'ripple-wave';
    wave.style.width = `${size}px`;
    wave.style.height = `${size}px`;
    wave.style.left = `${x}px`;
    wave.style.top = `${y}px`;

    target.appendChild(wave);
    setTimeout(() => {
      wave.remove();
    }, 500);
  }, { passive: true });
}

// 2. Universal Kinetic Mouse Drag-to-Scroll (تحريك أفقي سلس بالسحب والقصور الذاتي)
function makeKineticScrollable(container) {
  if (!container || container._hasKineticScroll) return;
  container._hasKineticScroll = true;
  container.classList.add('drag-scrollable');

  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;
  let velX = 0;
  let lastX = 0;
  let momentumID = null;
  let hasMoved = false;

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDown = true;
    hasMoved = false;
    cancelAnimationFrame(momentumID);
    container.classList.add('drag-scrolling');
    startX = e.pageX - container.offsetLeft;
    scrollLeft = container.scrollLeft;
    lastX = e.pageX;
    velX = 0;
  });

  window.addEventListener('mouseup', () => {
    if (!isDown) return;
    isDown = false;
    container.classList.remove('drag-scrolling');

    function momentumLoop() {
      if (Math.abs(velX) > 0.4) {
        container.scrollLeft -= velX;
        velX *= 0.92;
        momentumID = requestAnimationFrame(momentumLoop);
      }
    }
    momentumLoop();
  });

  container.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - container.offsetLeft;
    const walk = (x - startX) * 1.25;
    if (Math.abs(walk) > 6) hasMoved = true;
    velX = e.pageX - lastX;
    lastX = e.pageX;
    container.scrollLeft = scrollLeft - walk;
  });

  container.addEventListener('click', (e) => {
    if (hasMoved) {
      e.preventDefault();
      e.stopPropagation();
      hasMoved = false;
    }
  }, true);
}

function initAllKineticScrolls() {
  const elements = [
    DOM.likersRow,
    $('pkOppMvps'),
    $('pkOppGiftsFeed'),
    document.querySelector('.quick-stream-btn')?.parentElement,
    document.querySelector('.gift-filter-tab')?.parentElement,
  ];

  elements.forEach(el => {
    if (el) makeKineticScrollable(el);
  });

  document.querySelectorAll('.drag-scrollable').forEach(el => makeKineticScrollable(el));
}

// 3. Floating Quick Navigation Dock Controller (شريط التنقل السريع التفاعلي)
function initFloatingNavDock() {
  const dock = $('floatingNavDock');
  if (!dock) return;

  const buttons = dock.querySelectorAll('.nav-dock-btn[data-target]');
  const scrollTopBtn = $('navDockScrollTop');

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });

  if (scrollTopBtn) {
    scrollTopBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  const sectionIds = ['pkSection', 'commentsSection', 'giftsSection', 'leaderboardSection', 'liveFriendsSection'];
  const sections = sectionIds.map(id => document.getElementById(id)).filter(Boolean);

  if ('IntersectionObserver' in window && sections.length > 0) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          buttons.forEach(btn => {
            if (btn.getAttribute('data-target') === id) {
              btn.classList.add('active');
            } else {
              btn.classList.remove('active');
            }
          });
        }
      });
    }, {
      rootMargin: '-15% 0px -65% 0px',
      threshold: 0.1
    });

    sections.forEach(sec => observer.observe(sec));
  }
}

// Initialize all fluidity modules
initTactileRipple();
initAllKineticScrolls();
initFloatingNavDock();

console.log('🎯 TIKTOK VRF initialized successfully with Fluid UI & Kinetic Navigation.');

