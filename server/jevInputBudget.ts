import { JevError } from './jev';
import { JEV_MODEL, type JevQuestion } from './jevGateway';
import { jevMoveId } from './jevPolicy';

// Conservative wire-byte preflight, not a claim about a proprietary tokenizer.
// Leaves headroom below the advertised 32K context for provider formatting.
export const JEV_INPUT_BYTE_BUDGET = 26_000;
type Phase = 'proposals' | 'reproposal' | 'final';
const record = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const bytes = (state: unknown, questions: Record<string, JevQuestion>) =>
  Buffer.byteLength(JSON.stringify({ model: JEV_MODEL, state, questions }), 'utf8');

/** Compact duplicated descriptions first, then explicitly omit horizon detail
 * if necessary. Every choice ID and every enumerated first reply/outcome stays
 * in the request; the full unabridged analysis remains in the turn trace. */
export function prepareJevInput(phase: Phase, input: unknown, sourceQuestions: Record<string, JevQuestion>) {
  const originalBytes = bytes(input, sourceQuestions);
  if (phase === 'final' && record(input) && input.briefingVersion === 'jev-decision-1') {
    const state = structuredClone(input);
    const steps: string[] = [];
    const note = () => { state.inputCompaction = { steps: [...steps], fullEvidenceInTrace: true,
      meaning: 'All first-reply outcomes and horizon positions remain in shared tables. Pressure reply IDs, checked response counts and consequences remain. Example safe-response IDs and unproven extension examples may be omitted, never treated as safe.' }; };
    if (originalBytes > JEV_INPUT_BYTE_BUDGET) {
      // Actions remain in each criterion. Preserve the complete reply/horizon
      // dictionaries and concrete pressure facts before optional PV examples.
      for (const card of state.decisionCards) delete card.action;
      steps.push('deduplicate-decision-actions'); note();
    }
    if (bytes(state, sourceQuestions) > JEV_INPUT_BYTE_BUDGET) {
      for (const card of state.decisionCards) {
        for (const example of card.opponentCapturePressure?.examples ?? []) delete example.safeResponseExamples;
      }
      steps.push('omit-response-id-examples-keep-counts-and-replies'); note();
    }
    if (bytes(state, sourceQuestions) > JEV_INPUT_BYTE_BUDGET) {
      state.pressureExampleColumns = ['opponentReply', 'allResponsesChecked', 'checkedResponses', 'totalResponses',
        'safeResponseCounts', 'immediateWins', 'consequence'];
      for (const card of state.decisionCards) {
        const pressure = card.opponentCapturePressure;
        if (pressure?.examples) pressure.examples = pressure.examples.map((e: any) =>
          [e.opponentReply, e.allResponsesChecked, e.checkedResponses, e.totalResponses,
            e.safeResponseCounts, e.immediateWins, e.consequence]);
      }
      steps.push('table-encode-pressure-facts'); note();
    }
    if (bytes(state, sourceQuestions) > JEV_INPUT_BYTE_BUDGET) {
      for (const card of state.decisionCards) {
        const extension = card.search?.extension;
        if (!extension || extension.proven !== 'unknown') continue;
        delete extension.end; delete extension.exampleLine;
        extension.exampleDetail = 'omitted-for-budget; full unproven extension in trace';
      }
      steps.push('summarize-unproven-extension-examples'); note();
    }
    if (bytes(state, sourceQuestions) > JEV_INPUT_BYTE_BUDGET) {
      for (const card of state.decisionCards) {
        const search = card.search; const retained = card.retainedTerminalProof;
        if (!retained || !search || search.proven !== retained.proven
          || !['win', 'loss'].includes(search.proven)
          || ['winner', 'reason', 'plies'].some(key => search.proof?.[key] !== retained.proof?.[key])
          || JSON.stringify(search.exampleLine) !== JSON.stringify(retained.proofLine)) continue;
        card.search = { completedDepth: search.completedDepth, proven: search.proven,
          exactProofReference: 'retainedTerminalProof' };
      }
      state.exactProofReferenceMeaning = 'References replace identical current proof/line with the retained proof. Redundant terminal facts and extension examples are omitted; full search remains in trace.';
      steps.push('deduplicate-matching-terminal-proofs'); note();
    }
    if (bytes(state, sourceQuestions) > JEV_INPUT_BYTE_BUDGET) {
      const continuations = state.conditionalContinuations;
      if (continuations?.horizonDetail === 'lossless-shared-tables'
        && continuations.replyColumns?.[1] === 'conditionalOutcome') {
        const outcomes: string[] = [];
        for (const candidate of continuations.candidates) {
          candidate.replies = candidate.replies.map(([reply, outcome, horizon]: [number | null, string, number | null]) => {
            let index = outcomes.indexOf(outcome);
            if (index < 0) { index = outcomes.length; outcomes.push(outcome); }
            return [reply, index, horizon];
          });
        }
        continuations.replyColumns = ['firstReplyIndex', 'conditionalOutcomeIndex', 'horizonIndex'];
        continuations.conditionalOutcomes = outcomes;
        continuations.outcomeIndexMeaning = 'conditionalOutcomeIndex refers to conditionalOutcomes; all outcomes are preserved unchanged.';
        steps.push('intern-repeated-conditional-outcomes'); note();
      }
    }
    const sentBytes = bytes(state, sourceQuestions);
    if (sentBytes > JEV_INPUT_BYTE_BUDGET) {
      console.warn('[jev-input-budget]', JSON.stringify({ phase, originalBytes, sentBytes, steps }));
      throw new JevError('invalid_response', `JEV input exceeds conservative ${JEV_INPUT_BYTE_BUDGET}-byte budget (${sentBytes})`);
    }
    return { state, questions: sourceQuestions, budget: { originalBytes, sentBytes, byteBudget: JEV_INPUT_BYTE_BUDGET, steps } };
  }
  let state = input;
  let questions = sourceQuestions;
  const steps: string[] = [];
  const note = () => {
    if (record(state)) state.inputCompaction = {
      steps: [...steps], fullEvidenceInTrace: true,
      meaning: 'All candidate IDs and first reply/outcome rows are retained. Some detailed continuation horizon facts may be omitted; omitted detail is unknown, never evidence of safety.',
    };
  };
  if (originalBytes > JEV_INPUT_BYTE_BUDGET) {
    state = structuredClone(input);
    questions = structuredClone(sourceQuestions);
    if (phase === 'final' && record(state)) {
      // Preserve the pressure moves/counts/completeness even if option prose is
      // compacted later; omitted response coordinates remain in the trace.
      const pressure = state.opponentPressure;
      if (record(pressure) && Array.isArray(pressure.candidates)) {
        state.pressureSummary = pressure.candidates.map((c: any) => ({ id: c.id, complete: c.complete,
          repliesChecked: c.checkedOpponentReplies, totalReplies: c.totalOpponentReplies,
          examples: c.examples.map((e: any) => ({ reply: jevMoveId(e.opponentReply),
            checked: e.checkedResponses, total: e.totalResponses, complete: e.responsesComplete,
            nextReplySafe: {
              forwardKing: e.safeResponses.filter((r: any) => r.action === 'king' && r.advancesRow).length,
              otherKing: e.safeResponses.filter((r: any) => r.action === 'king' && !r.advancesRow).length,
              guards: e.safeResponses.filter((r: any) => r.action === 'guard').length,
              immediateWins: e.safeResponses.filter((r: any) => r.immediateWin).length,
            },
          })),
        }));
      }
      delete state.opponentPressure;
      steps.push('compact-pressure-examples'); note();
    }
  }
  if (bytes(state, questions) > JEV_INPUT_BYTE_BUDGET && record(state)) {
    const continuations = state.conditionalContinuations;
    if (phase === 'final' && record(continuations) && continuations.firstReplyCoverage === 'all-legal') {
      const moves: unknown[] = []; const outcomes: unknown[] = [];
      const intern = (items: unknown[], value: unknown) => {
        let index = items.indexOf(value); if (index < 0) { index = items.length; items.push(value); } return index;
      };
      continuations.replyColumns = ['firstReplyIndex', 'outcomeIndex'];
      continuations.replyValueDictionaries = { moves, outcomes };
      continuations.dictionaryMeaning = 'Each row contains zero-based indexes into moves and outcomes. Every legal first reply is retained.';
      continuations.horizonDetail = 'omitted-for-request-budget';
      for (const candidate of continuations.candidates) {
        candidate.replies = candidate.replies.map((row: unknown[]) => [intern(moves, row[0]), intern(outcomes, row[1])]);
      }
      steps.push('omit-continuation-horizon-detail-keep-all-replies'); note();
    }
  }
  if (bytes(state, questions) > JEV_INPUT_BYTE_BUDGET && record(state)) {
    // Both stages already contain board, ID-indexed root/candidate facts and
    // the exact terminal proof. Preserve those and remove repeated option prose.
    for (const question of Object.values(questions)) {
      if (question.type !== 'choice') continue;
      question.criteria = Object.fromEntries(Object.keys(question.criteria).map(id => [id,
        id === 'none' ? 'No useful move serves this role.' : `Legal move ${id}; evaluate its shared facts.`,
      ]));
    }
    state.moveIdFormat = 'p_ROW_COL deploys one guard. m_FROMROW_FROMCOL_TOROW_TOCOL moves the piece at the first cell. Coordinates are zero-based; the board identifies king versus guard.';
    steps.push('deduplicate-option-descriptions'); note();
  }
  if (bytes(state, questions) > JEV_INPUT_BYTE_BUDGET && phase !== 'final' && record(state) && Array.isArray(state.facts)) {
    const route = (r: any) => [r.status, r.kingMoves, r.firstStepExamples, r.reason];
    state.rootFactColumns = ['id', 'immediateWin', 'immediateLoss', 'opponentWinningReplies', 'checkedReplies', 'repliesComplete', 'totalGuardsIncludingReserve', 'selfFrozenRoute', 'opponentFrozenRoute', 'frozenRaceFuturePlies'];
    state.routeColumns = ['status', 'kingMoves', 'firstStepExamples', 'reason'];
    state.facts = state.facts.map((f: any) => [f.id, f.immediateWin, f.immediateLoss, f.opponentWinningReplies.map(jevMoveId), f.checkedReplies, f.repliesComplete, f.totalGuardsIncludingReserve, route(f.frozenRoutesAfterAction.self), route(f.frozenRoutesAfterAction.opponent), f.frozenRoutesAfterAction.frozenRaceFuturePlies]);
    steps.push('table-encode-all-root-facts'); note();
  }
  const sentBytes = bytes(state, questions);
  if (sentBytes > JEV_INPUT_BYTE_BUDGET) {
    console.warn('[jev-input-budget]', JSON.stringify({ phase, originalBytes, sentBytes, steps }));
    throw new JevError('invalid_response', `JEV input exceeds conservative ${JEV_INPUT_BYTE_BUDGET}-byte budget (${sentBytes})`);
  }
  return { state, questions, budget: { originalBytes, sentBytes, byteBudget: JEV_INPUT_BYTE_BUDGET, steps } };
}
