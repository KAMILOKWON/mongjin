export { PALETTES, DEFAULT_SPEC } from './soldier-data.js';
import { PALETTES, DEFAULT_SPEC } from './soldier-data.js';

export const MATERIAL_SLOTS = [
  { id: 'body', label: '군복' },
  { id: 'helmet', label: '헬멧' },
  { id: 'accent', label: '조끼' },
  { id: 'accentDark', label: '조끼 그림자' },
  { id: 'stripe', label: '헬멧 줄' },
  { id: 'visor', label: '헬멧 테' },
  { id: 'skin', label: '피부' },
  { id: 'boot', label: '부츠' },
  { id: 'pouch', label: '파우치' },
  { id: 'glove', label: '장갑' },
  { id: 'metal', label: '총기 금속' },
  { id: 'wood', label: '총기 폴리머' },
  { id: 'eye', label: '눈동자' },
  { id: 'eyeWhite', label: '흰자' },
];

export const SURFACES = {
  body: { roughness: 0.72, metalness: 0.04 },
  helmet: { roughness: 0.48, metalness: 0.08 },
  accent: { roughness: 0.7, metalness: 0.05 },
  accentDark: { roughness: 0.74, metalness: 0.04 },
  stripe: { roughness: 0.55, metalness: 0.02 },
  visor: { roughness: 0.28, metalness: 0.35 },
  skin: { roughness: 0.86, metalness: 0 },
  boot: { roughness: 0.82, metalness: 0.04 },
  pouch: { roughness: 0.88, metalness: 0.02 },
  glove: { roughness: 0.9, metalness: 0.02 },
  metal: { roughness: 0.32, metalness: 0.78 },
  wood: { roughness: 0.7, metalness: 0.08 },
  eye: { roughness: 0.25, metalness: 0.05 },
  eyeWhite: { roughness: 0.45, metalness: 0 },
};

export function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

export function hexToCss(n) {
  return `#${Number(n).toString(16).padStart(6, '0')}`;
}

export function cssToHex(css) {
  return parseInt(String(css).replace('#', ''), 16);
}

export function emptyBundle() {
  return {
    version: 2,
    spec: cloneData(DEFAULT_SPEC),
    palettes: cloneData(PALETTES),
  };
}

export function sanitizeBundle(raw) {
  const fallback = emptyBundle();
  if (!raw || typeof raw !== 'object') return fallback;
  const spec = raw.spec && typeof raw.spec === 'object' ? raw.spec : fallback.spec;
  const palettes = raw.palettes && typeof raw.palettes === 'object' ? raw.palettes : fallback.palettes;
  return {
    version: 2,
    spec: {
      version: 2,
      scale: Number.isFinite(spec.scale) ? spec.scale : fallback.spec.scale,
      parts: Array.isArray(spec.parts) ? spec.parts.map(sanitizePart) : fallback.spec.parts,
    },
    palettes: {
      blue: { ...fallback.palettes.blue, ...(palettes.blue || palettes.white || {}) },
      red: { ...fallback.palettes.red, ...(palettes.red || {}) },
    },
  };
}

function sanitizePart(part) {
  return {
    id: String(part.id || 'part'),
    type: part.type === 'group' ? 'group' : undefined,
    geo: part.geo || undefined,
    args: Array.isArray(part.args) ? part.args : undefined,
    parent: part.parent || 'visual',
    pos: toVec3(part.pos, [0, 0, 0]),
    rot: toVec3(part.rot, [0, 0, 0]),
    scale: toVec3(part.scale, [1, 1, 1]),
    mat: part.mat || 'body',
    role: part.role || undefined,
    visible: part.visible !== false,
  };
}

function toVec3(value, fallback) {
  if (!Array.isArray(value) || value.length < 3) return fallback.slice();
  return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
}

export function findPart(spec, id) {
  return spec.parts.find(part => part.id === id) || null;
}

function hexLit(n) {
  return `0x${Number(n).toString(16).padStart(6, '0')}`;
}

function formatPalette(palette) {
  const lines = Object.entries(palette).map(([key, value]) => {
    if (key === 'id' || key === 'name') return `    ${key}: ${JSON.stringify(value)},`;
    return `    ${key}: ${hexLit(value)},`;
  });
  return `  ${palette.id}: {\n${lines.join('\n')}\n  }`;
}

export function formatSoldierDataModule(bundle) {
  const clean = sanitizeBundle(bundle);
  const palettes = `export const PALETTES = {\n${formatPalette(clean.palettes.blue)},\n${formatPalette(clean.palettes.red)},\n};\n`;
  const spec = `export const DEFAULT_SPEC = ${JSON.stringify(clean.spec, null, 2)};\n`;
  return `${palettes}\n${spec}`;
}
