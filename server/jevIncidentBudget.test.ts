import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JEV_INPUT_BYTE_BUDGET, prepareJevInput } from './jevInputBudget';
import type { JevQuestion } from './jevGateway';

type JsonObject = Record<string, any>;
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/jev-final-budget.json', import.meta.url), 'utf8',
)) as { state: JsonObject; questions: Record<string, JevQuestion> };

const decodeRow = (row: unknown, columns: string[]) => Array.isArray(row)
  ? Object.fromEntries(columns.map((key, index) => [key, row[index]]))
  : row as JsonObject;

describe('JEV production incident final budget', () => {
  it('does not use the all-loss advisory omission for an unresolved candidate', () => {
    const input = structuredClone(fixture.state);
    input.decisionCards[0].retainedTerminalProof = null;
    expect(() => prepareJevInput('final', input, fixture.questions)).toThrow('byte budget');
    expect(input.developmentPlan).toBeDefined();
    expect(input.rolePriorities).toBeDefined();
  });
  it('losslessly fits the anonymous eight-proof final below the wire budget', () => {
    const stateBefore = structuredClone(fixture.state);
    const questionsBefore = structuredClone(fixture.questions);
    const originalCards = stateBefore.decisionCards as JsonObject[];
    const originalContinuations = stateBefore.conditionalContinuations as JsonObject;
    const expectedChoiceIds = Object.keys((questionsBefore.move as any).criteria);
    const expectedProofs = originalCards.map((card) => card.retainedTerminalProof);
    const expectedReplies = originalContinuations.candidates.map((candidate: JsonObject) => ({
      id: candidate.id,
      replies: candidate.replies,
    }));

    expect(expectedChoiceIds).toHaveLength(8);
    expect(expectedProofs).toHaveLength(8);
    expect(expectedProofs.every((proof) => proof?.proven === 'loss')).toBe(true);

    const prepared = prepareJevInput('final', fixture.state, fixture.questions);
    const sent = prepared.state as JsonObject;
    const continuations = sent.conditionalContinuations as JsonObject;

    expect(prepared.budget.sentBytes).toBeLessThanOrEqual(JEV_INPUT_BYTE_BUDGET);
    expect(prepared.budget.steps).toContain('encode-horizon-cells-as-board-indexes');
    expect(prepared.budget.steps).toContain('table-encode-decision-evidence');
    expect(Object.keys((prepared.questions.move as any).criteria)).toEqual(expectedChoiceIds);

    const decodedCards = sent.decisionCards.map((card: unknown) =>
      decodeRow(card, sent.decisionCardColumns));
    expect(decodedCards.map((card: JsonObject) => card.id)).toEqual(expectedChoiceIds);
    expect(decodedCards.map((card: JsonObject) => card.retainedTerminalProof)).toEqual(expectedProofs);

    const decodedReplies = continuations.candidates.map((candidate: JsonObject) => ({
      id: candidate.id,
      replies: candidate.replies.map(([reply, outcome, horizon]: [number | null, number | string, number | null]) => [
        reply,
        Array.isArray(continuations.conditionalOutcomes)
          ? continuations.conditionalOutcomes[outcome as number]
          : outcome,
        horizon,
      ]),
    }));
    expect(decodedReplies).toEqual(expectedReplies);

    const boardSize = continuations.cellEncoding.boardSize as number;
    const decodeCell = (cell: number | null) => cell === null
      ? null : `${Math.floor(cell / boardSize)},${cell % boardSize}`;
    expect(continuations.guardSets.map((set: (number | null)[]) => set.map(decodeCell)))
      .toEqual(originalContinuations.guardSets);
    expect(continuations.horizons.map(([self, opponent, ...facts]: [number | null, number | null, ...unknown[]]) => [
      decodeCell(self), decodeCell(opponent), ...facts,
    ])).toEqual(originalContinuations.horizons);

    expect(fixture.state).toEqual(stateBefore);
    expect(fixture.questions).toEqual(questionsBefore);
  });
});
