#!/usr/bin/env python3
"""Set the two passwords and encrypt the win photos.

Two passwords open one game: the first names player 1, the second player 2.
The room's real name is a random secret that never appears in the source. What
does appear is that secret XORed with each password's PBKDF2 key, plus a
checksum — so a valid password recovers the secret and an invalid one doesn't,
and reading this repo tells you nothing without cracking a password first.

The same secret keys the win photos, which are committed as .enc ciphertext so
that a public repo does not mean public pictures of you.

    python3 setup-secrets.py "player one password" "player two password" \\
        katewin.jpg snewin.jpg

Paste the printed constants into game.js. Changing the passwords abandons any
game in progress, because the room name is derived from them.
"""

import hashlib
import os
import pathlib
import secrets
import subprocess
import sys

SALT = b'komancala-room'
ITERATIONS = 200000
PHOTO_LABEL = b'komancala-photos'


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    pw1, pw2, *photos = sys.argv[1:]
    if pw1 == pw2:
        sys.exit('The two passwords must differ — they are what tells you apart.')
    for photo in photos:
        if not pathlib.Path(photo).is_file():
            sys.exit(f'No such photo: {photo}')

    room_secret = secrets.token_bytes(32)
    blobs = [
        bytes(a ^ b for a, b in zip(
            room_secret, hashlib.pbkdf2_hmac('sha256', pw.encode(), SALT, ITERATIONS, 32))).hex()
        for pw in (pw1, pw2)
    ]

    # Same derivation the browser does in game.js.
    photo_key = hashlib.sha256(room_secret + PHOTO_LABEL).hexdigest()
    for photo in photos:
        iv = os.urandom(16)
        result = subprocess.run(
            ['openssl', 'enc', '-aes-256-cbc', '-K', photo_key, '-iv', iv.hex(), '-in', photo],
            capture_output=True, check=True)
        target = pathlib.Path(photo).with_suffix('.enc')
        target.write_bytes(iv + result.stdout)
        print(f'# encrypted {photo} -> {target}', file=sys.stderr)

    print('\n// paste into game.js:\n')
    print('const ROOM_BLOBS = [')
    print(f"  '{blobs[0]}',  // player 1")
    print(f"  '{blobs[1]}',  // player 2")
    print('];')
    print(f"const ROOM_CHECKSUM = '{hashlib.sha256(room_secret).hexdigest()}';")


if __name__ == '__main__':
    main()
