import { CFG } from './config.js';
import { pathHitsWall, segmentHit } from './sim.js';

const R = CFG.playerRadius;
const BULLET_PAD = CFG.bulletRadius;
const HIT_PAD = R + CFG.bulletRadius + 0.34;

// 열린 동쪽 홀드. 벽 끝 구석(0.2, ±9.7)과 중앙 갭은 끼이므로 쓰지 않는다.
const HOLD = [
  { x: 6.8, z: 4.2, role: 'lane' },
  { x: 6.8, z: -4.2, role: 'lane' },
  { x: 3.6, z: 6.4, role: 'swing' },
  { x: 3.6, z: -6.4, role: 'swing' },
  { x: 2.6, z: 4.8, role: 'cover' },
  { x: 2.6, z: -4.8, role: 'cover' },
  { x: 10.3, z: 5.0, role: 'cover' },
  { x: 10.3, z: -5.0, role: 'cover' },
  { x: 8.4, z: 3.6, role: 'mid' },
  { x: 8.4, z: -3.6, role: 'mid' },
  { x: 4.8, z: 8.0, role: 'swing' },
  { x: 4.8, z: -8.0, role: 'swing' },
  { x: 3.4, z: 2.4, role: 'peek' },
  { x: 3.4, z: -2.4, role: 'peek' },
];

const PUSH = [
  { x: -3.4, z: 2.4 },
  { x: -3.4, z: -2.4 },
  { x: -4.8, z: 3.2 },
  { x: -4.8, z: -3.2 },
  { x: -5.6, z: 1.5 },
  { x: -5.6, z: -1.5 },
  { x: -6.4, z: 4.2 },
  { x: -6.4, z: -4.2 },
];

const WAYPOINTS = [
  { x: 6.5, z: 8.4 },
  { x: 6.5, z: -8.4 },
  { x: 8.5, z: 0 },
  { x: 4.4, z: 7.2 },
  { x: 4.4, z: -7.2 },
  { x: 10.0, z: 2.2 },
  { x: 10.0, z: -2.2 },
  { x: 3.6, z: 9.35 },
  { x: 3.6, z: -9.35 },
  { x: -3.6, z: 9.35 },
  { x: -3.6, z: -9.35 },
  { x: -6.5, z: 8.4 },
  { x: -6.5, z: -8.4 },
  { x: -10.2, z: -8.2 },
  { x: -10.2, z: 8.2 },
  { x: 10.2, z: -8.2 },
  { x: 10.2, z: 8.2 },
  { x: -10.2, z: 0 },
  { x: 10.2, z: 0 },
];

// Behind the north/south wall tips. Walkable, used to cross without entering the S pinch.
const LANE_Z = 9.35;
const LANE_GATE = 3.6;

const FLANK = [
  { x: 3.6, z: 9.35, role: 'flank' },
  { x: 3.6, z: -9.35, role: 'flank' },
  { x: -3.6, z: 9.35, role: 'flank' },
  { x: -3.6, z: -9.35, role: 'flank' },
  { x: 6.5, z: 8.4, role: 'flank' },
  { x: 6.5, z: -8.4, role: 'flank' },
  { x: -6.5, z: 8.4, role: 'flank' },
  { x: -6.5, z: -8.4, role: 'flank' },
  { x: 10.2, z: 8.2, role: 'flank' },
  { x: 10.2, z: -8.2, role: 'flank' },
  { x: -10.2, z: 8.2, role: 'flank' },
  { x: -10.2, z: -8.2, role: 'flank' },
  { x: 10.2, z: 1.6, role: 'flank' },
  { x: 10.2, z: -1.6, role: 'flank' },
  { x: -10.2, z: 1.6, role: 'flank' },
  { x: -10.2, z: -1.6, role: 'flank' },
];

export function createAi() {
  return {
    t: 0,
    round: -1,
    aimT: 0,
    seenT: 0,
    reloading: false,
    reloadTarget: CFG.magSize,
    destX: 6.8,
    destZ: 4.2,
    idleT: 0,
    patrol: 0,
    destIntent: 'peek',
    intent: 'peek',
    intentHoldT: 0,
    commitT: 0.9,
    retargetT: 0,
    lastFoeX: null,
    lastFoeZ: null,
    lastSeenX: CFG.spawnP1.x,
    lastSeenZ: CFG.spawnP1.z,
    lastFoeHp: CFG.maxHP,
    foeVx: 0,
    foeVz: 0,
    hideT: 0,
    strafeDir: 1,
    strafeT: 0.4,
    peekFlip: 1,
    peekStreak: 0,
    fakePeek: false,
    fakeArmed: false,
    lastX: CFG.spawnP2.x,
    lastZ: CFG.spawnP2.z,
    stuckT: 0,
    lastSelfHp: CFG.maxHP,
    clear: false,
    dwellT: 0,
    campT: 0,
    blindT: 0,
    home: 1,
  };
}

export function thinkAi(ai, self, foe, dt, world) {
  const input = { mx: 0, mz: 0, aim: null, fire: false, reload: false };
  if (!self.visible || self.hp <= 0) return input;

  const dtClamped = Math.max(1e-4, dt);
  syncRound(ai, self, world);
  perceive(ai, self, foe, dtClamped);
  const destDist = Math.hypot(self.x - ai.destX, self.z - ai.destZ);
  ai.dwellT = destDist < 0.75 && !ai.clear ? ai.dwellT + dtClamped : 0;
  ai.idleT = destDist < 0.4 ? ai.idleT + dtClamped : 0;

  const threat = findThreat(self, world);
  if (threat) ai.hideT = Math.max(ai.hideT, 0.3);
  const intent = commitIntent(ai, pickIntent(ai, self, foe, world), dtClamped, self, threat);
  let dest = pickDest(ai, self, foe, intent, dtClamped);
  const holding = intent === 'rush' || intent === 'home' || intent === 'defend';
  if (inPinch(self.x, self.z)) {
    dest = forceDest(ai, escapeDest(self));
  } else if (!holding && inTipPocket(self.x, self.z) && ai.stuckT > 0.22) {
    dest = forceDest(ai, escapeDest(self));
  } else if (!holding && intent !== 'fight' && ai.idleT > 0.55) {
    dest = forceDest(ai, nextPatrol(ai, self));
  }
  const nav = navTarget(self, dest, intent);

  if (threat) {
    input.mx = threat.mx;
    input.mz = threat.mz;
  } else {
    const step = steer(self, nav.x, nav.z);
    input.mx = step.mx;
    input.mz = step.mz;
  }

  if (wantReload(ai, self, foe, intent, threat)) {
    input.reload = true;
    if (self.ammo >= ai.reloadTarget) ai.reloading = false;
  } else {
    ai.reloading = false;
  }

  input.aim = computeAim(ai, self, foe);

  if (!input.reload && shouldFire(ai, self, foe, input.aim)) {
    input.fire = true;
    const tagged = foe.hp < ai.lastFoeHp;
    const punish = foe.reloading || foe.ammo <= 0 || foe.hp <= 1;
    ai.hideT = punish || tagged ? 0.06 : 0.22 + Math.random() * 0.1;
    if (ai.peekStreak >= 1 && !tagged) ai.peekFlip *= -1;
    ai.peekStreak = tagged ? 0 : ai.peekStreak + 1;
    ai.aimT = 0;
    const home = ai.home || 1;
    const sx = intent === 'defend' || intent === 'home' ? home : self.x >= 0 ? 1 : -1;
    forceDest(ai, {
      x: clamp(Math.max(Math.abs(self.x), 3.2) * sx, -CFG.arenaX + 0.4, CFG.arenaX - 0.4),
      z: clamp(self.z + 2.1 * ai.strafeDir, -8.2, 8.2),
    });
  }

  rememberMove(ai, self, input, dtClamped);
  ai.lastFoeHp = foe.hp;
  return input;
}

function syncRound(ai, self, world) {
  const round = world?.round ?? 0;
  const reset = round !== ai.round || (self.hp > ai.lastSelfHp && self.hp === CFG.maxHP);
  if (!reset) {
    ai.lastSelfHp = self.hp;
    return;
  }
  const sign = self.x >= 0 ? 1 : -1;
  ai.home = sign;
  ai.round = round;
  ai.aimT = 0;
  ai.seenT = 0;
  ai.reloading = false;
  ai.reloadTarget = CFG.magSize;
  ai.peekFlip = Math.random() < 0.5 ? 1 : -1;
  ai.peekStreak = 0;
  ai.patrol = Math.floor(Math.random() * HOLD.length);
  ai.destX = HOLD[ai.patrol].x * sign;
  ai.destZ = HOLD[ai.patrol].z;
  ai.idleT = 0;
  ai.destIntent = 'peek';
  ai.intent = 'peek';
  ai.intentHoldT = 0.4;
  ai.commitT = 0.9;
  ai.retargetT = 0;
  ai.lastFoeX = null;
  ai.lastFoeZ = null;
  ai.lastSeenX = world?.p1 === self ? CFG.spawnP2.x : CFG.spawnP1.x;
  ai.lastSeenZ = 0;
  ai.lastFoeHp = CFG.maxHP;
  ai.foeVx = 0;
  ai.foeVz = 0;
  ai.hideT = 0;
  ai.strafeDir = ai.peekFlip;
  ai.strafeT = 0.3;
  ai.fakePeek = false;
  ai.fakeArmed = false;
  ai.stuckT = 0;
  ai.lastX = self.x;
  ai.lastZ = self.z;
  ai.lastSelfHp = self.hp;
  ai.clear = false;
  ai.dwellT = 0;
  ai.idleT = 0;
  ai.campT = 0;
  ai.blindT = 0;
}

function perceive(ai, self, foe, dt) {
  ai.t += dt;
  ai.hideT = Math.max(0, ai.hideT - dt);
  ai.strafeT -= dt;

  if (ai.lastFoeX == null) {
    ai.foeVx = 0;
    ai.foeVz = 0;
  } else {
    const blend = 1 - Math.exp(-16 * dt);
    const vx = clamp((foe.x - ai.lastFoeX) / dt, -CFG.moveSpeed, CFG.moveSpeed);
    const vz = clamp((foe.z - ai.lastFoeZ) / dt, -CFG.moveSpeed, CFG.moveSpeed);
    ai.foeVx += (vx - ai.foeVx) * blend;
    ai.foeVz += (vz - ai.foeVz) * blend;
  }
  ai.lastFoeX = foe.x;
  ai.lastFoeZ = foe.z;

  ai.clear = shotClear(self.x, self.z, foe.x, foe.z);
  const spd = Math.hypot(ai.foeVx, ai.foeVz);
  ai.campT = spd < 1.6 ? ai.campT + dt : Math.max(0, ai.campT - dt * 2);
  if (ai.clear && foe.visible) {
    ai.seenT += dt;
    ai.aimT += dt;
    ai.blindT = 0;
    ai.lastSeenX = foe.x;
    ai.lastSeenZ = foe.z;
  } else {
    ai.seenT = 0;
    ai.blindT += dt;
    ai.aimT = Math.max(0, ai.aimT - dt * 2.4);
  }
}

function pickIntent(ai, self, foe, world) {
  const ammo = self.ammo;
  const vuln = foeVulnerable(foe);
  const threat = foeThreatening(foe);
  const clock = world?.roundTime ?? CFG.roundTime;
  const losingClock =
    clock < 9 && (self.hp < foe.hp || (self.hp === foe.hp && ammo < foe.ammo));

  if (consumeFake(ai)) return 'cover';

  if (ammo === 0) return 'reload';
  const home = ai.home || 1;
  const invading = foe.x * home > 1.2;
  const comingOver = Math.abs(foe.x) < 2.4 && ai.foeVx * home > 0.6;
  const foeAway = foe.x * home < -1.8;
  const IamAway = self.x * home < -1.2;

  if (invading || comingOver) {
    if (IamAway) return 'home';
    if (ai.clear && ammo >= 1) return 'fight';
    return ammo >= 1 ? 'defend' : 'reload';
  }

  if (losingClock && ammo >= 1) return ai.clear ? 'fight' : 'rush';
  if (IamAway && ammo >= 1) return ai.clear ? 'fight' : 'rush';
  if (foeAway && ammo >= 2 && !ai.clear && (ai.campT > 0.55 || ai.blindT > 0.85)) return 'rush';
  if (ai.hideT > 0 && !vuln) return 'cover';

  // 열린 각에 0.28초 이상 서 있으면 맞는다. 쏘지 못했어도 숨는다.
  if (ai.clear && ai.seenT > 0.28 && !vuln && !losingClock) {
    if (ai.hideT <= 0) ai.peekStreak += 1;
    ai.hideT = Math.max(ai.hideT, 0.32);
    return 'cover';
  }

  if (vuln && ammo >= 1) {
    if ((foe.reloading || foe.ammo <= 0) && !ai.clear) return 'rush';
    return ai.clear ? 'fight' : 'peek';
  }
  if (self.hp === 1 && foe.hp >= 2 && threat && !ai.clear && ammo <= 2) return 'reload';
  if (ammo <= 1 && !ai.clear && !vuln) return 'reload';
  if (!ai.clear && ai.dwellT > 0.32) {
    ai.hideT = Math.max(ai.hideT, 0.28);
    return 'cover';
  }
  if (ammo >= 3 && foeVulnerable(foe) && !ai.clear && ai.peekStreak >= 2) return 'rush';
  if (ai.peekStreak >= 3 && ammo >= 4 && foe.moving && foeVulnerable(foe)) return 'rush';
  if (ai.clear && ammo >= 1) return 'fight';
  if (ammo >= 1) {
    armFakePeek(ai);
    return 'peek';
  }
  return 'reload';
}

function foeVulnerable(foe) {
  return foe.reloading || foe.ammo <= 0 || foe.leverT > 0.36;
}

function foeThreatening(foe) {
  return foe.ammo > 0 && !foe.reloading && foe.leverT < 0.26;
}

function armFakePeek(ai) {
  if (ai.fakeArmed) return;
  ai.fakeArmed = true;
  ai.fakePeek = Math.random() < 0.12;
}

function consumeFake(ai) {
  if (!ai.fakePeek) {
    if (ai.destIntent !== 'peek') ai.fakeArmed = false;
    return false;
  }
  if (ai.clear && ai.seenT > 0.1) {
    ai.fakePeek = false;
    ai.hideT = 0.34;
    return true;
  }
  return false;
}

function commitIntent(ai, next, dt, self, threat) {
  const emergency =
    !!threat ||
    (next === 'reload' && self.ammo === 0) ||
    (next === 'cover' && ai.hideT > 0.05) ||
    next === 'rush' ||
    next === 'home' ||
    next === 'defend';
  if (next === ai.intent) {
    ai.intentHoldT = Math.max(0, ai.intentHoldT - dt);
    return next;
  }
  if (!emergency && ai.intentHoldT > 0) {
    ai.intentHoldT -= dt;
    return ai.intent;
  }
  ai.intent = next;
  ai.intentHoldT = next === 'rush' || next === 'home' ? 1.8 : next === 'defend' ? 0.9 : next === 'fight' ? 0.35 : 0.72;
  return next;
}

function pickDest(ai, self, foe, intent, dt) {
  ai.retargetT -= dt;
  ai.commitT = Math.max(0, ai.commitT - dt);
  if (intent === 'fight' && ai.strafeT <= 0) {
    ai.strafeDir *= -1;
    ai.strafeT = 0.28 + Math.random() * 0.28;
  }

  const destDist = Math.hypot(self.x - ai.destX, self.z - ai.destZ);
  const arrived = destDist < 0.16;
  const traveling = destDist > 1.4 && ai.commitT > 0 && ai.stuckT < 0.35;
  if (traveling && ai.destIntent === intent) return { x: ai.destX, z: ai.destZ };

  const stale = ai.retargetT <= 0 || ai.destIntent !== intent || arrived || ai.stuckT > 0.32;
  if (!stale) return { x: ai.destX, z: ai.destZ };

  const spots = collectSpots(self, intent, foe, ai.home || 1);
  let best = { x: self.x, z: self.z };
  let bestS = -1e9;
  for (let i = 0; i < spots.length; i++) {
    const p = spots[i];
    let s = scoreSpot(p, self, foe, ai, intent);
    const jump = Math.hypot(p.x - ai.destX, p.z - ai.destZ);
    const seeHere = shotClear(p.x, p.z, foe.x, foe.z);
    if (jump < 0.4) s += arrived && !seeHere ? -6 : 3.2;
    if (arrived && !seeHere && Math.hypot(p.x - self.x, p.z - self.z) < 0.4) s -= 8;
    if (jump > 7 && !arrived && intent !== 'rush' && intent !== 'home') s -= 8;
    if (Math.sign(p.z || 1) === Math.sign(self.z || 1)) s += 2.4;
    if (s > bestS) {
      bestS = s;
      best = p;
    }
  }

  const jump = Math.hypot(best.x - ai.destX, best.z - ai.destZ);
  ai.destX = best.x;
  ai.destZ = best.z;
  ai.destIntent = intent;
  ai.commitT = jump > 3 ? 1.05 : intent === 'defend' || intent === 'home' ? 0.9 : 0.55;
  ai.retargetT = intent === 'fight' ? 0.28 : intent === 'defend' ? 0.7 : 0.55;
  return best;
}

function inPinch(x, z) {
  return Math.abs(x) < 2.4 && Math.abs(z) < 2.8;
}

function inTipPocket(x, z) {
  return Math.abs(z) > 8.4 && Math.abs(x) < 2.2;
}

function inTrap(x, z) {
  return inTipPocket(x, z) || inPinch(x, z);
}

function escapeDest(self) {
  const sx = self.x >= 0 ? 1 : -1;
  const sz = self.z >= 0 ? 1 : -1;
  return { x: 7.2 * sx, z: 4.4 * sz };
}

function nextPatrol(ai, self) {
  const sign = self.x >= 0 ? 1 : -1;
  ai.patrol = (ai.patrol + 1) % HOLD.length;
  ai.idleT = 0;
  return { x: HOLD[ai.patrol].x * sign, z: HOLD[ai.patrol].z };
}

function forceDest(ai, dest) {
  ai.destX = dest.x;
  ai.destZ = dest.z;
  ai.commitT = 0.7;
  ai.retargetT = 0.45;
  ai.idleT = 0;
  return dest;
}

function collectSpots(self, intent, foe, home = 1) {
  const sign = self.x >= 0 ? 1 : -1;
  const spots = [{ x: self.x, z: self.z }];

  if (intent !== 'rush') {
    const holdSign = intent === 'home' || intent === 'defend' ? home : sign;
    for (const p of HOLD) {
      const q = { x: Math.abs(p.x) * holdSign, z: p.z, role: p.role };
      if (canOccupy(q.x, q.z) && !inTrap(q.x, q.z)) spots.push(q);
    }
  }

  if (intent === 'rush' || intent === 'punish') {
    const foeSign = (foe?.x ?? -1) >= 0 ? 1 : -1;
    for (const p of PUSH) {
      const q = { x: Math.abs(p.x) * foeSign, z: p.z, role: 'push' };
      if (canOccupy(q.x, q.z) && !inTrap(q.x, q.z)) spots.push(q);
    }
    if (foe) {
      const away = foe.x >= 0 ? -4.4 : 4.4;
      spots.push({ x: foe.x + away, z: foe.z + 2.3, role: 'push' });
      spots.push({ x: foe.x + away, z: foe.z - 2.3, role: 'push' });
    }
    for (const p of FLANK) {
      if (canOccupy(p.x, p.z) && !inTrap(p.x, p.z)) spots.push(p);
    }
  }

  const laterals = [
    { x: self.x, z: clamp(self.z + 1.8 * (self.z >= 0 ? 1 : -1), -CFG.arenaZ + 0.4, CFG.arenaZ - 0.4) },
    { x: self.x, z: clamp(self.z - 1.8 * (self.z >= 0 ? 1 : -1), -CFG.arenaZ + 0.4, CFG.arenaZ - 0.4) },
    { x: clamp(self.x + sign * 0.9, -CFG.arenaX + 0.3, CFG.arenaX - 0.3), z: self.z },
    { x: clamp(self.x - sign * 1.2, -CFG.arenaX + 0.3, CFG.arenaX - 0.3), z: self.z },
  ];
  if (intent === 'peek' || intent === 'fight') {
    laterals.push({ x: self.x, z: clamp(self.z + 2.4 * (self.z >= 0 ? -1 : 1), -8.2, 8.2), role: 'lane' });
    laterals.push({ x: clamp(self.x + sign * 2.2, sign > 0 ? 2.4 : -13, sign > 0 ? 13 : -2.4), z: self.z, role: 'lane' });
  }
  for (const p of laterals) {
    if (canOccupy(p.x, p.z) && !inTrap(p.x, p.z)) spots.push(p);
  }
  return spots;
}

function scoreSpot(p, self, foe, ai, intent) {
  if (!canOccupy(p.x, p.z) || inTrap(p.x, p.z)) return -1e9;
  const travel = Math.hypot(p.x - self.x, p.z - self.z);
  const range = Math.hypot(p.x - foe.x, p.z - foe.z);
  const seeNow = shotClear(p.x, p.z, foe.x, foe.z);
  const seeLast = shotClear(p.x, p.z, ai.lastSeenX, ai.lastSeenZ);
  const duck = !shotClear(p.x + Math.sign(p.x || 1) * 1.1, p.z, foe.x, foe.z);
  let s = -travel * 0.32;
  if (intent !== 'rush' && Math.abs(p.z) < 2.2) s -= 6;
  if (Math.abs(p.x) < 2.8 && Math.abs(p.z) < 3.2) s -= 10;
  if (inTrap(p.x, p.z)) s -= 20;

  if (intent === 'cover' || intent === 'reload') {
    s += seeNow ? -14 : 12;
    if (p.role === 'duck' || p.role === 'cover') s += 3.2;
    if (Math.sign(p.z || 1) === Math.sign(self.z || 1)) s += 4.5;
    s += Math.abs(p.z) > 7.5 && Math.abs(self.z) > 7 ? 1.2 : 0;
  } else if (intent === 'peek') {
    s += seeNow || seeLast ? 14 : -5;
    if ((seeNow || seeLast) && duck) s += 5;
    if (p.role === 'peek') s += 3.4;
    if (p.role === 'push' && seeNow) s += 2.2;
    s += Math.sign(p.z || 1) === Math.sign(self.z || ai.peekFlip) ? 3.4 : -3.2;
    if (range > 6 && range < 20) s += 1.6;
  } else if (intent === 'fight') {
    s += seeNow ? 12 : -10;
    s += Math.sign(p.z - self.z || ai.strafeDir) === ai.strafeDir ? 2.2 : 0;
    if (p.role === 'peek' && seeNow) s += 2.5;
    if (range < 3.4) s -= 3.2;
    if (duck) s += 1.2;
  } else if (intent === 'punish') {
    s += seeNow || seeLast ? 11 : -2;
    s -= range * 0.22;
    if (p.role === 'peek' || p.role === 'gap') s += 1.5;
  } else if (intent === 'rush') {
    s += seeNow ? 12 : -4;
    s -= range * 0.45;
    if (p.role === 'flank' && (seeNow || seeLast)) s += 7;
    if (p.role === 'flank' && Math.abs(foe.x) > 8 && Math.sign(p.x || 1) === Math.sign(foe.x || 1) && Math.abs(p.x) > 8) s += 6;
    if (p.role === 'push' && seeNow) s += 4;
    if (p.role === 'push' && !seeNow) s -= 3;
    if (range < 3.3) s -= 4;
    if (range > 5 && range < 12 && seeNow) s += 4;
  } else if (intent === 'home') {
    s += Math.abs(p.x) > 5 ? 8 : -2;
    s += seeNow ? 2 : 0;
    if (p.role === 'cover' || p.role === 'lane') s += 3;
  } else if (intent === 'defend') {
    s += seeNow ? 12 : -1;
    if (range > 4 && range < 12) s += 4;
    if (range < 3) s -= 5;
    if (p.role === 'cover' || p.role === 'swing' || p.role === 'lane') s += 2.5;
    s += Math.abs(p.x) > 3.5 ? 2 : -3;
  }
  return s;
}

function wantReload(ai, self, foe, intent, threat) {
  if (self.ammo >= CFG.magSize) {
    ai.reloading = false;
    return false;
  }
  const safe = !ai.clear || foe.reloading || foe.ammo <= 0 || !!threat;
  if (!ai.reloading) {
    if (self.ammo === 0) {
      ai.reloading = true;
      ai.reloadTarget = CFG.magSize;
    } else if (intent === 'reload' || (safe && self.ammo <= 3 && !foeThreatening(foe))) {
      ai.reloading = true;
      ai.reloadTarget = CFG.magSize;
    } else {
      return false;
    }
  }
  if (ai.clear && self.ammo >= 2 && foeThreatening(foe) && !threat) {
    ai.reloading = false;
    return false;
  }
  return self.ammo < ai.reloadTarget;
}

function computeAim(ai, self, foe) {
  const pred = predictImpact(ai, self, foe);
  if (pred.clear || ai.clear) return Math.atan2(pred.x - self.x, pred.z - self.z);
  return Math.atan2(ai.lastSeenX - self.x, ai.lastSeenZ - self.z);
}

function shouldFire(ai, self, foe, aim) {
  if (self.ammo <= 0 || self.leverT > 0 || !foe.visible || foe.hp <= 0) return false;

  const pred = predictImpact(ai, self, foe);
  if (!pred.clear && !ai.clear) return false;
  if (!pred.clear && pred.miss > CFG.playerRadius * 0.85) return false;

  const dirX = Math.sin(aim);
  const dirZ = Math.cos(aim);
  const mx = self.x + dirX * Math.min(1.1, CFG.muzzleLead);
  const mz = self.z + dirZ * Math.min(1.1, CFG.muzzleLead);
  if (segmentHit(mx, mz, CFG.bulletRadius * 1.8)) return false;

  const firstSight = ai.seenT < 0.18;
  const needed = firstSight ? Math.max(0.06, CFG.enemyAimDelay * 0.45) : 0.035;
  return ai.aimT >= needed;
}

function predictImpact(ai, self, foe) {
  let best = {
    x: foe.x,
    z: foe.z,
    clear: shotClear(self.x, self.z, foe.x, foe.z),
    miss: 99,
  };

  for (let step = 1; step <= 14; step++) {
    const t = step * 0.05;
    const px = clamp(foe.x + ai.foeVx * t, -CFG.arenaX, CFG.arenaX);
    const pz = clamp(foe.z + ai.foeVz * t, -CFG.arenaZ, CFG.arenaZ);
    if (!shotClear(self.x, self.z, px, pz)) continue;
    const dist = Math.hypot(px - self.x, pz - self.z);
    const fly = Math.max(0.02, (dist - CFG.muzzleLead) / CFG.bulletSpeed);
    const miss = Math.abs(fly - t);
    if (miss < best.miss) best = { x: px, z: pz, clear: true, miss };
  }
  return best;
}

function findThreat(self, world) {
  const bullets = world?.bullets;
  if (!bullets || !bullets.length) return null;

  const iAmP1 = world.p1 === self;
  let best = null;
  let bestCost = 0;

  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (b.foe !== iAmP1) continue;
    const sp2 = b.vx * b.vx + b.vz * b.vz;
    if (sp2 < 1e-6) continue;

    const rx = self.x - b.x;
    const rz = self.z - b.z;
    let t = -(rx * b.vx + rz * b.vz) / sp2;
    if (t < -0.05 || t > 0.95) continue;
    t = Math.max(0, t);

    const cx = b.x + b.vx * t;
    const cz = b.z + b.vz * t;
    const ox = cx - self.x;
    const oz = cz - self.z;
    const miss = Math.hypot(ox, oz);
    if (miss > HIT_PAD) continue;
    if (pathHitsWall(b.x, b.z, cx, cz, BULLET_PAD)) continue;

    const cost = (HIT_PAD - miss + 0.08) / Math.max(0.05, t);
    if (cost <= bestCost) continue;

    const speed = Math.sqrt(sp2);
    let dx = -b.vz / speed;
    let dz = b.vx / speed;
    let side = ox * dx + oz * dz;
    if (Math.abs(side) < 0.04) side = self.z >= 0 ? 1 : -1;
    else side = side >= 0 ? 1 : -1;
    dx *= side;
    dz *= side;

    if (!stepOk(self, dx, dz)) {
      dx = -dx;
      dz = -dz;
    }
    if (!stepOk(self, dx, dz)) {
      const away = Math.hypot(rx, rz) || 1;
      dx = rx / away;
      dz = rz / away;
    }

    const awayN = Math.hypot(rx, rz) || 1;
    dx += (rx / awayN) * 0.2;
    dz += (rz / awayN) * 0.2;
    best = { mx: dx, mz: dz };
    bestCost = cost;
  }
  return best;
}

function pickLaneZ(self, dest) {
  const prefer = Math.abs(dest.z) >= 2 ? dest.z : self.z;
  return (prefer >= 0 ? 1 : -1) * LANE_Z;
}

function navTarget(self, dest, intent) {
  const needCross = dest.x * self.x < 0 && Math.abs(dest.x) > 1.1 && Math.abs(self.x) > 0.7;
  if (needCross || ((intent === 'rush' || intent === 'home') && dest.x * (self.x || 1) < 0)) {
    const laneZ = pickLaneZ(self, dest);
    const toward = dest.x >= 0 ? 1 : -1;
    if (self.x * toward < -0.4) {
      if (Math.abs(self.x) > LANE_GATE + 0.15) {
        return { x: Math.sign(self.x || -toward) * LANE_GATE, z: laneZ };
      }
      return { x: toward * LANE_GATE, z: laneZ };
    }
  }
  const sideFlip = Math.sign(self.z || 1) !== Math.sign(dest.z || 1) && Math.abs(self.z) > 1.2 && Math.abs(dest.z) > 1.2;
  if (sideFlip && intent !== 'rush') {
    const sx = self.x >= 0 ? 1 : -1;
    return { x: 11.2 * sx, z: dest.z };
  }
  if (!blockedPath(self.x, self.z, dest.x, dest.z)) return dest;

  let best = dest;
  let bestS = -1e9;
  const before = Math.hypot(dest.x - self.x, dest.z - self.z);
  for (const w of WAYPOINTS) {
    if (!canOccupy(w.x, w.z)) continue;
    const here = Math.hypot(w.x - self.x, w.z - self.z);
    if (here < 0.55) continue;
    const selfClear = !blockedPath(self.x, self.z, w.x, w.z);
    const destClear = !blockedPath(w.x, w.z, dest.x, dest.z);
    if (!selfClear && here > 2.5) continue;
    const remain = Math.hypot(dest.x - w.x, dest.z - w.z);
    let s = -remain - here * 0.18 + (before - remain) * 1.6;
    if (selfClear) s += 8;
    if (destClear) s += 7;
    if (s > bestS) {
      bestS = s;
      best = w;
    }
  }
  return best;
}

function steer(self, tx, tz) {
  const dx = tx - self.x;
  const dz = tz - self.z;
  if (dx * dx + dz * dz < 0.01) return { mx: 0, mz: 0 };

  const base = Math.atan2(dx, dz);
  let best = { mx: Math.sin(base), mz: Math.cos(base) };
  let bestS = -1e9;
  for (let i = 0; i < 16; i++) {
    const k = i === 0 ? 0 : (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2);
    const a = base + k * 0.26;
    const mx = Math.sin(a);
    const mz = Math.cos(a);
    if (!stepOk(self, mx, mz)) continue;
    const nx = self.x + mx * 0.55;
    const nz = self.z + mz * 0.55;
    const remain = Math.hypot(tx - nx, tz - nz);
    const score = -remain - Math.abs(k) * 0.22;
    if (score > bestS) {
      bestS = score;
      best = { mx, mz };
    }
  }
  if (bestS > -1e8) return best;

  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const mx = Math.sin(a);
    const mz = Math.cos(a);
    if (!stepOk(self, mx, mz)) continue;
    const nx = self.x + mx * 0.28;
    const nz = self.z + mz * 0.28;
    const score = -Math.hypot(tx - nx, tz - nz);
    if (score > bestS) {
      bestS = score;
      best = { mx, mz };
    }
  }
  return bestS > -1e8 ? best : { mx: 0, mz: 0 };
}

function rememberMove(ai, self, input, dt) {
  const moved = Math.hypot(self.x - ai.lastX, self.z - ai.lastZ);
  ai.stuckT = moved < 0.06 ? ai.stuckT + dt : 0;
  if (ai.stuckT > 0.4) {
    if (inTrap(self.x, self.z)) {
      forceDest(ai, escapeDest(self));
    } else if (ai.intent === 'rush') {
      const sz = self.z >= 0 ? 1 : -1;
      forceDest(ai, { x: clamp(self.x + (self.x >= 0 ? -2.2 : 2.2), -11.2, 11.2), z: LANE_Z * sz });
    } else {
      forceDest(ai, nextPatrol(ai, self));
    }
    ai.stuckT = 0;
  }
  ai.lastX = self.x;
  ai.lastZ = self.z;
}

function shotClear(x1, z1, x2, z2) {
  return !pathHitsWall(x1, z1, x2, z2, BULLET_PAD);
}

function blockedPath(x1, z1, x2, z2) {
  return pathHitsWall(x1, z1, x2, z2, R * 0.72);
}

function canOccupy(x, z) {
  if (Math.abs(x) > CFG.arenaX - 0.2 || Math.abs(z) > CFG.arenaZ - 0.2) return false;
  return !segmentHit(x, z, R);
}

function stepOk(self, mx, mz) {
  const mag = Math.hypot(mx, mz) || 1;
  const ux = mx / mag;
  const uz = mz / mag;
  for (const dist of [0.16, 0.28, 0.5, 0.78]) {
    const nx = self.x + ux * dist;
    const nz = self.z + uz * dist;
    if (canOccupy(nx, nz) && !pathHitsWall(self.x, self.z, nx, nz, R * 0.7)) return true;
  }
  return false;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
