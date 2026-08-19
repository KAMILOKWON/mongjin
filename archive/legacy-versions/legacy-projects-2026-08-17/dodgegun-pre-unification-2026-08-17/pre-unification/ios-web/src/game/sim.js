import { CFG, WALL_VIS, WALLS } from './config.js';

export function wallFrame(w) {
  const dx = w.b[0] - w.a[0];
  const dz = w.b[1] - w.a[1];
  const len = Math.hypot(dx, dz) || 1;
  const ax = dx / len;
  const az = dz / len;
  return {
    cx: (w.a[0] + w.b[0]) * 0.5,
    cz: (w.a[1] + w.b[1]) * 0.5,
    ax,
    az,
    nx: -az,
    nz: ax,
    halfLen: len * 0.5 + w.t + WALL_VIS.endPad * 0.5,
    halfThick: w.t * WALL_VIS.thickMul * 0.5,
  };
}

function toWallLocal(f, x, z) {
  const px = x - f.cx;
  const pz = z - f.cz;
  return { u: px * f.ax + pz * f.az, v: px * f.nx + pz * f.nz };
}

function segmentHitsAabb(x1, y1, x2, y2, hl, ht) {
  if (Math.abs(x1) <= hl && Math.abs(y1) <= ht) return true;
  if (Math.abs(x2) <= hl && Math.abs(y2) <= ht) return true;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, x1 + hl) && clip(dx, hl - x1) && clip(-dy, y1 + ht) && clip(dy, ht - y1) && t0 <= t1;
}

export function resolveCircle(pos, r, walls = WALLS) {
  // Corners pin a single pass between two boxes. Repeat so the body slides out.
  for (let pass = 0; pass < 4; pass++) {
    let hit = false;
    for (const w of walls) {
      const f = wallFrame(w);
      const p = toWallLocal(f, pos.x, pos.z);
      const cu = Math.max(-f.halfLen, Math.min(f.halfLen, p.u));
      const cv = Math.max(-f.halfThick, Math.min(f.halfThick, p.v));
      const du = p.u - cu;
      const dv = p.v - cv;
      const d = Math.hypot(du, dv);
      if (d >= r) continue;
      hit = true;
      if (d < 1e-6) {
        const penU = f.halfLen - Math.abs(p.u);
        const penV = f.halfThick - Math.abs(p.v);
        if (penU < penV) {
          const s = (p.u >= 0 ? 1 : -1) * (penU + r);
          pos.x += f.ax * s;
          pos.z += f.az * s;
        } else {
          const s = (p.v >= 0 ? 1 : -1) * (penV + r);
          pos.x += f.nx * s;
          pos.z += f.nz * s;
        }
        continue;
      }
      const il = r / d;
      const nu = cu + du * il;
      const nv = cv + dv * il;
      pos.x = f.cx + f.ax * nu + f.nx * nv;
      pos.z = f.cz + f.az * nu + f.nz * nv;
    }
    if (!hit) break;
  }
}

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function dist2PointSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  const t = len2 < 1e-12 ? 0 : clamp01(((px - ax) * abx + (pz - az) * abz) / len2);
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return dx * dx + dz * dz;
}

export function segmentHit(x, z, extra, walls = WALLS) {
  for (const w of walls) {
    const f = wallFrame(w);
    const p = toWallLocal(f, x, z);
    if (Math.abs(p.u) <= f.halfLen + extra && Math.abs(p.v) <= f.halfThick + extra) return true;
  }
  return false;
}

export function pathHitsWall(x1, z1, x2, z2, extra = 0, walls = WALLS) {
  for (const w of walls) {
    const f = wallFrame(w);
    const a = toWallLocal(f, x1, z1);
    const b = toWallLocal(f, x2, z2);
    if (segmentHitsAabb(a.u, a.v, b.u, b.v, f.halfLen + extra, f.halfThick + extra)) return true;
  }
  return false;
}

function muzzleClearLead(x, z, dirX, dirZ, lead, extra, walls = WALLS) {
  const tx = x + dirX * lead;
  const tz = z + dirZ * lead;
  if (!pathHitsWall(x, z, tx, tz, extra, walls) && !segmentHit(tx, tz, extra, walls)) return lead;
  let lo = 0;
  let hi = lead;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) * 0.5;
    const mx = x + dirX * mid;
    const mz = z + dirZ * mid;
    if (pathHitsWall(x, z, mx, mz, extra, walls) || segmentHit(mx, mz, extra, walls)) hi = mid;
    else lo = mid;
  }
  return lo;
}

export function losClear(x1, z1, x2, z2, walls = WALLS) {
  return !pathHitsWall(x1, z1, x2, z2, 0, walls);
}

export function createFighter(spawn) {
  return {
    x: spawn.x,
    z: spawn.z,
    ang: spawn.ang,
    hp: CFG.maxHP,
    ammo: CFG.magSize,
    leverT: 0,
    reloadT: 0,
    reloading: false,
    hitT: 0,
    knockX: 0,
    knockZ: 0,
    walkT: 0,
    moving: false,
    rifleTilt: 0,
    visible: true,
  };
}

export function resetFighter(f, spawn) {
  f.x = spawn.x;
  f.z = spawn.z;
  f.ang = spawn.ang;
  f.hp = CFG.maxHP;
  f.ammo = CFG.magSize;
  f.leverT = 0;
  f.reloadT = 0;
  f.reloading = false;
  f.hitT = 0;
  f.knockX = 0;
  f.knockZ = 0;
  f.walkT = 0;
  f.moving = false;
  f.rifleTilt = 0;
  f.visible = true;
}

export function createMatch() {
  return {
    phase: 'countdown',
    phaseT: CFG.countdown,
    round: 1,
    score: { p1: 0, p2: 0 },
    roundTime: CFG.roundTime,
    p1: createFighter(CFG.spawnP1),
    p2: createFighter(CFG.spawnP2),
    bullets: [],
    flashes: [],
    banner: { text: '3', t: 1 },
    winner: null,
    lastReason: '',
    vsAi: true,
    opponentType: 'ai',
    opponentName: 'AI',
    paused: false,
    events: [],
  };
}

function emit(match, type, extra = {}) {
  match.events.push({ type, ...extra });
}

function spawnBullet(match, fighter, foe, spread = 0) {
  const ang = fighter.ang + spread;
  const dirX = Math.sin(ang);
  const dirZ = Math.cos(ang);
  const clear = muzzleClearLead(fighter.x, fighter.z, dirX, dirZ, CFG.muzzleLead, CFG.bulletRadius);
  match.flashes.push({
    x: fighter.x + dirX * (clear + 0.2),
    z: fighter.z + dirZ * (clear + 0.2),
    life: 0.07,
    foe,
  });
  emit(match, 'fire', { foe });
  // Never start a projectile past cover. Visual barrel can be longer than the gap to the wall.
  if (clear < CFG.muzzlePhysLead) return;
  const lead = CFG.muzzlePhysLead;
  match.bullets.push({
    x: fighter.x + dirX * lead,
    z: fighter.z + dirZ * lead,
    ox: fighter.x,
    oz: fighter.z,
    vx: dirX * CFG.bulletSpeed,
    vz: dirZ * CFG.bulletSpeed,
    life: CFG.bulletLife,
    foe,
  });
}

function tryFire(match, fighter, foe, spread = 0) {
  if (fighter.leverT > 0 || fighter.ammo <= 0) return false;
  fighter.ammo--;
  fighter.leverT = CFG.leverTime;
  fighter.reloading = false;
  fighter.reloadT = 0;
  spawnBullet(match, fighter, foe, spread);
  return true;
}

function applyHit(f, vx, vz) {
  const speed = Math.hypot(vx, vz) || 1;
  const kx = (vx / speed) * CFG.knockback;
  const kz = (vz / speed) * CFG.knockback;
  f.knockX += kx;
  f.knockZ += kz;
  f.x += kx;
  f.z += kz;
  f.hitT = CFG.hitReactTime;
  resolveCircle(f, CFG.playerRadius);
}

function decideRoundWinner(match) {
  const a = match.p1;
  const b = match.p2;
  if (a.hp > b.hp) return { winner: 'p1', reason: '체력' };
  if (b.hp > a.hp) return { winner: 'p2', reason: '체력' };
  if (a.ammo > b.ammo) return { winner: 'p1', reason: '탄약' };
  if (b.ammo > a.ammo) return { winner: 'p2', reason: '탄약' };
  return { winner: null, reason: '무승부' };
}

function endRound(match, winner, reason) {
  if (!winner) {
    match.lastReason = reason;
    match.phase = 'matchEnd';
    match.phaseT = 0;
    match.winner = null;
    match.banner = { text: '무승부', t: 2.4 };
    emit(match, 'matchEnd', { winner: null, reason, draw: true });
    return;
  }

  match.score[winner] += 1;
  match.lastReason = reason;
  match.p1.visible = match.p1.hp > 0;
  match.p2.visible = match.p2.hp > 0;
  if (match.score[winner] >= CFG.winsNeeded) {
    match.phase = 'matchEnd';
    match.phaseT = 0;
    match.winner = winner;
    match.banner = { text: winner === 'p1' ? '승리' : '패배', t: 2.4 };
    emit(match, 'matchEnd', { winner, reason });
  } else {
    match.phase = 'roundEnd';
    match.phaseT = CFG.roundEndHold;
    match.banner = { text: winner === 'p1' ? '라운드 승' : '라운드 패', t: CFG.roundEndHold };
    emit(match, 'roundEnd', { winner, reason, score: { ...match.score } });
  }
}

function beginNextRound(match) {
  match.round += 1;
  match.phase = 'countdown';
  match.phaseT = CFG.countdown;
  match.roundTime = CFG.roundTime;
  match.bullets.length = 0;
  match.flashes.length = 0;
  resetFighter(match.p1, CFG.spawnP1);
  resetFighter(match.p2, CFG.spawnP2);
  match.banner = { text: String(Math.ceil(match.phaseT)), t: 1 };
}

function stepCombat(match, dt, p1In, p2In) {
  const canAct = match.phase === 'fight';

  if (canAct && p1In?.fire) tryFire(match, match.p1, false, 0);
  if (canAct && p2In?.fire) {
    const spread = match.vsAi ? (Math.random() - 0.5) * CFG.enemySpread : 0;
    tryFire(match, match.p2, true, spread);
  }

  stepMoveAndReload(match.p1, dt, p1In, canAct);
  stepMoveAndReload(match.p2, dt, p2In, canAct);

  for (let i = match.flashes.length - 1; i >= 0; i--) {
    match.flashes[i].life -= dt;
    if (match.flashes[i].life <= 0) match.flashes.splice(i, 1);
  }

  for (let i = match.bullets.length - 1; i >= 0; i--) {
    const b = match.bullets[i];
    b.life -= dt;
    const nx = b.x + b.vx * dt;
    const nz = b.z + b.vz * dt;
    const blocked = pathHitsWall(b.x, b.z, nx, nz, CFG.bulletRadius) || segmentHit(nx, nz, CFG.bulletRadius);
    let dead = b.life <= 0;
    if (!dead && match.phase === 'fight') {
      const target = b.foe ? match.p1 : match.p2;
      const hitR = CFG.playerRadius + CFG.bulletRadius;
      const reached = dist2PointSeg(target.x, target.z, b.x, b.z, nx, nz) < hitR * hitR;
      const blockedToTarget = pathHitsWall(b.x, b.z, target.x, target.z, CFG.bulletRadius)
        || pathHitsWall(b.ox ?? b.x, b.oz ?? b.z, target.x, target.z, 0);
      if (reached && !blockedToTarget) {
        dead = true;
        target.hp -= 1;
        applyHit(target, b.vx, b.vz);
        emit(match, 'hit', { foe: !b.foe });
        if (target.hp <= 0) {
          target.hp = 0;
          target.visible = false;
          endRound(match, b.foe ? 'p2' : 'p1', '격추');
        }
      }
    }
    if (!dead && blocked) dead = true;
    b.x = nx;
    b.z = nz;
    if (dead) match.bullets.splice(i, 1);
  }
}

function stepMoveAndReload(f, dt, input, canAct) {
  f.knockX *= Math.exp(-8 * dt);
  f.knockZ *= Math.exp(-8 * dt);
  f.x += f.knockX * dt * 10;
  f.z += f.knockZ * dt * 10;

  if (f.hitT > 0) f.hitT = Math.max(0, f.hitT - dt);
  if (f.leverT > 0) f.leverT = Math.max(0, f.leverT - dt);

  let mx = 0;
  let mz = 0;
  if (canAct && input) {
    mx = input.mx || 0;
    mz = input.mz || 0;
  }
  const mag = Math.hypot(mx, mz);
  f.moving = mag > 0.08;
  if (f.moving) {
    const il = 1 / mag;
    f.x += mx * il * CFG.moveSpeed * dt;
    f.z += mz * il * CFG.moveSpeed * dt;
    f.walkT += dt;
  }

  resolveCircle(f, CFG.playerRadius);
  f.x = Math.max(-CFG.arenaX, Math.min(CFG.arenaX, f.x));
  f.z = Math.max(-CFG.arenaZ, Math.min(CFG.arenaZ, f.z));

  if (canAct && input && input.aim != null) f.ang = input.aim;

  if (canAct && input?.reload && f.ammo < CFG.magSize) {
    f.reloading = true;
    f.reloadT += dt;
    f.rifleTilt = 0.45;
    if (f.reloadT >= CFG.reloadPerBullet) {
      f.reloadT = 0;
      f.ammo++;
    }
  } else {
    f.reloadT = 0;
    if (!input?.reload) {
      f.reloading = false;
      f.rifleTilt = 0;
    }
  }
}

export function drainEvents(match) {
  const ev = match.events.splice(0, match.events.length);
  return ev;
}

export function forfeitMatch(match, winner, reason) {
  if (match.phase === 'matchEnd') return;
  match.paused = false;
  match.phase = 'matchEnd';
  match.phaseT = 0;
  match.winner = winner;
  match.lastReason = reason;
  match.banner = { text: winner === 'p1' ? '승리' : '패배', t: 2.4 };
  emit(match, 'matchEnd', { winner, reason, forfeit: true });
}

export function copyFighter(from, to) {
  const out = to || createFighter(CFG.spawnP1);
  out.x = from.x;
  out.z = from.z;
  out.ang = from.ang;
  out.hp = from.hp;
  out.ammo = from.ammo;
  out.leverT = from.leverT;
  out.reloadT = from.reloadT;
  out.reloading = from.reloading;
  out.hitT = from.hitT;
  out.knockX = from.knockX;
  out.knockZ = from.knockZ;
  out.walkT = from.walkT;
  out.moving = from.moving;
  out.rifleTilt = from.rifleTilt;
  out.visible = from.visible;
  return out;
}

export function applyLocalMove(f, dt, input) {
  stepMoveAndReload(f, dt, { ...input, fire: false }, true);
}

export function emptyInput() {
  return { mx: 0, mz: 0, aim: null, fire: false, reload: false };
}

export function stepMatch(match, dt, p1In, p2In) {
  if (match.paused || match.phase === 'matchEnd') {
    if (match.banner.t > 0) match.banner.t -= dt;
    return;
  }

  if (match.banner.t > 0) match.banner.t -= dt;

  if (match.phase === 'countdown') {
    match.phaseT -= dt;
    const n = Math.max(1, Math.ceil(match.phaseT));
    match.banner = { text: String(n), t: 0.35 };
    stepCombat(match, dt, null, null);
    if (match.phaseT <= 0) {
      match.phase = 'fight';
      match.phaseT = 0;
      match.roundTime = CFG.roundTime;
      match.banner = { text: 'FIGHT', t: 0.7 };
    }
    return;
  }

  if (match.phase === 'roundEnd') {
    match.phaseT -= dt;
    stepCombat(match, dt, null, null);
    if (match.phaseT <= 0) beginNextRound(match);
    return;
  }

  if (match.phase === 'fight') {
    match.roundTime -= dt;
    stepCombat(match, dt, p1In, p2In);
    if (match.phase === 'fight' && match.roundTime <= 0) {
      const { winner, reason } = decideRoundWinner(match);
      endRound(match, winner, `시간 종료 · ${reason}`);
    }
  }
}
