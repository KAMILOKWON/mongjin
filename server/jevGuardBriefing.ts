import type { JevGuardPressureDecision } from './jevPressurePolicy';
import type { JevDevelopmentBriefing, JevDeploymentGeometry, JevDevelopmentSideSnapshot } from './jevDevelopmentBriefing';

/** Table encoding preserves the geometry without repeating coordinate keys. */
export function briefJevGuardInfrastructure(facts: JevDevelopmentBriefing) {
  const cells = (ps: {r:number;c:number}[]) => ps.map(p => [p.r,p.c]);
  const side = (s: JevDevelopmentSideSnapshot) => [s.king ? [s.king.r,s.king.c] : null, cells(s.deployedGuards), s.reserveGuards];
  const geometry = (g: JevDeploymentGeometry) => [cells(g.kingOnlyCells), cells(g.guardSupportedCells), cells(g.ruleOnlyCells)];
  return {
    version: facts.version, selfPlayer: facts.selfPlayer, placementRule: facts.current.deployment.placementRule,
    sideColumns: ['king', 'guards', 'reserve'],
    geometryColumns: ['kingOnly', 'guardSupported', 'ruleOnly'],
    current: { self: side(facts.current.self), opponent: side(facts.current.opponent), deployment: geometry(facts.current.deployment) },
    candidateColumns: ['id', 'terminal', 'selfAfter', 'futureDeployment', 'new', 'lost'],
    candidates: facts.candidates.map(c => [c.id, c.terminal, side(c.afterAction.self),
      c.futureSelfTurnDeployment ? geometry(c.futureSelfTurnDeployment) : null,
      c.futureSelfTurnDeployment ? cells(c.futureSelfTurnDeployment.newCells) : null,
      c.futureSelfTurnDeployment ? cells(c.futureSelfTurnDeployment.lostCells) : null]),
    meaning: 'Cells are zero-based [row,column]. The three deployment lists partition canonical legal PLACE cells. In adjacent mode deployed guards are king-independent anchors; guardSupported includes cells also adjacent to the king. Future geometry applies the candidate once, then counterfactually asks for SELF placements with no opponent response. It is not a legal extra turn or secured blocking line; the actual response can change every cell. New/lost compare with current geometry. A terminal has no future deployment. These are facts, not scores or recommendations.',
  };
}

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
