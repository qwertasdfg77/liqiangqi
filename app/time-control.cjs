function timePlan(board, milliseconds, adaptive = true) {
  const distance = [board.distance(0), board.distance(1)];
  const separation = Math.abs(board.pawns[0] % 9 - board.pawns[1] % 9)
    + Math.abs(Math.floor(board.pawns[0] / 9) - Math.floor(board.pawns[1] / 9));
  const detour = Math.max(distance[0] - Math.floor(board.pawns[0] / 9),
    distance[1] - (8 - Math.floor(board.pawns[1] / 9)));
  const wallCount = board.walls.reduce((sum, wall) => sum + wall, 0);
  const critical = separation <= 3 || Math.min(...distance) <= 3 || detour >= 3;
  const simple = !critical && separation >= 6 && wallCount <= 2 && detour <= 1;
  const target = simple ? 4500 : critical ? 12000 : 7000;
  return { adaptive, kind: critical ? 'critical' : simple ? 'simple' : 'normal',
    soft: adaptive ? Math.max(1, Math.min(milliseconds * 0.6, target)) : milliseconds, hard: milliseconds,
    minimum: Math.min(milliseconds, simple ? 1000 : critical ? 4000 : 2500),
    minimumDepth: critical ? 6 : 5, scoreTolerance: 24 };
}
function stableChoice(history, plan) {
  const last = history.at(-1);
  if (!last || last.depth < plan.minimumDepth || history.length < 3) return false;
  const previous = history.findLast(item => item.depth === last.depth - 2);
  return history.slice(-3).every(item => item.action === last.action)
    && Boolean(previous) && Math.abs(last.score - previous.score) <= plan.scoreTolerance;
}
module.exports = { timePlan, stableChoice };
