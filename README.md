# komancala

Two-player mancala on a static page, with the board living in a Firebase
Realtime Database so neither player has to run anything. It looks like a
website from 2004. A cat bounces around the window like a DVD logo, changes
gif every few seconds, and says something unhelpful while you play.

There are two passwords, one per player. They open the same game — the
password is both your key and your name badge, which is how the page knows
which of you is looking at it without ever asking who you are.

## Setting it up

Two halves: a database to hold the board, and a place to serve the page.

### 1. The database (about five minutes, free, no credit card)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and
   create a project. Any name. Turn off Google Analytics — this doesn't use it.
2. In the sidebar pick **Build → Realtime Database → Create Database**. Choose
   whichever location is closest to you, and start in **locked mode**. You'll
   replace the rules in step 5, so it doesn't matter that it's locked now.
3. Click the gear icon → **Project settings → General**, scroll to *Your apps*,
   and click the web icon (`</>`). Register the app with any nickname. Skip the
   "add Firebase Hosting" checkbox — GitHub Pages is doing that job.
4. Firebase shows you a `firebaseConfig = { … }` block. Copy those values into
   [firebase-config.js](firebase-config.js), replacing the `PASTE_YOUR_…`
   placeholders. Make sure `databaseURL` is in there — if the console doesn't
   show it, copy the URL from the top of the Realtime Database page.
5. Back in **Realtime Database → Rules**, replace what's there with the
   contents of [database.rules.json](database.rules.json) and hit **Publish**.
   Skipping this leaves your database wide open, so don't.

### 2. The page

Push this folder to a GitHub repo, then **Settings → Pages → Source: Deploy
from a branch**, pick `main` and `/ (root)`, and save. A minute later it's live
at `https://yourname.github.io/komancala/`.

Pages is only free on public repos, which means your `firebase-config.js` is
public too. That's expected — see the note below.

### 3. Play

Send your friend the link and the password. Two browsers anywhere in the world,
no laptop of yours involved. Moves show up on the other screen right away, and
since the board lives in the database you can also just make a move and let
them reply hours later.

### The two passwords

There are two, one per player. They are not written down anywhere in this
repo — ask whoever set it up. Each one drops you into the same game, in your
own seat, and decides which win screen you get. Anything else is refused
outright rather than quietly opening an empty room of its own, which would
have looked exactly like a friend who never showed up.

Whoever wins gets their own photo on the win screen, with lightning fired out
of the giant one's eyes at the small one's head. The coordinates live in
`WIN_SCREENS` in [app.js](app.js) as percentages of the photo, so if you swap
the pictures, move the `eyes` and `head` numbers to match.

Moves are sown rather than snapped: the pile is lifted out of the hole you
picked and dropped one bead at a time round the board, and the board is locked
until the last one lands.

To change the passwords, run:

```bash
python3 setup-secrets.py "player one password" "player two password" katewin.jpg snewin.jpg
```

It prints two constants to paste into [game.js](game.js) and re-encrypts the
photos. Changing them abandons any game in progress, because the room name is
derived from them.

It works on phones. A phone held upright stands the board on its end — stores
top and bottom, the two rows of pits as two columns — because six pits across a
narrow screen leaves them too small to tap. Turn the phone sideways and you get
the usual wide board.

## Is it safe to publish the Firebase config?

Yes, and Firebase intends it to be. Those values identify your project, they
don't authorise anything — every Firebase web app ships them in plain sight.
What actually protects the game is:

- **The rules file.** It only allows reads and writes under
  `/games/<32 hex characters>`, and it constrains what a room may contain, so
  nobody can dump junk in your database or use it as free storage.
Everything personal in this repo — both win photos and every line the cat
says — is committed as ciphertext for that reason.

- **The room key.** The page never sends either password anywhere, and the
  room's name is not in the source either. What is in the source is that name
  XORed with each password's PBKDF2 key, plus a checksum: type a real password
  and the XOR hands the name back, type anything else and the checksum fails.
  So reading this repo tells you nothing without cracking a password first,
  and 200,000 PBKDF2 rounds make that slow going.

Nobody can list the existing rooms — the rules deny reading the parent
`/games` node, only individual rooms you already know the name of.

That said, this is a game between two friends, not a bank. Anyone who guesses
your password can play or wreck your board, so pick something non-obvious and
don't reuse a password you use anywhere else.

## Cost

Firebase's free Spark plan covers this many times over — a whole game is a few
kilobytes, and the plan allows on the order of a gigabyte of storage and
100 simultaneous connections. Two people pushing mancala stones around will not
get close. GitHub Pages is free for public repos.

## Working on it locally

There's no build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
```

Then http://localhost:8000. It talks to the same Firebase database as the
deployed copy, so use a different password if you don't want to disturb a game
in progress.

`test.html` runs the rules — sowing, captures, extra turns, end-of-game
sweeping, seat claiming — against [game.js](game.js) and prints the results.
Open it the same way; it needs no database. To also exercise the password gate,
pass the two passwords in the URL:

```
localhost:8000/test.html?p1=...&p2=...
```

Without them those checks are skipped, so the passwords stay out of the repo.

## How it fits together

- [game.js](game.js) — the rules and the state transitions, all pure functions.
  Knows nothing about Firebase.
- [app.js](app.js) — draws the board and runs those transitions inside Firebase
  transactions, so two simultaneous moves can't corrupt the board.
- [index.html](index.html) — markup and styling.
- [firebase-config.js](firebase-config.js) — your project's config.
- [database.rules.json](database.rules.json) — what to paste into the Rules tab.

Seats are released automatically when a player's connection drops, and taken
back when they reconnect, so a closed tab can't lock the other person out.

Open the same password twice — your laptop and your phone, say — and the second
one doesn't fight the first for the seat. It says so and offers **TAKE MY
SEAT**, which hands it over deliberately. An empty chair is still retaken
without asking; it is only an occupied one that waits for you. If a
seat gets stuck anyway — a dead tab the disconnect handler never noticed —
**KICK EVERYONE** clears both chairs. Anyone still actually there sits straight
back down within a second, because their password owns their chair; a stale
entry cannot, so it stays gone. The board is untouched either way.

What the cat says is encrypted too, in `catlines.enc`, and decrypted in the
browser once you're in — same key as the photos. To change them, edit
`cat-lines.txt` (one line per line; it's gitignored and stays on your machine)
and run:

```bash
python3 encrypt-lines.py "your password"
```

If `cat-lines.txt` is missing, decrypt the current ones first — any browser
that can play the game can, and so can `encrypt-lines.py`'s reverse.

## Rules used

Standard Kalah: six pits a side, four stones each. Sow counter-clockwise into
every pit and your own store, never your opponent's. Last stone in your store
earns another turn. Last stone in an empty pit on your side captures that stone
plus the contents of the pit across from it. When one player's pits are empty
the other banks their remaining stones, and the bigger store wins.
