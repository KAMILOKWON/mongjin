import { CFG } from './game/config.js';
import { createMatch, drainEvents, stepMatch } from './game/sim.js';
import { createAi, thinkAi } from './game/ai.js';
import { createRenderer } from './game/render.js';
import { createInput } from './game/input.js';
import { createNet } from './net/client.js';
import {
  closeMiniApp,
  getGameProfile,
  getUserKey,
  haptic,
  loadSettings,
  loadStats,
  loadTutorialDone,
  lockLandscape,
  muteAudio,
  notifyMatchEnded,
  openLeaderboard,
  playTone,
  recordMatch,
  restorePortrait,
  resumeAudio,
  saveSettings,
  saveTutorialDone,
  startBgm,
  stopBgm,
  submitUserWinScore,
  trackClick,
  trackEvent,
  trackScreen,
} from './ait/bridge.js';

const $ = id => document.getElementById(id);

const ui = {
  home: $('screen-home'),
  settings: $('screen-settings'),
  result: $('screen-result'),
  match: $('screen-match'),
  leaderboard: $('screen-leaderboard'),
  hud: $('hud'),
  controls: $('controls'),
  state: $('state'),
  scoreboard: $('scoreboard'),
  clock: $('round-clock'),
  modal: $('modal-exit'),
  foeName: $('foe-name'),
  matchClock: $('match-clock'),
  playerHp: [...document.querySelectorAll('#player-health .hp-segment')],
  enemyHp: [...document.querySelectorAll('#enemy-health .hp-segment')],
  ammoRack: $('player-ammo'),
  splash: $('screen-splash'),
  tip: $('tutorial-tip'),
  tipStep: $('tip-step'),
  tipText: $('tip-text'),
  tutorialDone: $('tutorial-done'),
};

const TUTORIAL_STEPS = [
  { key: 'move', text: '왼쪽 스틱을 움직여 이동하세요 · PC: WASD' },
  { key: 'fire', text: '오른쪽 스틱을 당겼다 놓아 발사하세요 · PC: 마우스 클릭' },
  { key: 'reload', text: '탄환이 부족하면 장전 버튼을 누르세요 · PC: R' },
];

for (let i = 0; i < CFG.magSize; i++) {
  const img = document.createElement('img');
  img.className = 'ammo-icon';
  img.src = '/assets/ammo-cartridge-hud.png';
  img.alt = '';
  ui.ammoRack.appendChild(img);
}
const ammoIcons = [...ui.ammoRack.querySelectorAll('.ammo-icon')];

const settings = loadSettings();
$('opt-sound').checked = settings.sound;
$('opt-haptic').checked = settings.haptic;
$('opt-nickname').value = settings.nickname || 'PLAYER';
$('opt-ws').value = settings.ws || '';

const view = createRenderer($('game'));
const input = createInput(document);
const net = createNet();
let match = null;
let ai = createAi();
let screen = 'home';
let last = performance.now();
let userKey = 'local';
let nickname = 'PLAYER';
let lastMode = 'practice';
let pvpLocal = false;
let queueStarted = 0;
let lastScreen = '';
let tutorial = null;

function show(el, on) {
  el.hidden = !on;
}

function paintProfile() {
  const stats = loadStats(userKey);
  const chip = $('player-chip');
  if (!chip) return;
  const wins = Math.max(0, Number(stats.userWins) || 0);
  const games = Math.max(wins, Number(stats.userGames) || 0);
  const draws = Math.max(0, Number(stats.userDraws) || 0);
  const losses = Math.max(0, games - wins - draws);
  const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;
  const rank = Number.isInteger(stats.userRank) && stats.userRank > 0 ? `${stats.userRank}위` : '미집계';
  const drawText = draws > 0 ? ` ${draws}무` : '';
  chip.textContent = `${nickname} - 승률 ${winRate}% (${wins}승 ${losses}패${drawText}) - 순위 ${rank}`;
}

function paintLeaderboard() {
  const stats = loadStats(userKey);
  const userGames = Math.max(0, Number(stats.userGames) || 0);
  const userWins = Math.max(0, Number(stats.userWins) || 0);
  const userDraws = Math.max(0, Number(stats.userDraws) || 0);
  const userLosses = Math.max(0, userGames - userWins - userDraws);
  const ghostGames = Math.max(0, Number(stats.ghostGames) || 0);
  const ghostWins = Math.max(0, Number(stats.ghostWins) || 0);
  const ghostDraws = Math.max(0, Number(stats.ghostDraws) || 0);
  const ghostLosses = Math.max(0, ghostGames - ghostWins - ghostDraws);
  $('lb-user').textContent = `유저전 ${userWins}승 ${userLosses}패${userDraws ? ` ${userDraws}무` : ''}`;
  $('lb-ghost').textContent = `고스트 ${ghostWins}승 ${ghostLosses}패${ghostDraws ? ` ${ghostDraws}무` : ''}`;
  $('lb-practice').textContent = `연습 승리 ${Math.max(0, Number(stats.practiceWins) || 0)}`;
}

function setScreen(name) {
  screen = name;
  show(ui.home, name === 'home');
  show(ui.settings, name === 'settings');
  show(ui.result, name === 'result');
  show(ui.match, name === 'match');
  show(ui.leaderboard, name === 'leaderboard');
  const battle = name === 'battle';
  show(ui.hud, battle);
  show(ui.controls, battle);
  if (name === 'home') paintProfile();
  if (name === 'leaderboard') paintLeaderboard();
  if (name === 'home' || name === 'settings' || name === 'leaderboard') stopBgm();
  if (name !== lastScreen) {
    lastScreen = name;
    trackScreen(name);
  }
}

function banner(text) {
  ui.state.textContent = text || '';
  ui.state.classList.toggle('visible', Boolean(text));
}

function localSide() {
  return lastMode === 'pvp' ? net.state.side : 'p1';
}

function youOf(m) {
  return localSide() === 'p2' ? m.p2 : m.p1;
}

function foeOf(m) {
  return localSide() === 'p2' ? m.p1 : m.p2;
}

function paintHud(m) {
  if (!m) return;
  const you = youOf(m);
  const foe = foeOf(m);
  ui.playerHp.forEach((el, i) => el.classList.toggle('active', i < you.hp));
  ui.enemyHp.forEach((el, i) => el.classList.toggle('active', i < foe.hp));
  ammoIcons.forEach((el, i) => el.classList.toggle('spent', i >= you.ammo));
  const youScore = localSide() === 'p2' ? m.score.p2 : m.score.p1;
  const foeScore = localSide() === 'p2' ? m.score.p1 : m.score.p2;
  ui.scoreboard.textContent = `${youScore} — ${foeScore}`;
  ui.clock.textContent = m.phase === 'fight' ? String(Math.max(0, Math.ceil(m.roundTime))) : '';
  ui.foeName.textContent = m.opponentType === 'ghost'
    ? (m.opponentName || '유저 고스트')
    : m.vsAi ? 'AI' : 'P2';
  const youName = $('you-name');
  if (youName) youName.textContent = nickname.slice(0, 8);
  if (net.state.peer) banner(net.state.peer);
  else if (m.paused) banner('일시정지');
  else if (m.banner?.t > 0) {
    const text = localizeBanner(m);
    banner(text);
  } else if (m.phase === 'fight' && you.ammo === 0) banner('장전');
  else banner('');
}

function localizeBanner(m) {
  const raw = m.banner?.text || '';
  if (raw === 'FIGHT' || /^\d+$/.test(raw)) return raw;
  if (m.phase === 'matchEnd') {
    if (m.winner == null) return '무승부';
    return m.winner === localSide() ? '승리' : '패배';
  }
  if (m.phase === 'roundEnd') {
    const p1Won = raw === '라운드 승';
    const youWon = localSide() === 'p1' ? p1Won : !p1Won;
    return youWon ? '라운드 승' : '라운드 패';
  }
  return raw;
}

function startPractice() {
  lastMode = 'practice';
  pvpLocal = false;
  trackClick('practice');
  net.leave();
  match = createMatch();
  match.vsAi = true;
  ai = createAi();
  setScreen('battle');
  startBgm(settings);
  playTone(settings, 440, 0.09, 0.04);
}

function startLocalPvpFallback() {
  lastMode = 'pvp';
  pvpLocal = true;
  net.leave();
  match = createMatch();
  match.vsAi = true;
  match.opponentType = 'ai';
  match.opponentName = 'AI';
  ai = createAi();
  setScreen('battle');
  startBgm(settings);
  playTone(settings, 440, 0.09, 0.04);
}

async function startPvp() {
  lastMode = 'pvp';
  pvpLocal = false;
  trackClick('pvp');
  match = null;
  queueStarted = performance.now();
  setScreen('match');
  ui.matchClock.textContent = String(CFG.matchWait);
  startBgm(settings);
  const ok = await net.connect(userKey, nickname);
  if (!ok) startLocalPvpFallback();
}

function cancelMatch() {
  net.leave();
  match = null;
  setScreen('home');
}

function paintTip() {
  if (!tutorial) return;
  ui.tipStep.textContent = `${tutorial.step + 1} / ${TUTORIAL_STEPS.length}`;
  ui.tipText.textContent = TUTORIAL_STEPS[tutorial.step]?.text || '';
}

function clearTutorialUi() {
  show(ui.tip, false);
  ui.tutorialDone.hidden = true;
}

function startTutorial() {
  lastMode = 'tutorial';
  pvpLocal = false;
  trackClick('tutorial');
  net.leave();
  match = createMatch();
  match.vsAi = true;
  tutorial = { step: 0, moveT: 0, lastAmmo: CFG.magSize };
  clearTutorialUi();
  show(ui.tip, true);
  paintTip();
  setScreen('battle');
  startBgm(settings);
  playTone(settings, 440, 0.09, 0.04);
}

function advanceTutorial() {
  if (!tutorial) return;
  tutorial.step += 1;
  playTone(settings, 660, 0.1, 0.05);
  if (settings.haptic) haptic('light');
  if (tutorial.step >= TUTORIAL_STEPS.length) {
    saveTutorialDone();
    trackEvent('tutorial_end', { completed: true });
    show(ui.tip, false);
    ui.tutorialDone.hidden = false;
  } else {
    paintTip();
  }
}

function exitTutorial(toHome) {
  tutorial = null;
  match = null;
  clearTutorialUi();
  stopBgm();
  if (toHome) setScreen('home');
}

function showSplash(after) {
  show(ui.splash, true);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    ui.splash.classList.add('fade');
    setTimeout(() => {
      show(ui.splash, false);
      ui.splash.classList.remove('fade');
    }, 500);
    after?.();
  };
  ui.splash.addEventListener('pointerdown', finish);
  setTimeout(finish, 2200);
}

function finishMatch(m, reason) {
  if (!m) return;
  const draw = m.winner == null && !String(reason || m.lastReason || '').includes('연결');
  const win = !draw && m.winner === localSide();
  const opponentType = m.opponentType || (m.vsAi ? 'ai' : 'human');
  const userVsUser = lastMode === 'pvp' && opponentType === 'human';
  const tag = lastMode === 'pvp'
    ? opponentType === 'ghost'
      ? `유저 고스트 대전 · ${m.opponentName || '상대'}`
      : m.vsAi ? '빠른 대전 · AI 폴백' : '유저 대전'
    : '연습 대전';
  $('result-tag').textContent = tag;
  $('result-title').textContent = draw ? '무승부' : win ? '승리' : '패배';
  const youScore = localSide() === 'p2' ? m.score.p2 : m.score.p1;
  const foeScore = localSide() === 'p2' ? m.score.p1 : m.score.p2;
  $('result-score').textContent = `${youScore} — ${foeScore}`;
  const stats = recordMatch(userKey, { userVsUser, opponentType, win, draw });
  let extra = reason || m.lastReason || '';
  if (userVsUser && win) {
    extra = extra ? `${extra} · 유저전 ${stats.userWins}승` : `유저전 ${stats.userWins}승`;
    submitUserWinScore(stats.userWins).then(res => {
      if (res.ok) {
        const el = $('result-reason');
        el.textContent = `${el.textContent} · 랭킹 기록`.replace(/^ · /, '');
      }
    });
  }
  $('result-reason').textContent = extra;
  $('btn-rematch').textContent = lastMode === 'pvp' ? '다시 찾기' : '다시 연습';
  trackEvent('match_end', { mode: lastMode, vsAi: !!m.vsAi, win, draw, userWins: stats.userWins });
  stopBgm();
  setScreen('result');
  if (m.phase === 'matchEnd') notifyMatchEnded();
}

function handleEvents(events) {
  for (const ev of events) {
    const localIsP2 = localSide() === 'p2';
    if (ev.type === 'fire') {
      const mine = localIsP2 ? ev.foe : !ev.foe;
      playTone(settings, mine ? 520 : 220, 0.06, 0.05);
      if (settings.haptic && mine) haptic('light');
    }
    if (ev.type === 'hit') {
      playTone(settings, 140, 0.12, 0.07, 'sawtooth');
      if (settings.haptic) haptic('heavy');
      const hitP2 = ev.foe;
      view.flashHit(hitP2 ? view.enemy : view.player);
    }
    if (ev.type === 'roundEnd' || ev.type === 'matchEnd') {
      const isDraw = ev.winner == null;
      const youWon = ev.winner === localSide();
      playTone(settings, isDraw ? 420 : youWon ? 660 : 180, 0.18, 0.06);
      if (settings.haptic) haptic(isDraw ? 'light' : 'heavy');
    }
    if (ev.type === 'matchEnd') finishMatch(match || net.viewMatch(), ev.reason);
  }
}

function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (screen === 'match') {
    const left = Math.max(0, CFG.matchWait - (now - queueStarted) / 1000);
    ui.matchClock.textContent = String(Math.ceil(left));
    if (net.state.status === 'battle' && net.state.match) {
      match = net.viewMatch();
      setScreen('battle');
      playTone(settings, 440, 0.09, 0.04);
    } else if (net.state.status === 'error') {
      finishMatch({ winner: 'p2', score: { p1: 0, p2: 0 }, vsAi: true, lastReason: net.state.error }, net.state.error);
    }
  }

  if (screen === 'battle' && lastMode === 'pvp' && !pvpLocal) {
    const p = input.consume();
    const live = net.viewMatch(dt);
    if (live) {
      if (p.mouseAim) {
        const aimed = view.aimFromNdc(p.mouseNdc, youOf(live));
        if (aimed != null) p.aim = aimed;
      }
      net.sendInput(p, dt);
      match = net.viewMatch(dt);
      handleEvents(net.drain());
      paintHud(match);
      if (match) view.sync(match, localSide());
    }
    return requestAnimationFrame(tick);
  }

  if (screen === 'battle' && lastMode === 'tutorial') {
    if (match && !match.paused) {
      const p1 = input.consume();
      if (p1.mouseAim) {
        const aimed = view.aimFromNdc(p1.mouseNdc, match.p1);
        if (aimed != null) p1.aim = aimed;
      }
      stepMatch(match, dt, p1, { mx: 0, mz: 0, aim: null, fire: false, reload: false });
      // 더미 상대와 무한 라운드: 라운드/매치 종료가 일어나지 않게 매 프레임 복구
      match.roundTime = CFG.roundTime;
      match.p2.hp = CFG.maxHP;
      match.p2.visible = true;
      const events = drainEvents(match);
      handleEvents(events);
      if (tutorial && match.phase === 'fight') {
        const stepKey = TUTORIAL_STEPS[tutorial.step]?.key;
        if (stepKey === 'move') {
          if (match.p1.moving) tutorial.moveT += dt;
          if (tutorial.moveT >= 1) advanceTutorial();
        } else if (stepKey === 'fire') {
          if (events.some(ev => ev.type === 'fire' && !ev.foe)) advanceTutorial();
        } else if (stepKey === 'reload') {
          if (match.p1.reloading && match.p1.ammo > tutorial.lastAmmo) advanceTutorial();
        }
        tutorial.lastAmmo = match.p1.ammo;
      }
      paintHud(match);
      view.sync(match, 'p1');
    } else if (match) {
      view.sync(match, 'p1');
    }
    return requestAnimationFrame(tick);
  }

  if (screen === 'battle' && match && !match.paused) {
    const p1 = input.consume();
    if (p1.mouseAim) {
      const aimed = view.aimFromNdc(p1.mouseNdc, match.p1);
      if (aimed != null) p1.aim = aimed;
    }
    const p2 = match.phase === 'fight' ? thinkAi(ai, match.p2, match.p1, dt, match) : { mx: 0, mz: 0, aim: null, fire: false, reload: false };
    stepMatch(match, dt, p1, p2);
    handleEvents(drainEvents(match));
    paintHud(match);
    view.sync(match, 'p1');
  } else if (match) {
    view.sync(match, localSide());
  } else {
    view.sync({
      phase: 'idle',
      p1: { x: -8, z: 0, ang: Math.PI / 2, hp: 3, ammo: 6, leverT: 0, rifleTilt: 0, walkT: 0, moving: false, hitT: 0, visible: true },
      p2: { x: 8, z: 0, ang: -Math.PI / 2, hp: 3, ammo: 6, leverT: 0, rifleTilt: 0, walkT: 0, moving: false, hitT: 0, visible: true },
      bullets: [],
    });
  }

  requestAnimationFrame(tick);
}

function onVisibility() {
  const hidden = document.hidden;
  if (lastMode === 'pvp') net.setAway(hidden);
  else if (match) match.paused = hidden && screen === 'battle';
  if (hidden) muteAudio();
  else resumeAudio(settings);
}

$('btn-practice').addEventListener('click', startPractice);
$('btn-pvp').addEventListener('click', startPvp);
$('btn-cancel-match').addEventListener('click', () => {
  trackClick('cancel_match');
  cancelMatch();
});
$('btn-rematch').addEventListener('click', () => {
  trackClick('rematch');
  if (lastMode === 'pvp') startPvp();
  else startPractice();
});
$('btn-home').addEventListener('click', () => {
  trackClick('home');
  net.leave();
  match = null;
  setScreen('home');
});
$('btn-tutorial').addEventListener('click', startTutorial);
$('btn-tutorial-skip').addEventListener('click', () => {
  trackClick('tutorial_skip');
  saveTutorialDone();
  exitTutorial(true);
});
$('btn-tutorial-home').addEventListener('click', () => {
  trackClick('tutorial_home');
  exitTutorial(true);
});
$('btn-tutorial-practice').addEventListener('click', () => {
  trackClick('tutorial_practice');
  tutorial = null;
  clearTutorialUi();
  startPractice();
});
$('btn-leaderboard').addEventListener('click', async () => {
  trackClick('leaderboard');
  const opened = await openLeaderboard();
  if (!opened) setScreen('leaderboard');
});
$('btn-leaderboard-back').addEventListener('click', () => setScreen('home'));
$('btn-settings').addEventListener('click', () => {
  trackClick('settings');
  $('opt-nickname').value = settings.nickname || nickname || 'PLAYER';
  $('opt-ws').value = settings.ws || '';
  setScreen('settings');
});
$('btn-settings-back').addEventListener('click', () => {
  settings.nickname = ($('opt-nickname').value || 'PLAYER').trim().slice(0, 12) || 'PLAYER';
  settings.ws = ($('opt-ws').value || '').trim();
  nickname = settings.nickname;
  saveSettings(settings);
  setScreen('home');
});
$('opt-sound').addEventListener('change', e => {
  settings.sound = e.target.checked;
  saveSettings(settings);
  if (settings.sound) {
    resumeAudio(settings);
    if (screen === 'battle' || screen === 'match') startBgm(settings);
  } else {
    stopBgm();
    muteAudio();
  }
});
$('opt-haptic').addEventListener('change', e => {
  settings.haptic = e.target.checked;
  saveSettings(settings);
});
$('btn-close').addEventListener('click', () => { ui.modal.hidden = false; });
$('btn-exit-no').addEventListener('click', () => { ui.modal.hidden = true; });
$('btn-exit-yes').addEventListener('click', async () => {
  ui.modal.hidden = true;
  net.leave();
  await restorePortrait();
  await closeMiniApp();
  setScreen('home');
});

document.addEventListener('visibilitychange', onVisibility);

lockLandscape().then(() => {
  view.resize();
  requestAnimationFrame(() => view.resize());
  setTimeout(() => view.resize(), 200);
  setTimeout(() => view.resize(), 600);
});
Promise.all([getUserKey(), getGameProfile()]).then(([key, profile]) => {
  userKey = key;
  if (profile?.nickname) nickname = profile.nickname;
  paintProfile();
});
const bootParams = new URLSearchParams(location.search);
if (bootParams.has('practice')) {
  setScreen('home');
  startPractice();
} else if (bootParams.has('pvp')) {
  setScreen('home');
  startPvp();
} else {
  setScreen('home');
  showSplash(() => {
    if (!loadTutorialDone()) startTutorial();
  });
}
requestAnimationFrame(t => {
  last = t;
  requestAnimationFrame(tick);
});
