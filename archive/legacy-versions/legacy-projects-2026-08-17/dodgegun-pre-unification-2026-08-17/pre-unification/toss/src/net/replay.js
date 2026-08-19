import { CFG } from '../game/config.js';

export const REPLAY_VERSION = 1;

export function replayInput(input) {
  const aim = input?.aim == null ? null : Number(input.aim);
  return {
    mx: finite(input?.mx),
    mz: finite(input?.mz),
    aim: Number.isFinite(aim) ? round(aim, 4) : null,
    fire: !!input?.fire,
    reload: !!input?.reload,
  };
}

export function emptyReplayInput() {
  return { mx: 0, mz: 0, aim: null, fire: false, reload: false };
}

export function compactReplay(frames) {
  const segments = [];
  let previous = null;
  let from = 0;

  for (let tick = 0; tick < frames.length; tick++) {
    const current = replayInput(frames[tick]);
    if (previous && sameInput(previous, current)) continue;
    if (previous) segments.push({ from, to: tick - 1, input: previous });
    previous = current;
    from = tick;
  }

  if (previous) segments.push({ from, to: frames.length - 1, input: previous });

  return {
    version: REPLAY_VERSION,
    tickHz: CFG.netHz,
    length: frames.length,
    segments,
  };
}

export function createReplayReader(replay) {
  const segments = Array.isArray(replay?.segments) ? replay.segments : [];
  let index = 0;

  return {
    inputAt(tick) {
      while (index < segments.length && Number(segments[index].to) < tick) index++;
      const segment = segments[index];
      if (!segment || Number(segment.from) > tick) return emptyReplayInput();
      return replayInput(segment.input);
    },
  };
}

function sameInput(a, b) {
  return a.mx === b.mx
    && a.mz === b.mz
    && a.aim === b.aim
    && a.fire === b.fire
    && a.reload === b.reload;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? round(n, 4) : 0;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
