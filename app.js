'use strict';
/* ══════════════════════════════════════════════════════════════════════
   app.js – Amore & Gambit  (main coordinator)
   Requires: chess.js · music.js · socket.io (from server)
══════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════
   0. INSTANCES & STATE
═══════════════════════════════════════════════════ */
const game  = new ChessGame();
const music = new MusicPlayer();

// Socket.IO – on Vercel: connect to Render backend. On localhost: same origin.
let socket;
try {
  const _backendUrl = (typeof RENDER_URL !== 'undefined' && RENDER_URL && location.hostname !== 'localhost')
    ? RENDER_URL : '';
  socket = _backendUrl
    ? io(_backendUrl, { autoConnect: false, transports: ['websocket', 'polling'] })
    : io({ autoConnect: false });
} catch(e) {
  const noop = () => {};
  socket = { connect: noop, emit: noop, on: noop, disconnect: noop, connected: false, id: null };
}

const State = {
  userId:        getUserId(),
  userName:      localStorage.getItem('ag_name') || '',
  roomCode:      localStorage.getItem('ag_room') || generateRoomCode(),
  partnerName:   null,
  partnerUserId: null,
  roomUsers:     [],
  syncMusic:     true,     // whether to broadcast/receive music-sync
  _receiving:    false,    // guard against echo loops
};

// Save room code persistently
localStorage.setItem('ag_room', State.roomCode);

/* ════════════════════════════════════════════════
   1. UTILITIES
═══════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const mkEl = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls)  el.className = cls;
  if (html) el.innerHTML = html;
  return el;
};
const fmtTime = s => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let _toastTimer;
function toast(msg, dur = 3000) {
  let el = document.querySelector('.toast');
  if (!el) { el = mkEl('div', 'toast'); document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(_toastTimer);
  el.classList.add('show');
  _toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function getUserId() {
  let id = localStorage.getItem('ag_user_id');
  if (!id) {
    id = 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    localStorage.setItem('ag_user_id', id);
  }
  return id;
}

/* ════════════════════════════════════════════════
   2. BACKEND API
═══════════════════════════════════════════════════ */
const api = {
  async getHistory() {
    try {
      const r = await fetch('/api/history');
      return await r.json();
    } catch(_) { return []; }
  },
  async saveHistory(entry) {
    try {
      const r = await fetch('/api/history', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(entry),
      });
      return await r.json();
    } catch(_) { return null; }
  },
  async saveUser(id, name) {
    try {
      await fetch('/api/user', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id, name }),
      });
    } catch(_) {}
  },
};

/* ════════════════════════════════════════════════
   3. NAME PROMPT
═══════════════════════════════════════════════════ */
function initNamePrompt() {
  const overlay = $('name-prompt-overlay');
  const input   = $('name-input');
  const btn     = $('btn-save-name');

  if (State.userName) {
    overlay.classList.add('hidden');
    afterNameSet();
    return;
  }

  overlay.classList.remove('hidden');
  setTimeout(() => input?.focus(), 400);

  const saveName = () => {
    const name = input.value.trim();
    if (!name) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
    setUserName(name);
    overlay.classList.add('hidden');
    afterNameSet();
  };

  btn.addEventListener('click', saveName);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });
}


function setUserName(name) {
  State.userName = name;
  localStorage.setItem('ag_name', name);
  api.saveUser(State.userId, name);
  updateNameDisplays();
}

function updateNameDisplays() {
  const n = State.userName;
  if ($('label-me'))              $('label-me').textContent = n;
  if ($('profile-display-name'))  $('profile-display-name').textContent = n + (State.partnerName ? ' & ' + State.partnerName : '');
  if ($('profile-letter'))        $('profile-letter').textContent = n.charAt(0).toUpperCase();
  if ($('avatar-letter-me'))      $('avatar-letter-me').textContent = n.charAt(0).toUpperCase();
}

function afterNameSet() {
  updateNameDisplays();
  updateRoomDisplays();
  connectSocket();
  navigateTo('settings');
}

/* Change name modal */
$('btn-change-name')?.addEventListener('click', () => {
  $('change-name-input').value = State.userName;
  $('change-name-modal').classList.remove('hidden');
  setTimeout(() => $('change-name-input')?.focus(), 100);
});
$('btn-cancel-rename')?.addEventListener('click', () => $('change-name-modal').classList.add('hidden'));
$('btn-confirm-rename')?.addEventListener('click', () => {
  const name = $('change-name-input').value.trim();
  if (!name) return;
  setUserName(name);
  $('change-name-modal').classList.add('hidden');
  // Rejoin room with new name
  joinRoom(State.roomCode);
  toast('✓ Name updated!');
});
$('change-name-modal')?.addEventListener('click', e => {
  if (e.target === $('change-name-modal')) $('change-name-modal').classList.add('hidden');
});

/* ════════════════════════════════════════════════
   4. SOCKET.IO – ROOM MANAGEMENT
═══════════════════════════════════════════════════ */
function connectSocket() {
  try {
    if (socket.connected) { joinRoom(State.roomCode); return; }
    socket.connect();
  } catch(e) {
    console.warn('[Socket] Could not connect — server may be offline.');
  }
}

socket.on('connect', () => {
  console.log('[Socket] Connected:', socket.id);
  joinRoom(State.roomCode);
});

socket.on('disconnect', () => {
  console.log('[Socket] Disconnected');
  updatePartnerStatus(false, null);
});

function joinRoom(code) {
  State.roomCode = code.toUpperCase();
  localStorage.setItem('ag_room', State.roomCode);
  socket.emit('join-room', {
    roomCode: State.roomCode,
    userId:   State.userId,
    userName: State.userName,
  });
  updateRoomDisplays();
  toast(`Joined room ${State.roomCode}`);
}

socket.on('room-joined', ({ users, musicState, queue }) => {
  State.roomUsers = users;
  updateRoomUsers(users);

  // If someone is already in the room, sync their music state
  if (musicState && musicState.videoId) {
    receiveMusicAction(musicState);
  }
  // Sync queue
  if (queue && queue.length) {
    State._receiving = true;
    music.setQueue(queue, musicState?.queueIdx ?? 0);
    State._receiving = false;
    renderMusicQueue();
    renderSidebarQueue();
  }
});

socket.on('peer-joined', ({ name }) => {
  State.partnerName = name;
  updatePartnerStatus(true, name);
  toast(`💕 ${name} joined the room!`);
});

socket.on('peer-left', ({ name }) => {
  updatePartnerStatus(false, null);
  toast(`${name} left the room.`);
});

socket.on('room-users', users => {
  State.roomUsers = users;
  updateRoomUsers(users);
  const others = users.filter(u => u.userId !== State.userId);
  if (others.length > 0) {
    State.partnerName = others[0].name;
    updatePartnerStatus(true, State.partnerName);
  } else {
    updatePartnerStatus(false, null);
  }
});

function updatePartnerStatus(online, name) {
  const dots  = document.querySelectorAll('.partner-dot, #drawer-partner-dot');
  const names = ['partner-name-nav', 'drawer-partner-name'];
  dots.forEach(d => {
    d.className = 'partner-dot' + (online ? ' partner-online' : ' partner-offline');
  });
  names.forEach(id => {
    const el = $(id);
    if (el) el.textContent = online ? name : 'Waiting for partner…';
  });
  if ($('profile-connected-label')) {
    $('profile-connected-label').textContent = online
      ? `Connected with ${name}`
      : 'Partner not connected';
  }
  if ($('label-partner'))  $('label-partner').textContent = name || 'Partner';
  updateNameDisplays();
}

function updateRoomUsers(users) {
  const list = $('room-users-list');
  if (!list) return;
  const others = users.filter(u => u.userId !== State.userId);
  if (!others.length) {
    list.innerHTML = '<div class="room-user-empty">No one else in the room yet.</div>';
    return;
  }
  list.innerHTML = '';
  others.forEach(u => {
    list.insertAdjacentHTML('beforeend', `
      <div class="room-user-item">
        <div class="room-user-avatar">${u.name.charAt(0).toUpperCase()}</div>
        <span class="room-user-name">${u.name}</span>
        <span class="partner-dot partner-online"></span>
      </div>`);
  });
}

function updateRoomDisplays() {
  const code = State.roomCode;
  [$('room-code-display'), $('settings-room-code'), $('drawer-room-code')].forEach(el => {
    if (el) el.textContent = code;
  });
}

// Copy room code buttons
document.querySelectorAll('[id^="btn-copy-room"], [data-copy-room]').forEach(btn => {
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(State.roomCode).then(() => toast('📋 Room code copied!')).catch(() => {
      prompt('Copy this room code:', State.roomCode);
    });
  });
});

// Join from settings
$('btn-join-room-settings')?.addEventListener('click', () => {
  const code = $('join-code-input').value.trim().toUpperCase();
  if (code.length < 4) { toast('Enter a valid room code (4+ characters)'); return; }
  joinRoom(code);
  $('join-code-input').value = '';
});
$('join-code-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-join-room-settings')?.click();
});

/* ════════════════════════════════════════════════
   5. NAVIGATION
═══════════════════════════════════════════════════ */
let currentPage = 'settings';

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.id !== `page-${page}`));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));
  document.querySelectorAll('.bottom-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.drawer-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));
  $('mobile-drawer').classList.remove('open');

  if (page === 'game')     { renderBoard(); updatePlayerUI(); renderClocks(); }
  if (page === 'settings') { renderHistory(); updateLobbyStats(); }
  if (page === 'music')    { renderMusicQueue(); }
  if (page === 'lobby')    { updateLobbyStats(); }
}

document.querySelectorAll('.nav-link,.drawer-link').forEach(l => {
  l.addEventListener('click', e => { e.preventDefault(); navigateTo(l.dataset.page); });
});
document.querySelectorAll('.bottom-nav-btn').forEach(b => {
  b.addEventListener('click', () => navigateTo(b.dataset.page));
});
$('hamburger').addEventListener('click', () => $('mobile-drawer').classList.toggle('open'));

/* ════════════════════════════════════════════════
   6. CHESS BOARD + CLOCKS
═══════════════════════════════════════════════════ */
const CLOCK_INITIAL = 10 * 60;  // 10 minutes in seconds
const clocks = { w: CLOCK_INITIAL, b: CLOCK_INITIAL };
let clockRunning  = false;
let clockInterval = null;
let clockLastTick = null;   // Date.now() when current player's turn started
let gameStarted   = false;

function startClocks() {
  if (clockRunning) return;
  clockRunning  = true;
  gameStarted   = true;
  clockLastTick = Date.now();
  if (!clockInterval) {
    clockInterval = setInterval(tickClock, 100); // 100ms precision
  }
  renderClocks();
}

function stopClocks() {
  clockRunning = false;
  renderClocks();
}

function resetClocks() {
  clockRunning  = false;
  gameStarted   = false;
  clockLastTick = null;
  clocks.w = CLOCK_INITIAL;
  clocks.b = CLOCK_INITIAL;
  if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
  renderClocks();
}

function tickClock() {
  if (!clockRunning || !clockLastTick) return;
  const now     = Date.now();
  const elapsed = (now - clockLastTick) / 1000;
  clockLastTick = now;
  const active  = game.turn;
  clocks[active] = Math.max(0, clocks[active] - elapsed);
  renderClocks();
  if (clocks[active] <= 0) {
    stopClocks();
    const loser      = active === 'w' ? 'White' : 'Black';
    const winnerName = active === 'w' ? (State.partnerName || 'Partner') : State.userName;
    toast(`\u23f0 ${loser} ran out of time! ${winnerName} wins!`, 7000);
    saveGameToHistory(winnerName).then(() => updateLobbyStats());
    game.status = 'checkmate';
    renderBoard();
  }
}

function renderClocks() {
  const fmtClock = s => {
    s = Math.max(0, Math.ceil(s));
    const m   = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    return `${m}:${sec}`;
  };
  const topEl = $('clock-top');
  const botEl = $('clock-bottom');
  if (topEl) {
    topEl.textContent = fmtClock(clocks.b);
    topEl.className   = 'player-clock'
      + (clockRunning && game.turn === 'b' ? ' clock-active' : '')
      + (clocks.b <= 30 && gameStarted     ? ' clock-low'    : '');
  }
  if (botEl) {
    botEl.textContent = fmtClock(clocks.w);
    botEl.className   = 'player-clock'
      + (clockRunning && game.turn === 'w' ? ' clock-active' : '')
      + (clocks.w <= 30 && gameStarted     ? ' clock-low'    : '');
  }
}

/* Call after every move — resets the tick reference for the new active player */
function onMoveMade() {
  if (!gameStarted) {
    startClocks();        // first move: begin counting
  } else {
    clockLastTick = Date.now();  // switch the tick baseline to now
    renderClocks();
  }
}



const SYMBOLS = {
  wK:'♔',wQ:'♕',wR:'♖',wB:'♗',wN:'♘',wP:'♙',
  bK:'♚',bQ:'♛',bR:'♜',bB:'♝',bN:'♞',bP:'♟',
};

let selectedSq   = null;
let legalCache   = [];
let promoPending = null;

function renderBoard() {
  const el = $('chess-board');
  if (!el) return;
  el.innerHTML = '';

  let checkKing = null;
  if (game.status === 'check' || game.status === 'checkmate') {
    checkKing = game._findKing(game.turn);
  }

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = mkEl('div', `chess-cell ${(r + c) % 2 === 0 ? 'light' : 'dark'}`);
      cell.dataset.r = r; cell.dataset.c = c;

      const isSel      = selectedSq && selectedSq.r === r && selectedSq.c === c;
      const isLastFrom = game.lastMove?.fr === r && game.lastMove?.fc === c;
      const isLastTo   = game.lastMove?.tr === r && game.lastMove?.tc === c;
      const isCheck    = checkKing?.r === r && checkKing?.c === c;
      const legalTgt   = legalCache.find(m => m.tr === r && m.tc === c);

      if (isSel)      cell.classList.add('sq-selected');
      if (isLastFrom) cell.classList.add('sq-last-from');
      if (isLastTo)   cell.classList.add('sq-last-to');
      if (isCheck)    cell.classList.add('sq-check');

      if (legalTgt) {
        cell.appendChild(mkEl('div', game.board[r][c] ? 'move-ring' : 'move-dot'));
      }

      if (c === 0) cell.appendChild(mkEl('span', 'coord coord-rank', (8 - r).toString()));
      if (r === 7) cell.appendChild(mkEl('span', 'coord coord-file', 'abcdefgh'[c]));

      const piece = game.board[r][c];
      if (piece) {
        const sym = SYMBOLS[piece.c + piece.t] || '?';
        cell.appendChild(mkEl('span', `piece piece-${piece.c}`, sym));
      }

      cell.addEventListener('click', () => onCellClick(r, c));
      el.appendChild(cell);
    }
  }
  updateGameStatus();
  updatePlayerUI();
}

function onCellClick(r, c) {
  if (game.status === 'checkmate' || game.status === 'stalemate' || game.status === 'draw') return;

  const piece = game.board[r][c];

  if (selectedSq) {
    const isLegal = legalCache.some(m => m.tr === r && m.tc === c);

    if (isLegal) {
      const result = game.move(selectedSq.r, selectedSq.c, r, c);
      if (result === 'promotion') {
        promoPending = { fr: selectedSq.r, fc: selectedSq.c, tr: r, tc: c };
        showPromoModal(game.board[selectedSq.r][selectedSq.c].c);
        return;
      }
      // Broadcast move to partner
      emitChessMove({ fr: selectedSq.r, fc: selectedSq.c, tr: r, tc: c, promo: null });
      selectedSq = null; legalCache = [];
      renderBoard();
      handleGameResult(result);
      onMoveMade();
      return;
    }

    if (piece && piece.c === game.turn) {
      selectedSq = { r, c }; legalCache = game.legalMoves(r, c);
      renderBoard(); return;
    }
    selectedSq = null; legalCache = [];
    renderBoard(); return;
  }

  if (piece && piece.c === game.turn) {
    selectedSq = { r, c }; legalCache = game.legalMoves(r, c);
    renderBoard();
  }
}

function emitChessMove(mv) {
  socket.emit('chess-move', { ...mv, fromUser: State.userId });
}

// Receive partner's move
socket.on('chess-move', ({ fr, fc, tr, tc, promo, reset }) => {
  if (reset) {
    game.reset(); selectedSq = null; legalCache = [];
    resetClocks(); renderBoard(); toast('♟ Partner started a new game!');
    return;
  }
  const result = game.move(fr, fc, tr, tc, promo);
  selectedSq = null; legalCache = [];
  renderBoard();
  handleGameResult(result);
  onMoveMade();
  toast(`♟ Partner moved ${game.squareName(fr,fc)} → ${game.squareName(tr,tc)}`);
});


// Resign events
socket.on('player-resigned', ({ name }) => {
  stopClocks();
  toast(`🏳 ${name} resigned. You win!`, 6000);
  saveGameToHistory(State.userName).then(() => updateLobbyStats());
  game.status = 'checkmate';
  renderBoard();
});

// Draw events
socket.on('draw-offered', ({ name }) => {
  $('draw-offer-msg').textContent = `${name} is offering a draw. Accept?`;
  $('draw-offer-modal').classList.remove('hidden');
});
socket.on('draw-accepted', () => {
  $('draw-offer-modal').classList.add('hidden');
  stopClocks();
  toast('🤝 Draw agreed!', 5000);
  saveGameToHistory(null).then(() => updateLobbyStats());
  game.status = 'stalemate';
  renderBoard();
});
socket.on('draw-declined', ({ name }) => {
  toast(`${name} declined the draw offer.`, 3000);
});


async function handleGameResult(result) {
  if (result === 'checkmate') {
    stopClocks();
    const winner = game.turn === 'w' ? 'Black' : 'White';
    toast(`♚ Checkmate! ${winner} wins! 🎉`, 6000);
    await saveGameToHistory(winner === 'White' ? State.userName : State.partnerName || 'Partner');
    updateLobbyStats();
  } else if (result === 'stalemate') {
    stopClocks();
    toast('🤝 Stalemate — Draw!', 5000);
    await saveGameToHistory(null);
    updateLobbyStats();
  } else if (result === 'draw') {
    stopClocks();
    toast('50-move rule — Draw!', 5000);
    await saveGameToHistory(null);
    updateLobbyStats();
  } else if (result === 'check') {
    toast('⚠️ Check!', 2000);
  }
}

async function saveGameToHistory(winner) {
  const entry = {
    winner,
    loser:    winner === State.userName ? (State.partnerName || 'Partner') : State.userName,
    moves:    game.history.length,
    result:   winner ? (winner === State.userName ? 'Victory' : 'Defeat') : 'Draw',
    players:  [State.userName, State.partnerName || 'Partner'],
    roomCode: State.roomCode,
    date:     new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
  };
  await api.saveHistory(entry);
}

function updateGameStatus() {
  const textEl = $('game-status-text');
  const iconEl = $('game-status-icon');
  if (!textEl) return;
  const turn = game.turn === 'w' ? 'White' : 'Black';
  let text = '', cls = '', icon = '♟';
  switch (game.status) {
    case 'playing':   text=`${turn}'s turn`;            cls='status-playing';   icon=game.turn==='w'?'♙':'♟'; break;
    case 'check':     text=`${turn} is in Check! ⚠️`;  cls='status-check';     icon='⚠️'; break;
    case 'checkmate': text=`Checkmate! ${turn==='White'?'Black':'White'} wins`; cls='status-checkmate'; icon='👑'; break;
    case 'stalemate': text='Stalemate — Draw';          cls='status-stalemate'; icon='🤝'; break;
    case 'draw':      text='Draw (50-move rule)';       cls='status-draw';      icon='🤝'; break;
  }
  textEl.textContent = text;
  textEl.className   = `game-status-text ${cls}`;
  if (iconEl) iconEl.textContent = icon;
}

function updatePlayerUI() {
  const topCard = $('player-top');
  const botCard = $('player-bottom');
  if (!topCard) return;
  const whiteActive = game.turn === 'w';
  botCard.classList.toggle('active-player', whiteActive);
  topCard.classList.toggle('active-player', !whiteActive);
  const sTop = $('status-top');
  const sBot = $('status-bottom');
  if (sTop) sTop.textContent = !whiteActive ? 'Thinking…' : 'Waiting…';
  if (sBot) { sBot.textContent = whiteActive ? 'Your turn' : 'Waiting…'; sBot.className = `player-status${whiteActive?' thinking':''}`; }

  const capByWhite = game.captured.w.map(p => SYMBOLS['b' + p.t] || '?').join('');
  const capByBlack = game.captured.b.map(p => SYMBOLS['w' + p.t] || '?').join('');
  const capBot = $('captured-bottom'); if (capBot) capBot.textContent = capByWhite;
  const capTop = $('captured-top');   if (capTop) capTop.textContent = capByBlack;
}

function showPromoModal(color) {
  const modal = $('promo-modal');
  modal.querySelectorAll('.promo-btn').forEach(btn => {
    btn.querySelector('.promo-piece').textContent = SYMBOLS[color + btn.dataset.piece] || '?';
  });
  modal.classList.remove('hidden');
}

document.querySelectorAll('.promo-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!promoPending) return;
    const { fr, fc, tr, tc } = promoPending;
    const result = game.move(fr, fc, tr, tc, btn.dataset.piece);
    emitChessMove({ fr, fc, tr, tc, promo: btn.dataset.piece });
    promoPending = null; selectedSq = null; legalCache = [];
    $('promo-modal').classList.add('hidden');
    renderBoard(); handleGameResult(result);
  });
});

$('btn-new-game')?.addEventListener('click', () => {
  game.reset(); selectedSq = null; legalCache = [];
  resetClocks();
  navigateTo('game');
});
$('btn-reset-game')?.addEventListener('click', () => {
  if (confirm('Start a new game?')) {
    game.reset(); selectedSq = null; legalCache = [];
    resetClocks();
    socket.emit('chess-move', { reset: true });
    renderBoard(); toast('♟ New game started!');
  }
});
$('btn-undo-move')?.addEventListener('click', () => {
  if (!game.history.length) { toast('Nothing to undo'); return; }
  const hist = [...game.history];
  hist.pop();
  game.reset();
  for (const h of hist) game.move(h.fr, h.fc, h.tr, h.tc, h.piece?.promo);
  selectedSq = null; legalCache = [];
  renderBoard(); toast('↩ Undone');
});

/* ── Resign ── */
$('btn-resign')?.addEventListener('click', () => {
  if (!confirm('Are you sure you want to resign?')) return;
  stopClocks();
  socket.emit('player-resigned', { name: State.userName, roomCode: State.roomCode });
  toast('🏳 You resigned.', 4000);
  saveGameToHistory(State.partnerName || 'Partner').then(() => updateLobbyStats());
  game.status = 'checkmate';
  renderBoard();
});

/* ── Request Draw ── */
$('btn-request-draw')?.addEventListener('click', () => {
  socket.emit('draw-offered', { name: State.userName, roomCode: State.roomCode });
  toast('🤝 Draw offer sent…', 3000);
});
$('btn-accept-draw')?.addEventListener('click', () => {
  socket.emit('draw-accepted', { roomCode: State.roomCode });
  $('draw-offer-modal').classList.add('hidden');
  stopClocks();
  toast('🤝 Draw agreed!', 5000);
  saveGameToHistory(null).then(() => updateLobbyStats());
  game.status = 'stalemate';
  renderBoard();
});
$('btn-decline-draw')?.addEventListener('click', () => {
  socket.emit('draw-declined', { name: State.userName, roomCode: State.roomCode });
  $('draw-offer-modal').classList.add('hidden');
  toast('Draw offer declined.', 2000);
});

/* ════════════════════════════════════════════════
   7. LOBBY STATS
═══════════════════════════════════════════════════ */
async function updateLobbyStats() {
  const history = await api.getHistory();
  const mine = history.filter(h => h.players?.includes(State.userName));
  const myWins = mine.filter(h => h.winner === State.userName).length;
  const partnerWins = mine.filter(h => h.winner && h.winner !== State.userName).length;
  const total = mine.length;
  const rate  = total ? Math.round((myWins / total) * 100) : 0;

  if ($('stat-my-wins'))      $('stat-my-wins').textContent = myWins;
  if ($('stat-partner-wins')) $('stat-partner-wins').textContent = partnerWins;
  if ($('stat-winrate'))      $('stat-winrate').textContent = total ? `${rate}% Win Rate` : '—';

  // Recent matches
  const matchList = $('recent-matches');
  if (!matchList) return;
  const recent = mine.slice(0, 5);
  if (!recent.length) { matchList.innerHTML='<div class="match-empty">No games yet — play your first match! ♟</div>'; return; }
  matchList.innerHTML = '';
  recent.forEach(h => {
    const icon = h.result === 'Victory' ? '🏆' : h.result === 'Defeat' ? '💔' : '🤝';
    const badgeCls = h.result === 'Victory' ? 'won-badge' : h.result === 'Defeat' ? 'waiting-badge' : 'your-turn-badge';
    matchList.insertAdjacentHTML('beforeend', `
      <div class="match-item">
        <div class="match-info"><span class="match-name">${icon} ${h.players?.join(' vs ')}</span><span class="match-sub">${h.moves} moves · ${h.date||''}</span></div>
        <span class="match-badge ${badgeCls}">${h.result}</span>
      </div>`);
  });
}

/* ════════════════════════════════════════════════
   8. MUSIC PLAYER  –  UI + Socket sync
═══════════════════════════════════════════════════ */

/* ── Callbacks ── */
music.onTrackChange = (track) => {
  updateNowPlayingUI(track);
  renderMusicQueue();
  renderSidebarQueue();
  // Update play buttons to show "playing"
  document.querySelectorAll('[data-ctrl="play"]').forEach(b => { b.textContent = '⏸'; });
  if (!State._receiving) emitMusicAction('trackChange');
};
music.onPlayStateChange = (playing) => {
  document.querySelectorAll('[data-ctrl="play"]').forEach(b => {
    b.textContent = playing ? '⏸' : '▶';
  });
  renderMusicQueue(); // refresh active indicator
  if (!State._receiving) emitMusicAction(playing ? 'play' : 'pause');
};
music.onProgress = (cur, dur) => {
  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  [['sidebar-progress-fill', 'sidebar-cur', 'sidebar-dur'],
   ['mini-fill', 'mini-cur', 'mini-dur']].forEach(([fId, cId, dId]) => {
    const f = $(fId); if (f) f.style.width = `${pct}%`;
    const c = $(cId); if (c) c.textContent = fmtTime(cur);
    const d = $(dId); if (d) d.textContent = fmtTime(dur);
  });
};
music.onQueueChange = () => {
  renderMusicQueue();
  renderSidebarQueue();
  if (!State._receiving) emitMusicAction('queueUpdate');
};

/* ── Emit music action to room ── */
function emitMusicAction(type) {
  if (!$('toggle-music-sync')?.checked) return;
  socket.emit('music-action', {
    type,
    videoId:     music.currentTrack?.id || null,
    title:       music.currentTrack?.title,
    artist:      music.currentTrack?.artist,
    thumb:       music.currentTrack?.thumb,
    source:      music.currentTrack?.source,
    currentTime: music.getCurrentTime(),
    isPlaying:   music.isPlaying,
    queueIdx:    music.currentIdx,
    queue:       music.queue,
  });
}

/* ── Receive music action from partner ── */
socket.on('music-action', payload => {
  if (!$('toggle-music-sync')?.checked) return;
  State._receiving = true;
  receiveMusicAction(payload);
  State._receiving = false;
});

function receiveMusicAction(payload) {
  const { type, videoId, title, artist, thumb, source, currentTime, isPlaying, queue, queueIdx, serverTime } = payload;

  // Sync queue first
  if (queue && queue.length) {
    const diff = music.queue.length !== queue.length ||
                 music.queue.some((t, i) => t.id !== queue[i]?.id);
    if (diff) music.setQueue(queue, queueIdx || 0);
  }

  // Compensate for network latency
  const latency = serverTime ? (Date.now() - serverTime) / 1000 : 0;
  const adjustedTime = Math.max(0, (currentTime || 0) + latency);

  if (type === 'trackChange') {
    if (videoId && videoId !== music.currentTrack?.id) {
      music.play(queueIdx !== undefined ? queueIdx : music.currentIdx, adjustedTime);
    }
    toast(`♫ ${payload.fromUser || 'Partner'} is playing: ${title}`);
  } else if (type === 'play') {
    if (videoId && videoId !== music.currentTrack?.id) {
      music.play(queueIdx !== undefined ? queueIdx : music.currentIdx, adjustedTime);
    } else if (!music.isPlaying) {
      music.seekToSeconds(adjustedTime);
      music.resume();
    }
  } else if (type === 'pause') {
    music.pause();
    music.seekToSeconds(currentTime || 0);
  } else if (type === 'queueUpdate') {
    // Queue already synced above
  }

  updateNowPlayingUI(music.currentTrack);
  renderMusicQueue();
  renderSidebarQueue();
}

/* ── UI Helpers ── */
function updateNowPlayingUI(track) {
  if (!track) {
    [$('sidebar-title'), $('mini-title')].forEach(el => { if (el) el.textContent = 'No song playing'; });
    [$('sidebar-artist'), $('mini-artist')].forEach(el => { if (el) el.textContent = 'Add a song to get started'; });
    return;
  }
  const pairs = [
    ['sidebar-title', 'sidebar-artist', 'sidebar-thumb'],
    ['mini-title',    'mini-artist',    'mini-thumb'],
  ];
  pairs.forEach(([tId, aId, imgId]) => {
    const t  = $(tId);  if (t)  t.textContent = track.title  || '—';
    const a  = $(aId);  if (a)  a.textContent = track.artist || '—';
    const im = $(imgId); if (im) im.src = track.thumb || '';
  });
}

/* ── Controls ── */
document.addEventListener('click', e => {
  const ctrl = e.target.closest('[data-ctrl]');
  if (!ctrl) return;
  const action = ctrl.dataset.ctrl;
  if (action === 'prev') music.prev();
  if (action === 'play') music.togglePlay();
  if (action === 'next') music.next();
});

/* ── Volume slider ── */
const volSlider = $('vol-slider');
if (volSlider) {
  volSlider.value = music.volume;
  volSlider.addEventListener('input', () => music.setVolume(+volSlider.value));
}

/* ── Progress bar seek ── */
[$('sidebar-progress-track'), $('mini-bar-track')].forEach(track => {
  if (!track) return;
  track.addEventListener('click', e => {
    const rect = track.getBoundingClientRect();
    music.seekTo((e.clientX - rect.left) / rect.width);
    emitMusicAction('seek');
  });
});

/* ── Album cards (quick add) ── */
document.querySelectorAll('.album-card').forEach(card => {
  card.addEventListener('click', async () => {
    const ytId   = card.dataset.ytid;
    if (!ytId) return;
    const title  = card.querySelector('.album-title')?.textContent || 'Song';
    const artist = card.querySelector('.album-artist')?.textContent || '';
    const thumb  = `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`;
    music.addTrack({ id: ytId, title, artist, thumb, source: 'youtube' });
    document.querySelectorAll('.album-card').forEach(c => c.classList.remove('active-album'));
    card.classList.add('active-album');
    toast(`♪ Added: ${title}`);
    music.play(music.queue.length - 1);
  });
});

/* ── Music page queue filter ── */
$('music-browse-search')?.addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.mq-item').forEach(item => {
    const text = item.querySelector('.mq-title')?.textContent.toLowerCase() || '';
    item.style.display = text.includes(q) || !q ? '' : 'none';
  });
});

/* ── Render music queue ── */
function renderMusicQueue() {
  const list = $('music-queue-list');
  if (!list) return;
  if (!music.queue.length) {
    list.innerHTML = `
      <div class="queue-empty">
        <strong>Queue is empty</strong><br/>
        Click <strong>+ Add Song</strong> to add music from<br/>
        YouTube, YouTube Music, or Spotify
      </div>`;
    return;
  }
  list.innerHTML = '';
  music.queue.forEach((track, idx) => {
    const active = idx === music.currentIdx;
    const item   = mkEl('div', `mq-item${active ? ' mq-active' : ''}`);
    const numSpan = mkEl('span', 'mq-num', active ? '▶' : (idx + 1).toString());
    const artEl  = mkEl('div', 'mq-art');
    if (track.thumb) {
      const img = document.createElement('img');
      img.src = track.thumb; img.alt = track.title;
      img.onerror = () => { artEl.innerHTML = '♪'; img.remove(); };
      artEl.appendChild(img);
    } else { artEl.textContent = '♪'; }
    const info = mkEl('div', 'mq-info',
      `<div class="mq-title">${track.title || '—'}</div><div class="mq-artist">${track.artist || ''}</div>`);
    const removeBtn = mkEl('button', 'mq-remove', '✕');
    removeBtn.setAttribute('aria-label', 'Remove');
    removeBtn.addEventListener('click', e => { e.stopPropagation(); music.removeTrack(idx); });
    item.append(numSpan, artEl, info, removeBtn);
    item.addEventListener('click', () => music.play(idx));
    list.appendChild(item);
  });
}

/* ── Render sidebar mini-queue ── */
function renderSidebarQueue() {
  const container = $('sidebar-queue');
  if (!container) return;
  container.innerHTML = '<div class="up-next-label">Up Next</div>';
  const upNext = music.queue.slice(music.currentIdx + 1, music.currentIdx + 4);
  if (!upNext.length) {
    container.innerHTML += '<div style="font-size:11px;color:var(--text-pale);padding:6px 0">Queue is empty</div>';
    return;
  }
  upNext.forEach((track, i) => {
    const realIdx = music.currentIdx + 1 + i;
    const item = mkEl('div', 'snq-item');
    const thumb = mkEl('div', 'snq-thumb');
    if (track.thumb) {
      const img = document.createElement('img');
      img.src = track.thumb; img.alt = ''; img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.onerror = () => { thumb.innerHTML = '♪'; img.remove(); };
      thumb.appendChild(img);
    } else { thumb.textContent = '♪'; }
    const info = mkEl('div', 'snq-info',
      `<div class="snq-title">${track.title || '—'}</div><div class="snq-by">${track.artist || ''}</div>`);
    item.append(thumb, info);
    item.addEventListener('click', () => music.play(realIdx));
    container.appendChild(item);
  });
}

/* ════════════════════════════════════════════════
   9. ADD SONG MODAL
═══════════════════════════════════════════════════ */
const addSongModal = $('add-song-modal');

document.querySelectorAll('.btn-add-song').forEach(b => {
  b.addEventListener('click', () => {
    addSongModal.classList.remove('hidden');
    $('song-search-input')?.focus();
  });
});
$('close-add-song').addEventListener('click', () => addSongModal.classList.add('hidden'));
addSongModal.addEventListener('click', e => { if (e.target === addSongModal) addSongModal.classList.add('hidden'); });

/* Tab switching */
document.querySelectorAll('.song-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.song-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.song-tab-panel').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
    $('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

/* ── Search Tab ── */
$('btn-song-search').addEventListener('click', doSearch);
$('song-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const q = $('song-search-input').value.trim();
  if (!q) return;
  const resEl = $('search-results');
  resEl.innerHTML = '<div class="search-msg">🔍 Searching…</div>';
  try {
    const results = await music.searchYouTube(q);
    renderSearchResults(results);
  } catch (err) {
    if (err.code === 'NO_KEY' || err.message?.includes('No API')) {
      resEl.innerHTML = `<div class="search-msg">
        🔑 <strong>No API key.</strong><br/>
        <a style="cursor:pointer;color:var(--rose)" onclick="document.querySelector('.song-tab[data-tab=apikey]').click()">Set your API key</a> or
        <a style="cursor:pointer;color:var(--rose)" onclick="document.querySelector('.song-tab[data-tab=url]').click()">paste a URL</a>.
      </div>`;
    } else {
      resEl.innerHTML = `<div class="search-msg" style="color:#c0392b">Search failed: ${err.message}</div>`;
    }
  }
}

function renderSearchResults(results) {
  const el = $('search-results');
  if (!results?.length) { el.innerHTML = '<div class="search-msg">No results found.</div>'; return; }
  el.innerHTML = '';
  results.forEach(track => {
    const item   = mkEl('div', 'sr-item');
    const img    = document.createElement('img');
    img.className = 'sr-thumb'; img.src = track.thumb || ''; img.alt = track.title;
    img.onerror  = () => img.style.display = 'none';
    const info   = mkEl('div', 'sr-info',
      `<div class="sr-title">${track.title}</div><div class="sr-artist">${track.artist}</div>`);
    const actions = mkEl('div', 'sr-actions');
    const addBtn  = mkEl('button', 'sr-add', '+ Add');
    const playBtn = mkEl('button', 'sr-play-now', '▶ Play');
    addBtn.addEventListener('click', () => {
      const wasEmpty = music.queue.length === 0;
      music.addTrack(track);
      addBtn.textContent = '✓ Added'; addBtn.disabled = true;
      toast(`♪ Added: ${track.title}`);
      // Auto-play if this was the first track
      if (wasEmpty) {
        music.play(0);
        $('add-song-modal')?.classList.add('hidden');
      }
    });
    playBtn.addEventListener('click', () => {
      music.addTrack(track);
      music.play(music.queue.length - 1);
      playBtn.textContent = '▶ Playing'; playBtn.disabled = true;
      addBtn.textContent  = '✓ Added';  addBtn.disabled  = true;
      toast(`▶ Now playing: ${track.title}`);
      $('add-song-modal')?.classList.add('hidden');
    });
    actions.append(addBtn, playBtn);
    item.append(img, info, actions);
    el.appendChild(item);
  });
}

/* ── URL Tab ── */
$('btn-add-url').addEventListener('click', doAddUrl);
$('song-url-input').addEventListener('keydown', e => { if (e.key === 'Enter') doAddUrl(); });

async function doAddUrl() {
  const url  = $('song-url-input').value.trim();
  const btn  = $('btn-add-url');
  const stat = $('url-status');
  if (!url) return;
  btn.textContent = 'Loading…'; btn.disabled = true;
  stat.textContent = 'Resolving…'; stat.className = 'url-status loading';
  try {
    const track = await music.resolveUrl(url);
    if (!track || !track.id) throw new Error('Could not resolve a playable video.');
    music.addTrack(track);
    $('song-url-input').value = '';
    stat.textContent = `✓ Added: ${track.title}`; stat.className = 'url-status ok';
    toast(`♪ Added: ${track.title}`);
    music.play(music.queue.length - 1);
  } catch (err) {
    stat.textContent = `✗ ${err.message}`; stat.className = 'url-status err';
  } finally {
    btn.textContent = 'Add to Queue'; btn.disabled = false;
  }
}

/* ── API Key tab removed – key is built-in ── */
// (btn-save-apikey and btn-open-apikey no longer in DOM)


/* ════════════════════════════════════════════════
   10. SETTINGS – HISTORY
═══════════════════════════════════════════════════ */
async function renderHistory() {
  const list = $('history-list');
  if (!list) return;
  const history = await api.getHistory();
  const mine    = history.filter(h => h.players?.includes(State.userName));

  if (!mine.length) {
    list.innerHTML = '<div class="queue-empty">No games recorded yet. Play a game to see history here!</div>';
    if ($('win-rate-label')) $('win-rate-label').textContent = '—';
    return;
  }

  const wins = mine.filter(h => h.winner === State.userName).length;
  const rate  = Math.round((wins / mine.length) * 100);
  if ($('win-rate-label')) $('win-rate-label').textContent = `${rate}% Win Rate`;

  list.innerHTML = '';
  mine.slice(0, 30).forEach(h => {
    const icon = h.result === 'Victory' ? '🏆' : h.result === 'Defeat' ? '💔' : '🤝';
    const cls  = h.result === 'Victory' ? 'result-victory' : h.result === 'Defeat' ? 'result-defeat' : 'result-draw';
    list.insertAdjacentHTML('beforeend', `
      <div class="history-item">
        <div class="history-icon">${icon}</div>
        <div class="history-info">
          <div class="history-game-name">${h.players?.join(' vs ') || 'Game'}</div>
          <div class="history-date">📅 ${h.date || '—'}</div>
        </div>
        <div class="history-moves-wrap">
          <div class="history-moves-num">${h.moves || '—'}</div>
          <div class="history-moves-label">MOVES</div>
        </div>
        <div class="history-result-wrap">
          <div class="history-result ${cls}">${h.result}</div>
          <div class="history-result-sub">${h.winner ? h.winner + ' won' : 'Draw'}</div>
        </div>
      </div>`);
  });
}

/* ── Theme toggle ── */
$('theme-toggle')?.addEventListener('click', e => {
  const btn = e.target.closest('.theme-btn');
  if (!btn) return;
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const r = document.documentElement;
  if (btn.dataset.theme === 'rose') {
    r.style.setProperty('--sq-light','#f0dede');
    r.style.setProperty('--sq-dark', '#bf9898');
    r.style.setProperty('--bg-dark', '#1a0e0e');
  } else {
    r.style.setProperty('--sq-light','#f5eded');
    r.style.setProperty('--sq-dark', '#d4b8b8');
    r.style.setProperty('--bg-dark', '#1a1414');
  }
  if (currentPage === 'game') renderBoard();
  toast(`Theme: ${btn.dataset.theme === 'rose' ? 'Midnight Rose 🌹' : 'Classic Ivory ☕'}`);
});

/* ── Google Client ID save ── */
const _savedClientId = localStorage.getItem('ag_google_client_id') || '';
if ($('google-client-id-input') && _savedClientId) {
  $('google-client-id-input').value = _savedClientId;
  $('google-client-id-input').placeholder = '••• Client ID saved •••';
}
$('btn-save-google-id')?.addEventListener('click', () => {
  const id = $('google-client-id-input')?.value.trim();
  if (!id) { toast('Paste a Google Client ID first'); return; }
  localStorage.setItem('ag_google_client_id', id);
  $('google-client-id-input').value = '';
  $('google-client-id-input').placeholder = '••• Client ID saved •••';
  toast('✓ Google Client ID saved! Reload to enable Google Sign-In.');
});

/* ════════════════════════════════════════════════
   11. BOOTSTRAP
═══════════════════════════════════════════════════ */
initNamePrompt();

