#!/usr/bin/env python3
"""Snap-on clips that hold the 3D-printed sign to a vertical PVC pipe.

    python3 tools/clip3d.py out-dir

For each pipe size (1/2", 3/4", 1" schedule 40 PVC) writes out-dir/clip-<size>.stl with two clips (top and bottom).
The clip is a C-ring that wraps ~260 degrees round the pipe and snaps on (a flared opening guides it), with a solid
block in front: an M4 thread-forming screw goes through the sign's hole into the block's pilot hole (M4 x 16: ~12.8 mm
in the plastic). Print standing up (as the C shape), so the layers run round the ring, the strong way for the snap.
PETG is best outdoors. Needs: manifold3d, numpy, trimesh.
"""
import math, os, sys
import numpy as np
from manifold3d import CrossSection, Manifold
import trimesh

PIPES = {'half-inch': 21.3, 'three-quarter-inch': 26.7, 'one-inch': 33.4}   # outside diameters, mm
HEIGHT = 16.0        # along the pipe
WALL = 2.8           # the ring (thin enough to flex, PETG)
GRIP = 0.15          # snug: the ring's inside is this much smaller than the pipe (radius)
OPEN_DEG = 116       # the opening at the back; the ring wraps the rest (~244 deg: well past half, so it holds)
BLOCK_W, BLOCK_D = 20.0, 15.0     # the block in front of the pipe: width, and depth past the pipe's surface
PILOT_D, PILOT_DEPTH = 3.4, 14.5  # M4 thread-forming screw pilot hole (about 0.85 x d), from the block's front face

out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)

def circle(r, n=96, cx=0.0, cy=0.0): return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]

def clip(od):
    R = od / 2 - GRIP
    ring = CrossSection([circle(R + WALL)]) - CrossSection([circle(R)])
    # the opening: a wedge at the back (-y), the sign is at +y
    a = math.radians(OPEN_DEG / 2); far = (R + WALL) * 3
    tri = [(0, 0), (far * math.sin(a), -far * math.cos(a)), (-far * math.sin(a), -far * math.cos(a))]
    wedge = CrossSection([tri if (tri[1][0] * tri[2][1] - tri[2][0] * tri[1][1]) > 0 else tri[::-1]])
    ring = ring - wedge
    # rounded lips at the opening's edges: they guide the pipe in
    lips = CrossSection()
    for s in (-1, 1):
        ang = -math.pi / 2 + s * a; mid = R + WALL / 2
        lips = lips + CrossSection([circle(WALL * 0.75, 32, mid * math.cos(ang), mid * math.sin(ang))])
    # the block in front, joined to the ring
    block = CrossSection([[(-BLOCK_W / 2, R * 0.55), (BLOCK_W / 2, R * 0.55), (BLOCK_W / 2, R + BLOCK_D), (-BLOCK_W / 2, R + BLOCK_D)]]) - CrossSection([circle(R)])
    body = Manifold.extrude(ring + lips + block, HEIGHT)
    # the pilot hole: from the block's front face (+y) towards the pipe, in the middle of the clip's height
    pilot = Manifold.cylinder(PILOT_DEPTH + 1, PILOT_D / 2, PILOT_D / 2, 48).rotate([-90, 0, 0]).translate([0, R + BLOCK_D - PILOT_DEPTH, HEIGHT / 2])
    lead = Manifold.cylinder(1.0, PILOT_D / 2 + 0.6, PILOT_D / 2, 48).rotate([90, 0, 0]).translate([0, R + BLOCK_D + 0.01, HEIGHT / 2])  # a small chamfer to start the screw
    body = body - pilot - lead
    return body, R

only = sys.argv[2] if len(sys.argv) > 2 else None   # e.g. half-inch
for name, od in PIPES.items():
    if only and name != only: continue
    one, R = clip(od)
    span = (R + BLOCK_D) - (-(R + WALL)) + 8
    pair = one + one.translate([0, -span, 0])            # two clips: top and bottom
    g = pair.to_mesh(); m = trimesh.Trimesh(vertices=np.array(g.vert_properties)[:, :3], faces=np.array(g.tri_verts), process=True)
    assert m.is_watertight, name
    m.export(os.path.join(out, f'clip-{name}.stl'))
    b = one.bounding_box()
    print(f'{name:20s} pipe {od:4.1f} mm: clip {b[3] - b[0]:.1f} x {b[4] - b[1]:.1f} x {HEIGHT:.0f} mm, sign stands {BLOCK_D:.0f} mm off the pipe, watertight={m.is_watertight}')
