#!/usr/bin/env python3
"""The guest-site sign as a 3D print (Bambu P1S with an AMS): a white base and raised red and green parts.

    node -e "process.stdout.write(JSON.stringify(require('./sign.js').printLayout(process.argv[1])))" https://t.example.com \
      | python3 tools/sign3d.py out-dir

Writes out-dir/sign-white.stl, sign-red.stl, sign-green.stl (load all three into Bambu Studio as one object with
three parts and give each its filament) and sign.3mf (the same three parts, already lined up), plus sign-preview.png.
Needs: manifold3d, numpy, trimesh, Pillow.

The plate is thin but stiff: 2.0 mm with a 4 mm wide, 4.4 mm tall rim (a rim makes a thin plate far stiffer and
guards the raised parts). Letters, QR code and TV stand 0.8 mm (4 layers at 0.2 mm). Two countersunk holes on the
centre line for #8 screws into the pipe, with a thicker pad round each; zip-tie slots either side as an alternative.
"""
import json, math, os, sys
import numpy as np
from manifold3d import CrossSection, Manifold, FillRule
import trimesh
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen

FONT = os.environ.get('SIGN_FONT', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')   # smooth, bold, free licence

PLATE, RIM_W, RIM_H, RAISE = 2.0, 4.0, 4.4, 0.8
HOLE_D, HEAD_D, PAD_R, PAD_H = 4.4, 9.0, 8.0, 3.2         # #8 screw: clearance hole, countersink, pad round it
SLOT_W, SLOT_H = 3.0, 5.5                                  # zip-tie slots (vertical, for a tie round the pipe)

lay = json.load(sys.stdin)
W, H = lay['w'], lay['h']
out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)

def yflip(y): return H - y                                 # the layout is y-down; the model is y-up

def rrect(x, y, w, h, r, n=10):                            # rounded rectangle outline (y-down input), counter-clockwise
    r = min(r, w / 2, h / 2); pts = []
    for cx, cy, a0 in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n); pts.append((cx + r * math.cos(a), yflip(cy + r * math.sin(a))))
    return pts[::-1] if area(pts) < 0 else pts

def area(p): return 0.5 * sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))
def ccw(p): return p if area(p) > 0 else p[::-1]
def circle(cx, cy, r, n=40): return ccw([(cx + r * math.cos(2 * math.pi * i / n), yflip(cy) + r * math.sin(2 * math.pi * i / n)) for i in range(n)])

_font = None
def text_section(s, cx, top, h, maxw):                      # a line of text from the font, capital height h, centred on cx
    global _font
    if _font is None: _font = TTFont(FONT)
    gs, cmap, upm = _font.getGlyphSet(), _font.getBestCmap(), _font['head'].unitsPerEm
    cap = getattr(_font['OS/2'], 'sCapHeight', 0) or 0.73 * upm
    k = h / cap
    adv = sum(_font['hmtx'][cmap.get(ord(ch), cmap[32])][0] for ch in s)
    if adv * k > maxw: k = maxw / adv                     # too wide: smaller
    x, base, polys = cx - adv * k / 2, top + cap * k, []
    for ch in s:
        g = cmap.get(ord(ch), cmap[32]); pen = RecordingPen(); gs[g].draw(pen); cur = []
        def P(pt): return (x + pt[0] * k, yflip(base) + pt[1] * k)
        for op, args in pen.value:
            if op == 'moveTo': cur = [P(args[0])]
            elif op == 'lineTo': cur.append(P(args[0]))
            elif op == 'qCurveTo':                         # TrueType quadratics (implied on-curve points between controls)
                pts = [cur[-1]] + [P(a) for a in args if a is not None]
                ctrl, end = pts[1:-1], pts[-1]
                seq = [pts[0]]
                for i, c in enumerate(ctrl):
                    nxt = end if i == len(ctrl) - 1 else ((c[0] + ctrl[i + 1][0]) / 2, (c[1] + ctrl[i + 1][1]) / 2)
                    a0 = seq[-1]
                    for t in range(1, 9):
                        t /= 8; seq.append(((1 - t) ** 2 * a0[0] + 2 * (1 - t) * t * c[0] + t * t * nxt[0], (1 - t) ** 2 * a0[1] + 2 * (1 - t) * t * c[1] + t * t * nxt[1]))
                cur += seq[1:]
            elif op == 'curveTo':                          # (cubic fonts)
                a0, c1, c2, e = cur[-1], P(args[0]), P(args[1]), P(args[2])
                for t in range(1, 13):
                    t /= 12; u = 1 - t
                    cur.append((u ** 3 * a0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * e[0], u ** 3 * a0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * e[1]))
            elif op in ('closePath', 'endPath'):
                if len(cur) > 2: polys.append(cur)
                cur = []
        x += _font['hmtx'][g][0] * k
    return CrossSection(polys, FillRule.NonZero)

def section(shape):                                        # one layout shape -> CrossSection
    k = shape['k']
    if k == 'text': return text_section(shape['s'], shape['cx'], shape['top'], shape['h'], shape['maxw'])
    if k == 'rect': return CrossSection([ccw([(shape['x'], yflip(shape['y'])), (shape['x'] + shape['w'], yflip(shape['y'])), (shape['x'] + shape['w'], yflip(shape['y'] + shape['h'])), (shape['x'], yflip(shape['y'] + shape['h']))])])
    if k == 'circle': return CrossSection([circle(shape['cx'], shape['cy'], shape['r'])])
    if k == 'poly': return CrossSection([ccw([(a, yflip(b)) for a, b in shape['pts']])])
    if k == 'ring':
        t = shape['t']
        return CrossSection([rrect(shape['x'], shape['y'], shape['w'], shape['h'], shape['r'])]) - CrossSection([rrect(shape['x'] + t, shape['y'] + t, shape['w'] - 2 * t, shape['h'] - 2 * t, max(0.01, shape['r'] - t))])
    raise ValueError(k)

def union(sections):
    acc = CrossSection()
    for s in sections: acc = acc + s
    return acc

# ---- the white base: plate, rim, pads round the screw holes; then the holes, countersinks and slots cut out ----
outline = CrossSection([rrect(0, 0, W, H, 9)])
inner = CrossSection([rrect(RIM_W, RIM_W, W - 2 * RIM_W, H - 2 * RIM_W, 9 - RIM_W)])
base = Manifold.extrude(outline, PLATE) + Manifold.extrude(outline - inner, RIM_H)
for hx, hy in lay['holes']:
    base = base + Manifold.extrude(CrossSection([circle(hx, hy, PAD_R)]), PAD_H)
cut = Manifold()
for hx, hy in lay['holes']:
    cut = cut + Manifold.cylinder(PAD_H + 2, HOLE_D / 2, HOLE_D / 2, 48).translate([hx, yflip(hy), -1])
    sink = (HEAD_D - HOLE_D) / 2                          # a 90-degree countersink from the top of the pad
    cut = cut + Manifold.cylinder(sink + 0.01, HOLE_D / 2, HEAD_D / 2, 48).translate([hx, yflip(hy), PAD_H - sink])
    cut = cut + Manifold.cylinder(1, HEAD_D / 2, HEAD_D / 2, 48).translate([hx, yflip(hy), PAD_H - 0.001])
for sx, sy in lay['slots']:
    cut = cut + Manifold.cube([SLOT_W, SLOT_H, PLATE + 2]).translate([sx - SLOT_W / 2, yflip(sy) - SLOT_H / 2, -1])
base = base - cut

# ---- the raised colours, standing on the plate ----
def raised(shapes): return Manifold.extrude(union(section(s) for s in shapes), RAISE).translate([0, 0, PLATE])
red, green = raised(lay['red']), raised(lay['green'])
red, green = red - cut, green - cut - red                  # never two colours in one spot

def to_mesh(m, color):
    g = m.to_mesh(); t = trimesh.Trimesh(vertices=np.array(g.vert_properties)[:, :3], faces=np.array(g.tri_verts), process=True)
    t.visual.face_colors = color
    return t
parts = {'white': to_mesh(base, [240, 240, 240, 255]), 'red': to_mesh(red, [200, 30, 40, 255]), 'green': to_mesh(green, [20, 120, 60, 255])}
for name, m in parts.items():
    assert m.is_watertight, name + ' is not watertight'
    m.export(os.path.join(out, f'sign-{name}.stl'))
scene = trimesh.Scene()
for name, m in parts.items(): scene.add_geometry(m, node_name=f'sign-{name}', geom_name=f'sign-{name}')
scene.export(os.path.join(out, 'sign.3mf'))

# ---- a top view, for checking (and the QR code must scan) ----
from PIL import Image, ImageDraw
k = 4; img = Image.new('RGB', (int(W * k), int(H * k)), (255, 255, 255)); d = ImageDraw.Draw(img)
from PIL import ImageChops
def draw(cs, fill):                                        # even-odd: every contour flips inside/outside (holes, islands in holes)
    mask = Image.new('1', img.size, 0)
    for p in cs.to_polygons():
        if len(p) < 3: continue
        m = Image.new('1', img.size, 0); ImageDraw.Draw(m).polygon([(x * k, (H - y) * k) for x, y in p], fill=1)
        mask = ImageChops.logical_xor(mask, m)
    img.paste(fill, (0, 0), mask)
draw(outline - inner, (225, 225, 225))
draw(union(section(s) for s in lay['green']), (20, 110, 55))
draw(union(section(s) for s in lay['red']), (200, 30, 40))
for hx, hy in lay['holes']: d.ellipse([(hx - HEAD_D / 2) * k, (hy - HEAD_D / 2) * k, (hx + HEAD_D / 2) * k, (hy + HEAD_D / 2) * k], outline=(90, 90, 90), width=3); d.ellipse([(hx - HOLE_D / 2) * k, (hy - HOLE_D / 2) * k, (hx + HOLE_D / 2) * k, (hy + HOLE_D / 2) * k], fill=(40, 40, 40))
for sx, sy in lay['slots']: d.rectangle([(sx - SLOT_W / 2) * k, (sy - SLOT_H / 2) * k, (sx + SLOT_W / 2) * k, (sy + SLOT_H / 2) * k], fill=(40, 40, 40))
img.save(os.path.join(out, 'sign-preview.png'))
for name, m in parts.items():
    b = m.bounds; print(f'{name:6s} {m.volume / 1000:6.1f} cm3  size {b[1][0] - b[0][0]:.1f} x {b[1][1] - b[0][1]:.1f} x {b[1][2]:.1f} mm  watertight={m.is_watertight}')
