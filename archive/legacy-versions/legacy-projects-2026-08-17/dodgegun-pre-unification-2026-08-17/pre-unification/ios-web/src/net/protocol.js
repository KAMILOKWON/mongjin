export const ROOM_NAME = 'dogegeon';

export function defaultEndpoint() {
  const params = new URLSearchParams(location.search);
  if (params.get('ws')) return params.get('ws');
  try {
    const saved = JSON.parse(localStorage.getItem('dogegeon-settings') || '{}');
    const ws = String(saved.ws || '').trim();
    if (ws) return ws;
  } catch { /* ignore */ }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = location.hostname && location.hostname !== 'game' ? location.hostname : '127.0.0.1';
  const port = params.get('wsPort') || '2567';
  return `${proto}://${host}:${port}`;
}

export function slimFighter(f) {
  return {
    x: +f.x.toFixed(3),
    z: +f.z.toFixed(3),
    ang: +f.ang.toFixed(3),
    hp: f.hp,
    ammo: f.ammo,
    leverT: +f.leverT.toFixed(3),
    reloadT: +f.reloadT.toFixed(3),
    reloading: !!f.reloading,
    hitT: +f.hitT.toFixed(3),
    knockX: +f.knockX.toFixed(3),
    knockZ: +f.knockZ.toFixed(3),
    walkT: +f.walkT.toFixed(3),
    moving: !!f.moving,
    rifleTilt: +f.rifleTilt.toFixed(3),
    visible: f.visible !== false,
  };
}

export function slimBullet(b) {
  return {
    x: +b.x.toFixed(3),
    z: +b.z.toFixed(3),
    vx: +b.vx.toFixed(3),
    vz: +b.vz.toFixed(3),
    life: +b.life.toFixed(3),
    foe: !!b.foe,
  };
}

export function slimMatch(match) {
  return {
    t: Date.now(),
    phase: match.phase,
    phaseT: match.phaseT,
    round: match.round,
    score: { ...match.score },
    roundTime: match.roundTime,
    p1: slimFighter(match.p1),
    p2: slimFighter(match.p2),
    bullets: match.bullets.map(slimBullet),
    banner: match.banner,
    winner: match.winner,
    lastReason: match.lastReason,
    vsAi: !!match.vsAi,
    opponentType: match.opponentType || (match.vsAi ? 'ai' : 'human'),
    opponentName: String(match.opponentName || (match.vsAi ? 'AI' : 'P2')).slice(0, 12),
    paused: !!match.paused,
  };
}

export function sanitizeInput(raw) {
  const mx = clampNum(raw?.mx, -1, 1);
  const mz = clampNum(raw?.mz, -1, 1);
  const aim = raw?.aim == null || !Number.isFinite(+raw.aim) ? null : +raw.aim;
  return {
    seq: raw?.seq | 0,
    mx,
    mz,
    aim,
    fire: !!raw?.fire,
    reload: !!raw?.reload,
  };
}

function clampNum(v, lo, hi) {
  const n = +v;
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}
