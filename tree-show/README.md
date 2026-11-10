# tree-show

Runs the light cone tree. It stores your designs and playlists, plays them to WLED over DDP all night with no phone open, and serves the mixer page you use to build them.

```
phone (mixer page)  --HTTP/WebSocket-->  tree-show (Proxmox LXC)  --DDP, UDP 4048-->  WLED on the ESP32 board
  build designs                            stores shows                                 GPIO16: ribs 1-10
  edit playlists                           runs the playlist                            GPIO17: ribs 11-20
  go live                                  relays live frames                           GPIO18: topper
```

## Install in a Proxmox LXC

1. Create an LXC from the **Debian 12** template (1 core, 256 MB RAM, 2 GB disk is plenty). Give it a static IP or DHCP reservation on the same network as WLED. No nesting or privileges needed.
2. Copy this folder into the container (for example `scp -r tree-show root@<lxc-ip>:/root/`).
3. In the container, as root:

```bash
cd /root/tree-show
bash install.sh 192.168.1.50        # your WLED's IP
```

4. Open `http://<lxc-ip>:8080` on your phone.

The playlist starts again by itself after a reboot if it was playing.

| What | Where |
|---|---|
| Settings | **⚙ on the page** (WLED address, ribs, pixels per rib, arc, topper start), saved in `/var/lib/tree-show/settings.json`. `/etc/tree-show.env` holds the port and the starting defaults (edit, then `systemctl restart tree-show`) |
| Your designs and playlist | `/var/lib/tree-show/shows.json` (back this up) |
| Logs | `journalctl -u tree-show -f` |
| Update | `tools/deploy.sh` (no sudo once install.sh has run), then `sudo systemctl restart tree-show`. Run `sudo bash install.sh` again only if dependencies change. Settings and data are kept. |

| Setting | Default | Meaning |
|---|---|---|
| `WLED_HOST` | `wled.local` | WLED IP or hostname |
| `WLED_DDP_PORT` | `4048` | DDP port |
| `HTTP_PORT` | `8080` | Mixer page |
| `FPS` | `40` | Playlist frame rate |
| `DATA_DIR` | `/var/lib/tree-show` | Where shows are saved |

Docker is optional: `docker compose up -d --build` uses the included `Dockerfile` and `docker-compose.yml`.

## Using it

**Mix** is the live mixer: two decks of 28 patterns, crossfader, tempo, pads, topper modes and image upload. **Save design** stores the current look, including any uploaded image it uses. **Go live** sends the mixer straight to the tree and pauses the playlist until you stop.

**Shows** (the main screen) holds your designs and the playlist. **Edit** opens a window for that design: pattern, colors, speed, second pattern, tempo and topper, with a live preview and an option to show it on the tree while you edit. **Brightness** sets the overall level for everything sent to the tree. **Schedule** sets times (every week on chosen days, or on a date, optionally every year) to play a chosen playlist or hold a design; times can be clock times or sunrise/sunset/dawn/dusk with an offset. A dated time beats the weekly ones; outside every time the tree is off. **Back to live tree** on the preview returns from Try/Preview to what the tree is showing.

- **Designs:** Try previews a design on the page, **On tree** sends it to the tree and keeps it there until you press **↩ Playlist** (or Play, Next, Stop), Edit loads it into the mixer, + adds it to the playlist, ✕ deletes it (tap twice). **+ Random** generates a new design from the pattern and palette library.
- **Playlist:** set seconds per design and reorder with the arrows.
- **In order / Shuffle / Random:** Shuffle plays your list in a new order each pass. Random ignores the list and makes a fresh look every N seconds.
- **Fade:** crossfade time between designs. **Tree %:** overall brightness for the playlist.
- **Play on tree / Stop tree:** runs the playlist in tree-show. When a design is being tried, the button becomes **Show on tree**.
- **Preview** runs the playlist on the page only. When the tree is playing, the page shows a live view of it.

When the page is opened anywhere else (for example the published copy), designs and playlists save in that browser only and can't reach the tree.

## Christmas design library

tree-show ships with 88 designs in 10 categories. Filter by category on the Designs list, and use **+ Add all** to drop a whole category into the playlist. The starter playlist is 20 favorites at 45 seconds each, shuffled.

| Category | Designs |
|---|---|
| Classic Christmas (12) | Classic C9 bulbs, Red and green spin, Red and green ribbons, Christmas helix to sparkle, Gold garland, Ornament tree, Warm white twinkle, Evergreen glow, Holly and berries, Silver tinsel, Marquee lights, Old-fashioned tree |
| Candy and sweets (10) | Candy cane, Candy cane stripes, Peppermint swirl, Sugar plum fairy, Gingerbread house, Gumdrops, Hot cocoa, Ribbon candy, Frosted cookies, Lollipop spiral |
| Snow and winter (11) | Snowfall, Heavy snow, Icicles, Northern lights, Frost, Blizzard, Winter wonderland, Ice palace, Snow globe, Polar night, Aurora to snowfall |
| Fireside (7) | Yule fire, Yule log, Candlelight, Fireplace glow, Embers, Chestnuts roasting, Hearth and home |
| Santa's workshop (10) | Santa suit, Elf chase, Reindeer run, Red nose glow, Sleigh ride, Wrapped presents, Green gift wrap, Toy factory, North Pole stripes, Naughty or nice |
| Holy night (7) | Silent night, Star of Bethlehem, Angels, O holy night, Peace on earth, Midnight candles, Joy to the world |
| Messages (13) | Scrolling text: Merry Christmas, Ho ho ho, Joy, Noel, Peace, Let it snow, Believe, Season's greetings, Happy holidays, Feliz Navidad, Naughty or nice?, Love and joy, Santa stop here |
| Party lights (8) | Rainbow comet, Rainbow spiral, Confetti, Ugly sweater, Christmas disco, Jingle bell rock, Color wipe, Plasma party |
| New Year's Eve (6) | Happy New Year, Fireworks, Champagne bubbles, Countdown pulse, Gold and silver, Midnight disco |
| Team colors (4) | Blue and gold spin, Cardinal rise, Blue and gold snowfall, Cardinal and gold fire |

Your own saved designs go under **My designs**. Deleting a library design hides it; **Bring back deleted library designs** at the end of the list restores them. Upgrades add any new library designs without touching yours.

**WLED-style effects (10):** Soap, Rockets, Starburst, Pacifica, Matrix, DNA, Rain, Lightning, Bounce, Lava, with 11 ready-made designs in the "WLED-style effects" category.

**Patterns (38, including the effects above):** Spin, Rise, Helix, Sparkle, Pulse, Radar, Rainbow, Plasma, Candy, Twinkle, Snow, Fire, Comet, Glow, Bulbs, Ornament, Garland, Aurora, Meteor, Icicle, Chase, Wipe, Gift, Firework, Confetti, Breathe, Text, Image.
**Topper modes:** Star, Flake (six-arm snowflake), Ripple (rings pulsing outward), Follow (continues the tree pattern), Image.
**Text:** pick Text on a deck and type up to 60 characters in the deck header. It scrolls around the cone in a 5×7 font; `<` draws a heart. Short words read best, since about two letters fit across the front of the tree at once.

## WLED setup

LED preferences on the controller board (ESP32-WROOM-32E), 1,100 LEDs total:

| Board terminal | GPIO | Carries | Length | Start |
|---|---|---|---|---|
| J3 · LED1 | 16 | Tree ribs 1-10, starts at the bottom of rib 1 | 500 | 0 |
| J4 · LED2 | 17 | Tree ribs 11-20, starts at the bottom of rib 11 | 500 | 500 |
| J5 · LED3 | 18 | Topper, center ring out | 100 | 1000 |
| J6 · LED4 | 19 | Spare | — | — |

- **Sync interfaces → Realtime:** turn on receiving UDP realtime. When tree-show stops, WLED returns to its own preset after the realtime timeout.
- Set the current limiter to the supply rating (max 20,000 mA on the board) and inject power at each 50-pixel string joint.
- If red and green look swapped, change the color order (RGB/GRB).

## Pixel order

| WLED index | Part | Order |
|---|---|---|
| 0-999 | Tree | Serpentine from the bottom of rib 1 (left, seen from the street): rib 1 up, rib 2 down, … rib 20 ends bottom right |
| 1000-1099 | Topper | Center ring out (10, 20, 30, 40), each ring from 12 o'clock clockwise seen from the street |

To change the wiring order, edit the `WLED order` block in `public/engine.js`.

## Files

| File | What it does |
|---|---|
| `server.js` | HTTP + WebSocket server, storage, playlist loop, DDP sender |
| `public/engine.js` | Light engine shared by the page and server: geometry, patterns, palettes, playlist player, WLED order |
| `public/index.html` | The mixer and Shows page |
| `install.sh`, `deploy/` | systemd install for an LXC |
| `Dockerfile`, `docker-compose.yml` | Optional Docker install |

API, if you want to script it (Home Assistant, cron): `GET /api/state`, `POST /api/player` with `{"action":"play"}`, `"stop"` or `"next"`, `PUT /api/playlist`, `PUT`/`DELETE /api/designs/<id>`.
