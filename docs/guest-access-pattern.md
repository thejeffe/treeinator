# Guest access pattern: let the public line up requests for something at home

A blueprint for a public web page where anyone nearby (passers-by, party guests, neighbours) scans a QR code, picks
something for a device at home to do, and joins a fair line, while the home system stays **unreachable from the
internet**. It was built for a Christmas-light tree ("pick a light show, add a message, watch it play"), but the
pattern fits anything that runs one request at a time: a jukebox, an LED sign, a light show, a fountain, a model railway.

Give this file to a coding session together with your project; the **Adapting** section at the end lists what to fill in.

Terms used below:
- **the thing**: the device or show guests control (the tree).
- **home app**: the program at home that drives the thing (owner's control page, schedule, playlist...).
- **guest site**: the public page and its small API, hosted in the cloud (here: AWS).
- **item**: what a guest can pick (a design/show/song), from the home app's catalog.
- **request (ticket)**: one guest's pick waiting in the line.

---

## 1. Architecture

```
 guests' phones ──HTTPS──▶ CDN (CloudFront) ──/*──────▶ private bucket (S3): the one-page site
                                            └─/api/*──▶ function (Lambda URL) ──▶ key-value table (DynamoDB)
                                                              ▲
 home app (behind NAT / carrier-grade NAT) ──HTTPS, outbound only, every few s──┘  POST /api/<thing> with a shared key
```

- **Nothing at home accepts inbound connections.** The home app *polls out* to the guest site: it reports its state
  and collects the waiting requests. That works behind any router or carrier NAT, with no port forwarding, VPN or MQTT.
- The cloud side is serverless and tiny: one static page, one function, one table. Idle cost is close to zero.
- The function URL is only usable through the CDN: the CDN adds a secret header (`x-origin-key`) and the function
  refuses requests without it (constant-time compare).
- The home app has its own secret (`x-<thing>-key`) for its check-in endpoint.
- The same function code also runs **inside the home app** as a local "sample site" (with a JSON file instead of the
  table), so the whole flow can be tested on the LAN before any cloud exists.

## 2. Data (three items in one table)

| key | holds | written by |
|---|---|---|
| `queue` | open/closed + why + reason text, seconds per request, the line (tickets), what's playing now and when it ends, per-phone rate stamps and fairness slots, geofence (lat/lon/radius), catalog hash, limits | guests' requests, the home app's check-ins |
| `catalog` | the pickable items (id, name, category, colors/preview data), favourites, page title; a content hash | the home app, only when its hash changed |
| `events` | the newest N activity events, numbered (`seq`) | the function (requests, refusals) and the page (opens, taps) |

**Every write is conditional on a version number** (read, change, write-if-version-unchanged, retry up to ~5 times).
Two guests tapping at the same moment can't lose each other's requests. Keep each item well under the store's item
size limit (DynamoDB: 400 KB): cap list lengths and string lengths everywhere.

## 3. API

| method + path | who | what |
|---|---|---|
| `GET /api/queue` | page (polls ~every 3-5 s while visible) | public view: open?, why/reason/back-at, now playing + seconds left, the line (names, colors, message, *mine* flag), the caller's limits, catalog hash |
| `GET /api/catalog` | page (on load, and when the hash changes) | the items to pick from |
| `POST /api/request` | page | `{id, colors, msg, lat?, lon?, acc?}` -> `{ticket, pos}` or a friendly refusal (`error` + `why`) |
| `POST /api/cancel` | page | `{ticket}`: only the phone that made it can cancel |
| `POST /api/log` | page | a batch of opens/taps for the owner's activity log |
| `POST /api/<thing>` | home app, with its key | check-in (below) |

Public responses **never contain** addresses, hashes of addresses or other people's tickets; "mine" is computed per caller.

**Check-in** (home app -> cloud, every 3 s while open, 15 s while closed, 60 s with the feature off). It sends:
- `open` plus `why` (`paused` / `resting` = outside the schedule / `live` = owner using it / `closed`), a `reason`
  sentence for guests, and `back` (when it opens again, in words);
- `sec` (play time per request) and the limits (line length in minutes);
- `now` = the ticket it's playing and seconds left (that ticket leaves the line);
- `drop` = tickets it can't play; `clear` when the owner emptied the line;
- `geo` (only if the owner turned the nearby check on);
- the catalog, **only when its hash changed**;
- `evAfter` = the last event number it has.

It gets back the waiting requests, the catalog hash and new events. If the cloud hears nothing for ~30 s it shows
the thing as closed, so a dead home server never leaves guests waiting.

## 4. Home app side

- Plays requests one after another for `sec` each, then hands the thing back to whatever it was doing (playlist,
  held item). A guest's pick is not an "override" of the owner's schedule.
- Takes requests only while the schedule has the thing on (or the owner is playing it by hand); never while paused,
  while the owner's live mode is in use, or with the feature off. Testing switch: "take requests outside the hours".
- Owner controls (settings page): on/off, pause with a note guests see, seconds per request, line length (minutes),
  nearby-only + radius, page title, favourites, the guest site address and key, skip the one playing, take any
  request out, clear the line, open the guest page, QR code / sign downloads.
- Owner's main screen shows a **"GUEST" status badge** while a guest's pick plays: `"<item>" · 42 s left · 2 waiting`
  (count down locally each second from the `left` seconds it got, so the clocks never need to agree).
- The secret key is never echoed back to the browser (settings responses return `keySet: true` instead).

## 5. Fairness and limits (these numbers felt right in use)

- **Line length is in time, not count.** `cap = lineMin * 60 / sec` (e.g. 10 minutes of 45 s plays = 13 requests).
- **Quiet line** (shorter than `cap`): anyone may line up to `cap` of their own. Don't make people wait for nothing.
- **Busy line**: a fair share each, `max(1, floor(cap / phones waiting including a newcomer))`, so a newcomer always
  gets a turn and nobody fills the line.
- **Order = start-time fair queuing.** Each request gets a *slot*: the time it would start if its phone had the thing
  to itself, `max(now, that phone's previous slot + sec)`. The line is kept in slot order. Busy phones alternate
  (A, B, A, B), a newcomer goes in at "now", ahead of a busy phone's extras, and nothing played earlier counts
  against anyone. (Round-robin with a 30-minute memory starved a returning phone; don't.)
- **Script guard only:** more than 5 requests in 10 s from one phone is refused ("Whoa, that's fast!"). Don't log
  those as "turned away": they're quick taps, not people being refused.
- Whole-line hard cap (e.g. 60) as a backstop.
- A **phone** is identified by a hash of its address with a salt (`who`), plus a random id the page keeps in
  `localStorage` (`v`, for the activity log only). No accounts, no names, no cookies.

## 6. The guest page (one HTML file, no framework)

- **Never more than one phone screen.** No page scrolling; lists scroll inside their own boxes, with a subtle arrow
  showing there's more. Compact header (logo small). Grid of items about 4 rows tall.
- **No zooming** (`maximum-scale=1, user-scalable=no` *and* cancel `gesturestart`/`gesturechange` and multi-touch
  `touchmove`, because iPhone Safari ignores the meta tag for pinches; `touch-action: manipulation` stops double-tap zoom).
- **The keyboard must not hide things:** when the message box has focus, keep the box and the "Add to line" button
  above the keyboard (use `visualViewport` resize events to place them).
- Flow: pick an item (live preview of it), pick 1-2 colors (or the item's own), optional message, **Add to line**
  (an icon on the button). Then show "you're #3", your tickets with Cancel, and the line (collapsed, expandable).
- **Status card at the top**, impossible to miss when closed: `⏸ PAUSED` (owner note), `💤 RESTING` (opens at 5:30 PM),
  `🎛 LIVE SHOW`, `OFFLINE`; the rest of the page dims. While closed, offer something fun: here a small canvas
  game ("Help Santa deliver presents") in a full-screen layer with ✕, sized to the screen's shape and stopped when closed.
- Small icon-only **refresh** and **share** buttons (Web Share API, else copy link), aligned on one line.
- Polls the queue every few seconds while visible; pauses when hidden; reloads the catalog when its hash changes.
- **Nearby only (optional):** ask for location only when they press Add (not on load). Allow for the reading's
  accuracy (up to ~300 m). Handle Safari's denied/prompt states with a clear message that says how to allow it.
  Show distances in the local units (miles/feet in the US): "You're about 0.4 miles away. Come by and try again!".
- **Messages:** short (24 chars here), only characters the thing can show, uppercase; a word filter that undoes
  leetspeak (`5H1T`, `$hit`), spacing (`s h i t`), dots and stretched letters, has a whole-word list for short words
  that hide inside normal words (class, cocktail), and refuses URLs, @handles and phone numbers. Check on the page for
  quick feedback **and** in the function (the real check).
- Installable: manifest with PNG icons (180/192/512; **no SVG icon in the manifest**, Safari on the Mac picks it and
  shows a blank icon), `apple-touch-icon` 180x180, theme colour.
- No cookie banner needed when you only keep a random id in `localStorage` for the feature to work and set no
  tracking cookies (check your own jurisdiction).

## 7. Owner's activity log (the home app keeps it)

- Events: opened, picked item, category, shared, location refused, sent (with distance, rounded), refused (reason),
  cancelled; and from the home app itself: played, done, cut short, skipped, removed, dropped. JSON lines, kept 90 days.
- Grouped into **visits** (a phone's events with no gap over 30 minutes), newest activity first, filter Today / 7 /
  30 days, auto-refresh while the tab is open, download.
- Each phone gets a **friendly generated name** from its id (three word lists, hashed: "Merry Peppermint Partridge"),
  unique within the list (a clash takes the next name), the raw id in the tooltip.
- Each visit says **New visitor**, or **Return visitor · visit 4 · ★★★ Superfan (#3 of 31)**: phones ranked over
  the whole log by a score (sends x3 + visits x2 + items looked at x0.5): top 10% Superfan, top third Regular, else
  Drops by.

## 8. QR code and sign

- The QR code points at the guest site (or a separate short link). Error correction **H** so a small logo can sit in
  the middle (cover at most ~6% of it). If no library is allowed, a byte-mode encoder for versions 1-10 is ~300 lines.
- Downloads from the settings page: QR as SVG and PNG; a printable sign (SVG/PDF at true size) with a welcoming line,
  the logo and the code. **No web address printed** (the code is enough, and it can change).
- For a 3D-printed sign: separate the colours into one mesh per colour (base / text / code), and check the code still
  scans in a rendered preview before printing; fill shapes with even-odd rules (holes in letters, islands in the code).

## 9. Deploying (AWS; any provider with the same four pieces works)

One idempotent script (re-run it to update code or page) that:
1. creates the table (on-demand billing);
2. creates the function's role (read/write that one table, write its logs) and the function (Node.js), with
   environment `TABLE`, `<THING>_KEY`, `ORIGIN_KEY`, `SALT`; gives it a function URL (auth NONE; the origin key guards it);
3. creates a **private** bucket (block public access) and uploads the page files with content types and cache
   headers (HTML `no-cache`; scripts/icons a few minutes to a day);
4. requests a TLS certificate for the site name **in us-east-1** (CloudFront only uses certificates from there),
   validated by DNS;
5. creates the CDN distribution: default behaviour = the bucket through Origin Access Control; `/api/*` = the
   function URL with caching disabled, all methods, the `x-origin-key` header added as a custom origin header,
   query strings and needed headers forwarded;
6. adds the DNS alias for the site name;
7. on every run, invalidates `/*` so new pages and icons show at once.

Practicalities:
- Deploy with a **dedicated least-privilege IAM user**: policy limited to resources named `<project>-*`, and DNS
  changes limited to the one record name (`route53:ChangeResourceRecordSetsNormalizedRecordNames`). Keep the policy
  as a template in the repo with placeholders for the zone id and site name.
- Secrets (shared key, origin key, salt) live only in a local state file with mode 0600 and in the function's
  environment; never in the repo, never in page responses. Generate them on first run.
- The deploy script must not depend on a `zip` program (zip the function with the language runtime).
- Use a profile name, not default credentials; never reuse another service's keys.
- A new distribution takes 5-15 minutes to answer, and DNS propagation can take longer: don't debug before then.

## 10. Testing checklist

- [ ] Local sample site (the function running inside the home app) works end to end before deploying.
- [ ] Two phones: alternate fairly when both line up several; a third newcomer gets in at once.
- [ ] Busy line refuses a phone over its share with a clear message; quiet line doesn't.
- [ ] Rapid tapping doesn't produce "turned away" log entries.
- [ ] Paused / outside hours / owner live mode: page shows the right card and reason; requests refused.
- [ ] Home server stopped: page says offline within ~30 s.
- [ ] Bad words, leetspeak, spaced letters, URLs, phone numbers refused; normal words (class, title) allowed.
- [ ] Nearby only: allowed inside the radius, friendly refusal outside with distance in local units; Safari denied-permission message.
- [ ] iPhone SE and a large phone: one screen, keyboard doesn't hide the message box or the button, no zoom.
- [ ] QR code scans from the printed sign and from a 3D-print preview.
- [ ] Settings responses never include the secret key; public API never includes addresses or others' tickets.
- [ ] Re-running the deploy script changes nothing when nothing changed, and updates code and page when they did.

## 11. Lessons learned

- Poll out from home; don't open ports. 3 s polling is plenty and costs nearly nothing.
- Measure the line in minutes, not requests, and only limit people when it's actually busy.
- Fair order matters more than limits: start-time fair queuing by slot; never let earlier plays count against someone.
- Make "closed" loud and explain why and when it opens; give people something to do meanwhile.
- One phone screen is a hard rule; test the keyboard on a real iPhone.
- Hash addresses with a salt; keep the raw ones nowhere.
- Constant-time compare for every secret; cap every input length; conditional writes everywhere.
- Content-hash the catalog so phones and the cloud only reload it when it changed.
- Invalidate the CDN on every deploy, or icons and pages stay stale for a day.

## 12. Adapting it: what to fill in

| placeholder | in the tree project | yours |
|---|---|---|
| the thing | a 1,000-LED Christmas tree (WLED) | |
| item | a light-show design (name, category, 2 colors) | |
| what a request carries | item id, up to 2 colours, a 24-char message, location | |
| play time per request (`sec`) | 45 s | |
| line length (`lineMin`) | 10 minutes | |
| when it takes requests | while the schedule has it on, not paused, not in live mode | |
| message rules | the thing's 5x7 font characters, 24 chars, word filter | |
| nearby radius | 200 m (off by default) | |
| page name / theme | "Tree-mote Control", retro TV + remote, snow | |
| fun thing while closed | catch-the-presents game | |
| site name | a subdomain like `t.<your domain>` | |
| home app hook points | `designs()`, `getDesign(id)`, `player`, `holdDesign()`, `running()`, `live()`, `scheduleOn()` | |

Ask the coding session to: build the function and page first, run them inside the home app as the local sample,
add the home app's check-in loop and owner settings, then write the deploy script and IAM policy template, and only
then deploy. Keep host names, addresses and keys out of the repository.
