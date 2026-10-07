'use strict';
const $ = id => document.getElementById(id);
const boardElement = $('board');
let state = null, mode = 'move', side = 0, posting = false, hovering = null, drawnRevision = -1, drawnMode = '';
let toastTimer, pollTimer, polling = false;
let computerSide = 'top';
try { if (localStorage.getItem('lqq-computer-side') === 'bottom') computerSide = 'bottom'; } catch {}
const flipped = () => state && (state.computer === 0) === (computerSide === 'top');
const viewCell = (x, y) => flipped() ? { x: 8 - x, y: 8 - y } : { x, y };
const canAct = () => state && !posting && !state.thinking && !state.isOver && state.waitFor === state.human;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); }
function wallGeometry(action) {
  const wall = action - 81, index = wall % 64, x = index % 8, y = Math.floor(index / 8);
  const rect = wall < 64 ? { x: 40 + 66 * x, y: 100 + 66 * y, width: 126, height: 6 }
    : { x: 100 + 66 * x, y: 40 + 66 * y, width: 6, height: 126 };
  return flipped() ? { ...rect, x: 668 - rect.x - rect.width, y: 668 - rect.y - rect.height } : rect;
}
function rectAttributes(rect) { return `x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"`; }
function renderBoard() {
  if (!state) return;
  const legal = new Set(state.actions), interactive = canAct();
  const last = state.history.at(-1), lastClass = last?.player === state.human ? 'last-human' : 'last-computer';
  let svg = '<rect x="28" y="28" width="612" height="612" rx="15" class="grid-background"/>';
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const action = x + 9 * y, name = `${'ABCDEFGHI'[x]}${9 - y}`, available = interactive && mode === 'move' && legal.has(action);
    const view = viewCell(x, y);
    const classes = `cell${available ? ' legal' : ''}${last?.action === action ? ' ' + lastClass : ''}`;
    svg += `<rect x="${40 + 66 * view.x}" y="${40 + 66 * view.y}" width="60" height="60" rx="7" class="${classes}" data-action="${action}" role="button" tabindex="${available ? 0 : -1}" aria-label="${name}${available ? '，可走' : ''}" aria-disabled="${!available}"/>`;
    if (available) svg += `<circle cx="${70 + 66 * view.x}" cy="${70 + 66 * view.y}" r="15" class="move-halo"/><circle cx="${70 + 66 * view.x}" cy="${70 + 66 * view.y}" r="6" class="move-dot"/>`;
  }
  for (let index = 0; index < 9; index++) {
    const coordinate = flipped() ? 8 - index : index;
    svg += `<text x="${70 + 66 * index}" y="655" class="coordinate">${'ABCDEFGHI'[coordinate]}</text><text x="${70 + 66 * index}" y="19" class="coordinate">${'ABCDEFGHI'[coordinate]}</text>`;
    svg += `<text x="15" y="${74 + 66 * index}" class="coordinate">${9 - coordinate}</text><text x="653" y="${74 + 66 * index}" class="coordinate">${9 - coordinate}</text>`;
  }
  for (const wall of state.walls) {
    const action = 81 + wall.x + 8 * wall.y + 64 * wall.d, rect = wallGeometry(action);
    svg += `<rect ${rectAttributes(rect)} rx="3" class="wall ${wall.p === state.human ? 'human' : 'computer'}${last?.action === action ? ' last' : ''}"/>`;
  }
  for (const player of [0, 1]) {
    const pos = state.playerPos[player], view = viewCell(pos.x, pos.y), human = player === state.human, x = 70 + 66 * view.x, y = 70 + 66 * view.y;
    svg += `<g data-pawn="${player}" role="img" aria-label="${human ? '你的棋子' : '电脑棋子'}，${'ABCDEFGHI'[pos.x]}${9 - pos.y}">`;
    if (human && interactive) svg += `<circle cx="${x}" cy="${y}" r="26" class="pawn-ring"/>`;
    svg += `<circle cx="${x}" cy="${y + 4}" r="22" class="pawn-shadow"/><circle cx="${x}" cy="${y}" r="21" class="pawn-${human ? 'human' : 'computer'}"/><text x="${x}" y="${y}" class="pawn-label">${human ? '你' : 'AI'}</text></g>`;
  }
  if (interactive && mode !== 'move') for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const action = 81 + x + 8 * y + (mode === 'vertical' ? 64 : 0), view = flipped() ? { x: 7 - x, y: 7 - y } : { x, y };
    const available = legal.has(action), cx = 103 + 66 * view.x, cy = 103 + 66 * view.y;
    svg += `<g><rect x="${cx - 30}" y="${cy - 30}" width="60" height="60" class="wall-hit${available ? '' : ' invalid'}" data-action="${action}" role="button" tabindex="${available ? 0 : -1}" aria-label="${mode === 'horizontal' ? '横墙' : '竖墙'} ${'ABCDEFGHI'[x]}${9 - y}${available ? '，可放置' : '，不能放置'}" aria-disabled="${!available}"/><circle cx="${cx}" cy="${cy}" r="4" class="wall-marker${available ? ' legal' : ''}"/></g>`;
  }
  svg += '<g id="wall-preview"></g>';
  boardElement.innerHTML = svg; renderPreview();
}
function renderPreview() {
  const preview = $('wall-preview'); if (!preview) return;
  preview.innerHTML = '';
  if (!canAct() || mode === 'move' || hovering === null || hovering < 81) return;
  const legal = state.actions.includes(hovering);
  preview.innerHTML = `<rect ${rectAttributes(wallGeometry(hovering))} rx="3" class="wall-preview${legal ? '' : ' invalid'}"/>`;
}
function updateClock() {
  if (!state?.thinking || !state.ai) return;
  const elapsed = Math.max(0, Date.now() - state.ai.started), remaining = Math.max(0, Math.ceil((state.ai.budget - elapsed) / 1000));
  $('think-progress').max = state.ai.budget; $('think-progress').value = Math.min(elapsed, state.ai.budget);
  $('think-clock').textContent = remaining ? `${state.ai.phase === 'extended' ? '深入推演' : '比较走法'} · 本阶段最多还需 ${remaining} 秒` : '评估是否需要深入推演…';
}
function renderWinrate() {
  const assessment = state.winrate;
  if (!assessment || assessment.positionRevision !== state.revision) {
    $('human-winrate').textContent = $('computer-winrate').textContent = '—';
    $('winrate-bar').hidden = true; $('winrate-state').textContent = '等待评估';
    $('winrate-detail').textContent = '正在读取当前局面评估。'; return;
  }
  const percentage = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
  $('human-winrate').textContent = percentage(assessment.human);
  $('computer-winrate').textContent = percentage(assessment.computer);
  $('winrate-state').textContent = assessment.kind === 'finished' ? '实际结果'
    : assessment.kind === 'forced' || assessment.kind === 'no-forced-winner' ? '已精确判定'
    : assessment.kind === 'pending' ? '最后一步待确认'
    : state.thinking ? '推演中更新' : '当前局面';
  const complementary = Number.isFinite(assessment.human) && Number.isFinite(assessment.computer)
    && Math.abs(assessment.human + assessment.computer - 100) < 0.01;
  $('winrate-bar').hidden = !complementary;
  if (complementary) $('winrate-bar').value = assessment.human;
  $('winrate-detail').textContent = assessment.detail;
}
function renderPonder() {
  const prediction = state.ponder;
  const visible = !state.thinking && !state.isOver && !state.pendingReply
    && state.waitFor === state.human && prediction?.positionRevision === state.revision;
  $('ponder-panel').hidden = !visible;
  if (!visible) return;
  $('ponder-state').textContent = prediction.active ? '进行中' : prediction.phase === 'paused' ? '已暂停' : '已就绪';
  $('ponder-detail').textContent = `共有 ${prediction.total} 种合法走法，动态关注 ${prediction.focus} 种，优先深入 ${prediction.deep} 种；已提前计算 ${prediction.covered} 种应对，其中 ${prediction.ready} 种可直接使用。名单随推演结果更新。`;
}
function render(next) {
  if (state && next.revision < state.revision) return;
  const changed = !state || state.revision !== next.revision || state.thinking !== next.thinking;
  state = next; $('connection').textContent = '本地运行';
  $('difficulty-label').textContent = state.difficulty.label;
  $('difficulty-time').textContent = `智能用时 · 上限 ${state.difficulty.milliseconds / 1000} 秒`;
  for (const button of document.querySelectorAll('[data-difficulty]')) {
    const selected = button.dataset.difficulty === state.difficulty.key;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    button.disabled = posting;
  }
  $('human-name').textContent = `你 · ${state.human === 0 ? '先手' : '后手'}`;
  $('computer-name').textContent = `电脑 · ${state.human === 0 ? '后手' : '先手'}`;
  const computerUpper = computerSide === 'top';
  $('human-direction').textContent = computerUpper ? '向上方终点前进' : '向下方终点前进';
  $('computer-direction').textContent = computerUpper ? '向下方终点前进' : '向上方终点前进';
  for (const button of document.querySelectorAll('[data-computer-side]')) {
    const selected = button.dataset.computerSide === computerSide;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  }
  $('human-walls').textContent = state.leftWalls[state.human]; $('computer-walls').textContent = state.leftWalls[state.computer];
  $('upper-goal').textContent = `↑ ${computerUpper ? '你的' : '电脑的'}终点`;
  $('lower-goal').textContent = `↓ ${computerUpper ? '电脑的' : '你的'}终点`;
  $('move-count').textContent = state.isOver ? `共 ${state.history.length} 手` : `第 ${state.history.length + 1} 手`;
  $('thinking').hidden = !state.thinking; $('retry').hidden = !state.error;
  $('undo').disabled = posting || !state.canUndo; $('new-game').disabled = posting;
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.disabled = !canAct() || (button.dataset.mode !== 'move' && !state.leftWalls[state.human]);
    button.classList.toggle('active', button.dataset.mode === mode); button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  let title, detail;
  if (state.isOver) {
    title = state.winnerId.length === 2 ? '共同获胜' : state.winnerId.includes(state.human) ? '你获胜了' : '电脑获胜';
    detail = state.winnerId.length === 2 ? '双方在同一轮到达终点。可以重新开局再战。' : '对局结束。可以换个先后手，再来一局。';
  } else if (state.error) { title = '等待重试'; detail = state.error; }
  else if (state.thinking) { title = '电脑思考中'; detail = state.pendingReply ? '先手已到达，电脑正在完成后手的最后一步。' : state.ai?.phase === 'extended' ? '走法还未稳定，正在深入推演。你可以悔棋或重开。' : '正在评估双方通道、剩余墙和组合布局，比较走棋与放墙。'; }
  else if (state.pendingReply) { title = '你的最后一步'; detail = '先手已经到达。你还有最后一步，到达终点即可共同获胜。'; }
  else { title = '轮到你了'; detail = state.history.length ? state.lastAnalysis?.resumed ? '电脑已利用提前推演落子，继续走棋或放墙。' : '电脑已落子，继续走棋或放墙。' : '点击棋盘走棋，或用墙改变双方路线。'; }
  if (state.repetition >= 3 && !state.isOver && !state.pendingReply && !state.thinking) detail = '局面已重复出现，对局仍继续。你可以改变路线或放墙。';
  $('status').textContent = title; $('status-detail').textContent = detail;
  $('board-help').textContent = !canAct() ? (state.isOver ? '重新开局即可再战。' : '等待电脑落子，你也可以悔棋或重开。')
    : mode === 'move' ? '点击发光的格子走棋。' : '点击墙位圆点放墙；鼠标悬停可预览，灰色点不可放置。';
  if (changed || drawnRevision !== state.revision || drawnMode !== mode) {
    drawnRevision = state.revision; drawnMode = mode; renderBoard();
    $('history').innerHTML = '';
    if (!state.history.length) { const item = document.createElement('li'); item.className = 'empty-history'; item.textContent = '棋盘准备好了，等你落子。'; $('history').append(item); }
    else for (let index = Math.max(0, state.history.length - 30); index < state.history.length; index++) {
      const entry = state.history[index], item = document.createElement('li'); item.className = entry.player === state.human ? 'human' : 'computer';
      for (const [className, text] of [['number', index + 1], ['who', entry.player === state.human ? '你' : '电脑'], ['what', entry.text]]) {
        const span = document.createElement('span'); span.className = className; span.textContent = text; item.append(span);
      }
      $('history').append(item);
    }
    $('history').scrollTop = $('history').scrollHeight;
  }
  $('history-count').textContent = `${state.history.length} 手`; updateClock(); renderWinrate(); renderPonder();
}
async function post(endpoint, payload = {}) {
  if (posting) return; posting = true; if (state) render(state);
  try {
    const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state?.revision, ...payload }) });
    const data = await response.json();
    if (!response.ok) { if (data.state) render(data.state); throw new Error(data.error); }
    mode = 'move'; hovering = null; drawnRevision = -1; render(data);
  } catch (cause) { toast(cause.message || '连接未完成，请重试。'); }
  finally { posting = false; drawnRevision = -1; if (state) render(state); clearTimeout(pollTimer); pollTimer = setTimeout(poll, 200); }
}
async function poll() {
  if (polling) return; polling = true;
  try { const response = await fetch('/api/state', { cache: 'no-store' }); if (!response.ok) throw new Error(); render(await response.json()); }
  catch { $('connection').textContent = '连接中断'; $('status').textContent = '本地服务已断开'; $('status-detail').textContent = '请重新双击“力墙棋.exe”，然后刷新页面。'; $('winrate-state').textContent = '暂停更新'; $('ponder-state').textContent = '已暂停'; }
  finally { polling = false; clearTimeout(pollTimer); pollTimer = setTimeout(poll, state?.thinking ? 450 : state?.ponder?.active ? 1000 : 8000); }
}
function boardAction(event) {
  const pawn = event.target.closest('[data-pawn]');
  if (pawn && Number(pawn.dataset.pawn) === state?.human && canAct()) { mode = 'move'; hovering = null; drawnMode = ''; render(state); return; }
  const target = event.target.closest('[data-action]'); if (!target || !canAct()) return;
  const action = Number(target.dataset.action);
  if ((mode === 'move') !== (action < 81)) return;
  if (!state.actions.includes(action)) { toast(action < 81 ? '请点击发光的格子。' : '这里不能放墙：墙不能重叠、交叉或封死通路。'); return; }
  post('move', { action });
}
boardElement.addEventListener('click', boardAction);
boardElement.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); boardAction(event); } });
boardElement.addEventListener('pointerover', event => { const target = event.target.closest('[data-action]'); hovering = target ? Number(target.dataset.action) : null; renderPreview(); });
boardElement.addEventListener('pointerleave', () => { hovering = null; renderPreview(); });
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => { mode = button.dataset.mode; hovering = null; drawnMode = ''; render(state); });
for (const button of document.querySelectorAll('[data-side]')) button.addEventListener('click', () => {
  side = Number(button.dataset.side);
  for (const choice of document.querySelectorAll('[data-side]')) { choice.classList.toggle('selected', Number(choice.dataset.side) === side); choice.setAttribute('aria-pressed', String(Number(choice.dataset.side) === side)); }
});
for (const button of document.querySelectorAll('[data-computer-side]')) button.addEventListener('click', () => {
  computerSide = button.dataset.computerSide;
  try { localStorage.setItem('lqq-computer-side', computerSide); } catch {}
  hovering = null; drawnRevision = -1;
  if (state) render(state);
});
for (const button of document.querySelectorAll('[data-difficulty]')) button.addEventListener('click', () => {
  if (state && button.dataset.difficulty !== state.difficulty.key) post('difficulty', { difficulty: button.dataset.difficulty });
});
$('new-game').addEventListener('click', () => post('new', { human: side }));
$('undo').addEventListener('click', () => post('undo'));
$('retry').addEventListener('click', () => post('retry'));
setInterval(updateClock, 250); poll();
