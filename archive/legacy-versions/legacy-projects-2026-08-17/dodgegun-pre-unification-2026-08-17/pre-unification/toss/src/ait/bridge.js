import {
  Analytics,
  Device,
  Game,
  Screen,
  getUserKeyForGame,
} from '@apps-in-toss/web-framework';

const SETTINGS_KEY = 'dogegeon-settings';

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { sound: true, haptic: true, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { sound: true, haptic: true };
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const TUTORIAL_KEY = 'dogegeon-tutorial-done';

export function loadTutorialDone() {
  try {
    return localStorage.getItem(TUTORIAL_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveTutorialDone() {
  try {
    localStorage.setItem(TUTORIAL_KEY, '1');
  } catch { /* ignore */ }
}

export async function lockLandscape() {
  try {
    await Screen.setOrientation({ type: 'landscape' });
  } catch { /* 브라우저 폴백 */ }
  try {
    await Screen.setAwakeMode({ enabled: true });
  } catch { /* ignore */ }
  try {
    await Screen.setIosSwipeBack({ isEnabled: false });
  } catch { /* ignore */ }
  try {
    await screen.orientation?.lock?.('landscape');
  } catch { /* 데스크톱은 락 불가 */ }
}

export async function restorePortrait() {
  try {
    await Screen.setOrientation({ type: 'portrait' });
  } catch { /* ignore */ }
  try {
    await Screen.setAwakeMode({ enabled: false });
  } catch { /* ignore */ }
  try {
    await screen.orientation?.unlock?.();
  } catch { /* ignore */ }
}

export async function closeMiniApp() {
  try {
    await Screen.close();
  } catch { /* 브라우저는 그냥 홈으로 */ }
}

export async function haptic(kind = 'light') {
  try {
    await Device.triggerHaptic({ type: kind === 'heavy' ? 'tickMedium' : 'tap' });
    return;
  } catch { /* ignore */ }
  try {
    navigator.vibrate?.(kind === 'heavy' ? 28 : 12);
  } catch { /* ignore */ }
}

export async function getUserKey() {
  try {
    const result = await getUserKeyForGame();
    if (result && result.type === 'HASH') return result.hash;
  } catch { /* ignore */ }
  let key = localStorage.getItem('dogegeon-user');
  if (!key) {
    key = `local-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('dogegeon-user', key);
  }
  return key;
}

export async function getGameProfile() {
  try {
    const profile = await Game.getUserProfile();
    if (profile?.statusCode === 'SUCCESS') {
      return { nickname: profile.nickname, image: profile.profileImageUri || '' };
    }
  } catch { /* ignore */ }
  return null;
}

function statsKey(userKey) {
  return `dogegeon-stats-${userKey || 'local'}`;
}

export function loadStats(userKey) {
  try {
    const raw = localStorage.getItem(statsKey(userKey));
    if (raw) return {
      userWins: 0,
      userGames: 0,
      userDraws: 0,
      practiceWins: 0,
      ghostWins: 0,
      ghostGames: 0,
      ghostDraws: 0,
      ...JSON.parse(raw),
    };
  } catch { /* ignore */ }
  return {
    userWins: 0,
    userGames: 0,
    userDraws: 0,
    practiceWins: 0,
    ghostWins: 0,
    ghostGames: 0,
    ghostDraws: 0,
  };
}

export function saveStats(userKey, stats) {
  localStorage.setItem(statsKey(userKey), JSON.stringify(stats));
}

export function recordMatch(userKey, { userVsUser, opponentType = 'practice', win, draw = false }) {
  const stats = loadStats(userKey);
  if (userVsUser) {
    stats.userGames += 1;
    if (win) stats.userWins += 1;
    if (draw) stats.userDraws += 1;
  } else if (opponentType === 'ghost') {
    stats.ghostGames += 1;
    if (win) stats.ghostWins += 1;
    if (draw) stats.ghostDraws += 1;
  } else if (win) {
    stats.practiceWins += 1;
  }
  saveStats(userKey, stats);
  return stats;
}

export async function submitUserWinScore(userWins) {
  try {
    const result = await Game.setLeaderboardScore({ score: String(userWins) });
    if (!result) return { ok: false, reason: 'unsupported' };
    if (result.statusCode === 'SUCCESS' || result === true) return { ok: true };
    return { ok: false, reason: result.statusCode || 'fail' };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

export async function openLeaderboard() {
  try {
    await Game.openLeaderboard();
    return true;
  } catch { /* ignore */ }
  return false;
}

export async function trackScreen(name) {
  try {
    await Analytics.screen({ name });
  } catch { /* ignore */ }
}

export async function trackClick(name) {
  try {
    await Analytics.click({ name });
  } catch { /* ignore */ }
}

export async function trackEvent(name, params = {}) {
  try {
    await Analytics.log({ name, ...params });
  } catch { /* ignore */ }
}

let audioCtx = null;
let bgmGain = null;
let bgmSource = null;
let bgmBuffer = null;
let bgmLoad = null;
let bgmEl = null;
let bgmWanted = false;

function ensureCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function ctx() {
  const ac = ensureCtx();
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

function decodeAudio(ac, raw) {
  return new Promise((resolve, reject) => {
    const ret = ac.decodeAudioData(raw, resolve, reject);
    if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
  });
}

function loadBgmBuffer(ac) {
  if (bgmBuffer) return Promise.resolve(bgmBuffer);
  if (!bgmLoad) {
    bgmLoad = fetch('/assets/bgm.mp3')
      .then(r => {
        if (!r.ok) throw new Error('bgm ' + r.status);
        return r.arrayBuffer();
      })
      .then(raw => decodeAudio(ac, raw))
      .then(buf => {
        bgmBuffer = buf;
        return buf;
      })
      .catch(err => {
        bgmLoad = null;
        throw err;
      });
  }
  return bgmLoad;
}

function detachBgmSource() {
  try {
    if (bgmSource) {
      bgmSource.onended = null;
      bgmSource.stop();
      bgmSource.disconnect();
    }
  } catch { /* already stopped */ }
  bgmSource = null;
  try {
    if (bgmEl) {
      bgmEl.pause();
      bgmEl.currentTime = 0;
    }
  } catch { /* ignore */ }
}

function attachBgmSource(ac) {
  if (!bgmWanted || !bgmBuffer) return;
  detachBgmSource();
  if (!bgmGain) {
    bgmGain = ac.createGain();
    bgmGain.connect(ac.destination);
  }
  const src = ac.createBufferSource();
  src.buffer = bgmBuffer;
  src.loop = true;
  src.connect(bgmGain);
  src.start(0);
  bgmSource = src;
  const now = ac.currentTime;
  bgmGain.gain.cancelScheduledValues(now);
  bgmGain.gain.setValueAtTime(0.0001, now);
  bgmGain.gain.linearRampToValueAtTime(0.3, now + 0.4);
}

function playBgmElement() {
  if (!bgmWanted) return;
  if (!bgmEl) {
    bgmEl = new Audio('/assets/bgm.mp3');
    bgmEl.loop = true;
    bgmEl.volume = 0.3;
  }
  bgmEl.currentTime = 0;
  bgmEl.play().catch(() => {});
}

export function playTone(settings, freq, dur = 0.08, gain = 0.05, type = 'square') {
  if (!settings?.sound) return;
  try {
    const ac = ctx();
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + dur);
  } catch { /* ignore */ }
}

export function startBgm(settings) {
  bgmWanted = true;
  if (!settings?.sound) {
    try { loadBgmBuffer(ensureCtx()).catch(() => {}); } catch { /* ignore */ }
    return;
  }
  try {
    const ac = ctx();
    loadBgmBuffer(ac)
      .then(() => {
        if (!bgmWanted) return;
        attachBgmSource(ac);
      })
      .catch(playBgmElement);
  } catch { /* ignore */ }
}

export function stopBgm() {
  bgmWanted = false;
  detachBgmSource();
  try {
    if (bgmGain && audioCtx) {
      const now = audioCtx.currentTime;
      bgmGain.gain.cancelScheduledValues(now);
      bgmGain.gain.setValueAtTime(0.0001, now);
    }
  } catch { /* ignore */ }
}

export function muteAudio() {
  try { audioCtx?.suspend(); } catch { /* ignore */ }
  try { bgmEl?.pause(); } catch { /* ignore */ }
}

export function resumeAudio(settings) {
  if (!settings?.sound) return;
  try { audioCtx?.resume(); } catch { /* ignore */ }
  if (!bgmWanted) return;
  try { bgmEl?.play()?.catch(() => {}); } catch { /* ignore */ }
}
