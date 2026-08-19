import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { toSquare } from './coords';
import { gameFromFinished, parseGame, serializeGame } from './format';
import { replayGame } from './replay';
import type { MgnGame } from './types';

describe('MGN notation', () => {
  it('착수·이동을 직렬화하고 파싱한다', () => {
    const placeBlack = { kind: 'PLACE' as const, to: { r: 7, c: 3 } };
    const placeWhite = { kind: 'PLACE' as const, to: { r: 2, c: 3 } };

    const game: MgnGame = {
      headers: {
        mgn: '1',
        black: 'Human',
        white: 'Bot',
        result: 'BLACK',
        config: { ...DEFAULT_CONFIG },
      },
      moves: [{ move: placeBlack }, { move: placeWhite }],
    };

    const text = serializeGame(game);
    expect(text).toContain('[Black "Human"]');
    expect(text).toContain('@d2');
    expect(text).toContain('@d7');

    const parsed = parseGame(text);
    expect(parsed.moves).toHaveLength(2);
    expect(parsed.moves[0]!.move.kind).toBe('PLACE');
    expect(parsed.moves[1]!.move.kind).toBe('PLACE');

    const { states } = replayGame(parsed);
    expect(states).toHaveLength(3);
  });

  it('종료 대국을 기보로보낸다', () => {
    const game = gameFromFinished({
      moves: [{ kind: 'PLACE', to: { r: 7, c: 3 } }],
      result: { winner: 'BLACK', reason: 'goal' },
      config: DEFAULT_CONFIG,
      meta: { black: 'Player', white: 'Mongjin', botSide: 'WHITE' },
    });
    const text = serializeGame(game);
    expect(text).toContain('[Result "BLACK"]');
    expect(text).toContain('[termination "goal"]');
    expect(text).toContain('[botSide "WHITE"]');
  });

  it('좌표 변환이 UI와 일치한다', () => {
    expect(toSquare({ r: 8, c: 4 }, 9)).toBe('e1');
    expect(toSquare({ r: 0, c: 4 }, 9)).toBe('e9');
  });
});
