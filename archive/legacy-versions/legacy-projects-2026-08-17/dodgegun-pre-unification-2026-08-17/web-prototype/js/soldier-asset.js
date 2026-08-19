import {
  DEFAULT_SPEC,
  PALETTES,
  SURFACES,
  cloneData,
} from '../assets/characters/soldier-spec.js';

const GEO_BUILDERS = {
  sphere: (THREE, [r = 0.3, w = 16, h = 12]) => new THREE.SphereGeometry(r, w, h),
  box: (THREE, [x = 0.2, y = 0.2, z = 0.2]) => new THREE.BoxGeometry(x, y, z),
  capsule: (THREE, [r = 0.1, len = 0.3, cap = 4, seg = 8]) => new THREE.CapsuleGeometry(r, len, cap, seg),
  cylinder: (THREE, [rt = 0.1, rb = 0.1, h = 0.4, seg = 10]) => new THREE.CylinderGeometry(rt, rb, h, seg),
  torus: (THREE, [r = 0.25, tube = 0.04, rad = 8, tub = 16]) => new THREE.TorusGeometry(r, tube, rad, tub),
};

function makeMaterials(THREE, palette) {
  const materials = {};
  for (const [slot, surface] of Object.entries(SURFACES)) {
    materials[slot] = new THREE.MeshStandardMaterial({
      color: palette[slot] ?? 0xffffff,
      roughness: surface.roughness,
      metalness: surface.metalness,
    });
  }
  return materials;
}

function applyTransform(obj, part) {
  const [px, py, pz] = part.pos || [0, 0, 0];
  const [rx, ry, rz] = part.rot || [0, 0, 0];
  const [sx, sy, sz] = part.scale || [1, 1, 1];
  obj.position.set(px, py, pz);
  obj.rotation.set(rx, ry, rz);
  obj.scale.set(sx, sy, sz);
  obj.visible = part.visible !== false;
}

function topoParts(parts) {
  const byId = new Map(parts.map(part => [part.id, part]));
  const seen = new Set();
  const ordered = [];
  const visit = (part) => {
    if (!part || seen.has(part.id)) return;
    seen.add(part.id);
    if (part.parent && part.parent !== 'visual' && byId.has(part.parent)) {
      visit(byId.get(part.parent));
    }
    ordered.push(part);
  };
  parts.forEach(visit);
  return ordered;
}

export function createSoldier(THREE, options = {}) {
  const spec = cloneData(options.spec || DEFAULT_SPEC);
  const palette = cloneData(options.palette || PALETTES.blue);
  const group = new THREE.Group();
  group.name = `soldier-${palette.id || 'custom'}`;
  const visual = new THREE.Group();
  visual.name = 'visual';
  visual.scale.setScalar(spec.scale ?? 1);
  group.add(visual);

  const materials = makeMaterials(THREE, palette);
  const flashMaterials = ['body', 'helmet', 'accent', 'accentDark', 'skin', 'boot', 'pouch', 'glove']
    .map(id => materials[id])
    .filter(Boolean);

  const nodes = { visual };
  const meshes = [];

  for (const part of topoParts(spec.parts || [])) {
    const parent = nodes[part.parent] || visual;
    const isGroup = part.type === 'group' || !part.geo;
    if (isGroup) {
      const node = new THREE.Group();
      node.name = part.id;
      applyTransform(node, part);
      parent.add(node);
      nodes[part.id] = node;
      continue;
    }
    const build = GEO_BUILDERS[part.geo];
    if (!build) continue;
    const mesh = new THREE.Mesh(build(THREE, part.args || []), materials[part.mat] || materials.body);
    mesh.name = part.id;
    mesh.userData.partId = part.id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    applyTransform(mesh, part);
    parent.add(mesh);
    nodes[part.id] = mesh;
    meshes.push(mesh);
  }

  return {
    group,
    visual,
    nodes,
    meshes,
    legs: [nodes.legL, nodes.legR].filter(Boolean),
    lever: nodes.lever || null,
    rifle: nodes.rifle || null,
    materials,
    flashMaterials,
    spec,
    palette,
  };
}

export function disposeSoldier(soldier) {
  if (!soldier) return;
  soldier.group.traverse(obj => {
    if (obj.isMesh) {
      obj.geometry?.dispose();
    }
  });
  Object.values(soldier.materials || {}).forEach(mat => mat.dispose());
}

export function applyPalette(soldier, palette) {
  soldier.palette = cloneData(palette);
  for (const [slot, material] of Object.entries(soldier.materials)) {
    if (palette[slot] != null) material.color.setHex(palette[slot]);
  }
}

export function replaceSoldier(THREE, previous, options) {
  const next = createSoldier(THREE, options);
  if (previous) {
    next.group.position.copy(previous.group.position);
    next.group.rotation.copy(previous.group.rotation);
    next.group.visible = previous.group.visible;
    next.blob = previous.blob;
    previous.group.parent?.add(next.group);
    previous.group.removeFromParent();
    disposeSoldier(previous);
  }
  return next;
}
