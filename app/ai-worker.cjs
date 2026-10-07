const { parentPort, workerData } = require('node:worker_threads');
const { Board, Search, WIN } = require('./engine.cjs');
class RetainedTable extends Map {
  begin(run) { this.run = run; this.hits = 0; this.reusedHits = 0; }
  get(key) {
    const entry = super.get(key);
    if (entry) { this.hits++; if (entry.run !== this.run) this.reusedHits++; }
    return entry;
  }
  set(key, value) { value.run = this.run; return super.set(key, value); }
}
function trim(map, limit) {
  if (map.size <= limit * 0.8) return;
  const target = Math.floor(limit * 0.6);
  for (const key of map.keys()) { if (map.size <= target) break; map.delete(key); }
}
const search = new Search({ maxEntries: workerData.maxEntries, compactKeys: workerData.compactKeys !== false });
search.table = new RetainedTable();
let board, signature, runId, abort;
const originalTick = search.tick.bind(search);
search.tick = () => {
  if ((search.nodes & 1023) === 0 && Atomics.load(abort, 0)) throw new Error('SEARCH_CANCELLED');
  originalTick();
};
parentPort.on('message', job => {
  if (job.type === 'start') {
    board = new Board(job.state); signature = board.signature(); runId = job.runId;
    abort = new Int32Array(job.abort); search.started = Date.now(); search.deadline = job.deadline;
    search.nodes = 0; search.aborted = false;
    trim(search.table, search.maxEntries); trim(search.best, search.maxEntries);
    search.table.begin(runId);
    parentPort.postMessage({ type: 'started', runId, retainedEntries: search.table.size }); return;
  }
  if (job.type !== 'search' || job.runId !== runId) return;
  const startNodes = search.nodes, startHits = search.table.hits, startReused = search.table.reusedHits;
  const transition = board.apply(job.action);
  try {
    if (Atomics.load(abort, 0)) throw new Error('SEARCH_CANCELLED');
    let score, aspirationResearches = 0;
    if (transition.terminal !== null) score = transition.terminal * WIN;
    else {
      const narrow = Number.isFinite(job.aspiration) && Math.abs(job.aspiration) < WIN;
      const alpha = narrow ? Math.max(job.alpha, job.aspiration - 64) : job.alpha;
      const beta = narrow ? Math.min(job.beta, job.aspiration + 64) : job.beta;
      if (alpha < beta) {
        score = search.minimax(board, job.depth - 1, alpha, beta);
        if (narrow && (score <= alpha || score >= beta)) {
          aspirationResearches++; score = search.minimax(board, job.depth - 1, job.alpha, job.beta);
        }
      } else score = search.minimax(board, job.depth - 1, job.alpha, job.beta);
    }
    const bound = transition.terminal !== null || job.depth === 1 ? 'exact'
      : score <= job.alpha ? 'upper' : score >= job.beta ? 'lower' : 'exact';
    parentPort.postMessage({ type: 'result', runId, depth: job.depth, action: job.action, score,
      bound, verification: Boolean(job.verification), aspirationResearches,
      nodes: search.nodes - startNodes, cacheHits: search.table.hits - startHits,
      reusedHits: search.table.reusedHits - startReused });
  } catch (error) {
    if (error.message === 'SEARCH_TIME_LIMIT') parentPort.postMessage({ type: 'timeout', runId });
    else if (error.message === 'SEARCH_CANCELLED') parentPort.postMessage({ type: 'cancelled', runId });
    else throw error;
  } finally {
    board.undo(transition.undo);
    if (board.signature() !== signature) throw new Error('Search did not restore its root');
  }
});
parentPort.postMessage({ type: 'ready' });
