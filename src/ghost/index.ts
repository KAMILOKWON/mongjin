export { GhostController } from './player';
export type { GhostDecision, GhostStyle } from './player';
export { GhostStore } from './store';
export { BUILT_IN_GHOSTS } from './seeds';
export { createGhostNickname, withEphemeralGhostNickname } from './nickname';
export type { GhostNicknameOptions } from './nickname';
export {
  decodeGhost,
  encodeGhost,
  ghostFromFinishedGame,
} from './types';
export type {
  GhostCatalog,
  GhostPlayerCard,
  GhostSharePayload,
  GhostSource,
  GhostTape,
} from './types';
