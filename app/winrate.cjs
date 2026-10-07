const { Board, WIN } = require('./engine.cjs');

// This is an evaluation-to-percentage display, not a statistically calibrated
// prediction. Search scores always favour player 0, regardless of the human.
function estimateWinrate(state, human, analysis = null, depthShift = 0) {
  const result = (kind, rates, detail, extra = {}) => ({
    kind, human: rates[human], computer: rates[1 - human], detail,
    depth: 0, score: null, ...extra
  });
  if (state.isOver) {
    return result('finished', [0, 1].map(player => state.winnerId.includes(player) ? 100 : 0),
      state.winnerId.length === 2 ? '对局结束：双方共同获胜。' : '对局结束：已按实际结果显示。');
  }
  if (state.pendingReply) {
    return result('pending', [null, null], '后手还有最后一步，完成后确认是否共同获胜。');
  }
  const exact = analysis?.source === 'exact-endgame' && [-1, 0, 1].includes(analysis.value);
  if (exact && analysis.value === 0) {
    return result('no-forced-winner', [null, null], '无墙残局：双方最优下无单方必胜，可能共胜或循环。');
  }
  const searched = Number.isFinite(analysis?.score);
  const score = exact ? analysis.value * WIN : searched ? analysis.score : new Board(state).evaluate();
  const depth = searched ? Math.max(0, (analysis.depth || 0) - depthShift) : 0;
  if (Math.abs(score) === WIN) {
    return result('forced', score > 0 ? [100, 0] : [0, 100],
      exact ? '无墙残局精确结果，假设双方最优应对。' : '搜索已证明单方可胜，假设最优应对。', { score, depth });
  }
  // A one-step route advantage is 100 evaluation points. Avoid displaying a
  // certainty for an unproven position, even if the heuristic is very large.
  const player0 = Math.round(Math.max(1, Math.min(99, 100 / (1 + Math.exp(-score / 200)))) * 10) / 10;
  const player1 = Math.round((100 - player0) * 10) / 10;
  return result('estimate', [player0, player1],
    searched ? `搜索 ${depth} 层 · AI 估算，非统计胜率。` : '局面初评 · AI 估算，非统计胜率。',
    { score, depth, source: searched ? 'search' : 'position' });
}

module.exports = { estimateWinrate };
