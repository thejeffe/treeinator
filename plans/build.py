import json,math
d=json.load(open("svgs.json"))
marks=d["marks"]; angs=d["angs"]
rows="".join(f'<tr><td>{i+1}</td><td>{a:+.1f}°</td><td>{m:.2f}"</td><td>{6.4*math.sin(math.radians(a)):+.2f}" / {6.4*math.cos(math.radians(a)):.2f}"</td></tr>' for i,(a,m) in enumerate(zip(angs,marks)))
def tbl(head,body):
    return '<div class="tw"><table><thead><tr>'+"".join(f"<th>{h}</th>" for h in head)+'</tr></thead><tbody>'+"".join("<tr>"+"".join(f"<td>{c}</td>" for c in r)+"</tr>" for r in body)+'</tbody></table></div>'
H=["Mark","Qty","Part","Cut","Notes"]
wood=[["B1","2","2x4, on edge","47⅛\"","Half-lap notch 1½\" W × 1¾\" D centered at 23⁹⁄₁₆\". Notch one board on top edge, one on bottom. Ends cut square: the ring straps to them."],
["B2","2","2x4, flat","10\"","Glue + screw into one 3\"-thick block. Center on the X, drill 2\" hole through block and lap."],
["B3","2","¾\" exterior ply disc","Ø14\"","Glue and screw the two together into one 1½\" hub. 1⅜\" center hole, 4 holes to match the flange. Mark the 20 strip positions around the edge (rib layout table)."]]
pipe=[["P1","1","1½\" Sch 40 PVC pole","99\"","Dry-fit first; trim so the hub top lands at 101\"."],
["P2","1","1¼\" EMT core","98\"","Slides inside P1, flush at bottom, ends 1\" below pole top. Deburr both ends."],
["P3","1","1\" Sch 40 PVC star stub","39\"","18\" into EMT, 3\" through flange and hub, 18\" exposed."],
["S2","20","Pixel mounting strip, 30 mm","105 holes","Cut midway between holes. Pixels go in holes 4, 6, 8 … 102. Holes 1–3 run up the hub edge and over the top; holes 103–105 wrap the ring. See D6."],
["P5","1","½\" Sch 40 PVC ring","115\"","270° arc at R24\", strapped to the outside ends of the spokes at mid-height (center 1¾\" up). 1\" overhang past each back spoke. Heat-gun bend or spring it into the straps."],
["P6","4","½\" PVC panel frame arms","9\"","From the second ½\" stick, into a ½\" 4-way cross. The down arm clamps to P3 with two hose clamps."],
["S1","1","4 mm coroplast disc","Ø22\"","100 holes on 4 rings (table below). Drill to fit the bulb or pixel (test one)."]]
hw=[["1","Screw eye, #10 × 1¼\" zinc","Guy line, under the back of the hub"],
["1","Heavy-duty tent stake, 10–12\"","Center pin: the pole and EMT slide down over it"],
["20","#10 × 1¼\" stainless pan-head screw + 1\" fender washer","Strip top tails to the hub top, 0.6\" in from the edge"],
["20","#8 × ½\" stainless pan-head screw + ⅝\" washer","Strip bottom tails into the side of the ring (pre-drill ⅛\")"],
["3","Landscape staple, 6\", or #4 rebar U-hook","Ring hold-downs midway between spokes"],
["1","1½\" PVC slip flange","Glued to pole top, bolted under disc"],
["4","¼-20 × 2½\" bolt, nut, 2 washers","Flange to the 1½\" hub"],
["1","½\" PVC 4-way cross","Panel frame hub"],
["5","#4 rebar, 18\"","4 base stakes at 21\" + 1 guy stake"],
["4","½\" two-hole conduit strap + #8 × 1½\" screws","Ring to the spoke ends; pre-drill the end grain"],
["2","Stainless hose clamp, 1¾–2¾\" range","Panel frame to stub"],
["12 ft","⅛\" vinyl-coated cable","Guy line"],
["1 set","¼\" turnbuckle, 2 thimbles, 4 cable clips","Guy line"],
["~100","UV-black zip ties, 8\"","Pixel string slack behind the strips, topper wiring"],
["~16","3\" exterior screws + Titebond III","Base laminations"],
["—","PVC primer + cement, exterior paint","Paint PVC to slow UV creep"],
["22","50-light strands","20 tree + 2 topper"]]
buy=[["2","Pixel mounting strip, 50 m roll, 1\" hole spacing, 12 mm","S2 ×20 (2,100 holes; one roll is about 2,000)"],
["2","2x4 × 8'","A: B1 + B2 + B2 · B: B1"],["1","¾\" ext. ply, 2'×4'","B3 ×2"],["1","1½\" Sch 40 PVC, 10'","P1"],["1","1¼\" EMT, 10'","P2"],["1","1\" Sch 40 PVC, 5'","P3"],["2","½\" Sch 40 PVC, 10'","P5, P6 ×4"],["1","4 mm coroplast, 24×24","S1"]]
steps=["Cut and half-lap the two B1 spokes into an X. Glue and screw. Laminate the B2 block, screw it to the X center, and drill the 2\" pole socket straight through.",
"Drill 5/8\" stake holes 21\" from center on each spoke.",
"Cut the ring P5 at 115\". Mark the 20 rib positions from the left end (table below). Strap the ring to the outside end of each of the four spokes, centered on the 2x4\'s height (D2 inset).",
"Make the hub: glue and screw the two B3 discs together. Mark the 20 strip positions around the edge (rib layout table) and put the guy eye under the back at a 6\" radius. Bolt the flange underneath.",
"Cut the pole and EMT. Slide the EMT in flush at the bottom. Dry-fit the flange and disc, check the 102\" height, then glue the flange.",
"Cut 20 strips of 105 holes. Push one 50-pixel string into holes 4, 6, 8 … 102 of each and tuck the extra wire behind. On odd ribs (1, 3, 5 …) the string's input end goes at the bottom (hole 102); on even ribs it goes at the top (hole 4), so data snakes up one strip and down the next.",
"On site: drive the tent stake at the tree's center, leaving about 4\" above grade. Set the base over it with the open side facing the house, drive the four rebar stakes, and slide the pole down over the tent stake.",
"Hang strips: lay the top tail up the hub edge and over the top at its mark, then drive a #10 screw with a fender washer through it 0.6\" in from the edge. Pull the strip down to its ring mark, wrap it over the outside half of the ring, and drive a #8 screw with a washer into the side of the ring. Make it snug, not drum-tight. Alternate left and right sides so the pole stays plumb. Drive the three ring hold-downs midway between the spokes.",
"Drive the guy stake 60\" behind center. Run the cable to the back eye and snug the turnbuckle until the pole is plumb.",
"Build the topper on the bench: scribe the four rings with a string compass, mark holes from 12 o'clock, push the lights through, route the wiring on the back, and zip-tie the panel to the PVC cross. Push the stub 18\" into the EMT and clamp the down arm to it with two hose clamps."]
html=f'''<title>Treeinator Drawing Package</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a drawing set; title block, then sheets (drawings) and schedules stacked; two columns on wide screens */
:root{{--paper:#EEF1F4;--sheet:#FFFFFF;--ink:#1B2836;--muted:#5B6B7B;--rule:#CBD4DD;--dim:#2A6AA3;--amber:#C27400;--amber-soft:#FBE7C2;--wood:#E6C796;--wood2:#D6B27A;--metal:#A8B3BE;--bore:#EEF1F4;--pvc:#FFFFFF;--strip:#2A3038;--gold:#D4A23A;
--display:"Barlow Condensed","Arial Narrow",sans-serif;--body:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--paper:#0D141B;--sheet:#131D27;--ink:#DCE5EE;--muted:#90A2B4;--rule:#2A3949;--dim:#70B1EA;--amber:#F2B33D;--amber-soft:#4B3512;--wood:#7C5D36;--wood2:#8E6B3E;--metal:#5A6672;--bore:#0D141B;--pvc:#1D2A37;--strip:#2A3644;--gold:#C9952C;color-scheme:dark}}}}
:root[data-theme="dark"]{{--paper:#0D141B;--sheet:#131D27;--ink:#DCE5EE;--muted:#90A2B4;--rule:#2A3949;--dim:#70B1EA;--amber:#F2B33D;--amber-soft:#4B3512;--wood:#7C5D36;--wood2:#8E6B3E;--metal:#5A6672;--bore:#0D141B;--pvc:#1D2A37;--strip:#2A3644;--gold:#C9952C;color-scheme:dark}}
body{{background:var(--paper);color:var(--ink);font:15px/1.55 var(--body)}}
.wrap{{max-width:1040px;margin:0 auto;padding-block:20px 48px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:20px}}
h1,h2{{font-family:var(--display);font-weight:600;letter-spacing:.01em;text-wrap:balance;margin:0}}
h1{{font-size:clamp(30px,6vw,44px);line-height:1}}
h2{{font-size:22px}}
.ts{{background:var(--sheet);border:2px solid var(--ink);outline:1px solid var(--ink);outline-offset:3px;margin:4px;display:grid}}
.ts-co{{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:14px 16px;border-bottom:2px solid var(--ink)}}
.mark{{width:46px;height:46px}}
.m-nut{{fill:var(--gold);stroke:var(--ink);stroke-width:2}} .m-ridge{{fill:none;stroke:var(--ink);stroke-width:2}} .m-ridge.thin{{stroke-width:1.2}}
.co{{font:600 26px/1 var(--display);letter-spacing:.22em}}
.co-sub{{font:500 10.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-top:5px}}
.pkg{{text-align:right;display:grid;gap:3px}} .pkg span{{font:500 10px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}} .pkg b{{font:500 15px var(--mono)}}
.ts-title{{padding:18px 16px 16px;border-bottom:2px solid var(--ink)}}
.ts-title h1{{font-size:clamp(38px,8vw,64px);letter-spacing:.14em;line-height:1;margin-top:4px}}
.ts-grid{{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:2px solid var(--ink)}}
.ts-grid>div{{padding:7px 10px;border-right:1px solid var(--ink);border-bottom:1px solid var(--ink);min-width:0;margin:0 -1px -1px 0}}
.ts-foot{{display:grid;grid-template-columns:minmax(0,2fr) repeat(3,minmax(0,1fr))}}
.ts-foot>div{{padding:8px 10px;border-right:1px solid var(--ink);min-width:0}} .ts-foot>div:last-child{{border-right:0}}
.tol p{{margin:4px 0 0;font-size:12px;line-height:1.45}}
.sig{{display:grid;grid-template-columns:auto 1fr;gap:6px 8px;align-content:start}} .sig span{{border-bottom:1px solid var(--ink);height:16px}}
.proj{{display:flex;align-items:center;gap:6px}} .proj svg{{width:36px;height:16px}} .pj{{fill:none;stroke:var(--ink);stroke-width:1.4}} .pjc{{stroke:var(--ink);stroke-width:.6;stroke-dasharray:4 2}}
.revs .fine{{margin:10px 0 0;font:400 11px var(--mono);color:var(--muted)}}
@media (max-width:640px){{.ts-grid{{grid-template-columns:repeat(2,minmax(0,1fr))}} .ts-co{{grid-template-columns:auto 1fr}} .pkg{{grid-column:1/-1;text-align:left}} .ts-foot{{grid-template-columns:1fr 1fr}} .tol{{grid-column:1/-1;border-right:0!important;border-bottom:1px solid var(--ink)}}}}
.k{{font:500 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}}
.v{{font:500 14px var(--mono);font-variant-numeric:tabular-nums}}
.sub{{color:var(--muted);margin:6px 0 0;max-width:62ch}}
.grid{{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr))}}
figure{{margin:0;background:var(--sheet);border:1px solid var(--rule);display:flex;flex-direction:column;min-width:0}}
figcaption{{display:flex;gap:10px;align-items:baseline;padding:10px 14px;border-bottom:1px solid var(--rule)}}
figcaption b{{font:600 13px var(--mono);color:var(--amber)}}
figcaption span{{font-family:var(--display);font-size:19px;font-weight:600}}
figcaption em{{margin-left:auto;font:400 11px var(--mono);color:var(--muted);font-style:normal}}
figure svg{{display:block;width:100%;height:auto;padding:8px;box-sizing:border-box}}
figure p{{margin:0;padding:0 14px 14px;color:var(--muted);font-size:13.5px}}
section{{background:var(--sheet);border:1px solid var(--rule);padding:16px 16px 18px;min-width:0}}
section>h2{{margin-bottom:10px}}
.tw{{overflow-x:auto}}
table{{border-collapse:collapse;width:100%;font-size:13.5px}}
th{{text-align:left;font:500 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:1.5px solid var(--ink);padding:6px 8px}}
td{{border-bottom:1px solid var(--rule);padding:7px 8px;vertical-align:top}}
td:first-child{{font:500 13px var(--mono);white-space:nowrap}}
td:nth-child(2),td:nth-child(4){{font-variant-numeric:tabular-nums}}
.cut td:nth-child(4){{font:500 13px var(--mono);white-space:nowrap;color:var(--dim)}}
.marks td{{font-family:var(--mono);font-size:12.5px}}
ol{{margin:0;padding-left:22px;display:grid;gap:8px;max-width:72ch}}
.note{{border-left:3px solid var(--amber);border-radius:0;background:var(--amber-soft);padding:10px 14px;font-size:14px}}
.note b{{font-weight:500}}
/* svg */
.ln{{stroke:var(--ink);stroke-width:1;fill:none}} .thin{{stroke-width:.5}} .gr{{stroke:var(--ink);stroke-width:1.3}}
.hid{{stroke-dasharray:4 3;opacity:.5}}
.rib{{stroke:var(--ink);stroke-width:.9;fill:none}}
.bulb{{stroke:var(--amber);stroke-width:2.6;stroke-linecap:round;stroke-dasharray:.01 5.6;fill:none}}
.ring{{stroke:var(--ink);stroke-width:2.6;fill:none}}
.wood{{fill:var(--wood);stroke:var(--ink);stroke-width:.8}} .wood2{{fill:var(--wood2);stroke:var(--ink);stroke-width:.8}}
.pvc{{fill:var(--pvc);stroke:var(--ink);stroke-width:.8}} .pvc2{{fill:var(--pvc);stroke:var(--dim);stroke-width:.9}}
.metal{{fill:var(--metal);stroke:var(--ink);stroke-width:.6}} .bore{{fill:var(--bore);stroke:none}} .bore2{{fill:var(--sheet);stroke:var(--ink);stroke-width:.7}}
.bolt{{fill:var(--muted);stroke:none}} .eye{{fill:none;stroke:var(--ink);stroke-width:1.2}} .zip{{fill:none;stroke:var(--amber);stroke-width:1.2}}
.panel{{fill:var(--sheet);stroke:var(--ink);stroke-width:1.2}} .so{{fill:var(--rule)}} .rg{{fill:none;stroke:var(--rule);stroke-width:.8}} .ghost{{fill:none;stroke:var(--amber);stroke-width:.8;stroke-dasharray:3 3;opacity:.7}}
.star{{fill:var(--amber-soft);stroke:var(--amber);stroke-width:1.2}} .sb{{fill:var(--amber)}}
.frame{{stroke:var(--muted);stroke-width:5;stroke-dasharray:6 4;opacity:.55}} .fit{{fill:none;stroke:var(--muted);stroke-width:1}}
.dm{{stroke:var(--dim);stroke-width:.8;fill:none}} .ld{{stroke:var(--muted);stroke-width:.6;fill:none}} .dot{{fill:var(--muted)}}
.guy{{stroke:var(--dim);stroke-width:1.1;stroke-dasharray:6 3;fill:none}}
.strip{{fill:var(--strip);stroke:var(--ink);stroke-width:.6}} .hole{{fill:var(--sheet);stroke:var(--ink);stroke-width:.6}} .zipl{{stroke:var(--amber);stroke-width:1.6}} .saddle{{fill:var(--sheet);stroke:var(--ink);stroke-width:.8}}
.band{{fill:none;stroke:var(--strip);stroke-width:4}} .screw{{fill:var(--amber);stroke:var(--ink);stroke-width:.6}} .stripl{{stroke:var(--strip);stroke-width:4}}
.washer{{fill:var(--metal);stroke:var(--ink);stroke-width:.6}} .shank{{stroke:var(--ink);stroke-width:1.6}} .pixel{{stroke:var(--amber);stroke-width:6;stroke-linecap:round}} .hold{{stroke:var(--ink);stroke-width:1.6}}
.stake{{fill:var(--sheet);stroke:var(--ink);stroke-width:1.2}} .pt{{fill:var(--amber)}}
.t,.lt,.dt,.nt,.lab{{font-family:var(--mono)}}
.lt{{fill:var(--ink);font-size:10.5px}} .dt{{fill:var(--dim);font-size:10.5px;font-weight:500}} .nt{{fill:var(--muted);font-size:8.5px}}
.lab{{fill:var(--muted);font-size:10px;letter-spacing:.12em}}
.bal{{fill:var(--sheet);stroke:var(--ink);stroke-width:1}} .bn{{fill:var(--ink);font-family:var(--mono);font-size:10px;font-weight:500}}
.legend{{margin:0;padding:0 14px 14px 34px;font-size:13.5px;display:grid;gap:3px}}
/* Print: letter pages, light ink, one drawing per block, nothing split mid-row or mid-line */
@page{{size:letter;margin:0.5in}}
@media print{{
:root:not([data-theme="light"]),:root[data-theme]{{--paper:#FFFFFF;--sheet:#FFFFFF;--ink:#111A24;--muted:#4A5866;--rule:#B8C2CC;--dim:#1F5E99;--amber:#B06A00;--amber-soft:#FBE7C2;--wood:#E6C796;--wood2:#D6B27A;--metal:#A8B3BE;--bore:#FFFFFF;--pvc:#FFFFFF;--strip:#2A3038;--gold:#D4A23A;color-scheme:light}}
html,body{{background:#fff!important}}
*{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.wrap{{max-width:none;padding:0!important;gap:14px}}
.grid{{display:block}}
.grid>*{{margin-bottom:14px}}
figure,section,.note,.ts{{break-inside:avoid;page-break-inside:avoid}}
section.cut,section.marks{{break-inside:auto;page-break-inside:auto}}
figure svg{{width:auto;max-width:100%;max-height:7.6in;margin:0 auto}}
figure:has(ol.legend) svg{{max-height:6.3in}}
.legend{{font-size:11.5px;gap:1px}}
figcaption,h2{{break-after:avoid;page-break-after:avoid}}
.revs{{break-after:page;page-break-after:always}}
.ts{{margin-top:0}}
.tw{{overflow:visible}}
table{{font-size:11px}}
thead{{display:table-header-group}}
tr,li,p{{break-inside:avoid;page-break-inside:avoid}}
td{{padding:5px 6px}}
.cut td:nth-child(4),td:first-child{{white-space:normal}}
}}
</style>
<div class="wrap">
<header class="ts" aria-label="Title block">
 <div class="ts-co">
  <svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><ellipse cx="32" cy="32" rx="17" ry="27" class="m-nut"/><path d="M32 6 C26 20 26 44 32 58 M32 6 C38 20 38 44 32 58" class="m-ridge"/><path d="M22 18 C27 22 27 28 22 32 M42 18 C37 22 37 28 42 32 M22 36 C27 40 27 46 22 50 M42 36 C37 40 37 46 42 50" class="m-ridge thin"/></svg>
  <div><div class="co">GOLDEN PECAN</div><div class="co-sub">Mechanical Design &amp; Fabrication</div></div>
  <div class="pkg"><span>Drawing package</span><b>GP-TRE-001</b></div>
 </div>
 <div class="ts-title">
  <div class="k">Project</div>
  <h1>TREEINATOR</h1>
  <p class="sub">Illuminated light cone tree: general arrangement, details, and fabrication schedules. 20 pixel strips over a 270° arc on a Ø48" base, with a Ø22" concentric-ring pixel topper.</p>
 </div>
 <div class="ts-grid">
  <div><div class="k">Drawing no.</div><div class="v">GP-TRE-001</div></div>
  <div><div class="k">Revision</div><div class="v">I</div></div>
  <div><div class="k">Date</div><div class="v">2026-10-24</div></div>
  <div><div class="k">Scale</div><div class="v">NTS</div></div>
  <div><div class="k">Units</div><div class="v">Inches</div></div>
  <div><div class="k">Projection</div><div class="v proj"><svg viewBox="0 0 44 20" aria-label="Third-angle projection"><circle cx="34" cy="10" r="7" class="pj"/><circle cx="34" cy="10" r="3" class="pj"/><path d="M2 5 L18 2 L18 18 L2 15 Z" class="pj"/><line x1="0" y1="10" x2="44" y2="10" class="pjc"/></svg>3rd angle</div></div>
  <div><div class="k">Pixels</div><div class="v">1,000 + 100</div></div>
  <div><div class="k">Hub height</div><div class="v">102" · 8'-6"</div></div>
  <div><div class="k">Overall height</div><div class="v">{d["startop"]:.0f}" · {int(d["startop"]//12)}'-{d["startop"]%12:.0f}"</div></div>
  <div><div class="k">Base</div><div class="v">Ø48" · 270°</div></div>
 </div>
 <div class="ts-foot">
  <div class="tol"><div class="k">Unless otherwise specified</div><p>Dimensions in inches. Tolerances: fractional ±⅛", angular ±1°. Break sharp edges. Exterior-rated materials and stainless fasteners throughout. Do not scale drawings.</p></div>
  <div class="sig"><div class="k">Drawn</div><span></span><div class="k">Date</div><span></span></div>
  <div class="sig"><div class="k">Checked</div><span></span><div class="k">Date</div><span></span></div>
  <div class="sig"><div class="k">Approved</div><span></span><div class="k">Date</div><span></span></div>
 </div>
</header>

<div class="note"><b>Check before cutting:</b> the strips are the ribs, held by one screw at the hub and one at the ring. Pixels sit in every other hole, 2" apart, so a 50-pixel string spans 98". Your bullet strings need at least 2" of wire between pixels; 8 cm strings leave about 1.2" of slack per gap to tuck behind the strip. Measure one string before cutting strips.</div>

<section class="revs"><h2>Revision history</h2>
<div class="tw"><table><thead><tr><th>Rev</th><th>Description</th></tr></thead><tbody>
<tr><td>A</td><td>Initial general arrangement: 20 ribs over 270°, Ø48" base, star topper</td></tr>
<tr><td>B</td><td>Hub height set to 8'-0"; star reduced to 24"</td></tr>
<tr><td>C–E</td><td>Topper developed from square panel to Ø22" four-ring pixel disc</td></tr>
<tr><td>F</td><td>Pixel mounting strip adopted; 2" pixel pitch; rib and strip detail added</td></tr>
<tr><td>G</td><td>Ring relocated to outside of spoke ends; spokes shortened to 47⅛"</td></tr>
<tr><td>H</td><td>Hub edge notches with strap band (superseded by I)</td></tr>
<tr><td>I</td><td>Strips become the ribs, screwed at hub and ring; Ø14" hub; ring hold-downs added</td></tr>
</tbody></table></div>
<p class="fine">© 2026 Golden Pecan. Prepared for the Treeinator build.</p></section>



<div class="grid">
<figure><figcaption><b>D1</b><span>Front elevation</span><em>from street</em></figcaption>{d["D1"]}<p>Strips behind the pole are dashed. Strip tilt is {d["ribang"]:.1f}° from vertical.</p></figure>
<figure><figcaption><b>D2</b><span>Base plan</span><em>from above</em></figcaption>{d["D2"]}<p>X base rotated 45° so the back spoke tips mark the ends of the arc. The ring wraps the outside of the spoke ends (inset). Numbers are rib positions.</p></figure>
<figure><figcaption><b>D3</b><span>Top hub section</span><em>front–back cut</em></figcaption>{d["D3"]}<ol class="legend"><li>Hub: two ¾" ply discs, Ø14", glued into 1½"</li><li>Pixel strip runs up the hub edge and over the top</li><li>#10 × 1¼" screw and fender washer through the strip tail</li><li>1" PVC star stub, 18" down into the EMT</li><li>1½" PVC slip flange, 4× ¼-20 × 2½" bolts</li><li>1½" Sch 40 PVC pole</li><li>1¼" EMT core, ends 1" below pole top</li><li>Guy eye, under the back of the hub</li></ol><p>The strips pull the hub toward the street and down; the guy line at the back balances them. Load path: strips → hub → flange → pole + EMT → ground, with the tent stake pinning the pole bottom.</p></figure>
<figure><figcaption><b>D4</b><span>Ring topper</span><em>face view, star lit</em></figcaption>{d["D4"]}<p>Every ring holds a multiple of 10 pixels, all starting at 12 o'clock, so the five star points land on a pixel in every ring. Arc spacing is the same 1.51" on all rings. Strand 1: ring 1 + ring 4 (10 + 40). Strand 2: rings 2 + 3 (20 + 30).</p></figure>
<figure><figcaption><b>D6</b><span>Strip ends</span><em>side views</em></figcaption>{d["D6"]}<p>Each strip runs up the hub edge and over the top, where one screw and washer hold it. At the bottom it wraps the outside half of the ring and screws into the pipe. Pixels sit in every other hole, 2" apart. The strips are held only at their ends, so keep them snug rather than tight.</p></figure>
<figure><figcaption><b>D5</b><span>Side elevation</span><em>guy line</em></figcaption>{d["D5"]}<p>The pole runs 100" from grade (it stands on the ground over the center tent stake) to its top, under the hub flange; the hub top is at 102". The 1" stub rises 18" above the hub to carry the topper. Nothing pulls from the open back, so the guy carries wind and keeps the pole plumb.</p></figure>
<section><h2>Drawing a design</h2>
<p style="margin:0 0 10px">The tree is a 20-column × 50-row grid: 1,000 pixels. Columns are the ribs; rows are bulb heights.</p>
<ul style="margin:0;padding-left:20px;display:grid;gap:6px">
<li>Row pitch is exactly 2" along each rib, set by the strip holes, so every rib's rows line up without measuring.</li>
<li>Column pitch shrinks going up: about 6" apart at the ring, 1.4" at the hub. Lay out art on a fan-shaped grid, not a square one, or shapes will pinch toward the top.</li>
</ul></section>
</div>

<section class="cut"><h2>Cut sheet · wood</h2>{tbl(H,wood)}</section>
<section class="cut"><h2>Cut sheet · pipe &amp; star</h2>{tbl(H,pipe)}</section>
<div class="grid">
<section><h2>Hardware</h2>{tbl(["Qty","Item","Use"],hw)}</section>
<section><h2>Buy list</h2>{tbl(["Qty","Stock","Yields"],buy)}
<p style="margin:14px 0 0;color:var(--muted);font-size:13.5px">Estimated weight: about 45 lb total, about 30 lb above the base. The pole sees mostly wind load, not weight.</p></section>
</div>
<section class="marks"><h2>Rib layout</h2><p style="margin:0 0 10px;color:var(--muted)">Angle is from the street centerline, + to the right as you face the tree. Ring mark is measured along the ring from its left end. Hub screw is where the strip's top screw goes, X (right) / Y (toward street) from the hub center. Ring mark is also where the bottom screw goes.</p>
<div class="tw"><table><thead><tr><th>Rib</th><th>Angle</th><th>Ring mark</th><th>Hub screw X / Y</th></tr></thead><tbody>{rows}</tbody></table></div>
<p style="margin:10px 0 0;color:var(--muted);font-size:13.5px">Guy eye: X 0, Y −6.00" (straight back, under the hub).</p></section>
<section><h2>Topper hole layout</h2><p style="margin:0 0 10px;color:var(--muted)">Start every ring at 12 o'clock and step clockwise. The first hole of each ring lines up on the same vertical line.</p>
<div class="tw"><table><thead><tr><th>Ring</th><th>Radius</th><th>Holes</th><th>Step</th><th>Arc spacing</th></tr></thead><tbody>
<tr><td>1</td><td>2.4"</td><td>10</td><td>36°</td><td>1.51"</td></tr><tr><td>2</td><td>4.8"</td><td>20</td><td>18°</td><td>1.51"</td></tr><tr><td>3</td><td>7.2"</td><td>30</td><td>12°</td><td>1.51"</td></tr><tr><td>4</td><td>9.6"</td><td>40</td><td>9°</td><td>1.51"</td></tr></tbody></table></div></section>
<section><h2>Assembly order</h2><ol>{"".join(f"<li>{s}</li>" for s in steps)}</ol></section>
</div>'''
open("light-cone-tree.html","w").write(html)
print(len(html))
