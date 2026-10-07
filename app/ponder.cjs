const { Board, WIN } = require('./engine.cjs');
const { Game } = require('./game.cjs');
const { analysisKey, finishedSeed } = require('./ai.cjs');

// Compare completed scores at the same horizon; partial bounds and deeper
// leaf scores must never change the prediction order.
function predictionScore(candidate, human) {
  const result = candidate.seed?.result;
  if (!result) return null;
  const sign = human === 0 ? 1 : -1;
  if (result.source === 'immediate-win') return -WIN;
  if (result.source === 'final-reply') return WIN;
  if (result.source === 'exact-endgame' && Number.isFinite(result.value)) return sign * result.value * WIN;
  if (['proven-win', 'proven-result'].includes(result.reason) && Math.abs(result.score) === WIN) return sign * result.score;
  const iteration = result.iterations?.find(item => item.depth === 2);
  return Number.isFinite(iteration?.score) ? sign * iteration.score : null;
}
function rankPredictions(candidates, human) {
  return [...candidates].filter(candidate => !candidate.failed && !candidate.noReply).sort((a, b) => {
    const left = predictionScore(a, human), right = predictionScore(b, human);
    if (left === null || right === null) {
      if (left !== null) return -1;
      if (right !== null) return 1;
    } else if (left !== right) return right - left;
    return a.staticRank - b.staticRank;
  });
}
function allocatedSlice(candidate, base) {
  const history = candidate.seed?.result.iterations || [], last = history.at(-1);
  const previous = history.findLast(item => item.depth === (last?.depth || 0) - 2);
  if (!last || !previous || history.length < 3) return base;
  const stable = history.slice(-3).every(item => item.action === last.action)
    && Math.abs(last.score - previous.score) <= 24;
  // Scheduling granularity changes; foreground stopping rules do not.
  return Math.max(100, Math.min(2000, Math.round(base * (stable ? 0.5 : 1.25))));
}

class PonderSession {
  constructor(search, { milliseconds = 30000, adaptive = true, focus = 6, deep = 2,
    initialSurvey = 12, surveyBatch = 8, coverSlice = 500, deepSlice = 1500,
    mediumSlice = 750, maxMilliseconds = 120000, shouldContinue = () => true } = {}) {
    Object.assign(this, { search, milliseconds, adaptive, focus, deep, initialSurvey,
      surveyBatch, coverSlice, deepSlice, mediumSlice, maxMilliseconds, shouldContinue });
    this.epoch = null; this.active = null;
  }
  start(game, revision) {
    if (game.state.isOver || game.state.pendingReply || game.state.waitFor !== game.human) return;
    const key = analysisKey(game.state, game.seen);
    if (this.epoch?.key === key && this.epoch.revision === revision) {
      if (this.epoch.phase === 'paused') this.run(this.epoch);
      return;
    }
    this.stop();
    const actions = new Board(game.state).orderedActions();
    const epoch = { key, revision, human: game.human, state: structuredClone(game.state),
      seen: new Map(game.seen), candidates: actions.map((action, staticRank) => ({ action, staticRank, seed: null, failed: false })),
      phase: 'covering', milliseconds: 0, queue: [], nextStage: 'analysis', rankingUpdates: 0,
      promoted: new Set(), expansion: Math.min(this.initialSurvey, actions.length), focused: [], deepCount: this.deep };
    this.epoch = epoch; this.refreshRanking(epoch);
    epoch.queue = epoch.candidates.slice(0, epoch.expansion).map(candidate => this.surveyTask(candidate));
    this.run(epoch);
  }
  surveyTask(candidate) { return { candidate, depth: 2, slice: this.coverSlice, phase: 'covering' }; }
  ready(candidate) { return finishedSeed(candidate.seed, this.milliseconds, this.adaptive); }
  refreshRanking(epoch) {
    const ranked = rankPredictions(epoch.candidates, epoch.human), focus = ranked.slice(0, this.focus);
    // Keep preparing the original leading move too. A deeper heuristic score
    // estimates strength, not the probability that a human will choose it.
    const common = ranked.find(candidate => candidate.staticRank === 0);
    if (common && !focus.includes(common)) focus[focus.length - 1] = common;
    const changed = focus.map(item => item.action).join(',') !== epoch.focused.map(item => item.action).join(',');
    if (changed && epoch.focused.length) epoch.rankingUpdates++;
    epoch.focused = focus;
    for (const candidate of focus) if (candidate.staticRank >= this.focus && predictionScore(candidate, epoch.human) !== null)
      epoch.promoted.add(candidate.action);
    const best = predictionScore(focus[0] || {}, epoch.human);
    const close = best === null ? this.deep : focus.filter(candidate => {
      const score = predictionScore(candidate, epoch.human); return score !== null && best - score <= 24;
    }).length;
    epoch.deepCount = Math.min(focus.length, Math.max(this.deep, Math.min(4, close)));
  }
  remember(candidate, calculation) {
    const seed = calculation.checkpoint();
    if (seed && seed.key === candidate.key) candidate.seed = seed;
  }
  refill(epoch) {
    this.refreshRanking(epoch);
    if (epoch.nextStage === 'survey') {
      let expansion = epoch.candidates.slice(epoch.expansion, epoch.expansion + this.surveyBatch);
      epoch.expansion += expansion.length;
      // Interrupted shallow searches remain eligible; no move is dropped.
      if (!expansion.length) expansion = epoch.candidates.filter(candidate => !candidate.failed && !candidate.noReply
        && !this.ready(candidate) && predictionScore(candidate, epoch.human) === null).slice(0, this.surveyBatch);
      epoch.queue = expansion.map(candidate => this.surveyTask(candidate));
      epoch.nextStage = 'analysis';
      if (epoch.queue.length) return;
    }
    const awaiting = epoch.focused.filter(candidate => !this.ready(candidate));
    const common = awaiting.find(candidate => candidate.staticRank === 0);
    const priority = common ? [common, ...awaiting.filter(candidate => candidate !== common)] : awaiting;
    const deep = priority.slice(0, epoch.deepCount), medium = awaiting.filter(candidate => !deep.includes(candidate));
    epoch.queue = deep.map(candidate => ({ candidate, depth: 32,
      slice: allocatedSlice(candidate, this.deepSlice), phase: 'deepening' }));
    for (const candidate of medium) if ((candidate.seed?.result.depth || 0) < 4)
      epoch.queue.push({ candidate, depth: 4, slice: this.mediumSlice, phase: 'covering' });
    epoch.nextStage = 'survey';
    if (!epoch.queue.length && epoch.expansion < epoch.candidates.length) this.refill(epoch);
  }
  async run(epoch) {
    if (epoch.running || this.epoch !== epoch) return;
    epoch.running = true;
    try {
      while (this.epoch === epoch) {
        if (!this.shouldContinue()) { epoch.phase = 'paused'; break; }
        if (epoch.milliseconds >= this.maxMilliseconds) { epoch.phase = 'ready'; break; }
        if (!epoch.queue.length) this.refill(epoch);
        const task = epoch.queue.shift();
        if (!task) { epoch.phase = 'ready'; break; }
        const candidate = task.candidate;
        if (candidate.failed || candidate.noReply || this.ready(candidate) || (candidate.seed?.result.depth || 0) >= task.depth) continue;
        if (task.depth > 2 && !epoch.focused.includes(candidate)) continue;
        if (!candidate.state) {
          const predicted = new Game(epoch.human, epoch.state); predicted.seen = new Map(epoch.seen);
          predicted.play(candidate.action);
          candidate.state = predicted.state; candidate.seen = predicted.seen;
          candidate.key = analysisKey(predicted.state, predicted.seen);
          if (predicted.state.isOver) { candidate.noReply = true; this.refreshRanking(epoch); continue; }
        }
        epoch.phase = task.phase;
        const started = Date.now();
        const calculation = this.search.choose(candidate.state, { milliseconds: this.milliseconds,
          adaptive: task.depth === 32 && this.adaptive, maxDepth: task.depth, resume: candidate.seed,
          sliceMilliseconds: Math.min(task.slice, this.maxMilliseconds - epoch.milliseconds), seen: candidate.seen });
        const current = { calculation, candidate, started, epoch }; this.active = current;
        const result = await calculation.promise;
        if (this.epoch !== epoch || this.active !== current) break;
        epoch.milliseconds += Date.now() - started;
        this.remember(candidate, calculation); this.active = null;
        if (!result || result.reason === 'worker-fallback' || result.source === 'fallback') candidate.failed = true;
        this.refreshRanking(epoch);
        await new Promise(resolve => setImmediate(resolve));
      }
    } catch (error) {
      if (this.epoch === epoch) {
        const previous = this.active; this.active = null; previous?.calculation.cancel();
        epoch.phase = 'paused'; epoch.error = error.message;
      }
    } finally { epoch.running = false; }
  }
  take(state, seen) {
    const key = analysisKey(state, seen), epoch = this.epoch;
    if (this.active) this.remember(this.active.candidate, this.active.calculation);
    const seed = epoch?.candidates.find(candidate => candidate.key === key)?.seed || null;
    this.stop(); return seed;
  }
  stop() {
    this.epoch = null;
    const previous = this.active; this.active = null; previous?.calculation.cancel();
  }
  snapshot() {
    const epoch = this.epoch;
    if (!epoch) return { active: false, phase: 'disabled', total: 0, covered: 0, ready: 0 };
    if (this.active) this.remember(this.active.candidate, this.active.calculation);
    return { positionRevision: epoch.revision, active: Boolean(this.active), phase: epoch.phase,
      total: epoch.candidates.length, focus: epoch.focused.length, deep: epoch.deepCount,
      rankingUpdates: epoch.rankingUpdates, promoted: epoch.promoted.size,
      covered: epoch.candidates.filter(candidate => candidate.seed).length,
      ready: epoch.candidates.filter(candidate => this.ready(candidate)).length,
      milliseconds: epoch.milliseconds + (this.active ? Date.now() - this.active.started : 0), workers: this.search.pool.length };
  }
}
module.exports = { PonderSession, predictionScore, rankPredictions, allocatedSlice };
