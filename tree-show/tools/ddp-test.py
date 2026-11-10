#!/usr/bin/env python3
"""Send plain test frames straight to WLED over DDP, bypassing tree-show, to check wiring and outputs.

Usage:  python3 ddp-test.py <mode> [seconds] [host]
Modes:  black   every pixel off (anything lit is NOT coming from the data)
        red | green | blue | white   every pixel that color at 25%
        sides   left half (WLED matrix x 0-8) red, right half (x 9-18) green
        ribs    each rib its own color, rib 1 = red, then green, blue, repeating
Stop tree-show's Go live / Play on tree first, or it will fight this script.
WLED falls back to its own preset a few seconds after the script ends.
"""
import socket, sys, time

W, H, COUNT = 19, 50, 950          # WLED 2D matrix size (logical x, y); index = y*W + x
mode = sys.argv[1] if len(sys.argv) > 1 else 'black'
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 15
host = sys.argv[3] if len(sys.argv) > 3 else 'wled.local'

L = 64  # 25% of 255
SOLID = {'black': (0, 0, 0), 'red': (L, 0, 0), 'green': (0, L, 0), 'blue': (0, 0, L), 'white': (L, L, L)}
CYCLE = [(L, 0, 0), (0, L, 0), (0, 0, L)]

frame = bytearray(COUNT * 3)
for y in range(H):
    for x in range(W):
        if mode in SOLID: c = SOLID[mode]
        elif mode == 'sides': c = (L, 0, 0) if x < 9 else (0, L, 0)
        elif mode == 'ribs': c = CYCLE[x % 3]
        else: sys.exit(__doc__)
        i = (y * W + x) * 3
        frame[i:i + 3] = bytes(c)

addr = (socket.gethostbyname(host), 4048)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
print(f'Sending "{mode}" to {host} ({addr[0]}) for {secs:g}s ...')
seq, end, CH = 0, time.time() + secs, 480 * 3
while time.time() < end:
    seq = seq % 15 + 1
    for off in range(0, len(frame), CH):
        data = frame[off:off + CH]
        last = off + CH >= len(frame)
        hdr = bytes([0x40 | (1 if last else 0), seq, 0x01, 0x01]) + off.to_bytes(4, 'big') + len(data).to_bytes(2, 'big')
        s.sendto(hdr + data, addr)
    time.sleep(0.05)
print('Done.')
