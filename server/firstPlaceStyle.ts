import { readFileSync } from 'node:fs';
import type { HumanStyleBook } from './humanStyle';

// Frozen training split; loading at startup adds no network or database request per move.
export const FIRST_PLACE_STYLE: HumanStyleBook = JSON.parse(
  readFileSync(new URL('./bot-data/first-place.json', import.meta.url), 'utf8'),
);
