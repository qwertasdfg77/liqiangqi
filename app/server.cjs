const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Game, initialState } = require('./game.cjs');
const { SearchSession } = require('./ai.cjs');
const { PonderSession } = require('./ponder.cjs');
const { estimateWinrate } = require('./winrate.cjs');
const { difficultyProfile } = require('./difficulty.cjs');
const SERVICE = 'lqq-duel-local-v2';
function addressPath(root = __dirname) {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'LqqDuel',
    createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 20) + '.json');
}
async function reusableAddress(url) {
  try {
    const address = new URL(url);
    if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port) return false;
    const info = await (await fetch(address.origin + '/api/info', { signal: AbortSignal.timeout(1000) })).json();
    return info.service === SERVICE && path.resolve(info.root) === __dirname;
  } catch { return false; }
}
function createApp({ milliseconds, difficulty = 'highest', workers, initial, human = 0, replay = [], revisionStart = 1, adaptive = true,
  ponder = true, ponderOptions = {}, idleMilliseconds = 15 * 60 * 1000 } = {}) {
  let selectedDifficulty = difficultyProfile(difficulty);
  milliseconds ??= selectedDifficulty.milliseconds;
  let game = new Game(human, initial || initialState()), revision = revisionStart, job = null;
  for (const action of replay) game.play(action);
  const search = new SearchSession({ workers });
  let error = '', lastAnalysis = null, progress = null, lastSeen = Date.now();
  const predictions = ponder ? new PonderSession(search, { ...ponderOptions, milliseconds, adaptive,
    shouldContinue: () => Date.now() - lastSeen < 15000 }) : null;
  let winrate;
  function assess(analysis = null, depthShift = 0) {
    winrate = { ...estimateWinrate(game.state, game.human, analysis, depthShift),
      positionRevision: revision, updatedAt: Date.now() };
  }
  assess();
  const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
  function snapshot() {
    return { ...game.snapshot(), revision, difficulty: selectedDifficulty, thinking: job !== null, error, lastAnalysis, winrate,
      ponder: predictions?.snapshot() || { active: false, phase: 'disabled' },
      ai: job ? { started: job.started, budget: job.timePlan.soft, hardBudget: job.timePlan.hard, ...progress } : null };
  }
  function cancel() { const previous = job; job = null; if (previous) previous.cancel(); }
  function selectDifficulty(profile) {
    selectedDifficulty = profile; milliseconds = profile.milliseconds;
    if (predictions) predictions.milliseconds = milliseconds;
  }
  function startPonder() { if (!job) predictions?.start(game, revision); }
  function startComputer(resume = null) {
    if (game.state.isOver || game.state.waitFor === game.human || job) return;
    error = ''; progress = { depth: 0, nodes: 0 }; const activeGame = game;
    const started = Date.now(), activeRevision = revision;
    const calculation = search.choose(game.state, { milliseconds, adaptive, seen: game.seen, resume,
      onProgress: update => {
        if (job?.started !== started || game !== activeGame || revision !== activeRevision) return;
        progress = update;
        // Publish only completed-depth scores, never a partial root bound.
        if (Number.isFinite(update.score) && (winrate.source !== 'search' ||
            winrate.depth !== update.depth || winrate.score !== update.score)) assess(update);
      } });
    const current = { ...calculation, started }; job = current;
    calculation.promise.then(result => {
      if (job !== current || game !== activeGame || !result) return;
      game.play(result.action, result); job = null; lastAnalysis = result; revision++; assess(result, 1); startPonder();
    }).catch(cause => {
      if (job !== current || game !== activeGame) return;
      job = null; error = '电脑计算未完成，请点击“重试电脑落子”。';
      console.error(cause);
    });
  }
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  async function readBody(request) {
    let data = '';
    for await (const chunk of request) { data += chunk; if (Buffer.byteLength(data) > 4096) throw new Error('请求过长。'); }
    try { return JSON.parse(data || '{}'); } catch { throw new Error('请求格式不正确。'); }
  }
  function checkRevision(body) {
    if (body.revision !== revision) throw new Error('局面已经更新，请稍后重新操作。');
  }
  const server = http.createServer(async (request, response) => {
    lastSeen = Date.now();
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
      json(response, 403, { error: '只接受本地游戏页面的操作。' }); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/info') {
      json(response, 200, { service: SERVICE, version: '1.8.0', root: __dirname }); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/state') { startPonder(); json(response, 200, snapshot()); return; }
    if (request.method === 'GET' && assets.has(url.pathname)) {
      const [filename, type] = assets.get(url.pathname);
      try {
        const data = fs.readFileSync(path.join(__dirname, filename));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); response.end(data);
      } catch { json(response, 500, { error: '页面文件缺失，请重新打开完整游戏文件夹。' }); }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.method === 'POST') {
      try {
        const body = await readBody(request);
        if (url.pathname === '/api/new') {
          if (![0, 1].includes(body.human)) throw new Error('请选择先手或后手。');
          const profile = body.difficulty === undefined ? null : difficultyProfile(body.difficulty);
          cancel(); predictions?.stop(); search.reset();
          if (profile) selectDifficulty(profile);
          game = new Game(body.human); error = ''; lastAnalysis = null; revision++; assess(); startComputer(); startPonder();
        } else if (url.pathname === '/api/difficulty') {
          checkRevision(body);
          const profile = difficultyProfile(body.difficulty);
          if (profile.key !== selectedDifficulty.key) {
            cancel(); predictions?.stop(); selectDifficulty(profile);
            error = ''; progress = null; revision++;
            winrate = { ...winrate, positionRevision: revision, updatedAt: Date.now() };
            startComputer(); startPonder();
          }
        } else if (url.pathname === '/api/move') {
          checkRevision(body);
          if (job || game.state.waitFor !== game.human || game.state.isOver) throw new Error('现在不是你的行动回合。');
          game.play(body.action); const resume = predictions?.take(game.state, game.seen);
          error = ''; revision++; assess(); startComputer(resume); startPonder();
        } else if (url.pathname === '/api/undo') {
          checkRevision(body);
          if (!game.canUndo()) throw new Error('还没有可撤回的走法。');
          cancel(); predictions?.stop(); game.undo(); error = ''; lastAnalysis = null; revision++; assess(); startComputer(); startPonder();
        } else if (url.pathname === '/api/retry') {
          checkRevision(body);
          if (job || game.state.waitFor === game.human || game.state.isOver) throw new Error('当前无需重试。');
          startComputer();
        } else { json(response, 404, { error: '接口不存在。' }); return; }
        json(response, 200, snapshot());
      } catch (cause) { json(response, 409, { error: cause.message, state: snapshot() }); }
      return;
    }
    json(response, 404, { error: '页面不存在。' });
  });
  const idleTimer = setInterval(() => { if (Date.now() - lastSeen > idleMilliseconds) close(); }, Math.min(30000, idleMilliseconds));
  idleTimer.unref();
  async function listen(port = 0) {
    await new Promise((resolve, reject) => {
      const failed = cause => { server.removeListener('error', failed); reject(cause); };
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', failed); resolve(); });
    });
    startComputer(); startPonder(); return `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    cancel(); predictions?.stop(); await search.close(); clearInterval(idleTimer);
    if (server.listening) {
      server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  return { server, listen, close, snapshot };
}
function openBrowser(url) {
  const process = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, windowsHide: true, stdio: 'ignore' });
  process.on('error', () => {}); process.unref();
}
async function main() {
  const addressFile = addressPath();
  try {
    const saved = JSON.parse(fs.readFileSync(addressFile, 'utf8'));
    if (await reusableAddress(saved.url)) { console.log(`GAME_URL=${saved.url}`); if (process.argv.includes('--open')) openBrowser(saved.url); return; }
  } catch {}
  const resumeIndex = process.argv.indexOf('--resume');
  const resume = resumeIndex < 0 ? null : JSON.parse(fs.readFileSync(process.argv[resumeIndex + 1], 'utf8').replace(/^\uFEFF/, ''));
  const app = createApp(resume ? { human: resume.human, replay: resume.history.map(entry => entry.action),
    revisionStart: resume.revision + 1, difficulty: resume.difficulty?.key || 'highest' } : {}); let url;
  try { url = await app.listen(18741); }
  catch (cause) {
    if (cause.code !== 'EADDRINUSE') throw cause;
    try {
      if (await reusableAddress('http://127.0.0.1:18741')) {
        await app.close(); console.log('GAME_URL=http://127.0.0.1:18741'); if (process.argv.includes('--open')) openBrowser('http://127.0.0.1:18741'); return;
      }
    } catch {}
    url = await app.listen(0);
  }
  console.log(`GAME_URL=${url}`);
  try {
    fs.mkdirSync(path.dirname(addressFile), { recursive: true });
    fs.writeFileSync(addressFile, JSON.stringify({ url, service: SERVICE, root: __dirname }));
  } catch {}
  if (process.argv.includes('--open')) openBrowser(url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
if (require.main === module) main().catch(cause => { console.error(cause); process.exitCode = 1; });
module.exports = { createApp, addressPath, reusableAddress };
