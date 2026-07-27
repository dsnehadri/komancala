#!/usr/bin/env python3
"""Encrypt the cat's lines so they aren't readable in a public repo.

Edit cat-lines.txt (one line per line, blank lines ignored), then:

    python3 encrypt-lines.py "your password"

It recovers the room secret from game.js using the password, encrypts the
lines with the same key the win photos use, and writes catlines.enc.
cat-lines.txt is gitignored and stays on your machine.
"""

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

SALT = b'komancala-room'
ITERATIONS = 200000
LABEL = b'komancala-photos'


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    password = sys.argv[1].encode()

    source = pathlib.Path('cat-lines.txt')
    if not source.is_file():
        sys.exit('cat-lines.txt not found — decrypt the current ones first, or write new ones.')
    lines = [line for line in source.read_text(encoding='utf-8').split('\n') if line.strip()]
    if not lines:
        sys.exit('cat-lines.txt is empty.')

    game = pathlib.Path('game.js').read_text()
    blobs = re.findall(
        r"'([0-9a-f]{64})'",
        game[game.index('const ROOM_BLOBS'):game.index('const ROOM_CHECKSUM')])
    checksum = re.search(r"const ROOM_CHECKSUM = '([0-9a-f]+)';", game).group(1)

    derived = hashlib.pbkdf2_hmac('sha256', password, SALT, ITERATIONS, 32)
    for blob in blobs:
        secret = bytes(a ^ b for a, b in zip(bytes.fromhex(blob), derived))
        if hashlib.sha256(secret).hexdigest() == checksum:
            break
    else:
        sys.exit('That password does not open this game.')

    key = hashlib.sha256(secret + LABEL).hexdigest()
    payload = json.dumps(lines, ensure_ascii=False).encode('utf-8')
    iv = os.urandom(16)
    ciphertext = subprocess.run(
        ['openssl', 'enc', '-aes-256-cbc', '-K', key, '-iv', iv.hex()],
        input=payload, capture_output=True, check=True).stdout
    pathlib.Path('catlines.enc').write_bytes(iv + ciphertext)
    print(f'catlines.enc written — {len(lines)} lines, {len(iv + ciphertext)} bytes')


if __name__ == '__main__':
    main()
