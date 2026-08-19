import * as THREE from 'three';
import { CAM, FLOOR_D, FLOOR_W, PANEL_COLS, PANEL_ROWS, WALL_VIS, WALLS } from './config.js';
import { DEFAULT_SPEC, PALETTES } from '../assets/characters/soldier-spec.js';
import { createSoldier } from './soldier-asset.js';

function isMobilePreset() {
  return window.matchMedia('(pointer: coarse)').matches || innerWidth < 980;
}

function hash2(ix, iy, seed) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function noise2(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, seed) {
  return noise2(x, y, seed) * 0.57
    + noise2(x * 2.07, y * 2.07, seed + 17) * 0.29
    + noise2(x * 4.13, y * 4.13, seed + 29) * 0.14;
}
function distToSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz || 1;
  let t = ((px - ax) * abx + (pz - az) * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

function canvasTexture(renderer, canvas, srgb = true) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeTiledTex(renderer, size, paint) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paint(c.getContext('2d'), size);
  return canvasTexture(renderer, c);
}

function makeArenaFloor(renderer, tile) {
  const W = tile ? 384 : 640;
  const H = tile ? 268 : 448;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      const wx = u * FLOOR_W - FLOOR_W * 0.5;
      const wz = FLOOR_D * 0.5 - v * FLOOR_D;
      const px = u * PANEL_COLS;
      const pz = v * PANEL_ROWS;
      const fx = px - Math.floor(px);
      const fz = pz - Math.floor(pz);
      const panel = hash2(Math.floor(px), Math.floor(pz), 9);
      const seam = (fx < 0.012 || fx > 0.988 || fz < 0.014 || fz > 0.986) ? 0.84 : 1;
      const n = fbm(x * 0.004, y * 0.004, 3);
      let r = 110 + n * 12 + panel * 6;
      let g = 114 + n * 10 + panel * 5;
      let b = 118 + n * 8 + panel * 4;
      let ao = 1;
      for (const w of WALLS) {
        const dist = distToSeg(wx, wz, w.a[0], w.a[1], w.b[0], w.b[1]);
        const reach = w.t + 0.85;
        if (dist < reach) ao = Math.min(ao, 0.62 + 0.38 * (dist / reach));
      }
      const i = (y * W + x) * 4;
      d[i] = Math.max(0, Math.min(255, r * seam * ao));
      d[i + 1] = Math.max(0, Math.min(255, g * seam * ao));
      d[i + 2] = Math.max(0, Math.min(255, b * seam * ao));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const map = canvasTexture(renderer, c);
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  return map;
}

export function createRenderer(canvas) {
  const mobile = isMobilePreset();
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !mobile,
    powerPreference: mobile ? 'low-power' : 'high-performance',
    alpha: false,
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.28;
  renderer.shadowMap.enabled = !mobile;
  if (!mobile) renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a323a);
  scene.fog = new THREE.Fog(0x2a323a, 48, 90);

  const camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.1, 200);
  camera.up.set(0, 0, -1);

  scene.add(new THREE.HemisphereLight(0xe4eaf0, 0x3a3834, 1.28));
  const sun = new THREE.DirectionalLight(0xfff3dc, mobile ? 1.7 : 2.2);
  sun.position.set(-14, 20, -10);
  sun.castShadow = !mobile;
  if (!mobile) {
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -26;
    sun.shadow.camera.right = 26;
    sun.shadow.camera.top = 22;
    sun.shadow.camera.bottom = -22;
    sun.shadow.camera.near = 2;
    sun.shadow.camera.far = 70;
  }
  scene.add(sun);
  scene.add(new THREE.DirectionalLight(0xa8bcc8, 0.5).translateX(10).translateY(9).translateZ(12));

  const tile = mobile ? 128 : 256;
  const concreteMap = makeTiledTex(renderer, tile, (ctx, size) => {
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.018, y * 0.018, 12);
      const i = (y * size + x) * 4;
      d[i] = 148 + n * 22;
      d[i + 1] = 148 + n * 18;
      d[i + 2] = 142 + n * 14;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
  concreteMap.repeat.set(2.4, 0.55);

  const oliveMap = makeTiledTex(renderer, tile, (ctx, size) => {
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.04, y * 0.04, 7);
      const i = (y * size + x) * 4;
      d[i] = 62 + n * 18;
      d[i + 1] = 72 + n * 16;
      d[i + 2] = 48 + n * 10;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });

  const woodMap = makeTiledTex(renderer, tile, (ctx, size) => {
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const grain = fbm(x * 0.09, y * 0.018, 5);
      const i = (y * size + x) * 4;
      d[i] = 118 + grain * 40;
      d[i + 1] = 86 + grain * 24;
      d[i + 2] = 52 + grain * 12;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });

  const outerFloorMap = new THREE.TextureLoader().load('/assets/outer-industrial-floor.png');
  outerFloorMap.colorSpace = THREE.SRGBColorSpace;
  outerFloorMap.wrapS = outerFloorMap.wrapT = THREE.RepeatWrapping;
  outerFloorMap.repeat.set(2.35, 2.35);
  outerFloorMap.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90),
    new THREE.MeshStandardMaterial({
      map: outerFloorMap,
      color: 0xb6bcc0,
      emissive: 0xffffff,
      emissiveMap: outerFloorMap,
      emissiveIntensity: 0.16,
      roughness: 0.96,
      metalness: 0.08,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.018;
  ground.receiveShadow = !mobile;
  scene.add(ground);

  const arenaFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_W, FLOOR_D),
    new THREE.MeshStandardMaterial({
      map: makeArenaFloor(renderer, mobile),
      roughness: 0.9,
      metalness: 0.12,
    })
  );
  arenaFloor.rotation.x = -Math.PI / 2;
  arenaFloor.position.y = 0.012;
  arenaFloor.receiveShadow = !mobile;
  scene.add(arenaFloor);

  function enableShadows(root) {
    if (mobile) return;
    root.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
  }

  const concreteMat = new THREE.MeshStandardMaterial({ map: concreteMap, color: 0xc5c4bc, roughness: 0.92 });
  const concreteCapMat = new THREE.MeshStandardMaterial({ map: concreteMap, color: 0xb7b6ae, roughness: 0.86 });
  const hazardMat = new THREE.MeshStandardMaterial({ color: 0xc9a33a, roughness: 0.72 });
  const hazardDarkMat = new THREE.MeshStandardMaterial({ color: 0x16191c, roughness: 0.9 });

  for (const w of WALLS) {
    const dx = w.b[0] - w.a[0];
    const dz = w.b[1] - w.a[1];
    const len = Math.hypot(dx, dz);
    const group = new THREE.Group();
    const layers = [
      { y: 0.16, h: 0.32, z: w.t * WALL_VIS.thickMul, x: WALL_VIS.endPad },
      { y: 0.46, h: 0.3, z: w.t * 2.15, x: 0.22 },
      { y: 1.18, h: 1.18, z: w.t * 1.78, x: 0.04 },
    ];
    for (const L of layers) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len + w.t * 2 + L.x, L.h, L.z), concreteMat);
      mesh.position.y = L.y;
      group.add(mesh);
    }
    const cap = new THREE.Mesh(new THREE.BoxGeometry(len + w.t * 2 + 0.1, 0.13, w.t * 1.9), concreteCapMat);
    cap.position.y = 1.84;
    group.add(cap);
    group.position.set((w.a[0] + w.b[0]) / 2, 0, (w.a[1] + w.b[1]) / 2);
    group.rotation.y = Math.atan2(-dz, dx);
    enableShadows(group);
    scene.add(group);

    const isCenterWall = Math.abs((w.a[0] + w.b[0]) / 2) < 4;
    if (len < 9 && !isCenterWall) {
      for (const s of [-1, 1]) {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.045, w.t * 2 + 0.72), hazardDarkMat);
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.055, w.t * 2 + 0.58), hazardMat);
        const g = new THREE.Group();
        g.add(plate, stripe);
        g.position.set(
          group.position.x + (dx / len) * (len * 0.5 - 0.14) * s,
          0.025,
          group.position.z + (dz / len) * (len * 0.5 - 0.14) * s
        );
        g.rotation.y = group.rotation.y;
        scene.add(g);
      }
    }
  }

  const crateOlive = new THREE.MeshStandardMaterial({ map: oliveMap, color: 0xb7c4a8, roughness: 0.86 });
  const crateBand = new THREE.MeshStandardMaterial({ color: 0x1d241f, roughness: 0.72 });
  const woodMat = new THREE.MeshStandardMaterial({ map: woodMap, color: 0xd2b48c, roughness: 0.84 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x2c3334, roughness: 0.62, metalness: 0.38 });
  const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });

  function addBlob(x, z, sx, sz, opacity = 0.3) {
    const blob = new THREE.Mesh(new THREE.CircleGeometry(1, 16), blobMat.clone());
    blob.material.opacity = opacity;
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(x, 0.018, z);
    blob.scale.set(sx, sz, 1);
    scene.add(blob);
    return blob;
  }

  function boxAt(mat, x, z, sx, sy, sz, y, r = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z);
    m.rotation.y = r;
    enableShadows(m);
    scene.add(m);
  }

  // These four crates belong to the original playable layout. Keep their
  // positions unchanged; everything added below is anchored outside the arena.
  boxAt(woodMat, -9.95, -7.55, 0.92, 0.7, 0.78, 0.35, 0.18);
  boxAt(woodMat, 9.95, -7.52, 0.92, 0.7, 0.78, 0.35, 0.12);
  boxAt(woodMat, -9.9, 7.5, 0.92, 0.7, 0.78, 0.35, -0.22);
  boxAt(woodMat, 9.92, 7.48, 0.92, 0.7, 0.78, 0.35, -0.16);

  const exterior = new THREE.Group();
  exterior.name = 'outer-map-decoration';
  scene.add(exterior);

  const armor = new THREE.MeshStandardMaterial({ map: oliveMap, color: 0x8f9a7b, roughness: 0.78 });
  const armorDark = new THREE.MeshStandardMaterial({ map: oliveMap, color: 0x566049, roughness: 0.84 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111513, roughness: 0.94 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x59605b, roughness: 0.62, metalness: 0.45 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x182328, roughness: 0.24, metalness: 0.22 });
  const exteriorSteel = new THREE.MeshStandardMaterial({ color: 0x20272a, roughness: 0.74, metalness: 0.42 });
  const grateMat = new THREE.MeshStandardMaterial({ color: 0x15191b, roughness: 0.82, metalness: 0.55 });
  const grateRibMat = new THREE.MeshStandardMaterial({ color: 0x303638, roughness: 0.78, metalness: 0.36 });
  const fadedHazard = new THREE.MeshStandardMaterial({ color: 0x8f7428, roughness: 0.86 });

  function addPart(parent, geometry, material, position, rotation = null, scale = null) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    if (scale) mesh.scale.set(...scale);
    mesh.castShadow = !mobile;
    mesh.receiveShadow = !mobile;
    parent.add(mesh);
    return mesh;
  }

  function addTruck(x, z, rotation, scale = 1) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotation;
    g.scale.setScalar(scale);
    exterior.add(g);

    addPart(g, new THREE.BoxGeometry(4.7, 0.32, 1.7), exteriorSteel, [0, 0.62, 0]);
    addPart(g, new THREE.BoxGeometry(2.75, 1.25, 1.76), armor, [-0.82, 1.28, 0]);
    addPart(g, new THREE.BoxGeometry(1.42, 1.42, 1.72), armorDark, [1.33, 1.3, 0]);
    addPart(g, new THREE.BoxGeometry(0.78, 0.78, 1.58), armor, [2.22, 1.02, 0]);
    addPart(g, new THREE.BoxGeometry(0.07, 0.58, 1.38), glassMat, [2.02, 1.48, 0]);
    addPart(g, new THREE.BoxGeometry(1.2, 0.12, 1.5), armor, [1.2, 2.05, 0]);
    for (const px of [-1.6, -0.42, 1.5]) {
      for (const pz of [-0.93, 0.93]) {
        addPart(g, new THREE.CylinderGeometry(0.43, 0.43, 0.3, 12), tireMat, [px, 0.48, pz], [Math.PI / 2, 0, 0]);
        addPart(g, new THREE.CylinderGeometry(0.19, 0.19, 0.315, 10), hubMat, [px, 0.48, pz], [Math.PI / 2, 0, 0]);
      }
    }
    for (const px of [-1.75, -0.82, 0.08]) {
      addPart(g, new THREE.BoxGeometry(0.09, 1.12, 1.82), armorDark, [px, 1.3, 0]);
    }
    addBlob(x, z, 2.7 * scale, 1.25 * scale, 0.24).rotation.z = -rotation;
  }

  function addApc(x, z, rotation, scale = 1) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotation;
    g.scale.setScalar(scale);
    exterior.add(g);

    addPart(g, new THREE.BoxGeometry(4.75, 0.72, 2.35), armorDark, [0, 0.68, 0]);
    addPart(g, new THREE.BoxGeometry(3.8, 0.72, 1.9), armor, [-0.16, 1.33, 0]);
    addPart(g, new THREE.BoxGeometry(1.0, 0.64, 1.78), armor, [1.78, 1.18, 0], [0, 0, -0.22]);
    addPart(g, new THREE.CylinderGeometry(0.78, 0.88, 0.42, 12), armorDark, [-0.45, 1.92, 0]);
    addPart(g, new THREE.CylinderGeometry(0.43, 0.49, 0.44, 12), armor, [-0.45, 2.27, 0]);
    addPart(g, new THREE.CylinderGeometry(0.09, 0.12, 2.05, 8), exteriorSteel, [0.58, 2.29, 0], [0, 0, Math.PI / 2]);
    for (const px of [-1.72, -0.58, 0.58, 1.72]) {
      for (const pz of [-1.27, 1.27]) {
        addPart(g, new THREE.CylinderGeometry(0.45, 0.45, 0.27, 12), tireMat, [px, 0.53, pz], [Math.PI / 2, 0, 0]);
        addPart(g, new THREE.CylinderGeometry(0.2, 0.2, 0.285, 10), hubMat, [px, 0.53, pz], [Math.PI / 2, 0, 0]);
      }
    }
    for (const px of [-1.2, 0.15, 1.35]) {
      addPart(g, new THREE.BoxGeometry(0.56, 0.08, 0.34), exteriorSteel, [px, 1.74, -0.58]);
    }
    addBlob(x, z, 2.75 * scale, 1.48 * scale, 0.26).rotation.z = -rotation;
  }

  function addBarrelCluster(x, z, rotation = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotation;
    exterior.add(g);
    const barrelGeo = new THREE.CylinderGeometry(0.34, 0.37, 0.92, 12);
    for (const [bx, bz] of [[0, 0], [0.68, 0.12], [0.22, 0.65], [-0.48, 0.48]]) {
      addPart(g, barrelGeo, barrelMat, [bx, 0.46, bz]);
      addPart(g, new THREE.TorusGeometry(0.355, 0.035, 6, 12), hubMat, [bx, 0.73, bz], [Math.PI / 2, 0, 0]);
    }
  }

  function addCrateStack(x, z, rotation = 0, rows = 2) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotation;
    exterior.add(g);
    addPart(g, new THREE.BoxGeometry(3.25, 0.13, 1.62), woodMat, [0, 0.1, 0]);
    for (let row = 0; row < rows; row++) {
      const count = row === 0 ? 3 : 2;
      for (let i = 0; i < count; i++) {
        const bx = (i - (count - 1) / 2) * 1.02 + (row ? -0.2 : 0);
        addPart(g, new THREE.BoxGeometry(0.92, 0.72, 1.12), crateOlive, [bx, 0.48 + row * 0.74, 0]);
        addPart(g, new THREE.BoxGeometry(0.97, 0.08, 1.17), crateBand, [bx, 0.74 + row * 0.74, 0]);
      }
    }
  }

  function addServiceGrate(x, z, sx, sz, rotation = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0.012, z);
    g.rotation.y = rotation;
    exterior.add(g);
    addPart(g, new THREE.BoxGeometry(sx, 0.055, sz), grateMat, [0, 0, 0]);
    const ribs = Math.max(3, Math.floor(sx / 0.52));
    for (let i = 0; i <= ribs; i++) {
      const px = -sx / 2 + (i / ribs) * sx;
      addPart(g, new THREE.BoxGeometry(0.035, 0.025, sz - 0.12), grateRibMat, [px, 0.04, 0]);
    }
  }

  // Side service lanes and their props sit wholly outside the 33 x 23 play field.
  addServiceGrate(-20.0, -5.6, 5.8, 11.8, 0.02);
  addServiceGrate(20.2, 5.8, 5.4, 11.4, -0.015);
  addPart(exterior, new THREE.BoxGeometry(0.18, 0.035, 10.2), fadedHazard, [-17.28, 0.04, -5.55], [0, 0.02, 0]);
  addPart(exterior, new THREE.BoxGeometry(0.18, 0.035, 9.8), fadedHazard, [17.66, 0.04, 5.75], [0, -0.015, 0]);

  addTruck(-20.3, -5.8, Math.PI / 2 + 0.05, 0.98);
  addTruck(-20.1, 6.5, Math.PI / 2 - 0.08, 0.92);
  addApc(20.15, -5.2, -Math.PI / 2 - 0.04, 0.96);
  addApc(20.2, 6.45, -Math.PI / 2 + 0.06, 0.9);

  addCrateStack(-13.2, -13.15, 0.06, 2);
  addCrateStack(-8.9, -13.3, -0.04, 1);
  addCrateStack(12.4, 13.25, Math.PI + 0.08, 2);
  addBarrelCluster(-17.75, 10.35, 0.1);
  addBarrelCluster(17.8, -10.0, -0.15);

  for (const [x, z] of [[-15.0, 13.35], [-5.4, 13.4], [4.4, -13.35], [14.2, -13.3]]) {
    addPart(exterior, new THREE.BoxGeometry(3.15, 0.82, 0.76), concreteMat, [x, 0.41, z]);
    addPart(exterior, new THREE.BoxGeometry(2.95, 0.1, 0.62), concreteCapMat, [x, 0.86, z]);
  }

  const player = createSoldier(THREE, { spec: DEFAULT_SPEC, palette: PALETTES.blue });
  const enemy = createSoldier(THREE, { spec: DEFAULT_SPEC, palette: PALETTES.red });
  player.blob = addBlob(-8, 0, 0.55, 0.46, 0.22);
  enemy.blob = addBlob(8, 0, 0.55, 0.46, 0.22);
  scene.add(player.group, enemy.group);

  const aimLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0xf2f4f0, transparent: true, opacity: 0.38 })
  );
  scene.add(aimLine);

  const bulletGeo = new THREE.CapsuleGeometry(0.045, 0.28, 2, 6);
  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffd25e });
  const bulletMatFoe = new THREE.MeshBasicMaterial({ color: 0xff6b5e });
  const bulletPool = [];

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const aimPoint = new THREE.Vector3();

  function poseHit(character, amount) {
    const s = character.spec?.scale ?? 1.12;
    if (amount <= 0) {
      character.visual.position.y = 0;
      character.visual.rotation.z = 0;
      character.visual.scale.set(s, s, s);
      return;
    }
    const t = amount / 0.16;
    character.visual.position.y = Math.sin((1 - t) * Math.PI) * 0.12;
    character.visual.rotation.z = (t > 0.45 ? 1 : -1) * 0.12 * t;
    character.visual.scale.set(s + 0.08 * t, s - 0.11 * t, s + 0.08 * t);
  }

  function syncFighter(character, f) {
    character.group.position.set(f.x, 0, f.z);
    character.group.rotation.y = f.ang;
    character.group.visible = f.visible;
    character.blob.position.set(f.x, 0.018, f.z);
    character.blob.visible = f.visible;
    const sw = f.moving ? Math.sin(f.walkT * 11) * 0.5 : 0;
    if (character.legs[0]) character.legs[0].rotation.x = sw;
    if (character.legs[1]) character.legs[1].rotation.x = -sw;
    if (character.lever) {
      const leverProg = 1 - f.leverT / 0.7;
      character.lever.rotation.x = f.leverT > 0 ? -Math.sin(leverProg * Math.PI) * 1.1 : 0;
    }
    if (character.rifle) character.rifle.rotation.x = f.rifleTilt;
    poseHit(character, f.hitT);
  }

  function flashHit(character) {
    character.flashMaterials.forEach(mat => mat.emissive.setHex(0x9a110d));
    setTimeout(() => character.flashMaterials.forEach(mat => mat.emissive.setHex(0x000000)), 105);
  }

  function sync(match, localSide = 'p1') {
    syncFighter(player, match.p1);
    syncFighter(enemy, match.p2);

    const pts = aimLine.geometry.attributes.position;
    const p = localSide === 'p2' ? match.p2 : match.p1;
    const dirx = Math.sin(p.ang);
    const dirz = Math.cos(p.ang);
    pts.setXYZ(0, p.x + dirx * 1.7, 1.42, p.z + dirz * 1.7);
    pts.setXYZ(1, p.x + dirx * 7.4, 1.42, p.z + dirz * 7.4);
    pts.needsUpdate = true;
    aimLine.visible = match.phase === 'fight' || match.phase === 'countdown';

    while (bulletPool.length < match.bullets.length) {
      const mesh = new THREE.Mesh(bulletGeo, bulletMat);
      scene.add(mesh);
      bulletPool.push(mesh);
    }
    for (let i = 0; i < bulletPool.length; i++) {
      const mesh = bulletPool[i];
      const b = match.bullets[i];
      if (!b) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.material = b.foe ? bulletMatFoe : bulletMat;
      mesh.position.set(b.x, 1.42, b.z);
      mesh.rotation.y = Math.atan2(b.vx, b.vz);
      mesh.rotation.x = Math.PI / 2;
    }

    resize();
    camera.up.set(0, 0, -1);
    camera.position.set(0, CAM.height, CAM.focusZ + CAM.tilt);
    camera.lookAt(0, 0, CAM.focusZ);
    renderer.render(scene, camera);
  }

  function aimFromNdc(ndc, fighter) {
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, aimPoint)) return null;
    const adx = aimPoint.x - fighter.x;
    const adz = aimPoint.z - fighter.z;
    if (adx * adx + adz * adz < 0.04) return null;
    return Math.atan2(adx, adz);
  }

  let drawW = 0;
  let drawH = 0;

  function viewSize() {
    const rect = canvas.getBoundingClientRect();
    const vv = window.visualViewport;
    const w = Math.round(rect.width || vv?.width || document.documentElement.clientWidth || innerWidth);
    const h = Math.round(rect.height || vv?.height || document.documentElement.clientHeight || innerHeight);
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  function resize() {
    const { w, h } = viewSize();
    const pr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
    if (w === drawW && h === drawH && renderer.getPixelRatio() === pr) return;
    drawW = w;
    drawH = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
  }

  addEventListener('resize', resize);
  addEventListener('orientationchange', () => {
    drawW = 0;
    setTimeout(resize, 50);
    setTimeout(resize, 250);
  });
  visualViewport?.addEventListener('resize', resize);
  visualViewport?.addEventListener('scroll', resize);
  resize();

  return { sync, flashHit, aimFromNdc, resize, player, enemy };
}
