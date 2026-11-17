# Topper re-map: 100 px (4 rings) -> 75 px (5 rings)

The topper was rebuilt as a 3D-printed disc. Update the show software to match.

## New topper
- 75 pixels, WLED indices 1000-1074 (tree stays 0-999). Total LED count is now 1075.
- 5 concentric rings, 2.00" (50.8 mm) between pixels along each ring:

| Ring | Radius mm | Pixels | Strip # | WLED # | First pixel angle |
|---|---|---|---|---|---|
| 1 | 40.4 | 5 | 1-5 | 1000-1004 | 216 deg |
| 2 | 80.9 | 10 | 6-15 | 1005-1014 | 198 deg |
| 3 | 121.3 | 15 | 16-30 | 1015-1029 | 192 deg |
| 4 | 161.7 | 20 | 31-50 | 1030-1049 | 189 deg |
| 5 | 202.1 | 25 | 51-75 | 1050-1074 | 187.2 deg |

Angles are measured clockwise from 12 o'clock, looking at the FRONT (lit side). The mounting pole is at 6 o'clock (180 deg).
Wiring: data enters at the first pixel just left of the pole on ring 1, runs clockwise all the way round each ring,
then jumps to the next ring outward, again starting just left of the pole. Pixel k of a ring sits at
first_angle + k * 360/count.

`topper_strip_map.csv` has every pixel: strip (1-75), index (0-74), wled, ring, pos, angle, x, y
(x right, y up, mm from the topper centre, front view). Use it as the source of truth.

## Tasks
1. Replace the old topper geometry (RINGS = 10/20/30/40, 100 px) in engine.js with this layout,
   built from the CSV or the table above, in strip order.
2. Change N / total pixel count from 1100 to 1075 everywhere (engine, server, DDP frame size).
3. Make sure the star / topper patterns and the Topper image mode use the new x,y positions.
4. Update the WLED LED count note in the docs (1075). Restart tree-show and check the topper on the tree.
