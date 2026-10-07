const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { Board, WIN, mirrorAction } = require('./engine.cjs');
const { timePlan, stableChoice } = require('./time-control.cjs');
const { planLayout } = require('./strategy.cjs');
const defaultWorkers = Math.min(8, Math.max(1, os.availableParallelism() - 2));
function analysisKey(state, seen = new Map()) {
  return createHash('sha256').update(JSON.stringify([new Board(state).signature(),
    Boolean(state.pendingReply), Boolean(state.isOver), state.winnerId || [],
    [...seen].sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
}
function resumable(seed, key, legal) {
  return seed?.key === key && seed.result && legal.includes(seed.result.action)
    && Number.isFinite(seed.milliseconds) && seed.milliseconds >= 0
    && ((Number.isInteger(seed.result.depth) && seed.result.depth > 0 && Number.isFinite(seed.result.score))
      || ['immediate-win', 'final-reply', 'exact-endgame'].includes(seed.result.source));
}
function finishedSeed(seed, milliseconds, adaptive, maxDepth = 32) {
  if (!seed) return false;
  const result = seed.result;
  return ['immediate-win', 'final-reply', 'exact-endgame'].includes(result.source)
    || ['proven-win', 'proven-result'].includes(result.reason)
    || (seed.budget === milliseconds && seed.milliseconds >= milliseconds)
    || (adaptive && seed.adaptive && seed.budget === milliseconds && result.reason === 'stable-choice')
    || result.depth >= maxDepth;
}
function rootPreferences(board, seen) {
  const player = board.turn, visits = new Map();
  // Count this player's completed moves, independently of the opponent's pawn.
  // A wall placement or changed wall stock starts a different route history.
  const key = fields => [fields[player], ...fields.slice(3)].join(',');
  for (const [signature, count] of seen) {
    const fields = signature.split(',');
    if (Number(fields[2]) !== 1 - player) continue;
    const route = key(fields); visits.set(route, (visits.get(route) || 0) + count);
  }
  const cache = new Map();
  return action => {
    if (!cache.has(action)) {
      const transition = board.apply(action);
      try {
        const signature = board.signature();
        cache.set(action, { pawnVisits: visits.get(key(signature.split(','))) || 0,
          repetitions: seen.get(signature) || 0, distance: board.distance(player) });
      } finally { board.undo(transition.undo); }
    }
    return cache.get(action);
  };
}
class SearchSession {
  constructor({ workers = defaultWorkers, maxEntries = 350000, dynamicOrdering = true, aspiration = true, compactKeys = true, strategyPlanning = true } = {}) {
    this.count = Math.max(1, Math.min(8, Math.floor(workers)));
    this.maxEntries = maxEntries; this.pool = []; this.sequence = 0;
    this.active = null; this.closed = false;
    this.dynamicOrdering = dynamicOrdering; this.aspiration = aspiration; this.compactKeys = compactKeys;
    this.strategyPlanning = strategyPlanning; this.layoutPlans = new Map();
  }
  ensurePool() {
    while (this.pool.length < this.count) {
      const entry = { ready: false, dead: false };
      entry.worker = new Worker(path.join(__dirname, 'ai-worker.cjs'), {
        workerData: { maxEntries: this.maxEntries, compactKeys: this.compactKeys }, resourceLimits: { maxOldGenerationSizeMb: 640 } });
      this.pool.push(entry);
      entry.worker.on('message', message => {
        if (entry.dead) return;
        if (message.type === 'ready') { entry.ready = true; this.active?.initialize(entry); }
        else this.active?.message(entry, message);
      });
      const failed = () => {
        if (entry.dead) return;
        entry.dead = true; this.pool = this.pool.filter(candidate => candidate !== entry);
        entry.worker.terminate(); this.active?.fail();
      };
      entry.worker.on('error', failed); entry.worker.on('exit', failed); entry.worker.unref();
    }
  }
  reset() {
    this.layoutPlans.clear();
    this.active?.cancel(); const previous = this.pool; this.pool = [];
    return Promise.allSettled(previous.map(entry => { entry.dead = true; return entry.worker.terminate(); }));
  }
  close() { this.closed = true; return this.reset(); }
  choose(state, { milliseconds = 30000, onProgress = () => {}, seen = new Map(),
    exact = true, maxDepth = 32, adaptive = true, resume = null, sliceMilliseconds = milliseconds } = {}) {
    if (this.closed) throw new Error('Search session is closed');
    this.active?.cancel();
    const started = Date.now(), board = new Board(state), key = analysisKey(state, seen);
    const plan = timePlan(board, milliseconds, adaptive);
    const immediate = result => {
      const value = { ...result, milliseconds: result.milliseconds ?? Date.now() - started,
        foregroundMilliseconds: Date.now() - started };
      return { promise: Promise.resolve(value), cancel() {}, timePlan: plan,
        checkpoint: () => ({ key, result: value, milliseconds: value.milliseconds, budget: milliseconds, adaptive }) };
    };
    if (state.pendingReply) {
      const moves = board.pawnMoves();
      return immediate({ action: moves.find(move => move >= 72) ?? board.orderedActions().find(candidate => candidate < 81), source: 'final-reply' });
    }
    let ordered = board.orderedActions();
    if (!ordered.length) throw new Error('No legal computer action');
    const seed = resumable(resume, key, ordered) ? resume : null;
    if (finishedSeed(seed, milliseconds, adaptive, maxDepth)) {
      return immediate({ ...seed.result, precomputedMilliseconds: seed.milliseconds,
        precomputedDepth: seed.result.depth || 0, resumed: true, ponderReady: true });
    }
    const priorMilliseconds = seed ? Math.min(milliseconds, seed.milliseconds) : 0;
    let finishedAt = null;
    const elapsed = () => priorMilliseconds + (finishedAt ?? Date.now()) - started;
    const remaining = Math.max(1, milliseconds - priorMilliseconds);
    const slice = Math.max(1, Math.min(remaining, sliceMilliseconds));
    const deadline = started + slice;
    const stopReason = () => elapsed() >= milliseconds ? 'time-limit' : 'slice-limit';
    const remainingPlan = { ...plan, soft: Math.max(1, plan.soft - priorMilliseconds), hard: remaining };
    for (const action of ordered) {
      const transition = board.apply(action); board.undo(transition.undo);
      if (transition.terminal === (state.waitFor === 0 ? 1 : -1)) return immediate({ action, source: 'immediate-win' });
    }
    if (exact && state.leftWalls.every(count => count === 0)) {
      const worker = new Worker(path.join(__dirname, 'exact-worker.cjs'), { workerData: { state, seen: [...seen] } });
      let settled = false, resolve, latest = null;
      const promise = new Promise(r => { resolve = r; });
      const finish = result => {
        if (settled) return; settled = true; clearTimeout(timer); worker.terminate();
        if (this.active === job) this.active = null; latest = result; resolve(result);
      };
      const job = { cancel: () => finish(null), initialize() {}, message() {}, fail() {} };
      this.active = job;
      const fallback = () => finish({ action: ordered[0], source: 'fallback', milliseconds: Date.now() - started });
      const timer = setTimeout(fallback, Math.max(1, deadline - Date.now()));
      worker.once('message', result => finish({ ...result, milliseconds: Date.now() - started }));
      worker.once('error', fallback); worker.once('exit', () => { if (!settled) fallback(); });
      return { promise, cancel: job.cancel, timePlan: { ...remainingPlan, soft: remaining },
        checkpoint: () => latest?.source === 'exact-endgame'
          ? { key, result: latest, milliseconds: latest.milliseconds, budget: milliseconds, adaptive } : null };
    }
    let strategy = null;
    if (this.strategyPlanning && milliseconds >= 2000) {
      const layoutKey = board.signature();
      strategy = seed?.strategy || this.layoutPlans.get(layoutKey);
      if (!strategy) {
        strategy = planLayout(board, { milliseconds: Math.min(45, Math.max(1, deadline - Date.now())) });
        if (this.layoutPlans.size >= 64) this.layoutPlans.delete(this.layoutPlans.keys().next().value);
        this.layoutPlans.set(layoutKey, strategy);
      }
      ordered = strategy.order;
    }
    // A symmetric board can have an asymmetric route history.
    if (board.symmetric() && (!seen.size || (seen.size === 1 && seen.get(board.signature()) === 1)))
      ordered = ordered.filter(action => action <= mirrorAction(action));
    const runId = ++this.sequence, abort = new SharedArrayBuffer(4), initialized = new Set(), ready = new Set();
    let resolve, settled = false, finalResult = null, depth = seed?.result.depth || 0;
    let completeDepth = depth, complete = seed ? { action: seed.result.action, score: seed.result.score } : null;
    let queue = [], active = new Set(), completed = new Map(), best = null;
    let selection = null, verificationQueue = [], tieVerifications = 0;
    const rootOwners = new Map();
    let previousRoots = new Map(seed?.previousRoots || []), parityRoots = new Map(seed?.parityRoots || []), aspirationResearches = 0;
    let nodes = seed?.result.nodes || 0, cacheHits = seed?.result.cacheHits || 0;
    let reusedHits = seed?.result.reusedHits || 0, retainedEntries = 0, extended = priorMilliseconds >= plan.soft;
    const history = seed?.result.iterations?.map(item => ({ ...item })) || [];
    const promise = new Promise(r => { resolve = r; });
    const ownSign = state.waitFor === 0 ? 1 : -1;
    const preferences = rootPreferences(board, seen);
    // Static distance scores can keep buying time against a hypothetical wall
    // forever. Price revisits in that same heuristic scale (six distance units,
    // capped at eighteen), while retaining every move and all proven outcomes.
    const penalty = item => item.action < 81 && Math.abs(item.score) < WIN
      ? Math.min(1800, preferences(item.action).pawnVisits * 600) : 0;
    const utility = item => ownSign * item.score - penalty(item);
    const tiePreference = action => {
      const info = preferences(action);
      return info.pawnVisits * 1000 + info.repetitions * 100 + info.distance + (action < 81 ? 0 : 0.01);
    };
    const better = (item, incumbent) => utility(item) > utility(incumbent)
      || (utility(item) === utility(incumbent) && tiePreference(item.action) < tiePreference(incumbent.action));
    const status = () => ({ depth: completeDepth, score: complete?.score ?? null, nodes, cacheHits, reusedHits, retainedEntries,
      milliseconds: elapsed(), foregroundMilliseconds: (finishedAt ?? Date.now()) - started,
      precomputedMilliseconds: priorMilliseconds, precomputedDepth: seed?.result.depth || 0,
      budget: Math.max(1, (extended ? milliseconds : plan.soft) - priorMilliseconds),
      hardBudget: remaining, phase: extended ? 'extended' : 'normal' });
    const result = reason => ({ action: complete?.action ?? ordered[0], score: complete?.score ?? null,
      source: 'parallel-alpha-beta', ...status(), depth: completeDepth, workers: this.pool.length,
      reason, timeClass: plan.kind, iterations: history, tieVerifications,
      repetitionPenalty: complete ? penalty(complete) : 0,
      pawnVisits: preferences(complete?.action ?? ordered[0]).pawnVisits,
      selectionScore: complete ? utility(complete) : null, resumed: Boolean(seed), aspirationResearches,
      strategy: strategy ? { horizon: strategy.horizon, selective: true, nodes: strategy.nodes,
        milliseconds: strategy.milliseconds, plans: strategy.plans.slice(0, 3),
        distance: strategy.assessment.distance, threats: strategy.assessment.threats,
        reserve: strategy.assessment.reserve } : null });
    const checkpoint = () => complete ? { key, milliseconds: elapsed(), budget: milliseconds, adaptive, strategy,
      previousRoots: [...previousRoots], parityRoots: [...parityRoots],
      result: { ...(finalResult || result('checkpoint')), iterations: history.map(item => ({ ...item })) },
      partialIteration: depth === completeDepth + 1 && completed.size
        ? { depth, completed: [...completed.values()].map(item => ({ ...item })) } : null } : null;
    const finish = value => {
      if (settled) return; finishedAt = Date.now(); finalResult = value;
      settled = true; clearTimeout(timer); clearInterval(adaptiveTimer);
      Atomics.store(new Int32Array(abort), 0, 1);
      if (this.active === job) this.active = null;
      for (const entry of this.pool) entry.worker.unref(); resolve(value);
    };
    const considerTime = () => {
      if (settled || !plan.adaptive) return;
      const spent = elapsed();
      if (spent >= plan.minimum && stableChoice(history, plan)) { finish(result('stable-choice')); return; }
      if (!extended && spent >= plan.soft) { extended = true; onProgress(status()); }
    };
    // Node timers can fire slightly before the wall-clock deadline. Do not
    // mislabel a full-budget search as a partial slice or credit unspent time.
    const reachDeadline = () => {
      const left = deadline - Date.now();
      if (left > 0) { timer = setTimeout(reachDeadline, left); return; }
      finish(result(stopReason()));
    };
    let timer = setTimeout(reachDeadline, Math.max(1, deadline - Date.now()));
    const adaptiveTimer = setInterval(considerTime, 100);
    const send = (entry, action, verification = false) => {
      if (!verification) rootOwners.set(action, entry);
      active.add(entry); entry.worker.postMessage({ type: 'search', runId, depth, action,
        verification, aspiration: this.aspiration && !verification && depth >= 6
          ? parityRoots.get(depth % 2)?.find(item => item.action === action && item.bound === 'exact')?.score : null,
        alpha: !verification && ownSign === 1 && best ? best.score : -2 * WIN,
        beta: !verification && ownSign === -1 && best ? best.score : 2 * WIN });
    };
    const pump = () => {
      if (settled) return;
      for (const entry of this.pool) if (ready.has(entry) && !active.has(entry) && queue.length) {
        // Keep expensive root branches with their retained transposition table.
        // Limit affinity to the leading batch so priority cannot be starved.
        const index = this.dynamicOrdering && depth >= 6 ? queue.slice(0, this.count).findIndex(action=>rootOwners.get(action)===entry) : -1;
        send(entry, queue.splice(index<0?0:index,1)[0]);
      }
    };
    const beginDepth = () => {
      if (settled) return;
      if (Date.now() >= deadline || depth >= maxDepth) { finish(result(depth >= maxDepth ? 'depth-limit' : stopReason())); return; }
      depth++; completed = new Map(); active.clear(); best = null;
      // Retain completed roots of an interrupted iteration as well as its last
      // completed depth. Every saved root belongs to the same board and history.
      const partial = seed?.partialIteration;
      if (partial?.depth === depth) for (const item of partial.completed) {
        if (!ordered.includes(item.action) || !Number.isFinite(item.score)) continue;
        completed.set(item.action, item);
        if (!best || ownSign * item.score > ownSign * best.score) best = item;
      }
      const principal = complete?.action ?? ordered[0];
      queue = ordered.filter(action => !completed.has(action) && action !== principal);
      if (this.dynamicOrdering && depth >= 6) queue.sort((a, b) => {
        const x = previousRoots.get(a), y = previousRoots.get(b);
        return (y ? utility(y) : -Infinity) - (x ? utility(x) : -Infinity);
      });
      if (completed.size === ordered.length) { prepareVerification(); return; }
      if (!completed.has(principal)) send(this.dynamicOrdering && depth >= 6 ? rootOwners.get(principal)||this.pool[0] : this.pool[0], principal);
      else pump();
    };
    const finishDepth = () => {
      previousRoots = new Map(completed);
      parityRoots.set(depth % 2, [...completed.values()]);
      complete = selection; completeDepth = depth;
      history.push({ depth, action: complete.action, score: complete.score,
        repetitionPenalty: penalty(complete), milliseconds: elapsed() });
      onProgress(status());
      if (Math.abs(best.score) === WIN) { finish(result('proven-result')); return; }
      considerTime(); if (!settled) beginDepth();
    };
    const verifyNext = () => {
      while (verificationQueue.length) {
        const candidate = verificationQueue.shift();
        // A non-improving root result is an optimistic bound for this player.
        // Reopen its window before using it as an equally good alternative.
        if (!better(candidate, selection)) continue;
        if (candidate.bound === 'exact') { selection = candidate; continue; }
        tieVerifications++; send(this.pool[0], candidate.action, true); return;
      }
      finishDepth();
    };
    const prepareVerification = () => {
      selection = best;
      verificationQueue = [...completed.values()].filter(item => item.action !== best.action)
        .sort((a, b) => utility(b) - utility(a) || tiePreference(a.action) - tiePreference(b.action));
      verifyNext();
    };
    const job = {
      cancel: () => finish(null), fail: () => finish(result('worker-fallback')),
      initialize: entry => {
        if (settled || initialized.has(entry)) return;
        initialized.add(entry); entry.worker.ref();
        entry.worker.postMessage({ type: 'start', runId, state, deadline, abort });
      },
      message: (entry, message) => {
        if (settled || message.runId !== runId) return;
        if (message.type === 'started') {
          ready.add(entry); retainedEntries += message.retainedEntries;
          if (ready.size === this.pool.length) beginDepth(); return;
        }
        if (message.type === 'timeout') { finish(result(stopReason())); return; }
        if (message.type !== 'result' || message.depth !== depth) return;
        active.delete(entry); nodes += message.nodes; cacheHits += message.cacheHits; reusedHits += message.reusedHits;
        aspirationResearches += message.aspirationResearches || 0;
        if (message.verification) {
          completed.set(message.action, message);
          if (better(message, selection)) selection = message;
          onProgress(status()); verifyNext(); return;
        }
        completed.set(message.action, message);
        if (!best || ownSign * message.score > ownSign * best.score) best = message;
        onProgress(status());
        if (ownSign * best.score === WIN) { complete = best; completeDepth = depth; finish(result('proven-win')); return; }
        if (completed.size === ordered.length) {
          prepareVerification();
        } else pump();
      }
    };
    this.active = job; this.ensurePool();
    for (const entry of this.pool) if (entry.ready) job.initialize(entry);
    considerTime();
    return { promise, cancel: job.cancel, timePlan: remainingPlan, checkpoint };
  }
}
function choose(state, options = {}) {
  const session = new SearchSession({ workers: options.workers });
  const calculation = session.choose(state, options);
  return { ...calculation, promise: calculation.promise.finally(() => session.close()) };
}
module.exports = { choose, SearchSession, rootPreferences, analysisKey, finishedSeed };
