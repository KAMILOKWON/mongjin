import { describe, expect, it } from 'vitest';
import { JEV_INPUT_BYTE_BUDGET, prepareJevInput } from './jevInputBudget';
import type { JevQuestion } from './jevGateway';

const questions: Record<string, JevQuestion> = { move: { type: 'choice', instructions: 'Choose the best legal move.', criteria: { p_1_1: 'Deploy a guard.', m_1_1_2_1: 'Move the king.' } } };
describe('JEV request budget', () => {
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
});
