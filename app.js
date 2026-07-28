// Wires the mancala rules in game.js to a Firebase Realtime Database room and
// draws the board. Both players write to the same room; every write goes
// through a transaction so two simultaneous moves can't corrupt the board.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import {
  getDatabase, ref, onValue, runTransaction, onDisconnect, remove,
} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-database.js';

import { firebaseConfig } from './firebase-config.js';
import {
  normalizeRoom, seatOf, bothSeated, identify, decryptPhoto, decryptLines, sowPath, makeLineBag,
  reduceClaimSeat, reduceMove, reduceNewGame, reduceKickSeats, NO_TURN,
} from './game.js';

const KEY_PW = 'komancala.password';
const KEY_ID = 'komancala.playerId';
const KEY_NAME = 'komancala.name';

const $ = (id) => document.getElementById(id);
const setupEl = $('setup');
const loginEl = $('login');
const gameEl = $('game');
const bannerEl = $('banner');
const statusEl = $('status');
const boardEl = $('board');
const catsEl = $('cats');
const winPhotoEl = $('winphoto');
const loginError = $('login-error');
const gameError = $('game-error');

// ------------------------------------------------------------------ identity

let playerId = localStorage.getItem(KEY_ID);
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem(KEY_ID, playerId);
}
let playerName = localStorage.getItem(KEY_NAME) || '';

// -------------------------------------------------------------------- state

let db = null;
let roomRef = null;
let seatRef = null;
let disconnectHandle = null;
let unsubscribeRoom = null;
let unsubscribeConn = null;
let room = null;
let seat = null;
let view = null;          // which side is drawn along the bottom
let renderedMove = null;  // the position we last drew, to spot a fresh move
let shownBoard = null;    // the board currently on screen, which the sowing
                          // animation starts from
let sowToken = 0;         // bumped to abandon an animation that got overtaken
let assignedSeat = null;  // which chair this password owns
let mediaKey = null;      // unlocks the win photos, derived from the password

// ------------------------------------------------------------------ startup

const missingConfig = Object.entries(firebaseConfig)
  .filter(([, value]) => typeof value !== 'string' || value.includes('PASTE_YOUR'))
  .map(([key]) => key);

if (missingConfig.length) {
  setupEl.classList.remove('hidden');
  // The database URL is the one people miss, because Firebase leaves it out of
  // the config it shows you until a Realtime Database actually exists.
  if (missingConfig.length === 1 && missingConfig[0] === 'databaseURL') {
    setupEl.querySelector('strong').textContent = 'Almost there — no database yet.';
    setupEl.querySelector('p').innerHTML =
      'In the Firebase console go to <code>Build → Realtime Database → Create Database</code>, ' +
      'then copy the URL it shows into <code>firebase-config.js</code> as ' +
      '<code>databaseURL</code> and reload this page.';
  }
} else {
  try {
    db = getDatabase(initializeApp(firebaseConfig));
    loginEl.classList.remove('hidden');
    const saved = localStorage.getItem(KEY_PW);
    $('name').value = playerName;
    if (saved) {
      $('pw').value = saved;
      join();
    }
  } catch (err) {
    setupEl.classList.remove('hidden');
    setupEl.querySelector('p').textContent =
      'Firebase would not start up: ' + err.message + ' — check firebase-config.js.';
  }
}

// ---------------------------------------------------------------- rendering

// Stones ring the pit's number rather than piling on it, and the layout has to
// stay put between updates, so positions come from the stone's index instead of
// being randomised.
function scatter(i) {
  const angle = i * 2.39996;                 // golden angle, spreads them evenly
  const radius = 0.58 + 0.10 * (i % 3);      // three loose rings, clear of the number
  return {
    left: (50 + Math.cos(angle) * radius * 50 - 11) + '%',
    top: (50 + Math.sin(angle) * radius * 50 - 11) + '%',
  };
}

function buildPit(index) {
  const el = document.createElement('button');
  el.className = 'pit';
  el.dataset.index = index;
  el.innerHTML = '<div class="stones"></div><div class="count">0</div>';
  el.addEventListener('click', () => onPitClick(Number(el.dataset.index)));
  return el;
}

function layout(bottomPlayer) {
  const top = $('row-top');
  const bottom = $('row-bottom');
  top.replaceChildren();
  bottom.replaceChildren();
  const them = 1 - bottomPlayer;
  // Your six pits run left to right along the bottom, in sowing order.
  for (let i = 0; i < 6; i++) bottom.appendChild(buildPit(bottomPlayer * 7 + i));
  // Theirs are mirrored above, so the whole loop reads as one circuit.
  for (let i = 5; i >= 0; i--) top.appendChild(buildPit(them * 7 + i));
  $('store-left').dataset.index = them * 7 + 6;
  $('store-right').dataset.index = bottomPlayer * 7 + 6;
}

function paintPit(el, stones, opts) {
  el.querySelector('.count').textContent = stones;
  const bowl = el.querySelector('.stones');
  bowl.replaceChildren();
  for (let i = 0; i < Math.min(stones, 12); i++) {
    const s = document.createElement('div');
    s.className = opts.hop ? 'stone hop' : 'stone';
    Object.assign(s.style, scatter(i));
    // A small stagger so the beads in the hole being filled bounce in turn.
    if (opts.hop) s.style.animationDelay = `${i * 16}ms`;
    bowl.appendChild(s);
  }
  el.classList.toggle('playable', !!opts.playable);
  el.classList.toggle('last-move', !!opts.lastMove);
  el.disabled = !opts.playable;
}

// Draw an arbitrary board without touching the status line — used for the
// in-between frames while the stones are being sown.
function paintBoard(board, landingIndex) {
  for (const el of document.querySelectorAll('.pit')) {
    const index = Number(el.dataset.index);
    paintPit(el, board[index], {
      playable: false,
      lastMove: index === landingIndex,
      hop: index === landingIndex,     // the hole that just took a bead
    });
  }
  const left = $('store-left');
  const right = $('store-right');
  left.querySelector('.count').textContent = board[Number(left.dataset.index)];
  right.querySelector('.count').textContent = board[Number(right.dataset.index)];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Identifies a position, so a repeat render doesn't look like a fresh move.
const moveKeyOf = (state) =>
  `${state.gamesPlayed}:${state.lastMove.player}:${state.lastMove.pit}:${state.board.join(',')}`;

// Walk the stones round the board one hole at a time, dropping one in each,
// the way you would with a handful of beads. Returns once the final position
// has been drawn, or early if another update overtook this one.
async function animateSow(fromBoard, move) {
  // Claim the token first: a caller checks it to see whether a newer update
  // overtook this animation, and that has to hold even when there is nothing
  // to animate.
  const token = ++sowToken;
  const path = sowPath(fromBoard, move.player, move.pit);
  if (!path) return token;
  const working = fromBoard.slice();
  const total = path.drops.length + (path.capture ? 2 : 0);
  // Long sows shouldn't drag: keep the whole thing to roughly a second.
  const step = Math.max(38, Math.min(95, Math.round(900 / Math.max(total, 1))));

  working[path.from] = 0;                       // scoop the pile up
  paintBoard(working, path.from);
  await sleep(step);
  if (token !== sowToken) return token;

  for (const index of path.drops) {
    working[index]++;
    paintBoard(working, index);
    await sleep(step);
    if (token !== sowToken) return token;
  }

  if (path.capture) {
    const { landing, across, store } = path.capture;
    working[store] += working[landing] + working[across];
    working[landing] = 0;
    working[across] = 0;
    paintBoard(working, store);
    await sleep(step * 2);
    if (token !== sowToken) return token;
  }
  return token;
}

function render() {
  if (!room) return;
  const bottom = seat === null ? 0 : seat;
  if (view !== bottom) {
    layout(bottom);
    view = bottom;
  }

  const board = room.board;
  const myTurn = seat !== null && room.turn === seat && !room.over;
  const seated = bothSeated(room);
  const last = room.lastMove;
  const lastIndex = last.player === NO_TURN ? -1 : last.player * 7 + last.pit;

  // A move landed if the move counter moved on. Compare against what we drew
  // last, so re-renders from seat changes or reconnects don't re-trigger it.
  const moveKey = moveKeyOf(room);
  const sawNewMove = lastIndex >= 0 && renderedMove !== null && renderedMove !== moveKey;
  renderedMove = moveKey;

  for (const el of document.querySelectorAll('.pit')) {
    const index = Number(el.dataset.index);
    const mine = seat !== null && index >= seat * 7 && index <= seat * 7 + 5;
    paintPit(el, board[index], {
      playable: myTurn && seated && mine && board[index] > 0,
      lastMove: index === lastIndex,
    });
  }
  shownBoard = board.slice();

  if (sawNewMove) moveLanded();
  if (room.over) showCats(4);

  if (room.over && room.winner !== 'tie') showWinPhoto(WIN_SCREENS[Number(room.winner)]);
  else hideWinPhoto();

  const left = $('store-left');
  const right = $('store-right');
  left.querySelector('.count').textContent = board[Number(left.dataset.index)];
  right.querySelector('.count').textContent = board[Number(right.dataset.index)];
  const themSeat = room.seats[String(1 - bottom)];
  left.querySelector('.label').textContent = seat === null
    ? `player ${2 - bottom}`
    : (themSeat ? themSeat.name : 'them');
  right.querySelector('.label').textContent = seat === null ? `player ${bottom + 1}` : 'you';

  statusEl.className = 'status' + (myTurn ? ' your-turn' : '');
  statusEl.innerHTML = statusText({ myTurn, seated });
  $('newgame').disabled = seat === null;
}

function statusText({ myTurn, seated }) {
  const them = room.seats[String(seat === null ? 1 : 1 - seat)];
  const last = room.lastMove;

  if (room.over) {
    const scores = seat === null
      ? `${room.board[6]} — ${room.board[13]}`
      : `you ${room.board[seat * 7 + 6]} — them ${room.board[(1 - seat) * 7 + 6]}`;

    if (room.winner === 'tie') {
      return `<strong>NOBODY WINS</strong>`
        + `<span class="sub">everybody vibes</span>`
        + `<span class="sub">${escape(scores)} · hit NEW GAME</span>`;
    }

    const screen = WIN_SCREENS[Number(room.winner)];
    const verdict = seat === null
      ? ''
      : (Number(room.winner) === seat ? 'YOU WIN' : 'YOU LOSE');
    return `<strong>${escape(screen.headline)}</strong>`
      + `<span class="sub">${escape(screen.line)}</span>`
      + `<span class="sub">${verdict ? escape(verdict) + ' · ' : ''}${escape(scores)} · hit NEW GAME</span>`;
  }
  if (seat === null) {
    return `<strong>Watching</strong><span class="sub">Both seats are taken. You'll get one if somebody leaves.</span>`;
  }
  if (!seated) {
    return `<strong>Waiting for your friend</strong><span class="sub">Send them this link and the password.</span>`;
  }
  if (myTurn) {
    const bonus = last.player === seat && last.extraTurn
      ? ' Free turn — you landed in your store.'
      : '';
    return `<strong>Your turn</strong><span class="sub">Pick a pit on your side.${bonus}</span>`;
  }
  const captured = last.player === seat && last.captured
    ? ` You captured ${last.captured}.`
    : '';
  const whose = them && them.name ? `${escape(them.name)}'s turn` : 'Their turn';
  return `<strong>${whose}</strong><span class="sub">Hang tight.${captured}</span>`;
}

// Names come from the other player, so they go through the DOM as text.
function escape(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// Hotlinked from Giphy, which is what Giphy is for. A mix of real cats and
// cartoon ones; each was checked at the size it actually renders. If one ever
// 404s, the error handler swaps in the next rather than leaving a broken
// image on the page.
const CAT_GIFS = [
  'https://media.giphy.com/media/TjSPQgowhhJdHgvnwA/giphy.gif',
  'https://media.giphy.com/media/GR0CVcTdcfQjeJ4jYW/giphy.gif',
  'https://media.giphy.com/media/8KXshjTuyHTHT4vY23/giphy.gif',
  'https://media.giphy.com/media/CLJObmqmzxa1N6GAxB/giphy.gif',
  'https://media.giphy.com/media/omHLPPV87OJCEn0lGu/giphy.gif',
  'https://media.giphy.com/media/bUGnyabq6EHtD8TTyV/giphy.gif',
  'https://media.giphy.com/media/ZlHG4gSXeFpur3Rzvu/giphy.gif',
  'https://media.giphy.com/media/8pYMOn1sEb43EloTf8/giphy.gif',
  'https://media.giphy.com/media/3UkqVq3F50bVCi9URl/giphy.gif',
  'https://media.giphy.com/media/OwFsPO2tCcrSYxDErS/giphy.gif',
  'https://media.giphy.com/media/IAbrtESCyrqLOMlWdx/giphy.gif',
  'https://media.giphy.com/media/VSLIjK1WyV3GbT5m9G/giphy.gif',
  'https://media.giphy.com/media/scpcMQTvUkA7STaA27/giphy.gif',
  'https://media.giphy.com/media/j93ycvEyWlSIIg8AEl/giphy.gif',
  'https://media.giphy.com/media/tphCApwvdtC1VJabZ1/giphy.gif',
  'https://media.giphy.com/media/cW64pEEZe0YZa/giphy.gif',
  'https://media.giphy.com/media/OTcLMgMdx1ACCuy11E/giphy.gif',
  'https://media.giphy.com/media/9n0CvokbUMaWhFuCkp/giphy.gif',
  'https://media.giphy.com/media/VXS7y6lz5ZEI0W7ZOB/giphy.gif',
  'https://media.giphy.com/media/4mAvdIOErglBOag7Qo/giphy.gif',
  'https://media.giphy.com/media/T7jYi3VXmhsOY/giphy.gif',
  'https://media.giphy.com/media/Tvd56JByYXKMyipX2h/giphy.gif',
  'https://media.giphy.com/media/lQyBm0PDRIGHgXyFtx/giphy.gif',
  'https://media.giphy.com/media/2raTcMjNC82sRvDk4f/giphy.gif',
  'https://media.giphy.com/media/3ohs7HqwyUscSwZz4A/giphy.gif',
  'https://media.giphy.com/media/UVUslMrgTNHaVu2tOI/giphy.gif',
  'https://media.giphy.com/media/8CoGnT9WNfTUlEWB3j/giphy.gif',
  'https://media.giphy.com/media/FhJHUMWU5BslKdvtSC/giphy.gif',
  'https://media.giphy.com/media/qqBRgmarYUfYs/giphy.gif',
  'https://media.giphy.com/media/Sos2kKKBJF7XO/giphy.gif',
  'https://media.giphy.com/media/uCl6VMYjzmRl8raz98/giphy.gif',
  'https://media.giphy.com/media/A4X3oXPlGJAzu/giphy.gif',
  'https://media.giphy.com/media/E7FMGUqi8ih5CPBSXm/giphy.gif',
  'https://media.giphy.com/media/P5K1aynBiJWg14coAY/giphy.gif',
  'https://media.giphy.com/media/lsM0MSTfguTkeeeLB8/giphy.gif',
  'https://media.giphy.com/media/KiTqoWPWblxeN3a2Hf/giphy.gif',
  'https://media.giphy.com/media/6r5EbCaGFFcC0gWEjE/giphy.gif',
];

let catCursor = Math.floor(Math.random() * CAT_GIFS.length);

// Things the cat says. They live encrypted in catlines.enc and are decrypted
// with the same key as the photos once you are in, so the repo is public but
// the material isn't. Edit cat-lines.txt and run encrypt-lines.py to change
// them. Empty until that fetch lands.
let catLines = [];
let nextLine = makeLineBag([]);

async function loadCatLines(mediaKey) {
  try {
    catLines = await decryptLines('catlines.enc', mediaKey);
  } catch {
    catLines = [];        // the cat just sticks to the weekday line
  }
  nextLine = makeLineBag(catLines.length ? [...catLines, WEEKDAY_TOKEN] : []);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// The weekday line is generated rather than stored, so it goes into the deck as
// a token and is rendered when it comes up. That way it is dealt exactly once
// per cycle, the same as every written line, and it is still what the cat falls
// back on if the encrypted lines never arrive.
const WEEKDAY_TOKEN = '\u0000weekday';
const weekdayLine = () => `it's mancala ${WEEKDAYS[new Date().getDay()]}`;

function catLine() {
  if (!catLines.length) return weekdayLine();
  const drawn = nextLine(lastLine);
  return drawn === WEEKDAY_TOKEN ? weekdayLine() : drawn;
}

let lastLine = '';
let bubbleTimer = null;

function speak() {
  if (!bouncers.length) return;
  const cat = bouncers[Math.floor(Math.random() * bouncers.length)];
  // The deck guarantees no repeats, including across a reshuffle.
  const line = catLine();
  lastLine = line;

  for (const other of bouncers) other.bubble.classList.add('hidden');
  cat.bubble.textContent = line;
  cat.bubble.classList.remove('hidden');

  // Long enough to read at a glance, and longer still for the long ones —
  // the wall-of-text lines need a while before they mean anything.
  const showFor = Math.min(22000, 6500 + line.length * 60);
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => cat.bubble.classList.add('hidden'), showFor);
}

let movesSinceLine = 0;

// Everything that happens when a move lands, wherever we noticed it.
function moveLanded() {
  nextCat();
  if (movesSinceLine++ % 3 === 0) speak();
}

// Cats drift across the screen and bounce off the edges, like the DVD logo,
// swapping to the next gif every few seconds and whenever somebody moves.
const bouncers = [];
let catLoopRunning = false;

function catSize() {
  return window.innerWidth < 560 ? 88 : 120;
}

function spawnCat() {
  const wrapper = document.createElement('div');
  wrapper.className = 'cat';

  const img = document.createElement('img');
  img.alt = 'a cat, vibing';
  img.src = CAT_GIFS[catCursor++ % CAT_GIFS.length];
  img.addEventListener('error', () => { img.src = CAT_GIFS[catCursor++ % CAT_GIFS.length]; });

  const bubble = document.createElement('div');
  bubble.className = 'bubble hidden';

  wrapper.append(bubble, img);
  catsEl.appendChild(wrapper);

  const size = catSize();
  const speed = 90 + Math.random() * 60;               // pixels per second
  const angle = (Math.random() * 0.6 + 0.2) * Math.PI; // never dead flat
  const cat = {
    el: wrapper,
    img,
    bubble,
    x: Math.random() * Math.max(1, window.innerWidth - size),
    y: Math.random() * Math.max(1, window.innerHeight - size),
    vx: Math.cos(angle) * speed * (Math.random() < 0.5 ? -1 : 1),
    vy: Math.sin(angle) * speed * (Math.random() < 0.5 ? -1 : 1),
  };
  bouncers.push(cat);
  if (!catLoopRunning) { catLoopRunning = true; requestAnimationFrame(stepCats); }
  return cat;
}

let lastFrame = 0;
function stepCats(now) {
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0;
  lastFrame = now;
  const size = catSize();
  const maxX = Math.max(0, window.innerWidth - size);
  const maxY = Math.max(0, window.innerHeight - size);

  for (const cat of bouncers) {
    cat.x += cat.vx * dt;
    cat.y += cat.vy * dt;
    if (cat.x <= 0) { cat.x = 0; cat.vx = Math.abs(cat.vx); }
    if (cat.x >= maxX) { cat.x = maxX; cat.vx = -Math.abs(cat.vx); }
    if (cat.y <= 0) { cat.y = 0; cat.vy = Math.abs(cat.vy); }
    if (cat.y >= maxY) { cat.y = maxY; cat.vy = -Math.abs(cat.vy); }
    cat.el.style.transform = `translate(${Math.round(cat.x)}px, ${Math.round(cat.y)}px)`;
    // Near the top of the window the bubble would sail off-screen, so it
    // flips underneath and the tail flips with it.
    cat.el.classList.toggle('speak-below', cat.y < 70);
  }
  requestAnimationFrame(stepCats);
}

// Everyone changes cat together, on a move or on the timer.
function nextCat() {
  for (const cat of bouncers) {
    cat.img.src = CAT_GIFS[catCursor++ % CAT_GIFS.length];
  }
}

function showCats(count) {
  while (bouncers.length < count) spawnCat();
}

function clearCats() {
  for (const cat of bouncers) cat.el.remove();
  bouncers.length = 0;
}

setInterval(() => { if (bouncers.length) nextCat(); }, 6000);
setInterval(speak, 17000);

// A win screen per player, chosen by which password was typed rather than by
// anyone's name. Index 0 is player 1, index 1 is player 2.
// Coordinates are percentages of the photo, so the overlay keeps lining up at
// any size. Eyes belong to whoever the Ames room made enormous; the head box
// is that of whoever it shrank — the bolts all converge on it.
const WIN_SCREENS = [
  {
    headline: 'KATE WINS',
    line: 'total short hills victor',
    photo: 'katewin.enc',
    eyes: [[78.9, 33.0], [80.6, 32.8]],
    head: { x: 27.0, y: 65.2, w: 5.0, h: 5.8 },     // his head, sitting, bottom left
  },
  {
    headline: 'SNE WINS',
    line: 'total hicksvilel victory',
    photo: 'snewin.enc',
    eyes: [[76.0, 30.8], [78.4, 30.7]],
    head: { x: 24.8, y: 49.6, w: 5.0, h: 6.2 },     // her head, standing, left
  },
];

// A jagged path from an eye to the target. Deterministic per seed, and pinned
// at both ends so every flicker frame starts and lands in the same place.
function boltPoints(from, to, seed) {
  const segments = 8;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const perpX = -dy / length;
  const perpY = dx / length;
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const wobble = Math.sin((i + seed * 2.7) * 2.1) * 3.4 * Math.sin(Math.PI * t);
    points.push(
      `${(from[0] + dx * t + perpX * wobble).toFixed(2)},` +
      `${(from[1] + dy * t + perpY * wobble).toFixed(2)}`,
    );
  }
  return points.join(' ');
}

// Three frames of bolts, cycled by CSS, which is cheaper and smoother than
// redrawing on a timer.
function buildZap(screen) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'zap');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');

  const { x, y, w, h } = screen.head;
  const centre = [x + w / 2, y + h / 2];

  // Every bolt lands on the head, wandering only enough to look alive.
  const strikes = [0.35, 0.5, 0.65, 0.45, 0.55].map((down, i) => [
    x + w * (0.35 + 0.3 * ((i % 3) / 2)),
    y + h * down,
  ]);

  // A glow around the head so it reads as cooking.
  const halo = document.createElementNS(ns, 'ellipse');
  halo.setAttribute('class', 'fry');
  halo.setAttribute('cx', centre[0]);
  halo.setAttribute('cy', centre[1]);
  halo.setAttribute('rx', w * 0.85);
  halo.setAttribute('ry', h * 0.7);
  svg.appendChild(halo);

  for (let frame = 0; frame < 3; frame++) {
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('class', `zap-frame zap-frame-${frame}`);

    for (const [eyeIndex, eye] of screen.eyes.entries()) {
      // Each eye rakes down the body, hitting a different point per frame.
      const strike = strikes[(frame * 2 + eyeIndex) % strikes.length];
      const points = boltPoints(eye, strike, frame * 3 + eyeIndex);
      for (const cls of ['glow', 'core']) {
        const line = document.createElementNS(ns, 'polyline');
        line.setAttribute('points', points);
        line.setAttribute('class', cls);
        group.appendChild(line);
      }
    }

    // Arcs crawling over the head, plus sparks spitting off it.
    for (let i = 0; i < 5; i++) {
      const a = [x + w * ((i * 0.27 + frame * 0.2) % 1), y + h * ((i * 0.19 + frame * 0.3) % 1)];
      const b = [x + w * ((i * 0.41 + frame * 0.5) % 1), y + h * ((i * 0.53 + frame * 0.1) % 1)];
      const arc = document.createElementNS(ns, 'polyline');
      arc.setAttribute('points', boltPoints(a, b, i + frame * 2));
      arc.setAttribute('class', 'crawl');
      group.appendChild(arc);
    }
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + frame * 0.6;
      const edge = [
        centre[0] + Math.cos(angle) * w * 0.45,
        centre[1] + Math.sin(angle) * h * 0.4,
      ];
      const tip = [
        centre[0] + Math.cos(angle) * w * 1.15,
        centre[1] + Math.sin(angle) * h * 0.95,
      ];
      const spark = document.createElementNS(ns, 'polyline');
      spark.setAttribute('points', boltPoints(edge, tip, i + frame));
      spark.setAttribute('class', 'spark');
      group.appendChild(spark);
    }
    svg.appendChild(group);
  }
  return svg;
}

// Decrypted photos are kept as blob URLs for the session — decrypting is fast,
// but there's no reason to do it again every time somebody wins.
const decrypted = new Map();

async function showWinPhoto(screen) {
  if (winPhotoEl.dataset.photo !== screen.photo) {
    winPhotoEl.dataset.photo = screen.photo;
    try {
      if (!decrypted.has(screen.photo)) {
        decrypted.set(screen.photo, await decryptPhoto(screen.photo, mediaKey));
      }
      const img = document.createElement('img');
      img.src = decrypted.get(screen.photo);
      img.alt = screen.headline;
      winPhotoEl.replaceChildren(img, buildZap(screen));
    } catch (err) {
      // A missing or unreadable photo shouldn't swallow the win screen.
      winPhotoEl.dataset.photo = '';
      winPhotoEl.classList.add('hidden');
      return;
    }
  }
  winPhotoEl.classList.remove('hidden');
}

function hideWinPhoto() {
  winPhotoEl.classList.add('hidden');
  winPhotoEl.dataset.photo = '';
}

// ------------------------------------------------------------------ actions

async function onPitClick(index) {
  if (seat === null || !room) return;
  gameError.textContent = '';
  const pit = index - seat * 7;
  try {
    const result = await runTransaction(roomRef, (state) => reduceMove(state, { id: playerId, pit }));
    if (!result.committed) gameError.textContent = 'That move is no longer legal.';
  } catch (err) {
    gameError.textContent = 'Could not reach the game: ' + err.message;
  }
}

async function claimSeat(force = false) {
  const result = await runTransaction(roomRef, (state) =>
    reduceClaimSeat(state, { id: playerId, name: playerName, seat: assignedSeat, force }));

  const committed = normalizeRoom(result.snapshot.val());
  const mine = seatOf(committed, playerId);

  // Hand the seat back to the server if this tab goes away, so a closed laptop
  // doesn't hold a chair forever.
  if (disconnectHandle) { disconnectHandle.cancel().catch(() => {}); disconnectHandle = null; }
  if (mine !== null) {
    seatRef = ref(db, `games/${roomRef.key}/seats/${mine}`);
    disconnectHandle = onDisconnect(seatRef);
    disconnectHandle.remove().catch(() => {});
  } else {
    seatRef = null;
  }
  return mine;
}

async function join() {
  const password = $('pw').value;
  playerName = $('name').value.trim().slice(0, 20);
  loginError.textContent = '';
  if (!password) { loginError.textContent = 'Type the password first.'; return; }

  $('join').disabled = true;
  try {
    // The password says both who you are and which room to open. Checked
    // before touching the database, so a typo can't create a stray room.
    const who = await identify(password);
    if (!who) {
      loginError.textContent = "That's not the password.";
      localStorage.removeItem(KEY_PW);
      return;
    }
    assignedSeat = who.player;
    mediaKey = who.mediaKey;
    loadCatLines(mediaKey);
    roomRef = ref(db, `games/${who.roomKey}`);
    await claimSeat();

    localStorage.setItem(KEY_PW, password);
    localStorage.setItem(KEY_NAME, playerName);
    loginEl.classList.add('hidden');
    // Say something while the first snapshot is in flight, or the board shows
    // up under a blank status line for as long as the round trip takes.
    statusEl.innerHTML = '<strong>Connecting…</strong><span class="sub">Fetching the board.</span>';
    gameEl.classList.remove('hidden');
    showCats(1);

    watchRoom();
    watchConnection();
  } catch (err) {
    loginError.textContent = describe(err);
  } finally {
    $('join').disabled = false;
  }
}

function watchRoom() {
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = onValue(roomRef, async (snap) => {
    const next = normalizeRoom(snap.val());
    if (!next) return;

    // Sow the stones across the board before showing the result, starting from
    // whatever is on screen right now — which is the position before the move.
    const move = next.lastMove;
    const from = shownBoard;
    const worthAnimating = from
      && move.player !== NO_TURN
      && renderedMove !== null
      && renderedMove !== moveKeyOf(next);

    room = next;
    seat = seatOf(room, playerId);
    gameError.textContent = '';

    // Your password owns your chair, so if it is standing empty — you were
    // kicked, or dropped — sit back down. But if another session is sitting in
    // it, say so and wait: grabbing it automatically is how two clients on one
    // password end up evicting each other forever.
    const myChair = assignedSeat === null ? null : room.seats[String(assignedSeat)];
    if (seat === null && assignedSeat !== null && !myChair) {
      showDisplaced(false);
      claimSeat().catch(() => {});
      return;
    }
    showDisplaced(seat === null && assignedSeat !== null && !!myChair);

    if (worthAnimating) {
      renderedMove = moveKeyOf(next);
      moveLanded();
      const token = await animateSow(from, move);
      if (token !== sowToken) return;      // a newer update took over
    }
    render();
  }, (err) => {
    gameError.textContent = describe(err);
  });
}

// Firebase drops our seat when the connection dies. When it comes back, take
// the seat again rather than leaving the player stranded as a spectator.
function watchConnection() {
  if (unsubscribeConn) unsubscribeConn();
  let sawFirst = false;
  unsubscribeConn = onValue(ref(db, '.info/connected'), async (snap) => {
    const online = snap.val() === true;
    boardEl.classList.toggle('stale', !online);
    bannerEl.classList.toggle('hidden', online);
    if (!online) {
      bannerEl.textContent = 'Offline — reconnecting…';
      return;
    }
    if (sawFirst) {
      try { await claimSeat(); } catch { /* the room watcher will show it */ }
    }
    sawFirst = true;
  });
}

// Shown when another session holds your chair — your own phone, usually.
function showDisplaced(displaced) {
  $('takeseat').classList.toggle('hidden', !displaced);
  if (displaced) {
    bannerEl.textContent = 'Your password is open somewhere else — that session has the seat.';
    bannerEl.classList.remove('hidden');
  } else if (bannerEl.textContent.startsWith('Your password is open')) {
    bannerEl.classList.add('hidden');
  }
}

function describe(err) {
  const message = String(err && err.message ? err.message : err);
  if (message.toLowerCase().includes('permission_denied')) {
    return 'The database rejected that — check the rules in database.rules.json are published.';
  }
  return message;
}

$('join').addEventListener('click', join);
for (const id of ['pw', 'name']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
}

$('newgame').addEventListener('click', async () => {
  gameError.textContent = '';
  try {
    const result = await runTransaction(roomRef, (state) => reduceNewGame(state, { id: playerId }));
    if (!result.committed) gameError.textContent = 'Only the two players can start a new game.';
  } catch (err) {
    gameError.textContent = describe(err);
  }
});

$('takeseat').addEventListener('click', async () => {
  gameError.textContent = '';
  try {
    await claimSeat(true);          // deliberate handoff, so force it
  } catch (err) {
    gameError.textContent = describe(err);
  }
});

$('kick').addEventListener('click', async () => {
  gameError.textContent = '';
  try {
    const result = await runTransaction(roomRef, (state) =>
      reduceKickSeats(state, { id: playerId, name: playerName, seat: assignedSeat }));
    if (!result.committed) gameError.textContent = 'Could not clear the seats.';
    else gameError.textContent = 'Seats cleared. A live player will sit straight back down.';
  } catch (err) {
    gameError.textContent = describe(err);
  }
});

$('leave').addEventListener('click', async () => {
  // Stop listening before letting go of the seat. The connection watcher
  // re-claims a seat whenever Firebase reconnects, and if it were still
  // attached it could grab the chair back on the way out.
  if (unsubscribeConn) { unsubscribeConn(); unsubscribeConn = null; }
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  try {
    if (disconnectHandle) { await disconnectHandle.cancel().catch(() => {}); disconnectHandle = null; }
    if (seatRef) await remove(seatRef);
  } catch { /* leaving is best effort */ }
  localStorage.removeItem(KEY_PW);
  room = null; seat = null; view = null; seatRef = null; assignedSeat = null;
  shownBoard = null; renderedMove = null;
  clearCats();
  gameEl.classList.add('hidden');
  bannerEl.classList.add('hidden');
  loginEl.classList.remove('hidden');
  $('pw').value = '';
});
