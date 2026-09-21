import type { JevGuardPressureDecision } from './jevPressurePolicy';

/** Existing canonical checks, not the policy's selected move or ranking. */
export function briefJevGuardDevelopment(decision: JevGuardPressureDecision | undefined) {
  const stats = decision?.stats;
  const baseline = stats?.enemyForwardBaseline;
  return {
    scope: 'guard-actions-only; immediate terminal and next-king-capture checks, not long-term safety',
    baselineMeaning: 'Enemy moves before our action is a counterfactual for comparing guard effects, not a legal pass or an extra enemy turn.',
    beforeForwardKingReplies: baseline?.complete ? baseline.safeForwardKingMoves : null,
    actionColumns: ['id', 'allRepliesChecked', 'checkedReplies', 'totalReplies', 'directCaptureThreat',
      'captureSafeForwardKingRepliesAfter', 'forwardReplyReduction', 'opponentImmediateWinningReplies'],
    actions: stats?.pressureCandidates.map(c => {
      const complete = c.complete && baseline?.complete === true;
      return [c.id, complete, c.checkedResponses, c.totalResponses, complete ? c.directThreat : null,
        complete ? c.forwardSafeKingEscapes : null, complete ? c.forwardEscapeReduction : null,
        complete ? c.immediateWinningResponses : null];
    }) ?? [],
    meaning: 'Only guard actions were checked here. Missing or incomplete entries are unknown, not ineffective. Fewer forward replies means fewer immediately capture-safe geometric king advances, not a forced delay or win. The opponent may take other actions, develop guards, or use an unexamined longer plan. No policy recommendation or combined score is supplied.',
  };
}
