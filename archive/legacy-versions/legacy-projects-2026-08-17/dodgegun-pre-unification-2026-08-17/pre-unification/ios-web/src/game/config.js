export const CFG = {
  moveSpeed: 6,
  playerRadius: 0.68,
  bulletSpeed: 16,
  bulletRadius: 0.12,
  leverTime: 0.7,
  magSize: 6,
  reloadPerBullet: 0.45,
  maxHP: 3,
  arenaX: 15.5,
  arenaZ: 10.5,
  enemyAimDelay: 0.16,
  enemySpread: 0.05,
  knockback: 0.78,
  hitReactTime: 0.16,
  bulletLife: 2.5,
  muzzleLead: 1.75,
  // Keep the projectile on this side of cover; 1.75 is only the visual barrel.
  muzzlePhysLead: 0.42,
  countdown: 3,
  roundTime: 40,
  roundEndHold: 2,
  winsNeeded: 2,
  matchWait: 8,
  awayPause: 3,
  forfeitWait: 10,
  netHz: 20,
  spawnP1: { x: -8, z: 0, ang: Math.PI / 2 },
  spawnP2: { x: 8, z: 0, ang: -Math.PI / 2 },
};

export const FLOOR_W = 33;
export const FLOOR_D = 23;
export const PANEL_COLS = 4;
export const PANEL_ROWS = 3;

// Must match the largest wall box in render.js (base layer).
export const WALL_VIS = {
  thickMul: 2.55,
  endPad: 0.42,
};

export const WALLS = [
  { a: [0, -8], b: [0, -2], t: 0.35 },
  { a: [0, -2], b: [-1.6, -0.4], t: 0.35 },
  { a: [0, 2], b: [0, 8], t: 0.35 },
  { a: [0, 2], b: [1.6, 0.4], t: 0.35 },
  { a: [-9, -7], b: [-9, -3], t: 0.35 },
  { a: [-9, 3], b: [-9, 7], t: 0.35 },
  { a: [9, -7], b: [9, -3], t: 0.35 },
  { a: [9, 3], b: [9, 7], t: 0.35 },
  { a: [-16, -11], b: [16, -11], t: 0.4 },
  { a: [-16, 11], b: [16, 11], t: 0.4 },
  { a: [-16, -11], b: [-16, 11], t: 0.4 },
  { a: [16, -11], b: [16, 11], t: 0.4 },
];

export const CAM = {
  height: 42.2,
  tilt: 18.8,
  focusZ: -1.2,
  fov: 38,
};
