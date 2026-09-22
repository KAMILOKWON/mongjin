import { describe, expect, it } from 'vitest';
import { JEV_INPUT_BYTE_BUDGET, prepareJevInput } from './jevInputBudget';
import type { JevQuestion } from './jevGateway';

const questions: Record<string, JevQuestion> = { move: { type: 'choice', instructions: 'Choose the best legal move.', criteria: { p_1_1: 'Deploy a guard.', m_1_1_2_1: 'Move the king.' } } };
describe('JEV request budget', () => {
  it('encodes large continuation boards without dropping any cell, reply or terminal outcome', () => {
    const guardSets = Array.from({ length: 250 }, (_, i) => ['0,0', '8,8', `${i % 9},4`, '3,6']);
    const horizons = Array.from({ length: 250 }, (_, i) => [i % 2 ? null : '0,0', '8,8', i, 0, 4, 5, 'SELF']);
    const input: any = { briefingVersion: 'jev-decision-1', board: { position: { board: Array(9).fill('.........') } },
      decisionCards: [], conditionalContinuations: { horizonDetail: 'lossless-shared-tables',
        replyColumns: ['firstReplyIndex', 'conditionalOutcome', 'horizonIndex'],
        replyIds: ['p_1_1'], guardSets, horizons,
        candidates: [{ id: 'p_1_1', replies: [[0, 'OPPONENT won:goal', 2], [0, 'unknown', 0]] }] } };
    input.padding = 'x'.repeat(27000 - Buffer.byteLength(JSON.stringify(input)));
    const before = structuredClone(input);
    const out = prepareJevInput('final', input, questions);
    const c = (out.state as any).conditionalContinuations;
    const decode = (n: number | null) => n === null ? null : `${Math.floor(n / 9)},${n % 9}`;
    expect(out.budget.steps).toContain('encode-horizon-cells-as-board-indexes');
    expect(c.guardSets.map((s: number[]) => s.map(decode))).toEqual(guardSets);
    expect(c.horizons.map(([a, b, ...rest]: [number | null, number | null, ...unknown[]]) => [decode(a), decode(b), ...rest])).toEqual(horizons);
    expect(c.candidates[0].replies.map(([r, o, h]: number[]) => [r, c.conditionalOutcomes[o], h]))
      .toEqual(before.conditionalContinuations.candidates[0].replies);
    expect(out.budget.sentBytes).toBeLessThanOrEqual(JEV_INPUT_BYTE_BUDGET);
    expect(out.questions).toEqual(questions);
    expect(input).toEqual(before);
  });
  it('keeps small requests and the original objects unchanged', () => {
    const input = { board: 'small' };
    const out = prepareJevInput('final', input, questions);
    expect(out.state).toEqual(input); expect(out.questions).toEqual(questions);
    expect(out.budget.steps).toEqual([]);
    expect(out.budget.sentBytes).toBeLessThan(JEV_INPUT_BYTE_BUDGET);
  });
  it('compacts horizon details while retaining every reply, outcome and choice ID', () => {
    const rows = Array.from({ length: 150 }, (_, i) => [`p_${i}_0`, i % 2 ? 'unknown' : 'OPPONENT-won:goal', 'x'.repeat(300)]);
    const input = { conditionalContinuations: { firstReplyCoverage: 'all-legal', candidates: [{ id: 'p_1_1', replies: rows }], replyColumns: ['firstOpponentReply', 'conditionalOutcome', 'detail'] } };
    const snapshot = structuredClone(input);
    const out = prepareJevInput('final', input, questions);
    const state = out.state as typeof input;
    const compact = state.conditionalContinuations as any;
    expect(compact.candidates[0].replies.map(([m, o]: [number, number]) => [compact.replyValueDictionaries.moves[m], compact.replyValueDictionaries.outcomes[o]])).toEqual(rows.map(r => r.slice(0, 2)));
    expect(out.questions).toEqual(questions);
    expect(out.budget.steps).toContain('omit-continuation-horizon-detail-keep-all-replies');
    expect(out.budget.sentBytes).toBeLessThanOrEqual(JEV_INPUT_BYTE_BUDGET);
    expect(input).toEqual(snapshot);
  });
  it('preserves pressure counts if redundant option descriptions are also removed', () => {
    const q = structuredClone(questions);
    if (q.move?.type === 'choice') q.move.criteria.p_1_1 = 'description '.repeat(3000);
    const input = { opponentPressure: { candidates: [{ id: 'p_1_1', complete: false, checkedOpponentReplies: 2, totalOpponentReplies: 5,
      examples: [{ opponentReply: { kind: 'PLACE', to: { r: 1, c: 2 } }, checkedResponses: 2, totalResponses: 4, responsesComplete: false,
        safeResponses: [{ action: 'guard', advancesRow: false, immediateWin: false }] }] }] } };
    const out = prepareJevInput('final', input, q);
    expect((out.state as any).pressureSummary[0]).toMatchObject({ complete: false, examples: [{ reply: 'p_1_2', complete: false, nextReplySafe: { guards: 1, forwardKing: 0 } }] });
    expect(out.questions.move?.type === 'choice' && Object.keys(out.questions.move.criteria)).toEqual(['p_1_1', 'm_1_1_2_1']);
    expect(out.budget.sentBytes).toBeLessThanOrEqual(JEV_INPUT_BYTE_BUDGET);
  });
  it('fails before a gateway call when the irreducible shared state exceeds the budget', () => {
    expect(() => prepareJevInput('proposals', { board: 'x'.repeat(30000) }, questions)).toThrow('byte budget');
  });
  it('retains v15 reply/horizon tables and pressure counts when optional details exceed the budget', () => {
    const continuation = { firstReplyCoverage: 'all-legal', horizonDetail: 'lossless-shared-tables',
      replyIds: ['p_4_4'], guardSets: [[], ['4,4']], horizons: [['3,4', '5,4', 0, 1, 8, 7, 'SELF']],
      candidates: [{ id: 'm_2_4_3_4', replies: [[0, 'unknown', 0]] }] };
    const input = { briefingVersion: 'jev-decision-1', conditionalContinuations: continuation,
      decisionCards: [{ id: 'm_2_4_3_4', action: 'shared action '.repeat(1000),
        opponentCapturePressure: { examples: [{ opponentReply: 'p_4_4', allResponsesChecked: true,
          safeResponseCounts: [0, 2, 3, 0], consequence: 'only-sideways-or-backward-king', safeResponseExamples: ['id'.repeat(15000)] }] },
        search: { proven: 'unknown', extension: null } }] };
    const before = structuredClone(input);
    const out = prepareJevInput('final', input, questions);
    expect((out.state as any).conditionalContinuations).toEqual(continuation);
    expect((out.state as any).decisionCards[0].opponentCapturePressure.examples[0]).toEqual({
      opponentReply: 'p_4_4', allResponsesChecked: true, safeResponseCounts: [0, 2, 3, 0], consequence: 'only-sideways-or-backward-king' });
    expect(out.budget.steps).toContain('omit-response-id-examples-keep-counts-and-replies');
    expect(out.budget.steps).not.toContain('omit-continuation-horizon-detail-keep-all-replies');
    expect(out.budget.sentBytes).toBeLessThanOrEqual(JEV_INPUT_BYTE_BUDGET);
    expect(out.questions).toEqual(questions);
    expect(input).toEqual(before);
  });
  it('fails closed when v15 shared horizons alone exceed the budget', () => {
    expect(() => prepareJevInput('final', { briefingVersion: 'jev-decision-1', decisionCards: [],
      conditionalContinuations: { horizonDetail: 'lossless-shared-tables', horizons: ['x'.repeat(27000)] } }, questions)).toThrow('byte budget');
  });
  it('losslessly table-encodes pressure facts including incomplete checks when needed', () => {
    const example = { opponentReply: 'p_4_4', allResponsesChecked: false, checkedResponses: 4, totalResponses: 9,
      safeResponseCounts: [0, 2, 1, 0], immediateWins: [], consequence: 'incomplete' };
    const input: any = { briefingVersion: 'jev-decision-1', decisionCards: Array.from({ length: 12 }, (_, i) => ({
      id: `p_${i}_0`, action: 'Deploy a guard.', opponentCapturePressure: { examples: Array.from({ length: 3 }, () => structuredClone(example)) },
      search: { proven: 'unknown', extension: null } })), conditionalContinuations: { horizons: [] } };
    input.padding = 'x'.repeat(27000 - Buffer.byteLength(JSON.stringify(input)));
    const out = prepareJevInput('final', input, questions);
    expect(out.budget.steps).toContain('table-encode-pressure-facts');
    const sent = out.state as any;
    const row = sent.decisionCards[0].opponentCapturePressure.examples[0];
    expect(Object.fromEntries(sent.pressureExampleColumns.map((key: string, i: number) => [key, row[i]]))).toEqual(example);
    expect(out.budget.sentBytes).toBeLessThanOrEqual(JEV_INPUT_BYTE_BUDGET);
    expect(input.decisionCards[0].opponentCapturePressure.examples[0]).toEqual(example);
  });
  it('references only matching exact proofs and preserves every repeated conditional outcome', () => {
    const proof = { winner: 'WHITE', reason: 'goal', plies: 2 };
    const proofLine = ['p_1_1', 'm_7_3_8_3'];
    const retained = { proven: 'loss', proof, searchedDepth: 4, sourceSearch: 0, proofLine };
    const current = { completedDepth: 4, proven: 'loss', proof, exampleLine: proofLine, end: { terminal: proof }, extension: null };
    const rows = Array.from({ length: 350 }, (_, i) => [i, i % 2 ? 'OPPONENT won:goal' : 'unknown', i % 3]);
    const input: any = { briefingVersion: 'jev-decision-1', decisionCards: [
      { id: 'p_1_1', retainedTerminalProof: retained, search: current },
      { id: 'm_1_1_2_1', retainedTerminalProof: retained, search: { ...current, proven: 'unknown', proof: null } },
      { id: 'p_1_2', retainedTerminalProof: retained, search: { ...current, exampleLine: ['p_1_2', 'm_7_3_8_3'] } },
    ], conditionalContinuations: { horizonDetail: 'lossless-shared-tables',
      replyColumns: ['firstReplyIndex', 'conditionalOutcome', 'horizonIndex'],
      replyIds: rows.map((_, i) => `p_${i}_0`), horizons: [['1,1'], ['2,2'], ['3,3']], guardSets: [[]],
      candidates: [{ id: 'p_1_1', replies: rows }] } };
    input.padding = 'x'.repeat(27000 - Buffer.byteLength(JSON.stringify(input)));
    const before = structuredClone(input);
    const out = prepareJevInput('final', input, questions);
    const sent = out.state as any;
    expect(sent.decisionCards[0].search).toEqual({ completedDepth: 4, proven: 'loss', exactProofReference: 'retainedTerminalProof' });
    expect(sent.decisionCards[0].retainedTerminalProof).toEqual(retained);
    expect(sent.decisionCards[1].search).toEqual(input.decisionCards[1].search);
    expect(sent.decisionCards[2].search).toEqual(input.decisionCards[2].search);
    const table = sent.conditionalContinuations;
    expect(table.candidates[0].replies.map(([r, o, h]: number[]) => [r, table.conditionalOutcomes[o], h])).toEqual(rows);
    expect(table.horizons).toEqual(input.conditionalContinuations.horizons);
    expect(table.guardSets).toEqual(input.conditionalContinuations.guardSets);
    expect(table.replyIds).toEqual(input.conditionalContinuations.replyIds);
    expect(out.questions).toEqual(questions);
    expect(input).toEqual(before);
    expect(out.budget.steps).toContain('intern-repeated-conditional-outcomes');
    expect(out.budget.sentBytes).toBeLessThanOrEqual(JEV_INPUT_BYTE_BUDGET);
  });
  it('keeps action descriptions and losslessly encodes after-action facts at the last budget step', () => {
    const afterAction = { terminal: null, complete: false, totalGuardsIncludingReserve: [8, 7],
      frozenKingMoves: [4, 'unknown'], frozenFirstStepExamples: [[{ r: 3, c: 4 }], []],
      frozenRaceFirst: 'unknown', frozenArrivalPlies: [8, null] };
    const cards = Array.from({ length: 16 }, (_, i) => ({ id: `p_${i}_0`,
      action: `Deploy SELF guard at (${i},0). OPPONENT acts next.`, afterAction: structuredClone(afterAction) }));
    const q: Record<string, JevQuestion> = { move: { type: 'choice', instructions: 'Compare the cards.',
      criteria: Object.fromEntries(cards.map(c => [c.id, c.action + ' See checked facts.'])) } };
    const input: any = { briefingVersion: 'jev-decision-1', decisionCards: cards,
      conditionalContinuations: { horizons: [['3,4', '5,4']], candidates: [] } };
    input.padding = 'x'.repeat(27000 - Buffer.byteLength(JSON.stringify(input)) - Buffer.byteLength(JSON.stringify(q)));
    const before = structuredClone(input); const beforeQuestions = structuredClone(q);
    const out = prepareJevInput('final', input, q); const sent = out.state as any;
    expect(out.budget.steps).toContain('table-encode-after-action-facts');
    for (const card of sent.decisionCards) {
      expect(Object.fromEntries(sent.afterActionColumns.map((key: string, i: number) => [key, card.afterAction[i]]))).toEqual(afterAction);
    }
    expect(out.questions.move.type === 'choice' && out.questions.move.criteria).toEqual(Object.fromEntries(cards.map(c => [c.id, c.action])));
    expect(sent.conditionalContinuations).toEqual(input.conditionalContinuations);
    expect(out.budget.sentBytes).toBeLessThanOrEqual(JEV_INPUT_BYTE_BUDGET);
    expect(input).toEqual(before); expect(q).toEqual(beforeQuestions);
  });
});
