import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState } from '../src/core/rules';
import { analyzeJevFacts } from './jevAnalysis';
import { briefJevRoutes, buildJevBriefing, describeJevAction, describeJevPressure, describeJevRace } from './jevBriefing';

it('explains alternating actions, permanent guard capture and expanding deployment for both sides', () => {
  const briefing = buildJevBriefing(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG);
  expect(briefing.turnEconomy).toContain('ONE action per turn');
  expect(briefing.exactRules.join(' ')).toContain('Kings cannot capture');
  expect(briefing.exactRules.join(' ')).toContain('removed permanently');
  expect(briefing.exactRules.join(' ')).toContain('New guards become new deployment anchors');
  const ownHalf = buildJevBriefing(initialState(DEFAULT_CONFIG), { ...DEFAULT_CONFIG, placement: 'own-half', kingCapture: false });
  expect(ownHalf.exactRules.join(' ')).not.toContain('New guards become new deployment anchors');
  expect(ownHalf.exactRules.join(' ')).toContain('king cannot be captured');
});

it('does not confuse a one-move king race when the opponent moves next', () => {
  const facts = analyzeJevFacts(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG, { deadlineMs: Date.now() + 1_000 });
  const routes = structuredClone(facts.initialRoute);
  routes.own.distance = 1; routes.opponent.distance = 1;
  expect(briefJevRoutes(routes, true).frozenRaceFuturePlies).toEqual({ self: 1, opponent: 2 });
  expect(briefJevRoutes(routes, false).frozenRaceFuturePlies).toEqual({ self: 2, opponent: 1 });
  expect(describeJevRace(routes, false)).toContain('SELF: 1 king moves, arrival in 2 alternating plies');
  expect(describeJevRace(routes, false)).toContain('OPPONENT: 1 king moves, arrival in 1 alternating plies');
  routes.own.status = 'incomplete'; routes.own.distance = null;
  expect(briefJevRoutes(routes, false).frozenRaceFuturePlies.self).toBeNull();
});

it('describes which piece acts and distinguishes king movement from deployment', () => {
  const state = initialState(DEFAULT_CONFIG);
  expect(describeJevAction(state, { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 7, c: 4 } }))
    .toContain('Move SELF king (8,4) -> (7,4)');
  expect(describeJevAction(state, { kind: 'PLACE', to: { r: 7, c: 4 } })).toContain('SELF king stays in place');
  state.turn = 'WHITE';
  const white = buildJevBriefing(state, DEFAULT_CONFIG);
  expect(white.position.selfDirection).toContain('increasing row');
  expect(white.position.selfKing).toEqual({ r: 0, c: 4 });
});

it('keeps partial pressure counts explicitly incomplete in the choice description', () => {
  expect(describeJevPressure(undefined)).toContain('not checked');
  const text = describeJevPressure({ id: 'example', complete: false, totalOpponentReplies: 12,
    checkedOpponentReplies: 0, threatsFound: 1, examples: [{
      opponentReply: { kind: 'PLACE', to: { r: 3, c: 3 } },
      captureThreatsIfUnanswered: [], checkedResponses: 2, totalResponses: 9, responsesComplete: false,
      safeResponses: [{ move: { kind: 'PLACE', to: { r: 4, c: 3 } }, action: 'guard', advancesRow: false, immediateWin: false }],
    }] });
  expect(text).toContain('2/9 SELF responses checked');
  expect(text).toContain('1 guard actions');
  expect(text).toContain('Unchecked responses remain unknown');
});
