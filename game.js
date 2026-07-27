// Mancala rules and the state transitions the database runs.
//
// Everything here is pure: give it a room state, get a new room state back.
// app.js feeds these to Firebase transactions, which is what keeps two players
// from writing over each other. Nothing in this file knows Firebase exists.

export const PITS = 6;
export const STORES = [6, 13];
export const STONES_PER_PIT = 4;

// Firebase deletes keys whose value is null, so "no turn" and "no winner" are
// sentinels rather than nulls.
export const NO_TURN = -1;

export const pitIndex = (player, pit) => player * 7 + pit;
export const ownsPit = (player, index) => player * 7 <= index && index <= player * 7 + 5;

export function newBoard() {
  const board = new Array(14).fill(STONES_PER_PIT);
  board[STORES[0]] = 0;
  board[STORES[1]] = 0;
  return board;
}

export function newGameState(startingPlayer = 0) {
  return {
    board: newBoard(),
    turn: startingPlayer,
    over: false,
    winner: 'none',                  // 'none' | '0' | '1' | 'tie'
    lastMove: { player: NO_TURN, pit: NO_TURN, extraTurn: false, captured: 0 },
  };
}

export function initialRoom() {
  return { ...newGameState(0), seats: {}, gamesPlayed: 0 };
}

// Firebase hands back arrays as arrays, objects with missing keys, and numbers
// as numbers — but a board that arrived mid-write, or a room somebody poked by
// hand, could be any shape. Force it back into something the rules can run on.
export function normalizeRoom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const board = new Array(14);
  for (let i = 0; i < 14; i++) {
    const v = raw.board ? raw.board[i] : undefined;
    board[i] = Number.isFinite(Number(v)) ? Number(v) : 0;
  }
  const seats = {};
  for (const key of ['0', '1']) {
    const seat = raw.seats && raw.seats[key];
    if (seat && typeof seat.id === 'string') {
      seats[key] = { id: seat.id, name: typeof seat.name === 'string' ? seat.name : '' };
    }
  }
  const last = raw.lastMove || {};
  return {
    board,
    turn: raw.turn === 0 || raw.turn === 1 ? raw.turn : NO_TURN,
    over: !!raw.over,
    winner: ['none', '0', '1', 'tie'].includes(raw.winner) ? raw.winner : 'none',
    lastMove: {
      player: last.player === 0 || last.player === 1 ? last.player : NO_TURN,
      pit: Number.isFinite(Number(last.pit)) ? Number(last.pit) : NO_TURN,
      extraTurn: !!last.extraTurn,
      captured: Number(last.captured) || 0,
    },
    seats,
    gamesPlayed: Number(raw.gamesPlayed) || 0,
  };
}

export function sideIsEmpty(board, player) {
  for (let i = 0; i < PITS; i++) {
    if (board[pitIndex(player, i)] > 0) return false;
  }
  return true;
}

export function seatOf(state, playerId) {
  if (!playerId || !state || !state.seats) return null;
  for (const key of ['0', '1']) {
    if (state.seats[key] && state.seats[key].id === playerId) return Number(key);
  }
  return null;
}

export const bothSeated = (state) => !!(state && state.seats && state.seats['0'] && state.seats['1']);

// Returns { error } or { game } — never mutates what it was given.
export function applyMove(game, player, pit) {
  if (game.over) return { error: 'The game is already over.' };
  if (player !== game.turn) return { error: "It's not your turn." };
  if (!Number.isInteger(pit) || pit < 0 || pit >= PITS) return { error: 'That pit does not exist.' };

  const board = game.board.slice();
  const start = pitIndex(player, pit);
  let stones = board[start];
  if (stones === 0) return { error: 'That pit is empty.' };

  board[start] = 0;
  let index = start;
  while (stones > 0) {
    index = (index + 1) % 14;
    if (index === STORES[1 - player]) continue;   // never sow into their store
    board[index]++;
    stones--;
  }

  // Landing in your own store earns another turn.
  const extraTurn = index === STORES[player];

  // Landing in one of your own empty pits captures it plus the pit across.
  let captured = 0;
  if (!extraTurn && ownsPit(player, index) && board[index] === 1) {
    const across = 12 - index;
    if (board[across] > 0) {
      captured = board[across] + 1;
      board[STORES[player]] += captured;
      board[index] = 0;
      board[across] = 0;
    }
  }

  let turn = extraTurn ? player : 1 - player;
  let over = false;
  let winner = 'none';

  // One side empty ends the game; the other player sweeps their own pits.
  const finished = [0, 1].find((p) => sideIsEmpty(board, p));
  if (finished !== undefined) {
    const other = 1 - finished;
    for (let i = 0; i < PITS; i++) {
      const idx = pitIndex(other, i);
      board[STORES[other]] += board[idx];
      board[idx] = 0;
    }
    over = true;
    turn = NO_TURN;
    const a = board[STORES[0]];
    const b = board[STORES[1]];
    winner = a === b ? 'tie' : a > b ? '0' : '1';
  }

  return {
    game: {
      board,
      turn,
      over,
      winner,
      lastMove: { player, pit, extraTurn, captured },
    },
  };
}

// The route a move takes, for the sowing animation: which pit is emptied, then
// every pit that receives a stone in order, then the capture if there is one.
// Same walk as applyMove, kept separate so the rules stay a single expression
// of the truth and the animation just retraces them.
export function sowPath(board, player, pit) {
  if (!Number.isInteger(pit) || pit < 0 || pit >= PITS) return null;
  const from = pitIndex(player, pit);
  let stones = board[from];
  if (stones === 0) return null;

  const drops = [];
  let index = from;
  while (stones > 0) {
    index = (index + 1) % 14;
    if (index === STORES[1 - player]) continue;
    drops.push(index);
    stones--;
  }

  // Recreate the landing pit's count to know whether it captures.
  const landedIn = index;
  const extraTurn = landedIn === STORES[player];
  let capture = null;
  if (!extraTurn && ownsPit(player, landedIn)) {
    const sownHere = drops.filter((i) => i === landedIn).length;
    if (board[landedIn] + sownHere === 1) {
      const across = 12 - landedIn;
      const acrossSown = drops.filter((i) => i === across).length;
      if (board[across] + acrossSown > 0) {
        capture = { landing: landedIn, across, store: STORES[player] };
      }
    }
  }
  return { from, drops, capture, extraTurn };
}

// ------------------------------------------------- transaction reducers
// Each returns a new room state, or undefined to abort the write. Firebase
// re-runs these against fresh data whenever two people write at once, so they
// have to re-check every precondition against the state they are handed.

export function reduceClaimSeat(state, { id, name, seat }) {
  const room = state ? normalizeRoom(state) : initialRoom();
  if (seat !== 0 && seat !== 1) return room;

  // Your password owns your seat, so take it back unconditionally — the only
  // thing that can be sitting in it is a stale session of your own.
  const seats = { ...room.seats };
  seats[String(seat)] = { id, name: name || `Player ${seat + 1}` };

  // And if a previous session of yours is in the other chair, get out of it.
  const other = String(1 - seat);
  if (seats[other] && seats[other].id === id) delete seats[other];

  return { ...room, seats };
}

// Clears both chairs and sits you back down in your own. For when a dead tab
// or a dropped phone is still holding a seat and the disconnect handler never
// fired — the other player's live client simply takes its seat back.
export function reduceKickSeats(state, { id, name, seat }) {
  if (!state) return undefined;
  const room = normalizeRoom(state);
  if (seat !== 0 && seat !== 1) return undefined;
  return { ...room, seats: { [String(seat)]: { id, name: name || `Player ${seat + 1}` } } };
}

export function reduceMove(state, { id, pit }) {
  if (!state) return undefined;
  const room = normalizeRoom(state);
  const seat = seatOf(room, id);
  if (seat === null) return undefined;              // spectators cannot move
  if (!bothSeated(room)) return undefined;          // nobody to play against
  const result = applyMove(room, seat, pit);
  if (result.error) return undefined;
  return { ...room, ...result.game };
}

export function reduceNewGame(state, { id }) {
  if (!state) return undefined;
  const room = normalizeRoom(state);
  if (seatOf(room, id) === null) return undefined;  // spectators cannot reset
  const gamesPlayed = room.gamesPlayed + 1;
  return { ...room, ...newGameState(gamesPlayed % 2), gamesPlayed };
}

const toHex = (buffer) => Array.from(new Uint8Array(buffer))
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');

// Two passwords, one game. Each password identifies a player *and* opens the
// same room — which is the awkward part, because the room name has to stay
// unguessable in a public repo. So the room's real name is a random secret
// that is never written down here. What is written down is that secret XORed
// with each password's key, plus a checksum. Type a valid password and the XOR
// hands the secret back; type anything else and the checksum fails. Which of
// the two blobs unlocked it is what tells the page who you are.
//
// To change the passwords, regenerate all three constants together — see
// regenerate-passwords.py.
const ROOM_BLOBS = [
  'a227155bf52c07d4cfd141e70100f1c770fcdddba8b98bf15ef8edbd333870ab',  // player 1
  '7d760135feddf279ddc9a83c1024d4791480d554dd55704c88f9b8e9e725542f',  // player 2
];
const ROOM_CHECKSUM = '4cbc0c9dfec9f10d589a4bbb5a52ddabb2ec13a83490e4645a45cdc5143be698';

const ROOM_ITERATIONS = 200000;
const ROOM_SALT = 'komancala-room';

const fromHex = (hex) =>
  new Uint8Array(hex.match(/../g).map((byte) => parseInt(byte, 16)));

async function roomKeyMaterial(password) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(ROOM_SALT),
      iterations: ROOM_ITERATIONS,
      hash: 'SHA-256',
    },
    key, 256,
  );
  return new Uint8Array(bits);
}

// Returns { player, roomKey, mediaKey } for a valid password, or null for
// anything else. Both players get the same roomKey and mediaKey; only `player`
// differs. mediaKey decrypts the win photos, which are committed as ciphertext
// so that a public repo doesn't mean public pictures of you.
export async function identify(password) {
  if (typeof password !== 'string' || password === '') return null;
  const derived = await roomKeyMaterial(password);      // one KDF pass, two tries

  for (let player = 0; player < ROOM_BLOBS.length; player++) {
    const blob = fromHex(ROOM_BLOBS[player]);
    const candidate = blob.map((byte, i) => byte ^ derived[i]);
    const checksum = toHex(await crypto.subtle.digest('SHA-256', candidate));
    if (checksum !== ROOM_CHECKSUM) continue;

    const secretHex = toHex(candidate);
    const room = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(`komancala:${secretHex}`),
    );

    // Separate derivation for the photo key, so nothing about the room name
    // leaks the key or the other way round.
    const label = new TextEncoder().encode('komancala-photos');
    const material = new Uint8Array(candidate.length + label.length);
    material.set(candidate, 0);
    material.set(label, candidate.length);
    const mediaKey = await crypto.subtle.importKey(
      'raw', await crypto.subtle.digest('SHA-256', material),
      'AES-CBC', false, ['decrypt'],
    );

    return { player, roomKey: toHex(room).slice(0, 32), mediaKey };
  }
  return null;
}


// Encrypted assets — the win photos and the cat's lines — are fetched, have
// their 16-byte IV peeled off, and are decrypted with the key the password
// derived. None of it is readable in the repo.
async function decryptBytes(url, mediaKey) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: bytes.slice(0, 16) }, mediaKey, bytes.slice(16),
  );
}

export async function decryptPhoto(url, mediaKey) {
  const plain = await decryptBytes(url, mediaKey);
  return URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
}

export async function decryptLines(url, mediaKey) {
  const plain = await decryptBytes(url, mediaKey);
  const lines = JSON.parse(new TextDecoder().decode(plain));
  if (!Array.isArray(lines)) throw new Error('lines file is not a list');
  return lines.filter((line) => typeof line === 'string' && line.length > 0);
}
