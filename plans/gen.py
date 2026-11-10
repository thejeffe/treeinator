import math
S=[]  # helpers
def f(v): return f"{v:.1f}"
def line(x1,y1,x2,y2,c="ln"): return f'<line x1="{f(x1)}" y1="{f(y1)}" x2="{f(x2)}" y2="{f(y2)}" class="{c}"/>'
def rect(x,y,w,h,c="ln"): return f'<rect x="{f(x)}" y="{f(y)}" width="{f(w)}" height="{f(h)}" class="{c}"/>'
def text(x,y,s,a="start",c="t"): return f'<text x="{f(x)}" y="{f(y)}" text-anchor="{a}" class="{c}">{s}</text>'
def dimh(x1,x2,y,lab,ty=None):
    o=[line(x1,y,x2,y,"dm")]
    for x in (x1,x2): o.append(line(x-3,y+3,x+3,y-3,"dm"));o.append(line(x,y-5,x,y+5,"dm thin"))
    o.append(text((x1+x2)/2,(ty if ty else y-5),lab,"middle","dt"));return "".join(o)
def dimv(x,y1,y2,lab,side=1):
    o=[line(x,y1,x,y2,"dm")]
    for y in (y1,y2): o.append(line(x-3,y+3,x+3,y-3,"dm"));o.append(line(x-5,y,x+5,y,"dm thin"))
    o.append(text(x+6*side,(y1+y2)/2+3,lab,"start" if side>0 else "end","dt"));return "".join(o)
def leader(x1,y1,x2,y2,lab,a="start"):
    tx=x1
    return line(x1,y1+3,x2,y2,"ld")+f'<circle cx="{f(x2)}" cy="{f(y2)}" r="1.6" class="dot"/>'+text(tx,y1,lab,a,"lt")

R=24.0; RH=7.0   # hub radius: strips run up the hub edge (Ø14 hub)
run=R-RH
H_RING=1.75; H_DISC_T=102.0; H_DISC_B=100.5; H_RIBTOP=100.5   # hub = two 3/4" discs = 1 1/2"; strips leave the hub at its bottom edge
SPOKE=23.5625  # spoke tip radius (47 1/8" boards); ring centerline at R24 sits against the end grain
vert=H_RIBTOP-H_RING; RIB=math.hypot(vert,run)
STAR_R=11.6; star_r=STAR_R*0.42; PANEL=22.0; PP=2.4; H_STAR=H_DISC_T+14; H_STAR_TOP=H_STAR+PANEL/2
POLE=100.0; PITCH=1.25
angs=[-135+270/19*i for i in range(20)]

def star_pts(cx,cy,Rp,rp):
    p=[]
    for k in range(10):
        a=math.radians(-90+36*k); rr=Rp if k%2==0 else rp
        p.append((cx+rr*math.cos(a),cy+rr*math.sin(a)))
    return p
def inpoly(x,y,P):
    c=False;n=len(P)
    for i in range(n):
        x1,y1=P[i];x2,y2=P[(i+1)%n]
        if (y1>y)!=(y2>y) and x<(x2-x1)*(y-y1)/(y2-y1)+x1: c=not c
    return c
# star grid in inches, star center at 0,0 (y down)
SP=star_pts(0,0,STAR_R,star_r)
SPm=star_pts(0,0.6,STAR_R,star_r)
RINGS=[(2.4,10),(4.8,20),(7.2,30),(9.6,40)]
SPm=star_pts(0,0,10.4,10.4*0.5)
GRID=[];LIT=set();RINGIDX=[]
for ri,(rad,n) in enumerate(RINGS):
    for k in range(n):
        x=rad*math.sin(2*math.pi*k/n); y=-rad*math.cos(2*math.pi*k/n)
        if inpoly(x,y,SPm): LIT.add(len(GRID))
        GRID.append((x,y)); RINGIDX.append(ri)

print("grid holes",len(GRID), "vert",vert,"ribtop",H_RIBTOP,"startop",H_STAR_TOP)

# ---------- D1 front elevation
s=3.0; cx=210; top=H_STAR_TOP+4
Y=lambda h: 24+(top-h)*s
o=[]
gy=Y(0)
o.append(line(20,gy,390,gy,"gr"))
for k in range(9): o.append(line(40+k*40,gy,32+k*40,gy+7,"ln thin"))
# base X front projection
e=SPOKE*math.cos(math.radians(45))
o.append(rect(cx-e*s,Y(3.5),2*e*s,3.5*s,"wood"))
o.append(rect(cx-5*s,Y(6.5),10*s,3*s,"wood"))
# ribs behind (|a|>90) first, dashed
def ribline(a,cls):
    ar=math.radians(a); x1=cx+R*math.sin(ar)*s; x2=cx+RH*math.sin(ar)*s
    return line(x1,Y(H_RING),x2,Y(H_RIBTOP),cls)
for a in angs:
    if abs(a)>90: o.append(ribline(a,"rib hid"))
o.append(rect(cx-0.95*s,Y(POLE),1.9*s,POLE*s,"pvc"))
for a in angs:
    if abs(a)<=90: o.append(ribline(a,"rib")); o.append(ribline(a,"bulb"))
o.append(line(cx-R*s,Y(H_RING),cx+R*s,Y(H_RING),"ring"))
o.append(rect(cx-3*s,Y(H_DISC_B),6*s,0.5*s,"pvc"))
o.append(rect(cx-RH*s,Y(H_DISC_T),2*RH*s,1.5*s,"wood"))
o.append(rect(cx-0.66*s,Y(H_DISC_T+18),1.315*s,18*s,"pvc"))
o.append(f'<circle cx="{cx}" cy="{f(Y(H_STAR))}" r="{f(PANEL/2*s)}" class="panel"/>')
for k,(x,y) in enumerate(GRID): o.append(f'<circle cx="{f(cx+x*s)}" cy="{f(Y(H_STAR)+y*s)}" r="{1.9 if k in LIT else 1.3}" class="{'sb' if k in LIT else 'so'}"/>')
# dims
o.append(dimv(352,Y(H_STAR_TOP),gy,f'{H_STAR_TOP:.0f}"'))

o.append(dimv(305,Y(H_DISC_T),gy,f'{H_DISC_T:.0f}"'))
o.append(text(311,(Y(H_DISC_T)+gy)/2+16,f"{int(H_DISC_T//12)}'-{H_DISC_T%12:.0f}\"","start","dt"))
o.append(dimh(cx-R*s,cx+R*s,gy+22,'Ø48" ring'))
o.append(dimh(cx-PANEL/2*s,cx+PANEL/2*s,Y(H_STAR_TOP)-6,'Ø22"'))
# leaders left
o.append(leader(8,Y(H_STAR)-26,cx-PANEL/2*s,Y(H_STAR)-6,"Star topper · D4"))
o.append(leader(8,Y(H_DISC_T)+16,cx-6*s,Y(H_DISC_T)+1,"Top hub · D3"))
mid=(H_RING+H_RIBTOP)/2; xm=cx-(R+RH)/2*s*math.sin(math.radians(90))
o.append(leader(8,Y(mid)-40,cx-((R-RH)*0.5+RH)*s,Y(mid),"20 pixel strips · D6"))
o.append(leader(8,Y(48),cx-0.95*s,Y(40),"1½\" pole + EMT"))
o.append(leader(8,Y(18),cx-R*0.8*s,Y(H_RING),"½\" PVC ring"))
o.append(text(8,Y(18)+12,"","start","lt"))
o.append(leader(8,gy-8+0,cx-e*s+4,Y(2),"2x4 X base"))
H1=gy+40
D1=f'<svg viewBox="0 0 400 {f(H1)}" role="img" aria-label="Front elevation"><title>Front elevation</title>'+"".join(o)+'</svg>'

# ---------- D2 plan
s=3.3; cx=200; cy=232
o=[]
def P2(r,a):  # a degrees from front (down), + to viewer's right
    ar=math.radians(a); return cx+r*math.sin(ar)*s, cy+r*math.cos(ar)*s
for a in (45,135):  # two boards
    x1,y1=P2(SPOKE,a); x2,y2=P2(SPOKE,a+180)
    ang=math.degrees(math.atan2(y2-y1,x2-x1)); L=2*SPOKE*s
    o.append(f'<rect x="{f(cx-L/2)}" y="{f(cy-0.75*s)}" width="{f(L)}" height="{f(1.5*s)}" class="wood" transform="rotate({f(ang)} {cx} {cy})"/>')
o.append(f'<rect x="{f(cx-1.75*s)}" y="{f(cy-5*s)}" width="{f(3.5*s)}" height="{f(10*s)}" class="wood2"/>')
o.append(f'<circle cx="{cx}" cy="{cy}" r="{f(0.95*s)}" class="pvc"/>')
# ring arc
x1,y1=P2(R,-135); x2,y2=P2(R,135)
o.append(f'<path d="M{f(x1)} {f(y1)} A{f(R*s)} {f(R*s)} 0 1 0 {f(x2)} {f(y2)}" class="ring" fill="none"/>')
# extension 1" overhang ignored visually
for a in (45,135,-45,-135):
    x,y=P2(21,a); o.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="2.6" class="stake"/>')
for i,a in enumerate(angs):
    x,y=P2(R,a); o.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="2.2" class="pt"/>')
    tx,ty=P2(R+5.2,a)
    if i%2==0 or True: o.append(text(tx,ty+3,str(i+1),"middle","nt"))
# guy
gx,gyy=P2(60,180); hx,hy=P2(6.0,180)
o.append(line(hx,hy,gx,gyy+4,"guy"))
o.append(f'<circle cx="{f(gx)}" cy="{f(gyy)}" r="3" class="stake"/>')
o.append(text(gx+8,gyy+4,"Guy stake 60\" back","start","lt"))
o.append(text(cx-8,cy-R*s-8,"Open back","end","lt"))
o.append(text(cx,cy+R*s+42,"FRONT · STREET","middle","lab"))
o.append(line(cx,cy+R*s+20,cx,cy+R*s+28,"ln"))
# dims
o.append(dimv(366,cy,cy+R*s,'R24"',-1))
o.append(text(cx+92,cy+14,"","start","lt"))
o.append(leader(8,cy+R*s+20,P2(21,-45)[0],P2(21,-45)[1],"#4 rebar ×4 at 21\""))
for a in (-90,0,90):   # hold-down staples over the ring, midway between spokes
    hx_,hy_=P2(R,a); ar=math.radians(a); ux,uy=math.sin(ar),math.cos(ar)
    o.append(line(hx_-uy*5-ux*5,hy_+ux*5-uy*5,hx_-uy*5+ux*5,hy_+ux*5+uy*5,"hold")); o.append(line(hx_+uy*5-ux*5,hy_-ux*5-uy*5,hx_+uy*5+ux*5,hy_-ux*5+uy*5,"hold"))
o.append(leader(262,cy+R*s+30,P2(R,0)[0]+5,P2(R,0)[1]+3,"Ring hold-down ×3"))
# inset: ring on the outside of a spoke end (side view)
k=12.0; ix,iy=22,26
o.append(text(ix-10,iy-8,"RING AT SPOKE END","start","lab"))
o.append(rect(ix,iy,4.0*k,3.5*k,"wood"))                                  # 2x4 on edge, end on the right
o.append(f'<circle cx="{f(ix+4.0*k+0.42*k)}" cy="{f(iy+1.75*k)}" r="{f(0.42*k)}" class="pvc"/>')
px=ix+4.0*k; pr=0.42*k
o.append(f'<path d="M{f(px)} {f(iy+1.75*k-pr-6)} L{f(px+pr*0.5)} {f(iy+1.75*k-pr-1)} A{f(pr+1)} {f(pr+1)} 0 0 1 {f(px+pr*0.5)} {f(iy+1.75*k+pr+1)} L{f(px)} {f(iy+1.75*k+pr+6)}" class="zipl" fill="none"/>')
o.append(f'<circle cx="{f(px-2)}" cy="{f(iy+1.75*k-pr-6)}" r="1.6" class="dot"/><circle cx="{f(px-2)}" cy="{f(iy+1.75*k+pr+6)}" r="1.6" class="dot"/>')
o.append(text(ix-10,iy+3.5*k+16,"Strap ring to end grain","start","lt"))
o.append(text(ix-10,iy+3.5*k+30,"Center 1¾\" up, at R24\"","start","lt"))
H2=cy+R*s+54
D2=f'<svg viewBox="0 0 400 {f(H2)}" role="img" aria-label="Plan view of base"><title>Base plan</title>'+"".join(o)+'</svg>'

# ---------- D3 hub section (front-back cut, front to the left) + hub plan
s=13; cx=190; htop=H_DISC_T+5; hbot=H_DISC_B-8
Y=lambda h: 30+(htop-h)*s
o=[]
pb=Y(hbot); pt=Y(POLE)
o.append(rect(cx-0.95*s,pt,1.9*s,pb-pt,"pvc")); o.append(rect(cx-0.805*s,pt,1.61*s,pb-pt,"bore"))
et=Y(POLE-1)
o.append(rect(cx-0.755*s,et,1.51*s,pb-et,"metal")); o.append(rect(cx-0.69*s,et,1.38*s,pb-et,"bore"))
sb=Y(hbot); stt=Y(htop)
o.append(rect(cx-0.6575*s,stt,1.315*s,sb-stt,"pvc2"))
o.append(rect(cx-3*s,Y(H_DISC_B),6*s,0.45*s,"pvc"))
o.append(rect(cx-1.25*s,Y(H_DISC_B-0.45),2.5*s,1.4*s,"pvc"))
o.append(rect(cx-0.95*s,Y(H_DISC_B-0.45),1.9*s,1.4*s,"pvc"))
for top in (H_DISC_T,H_DISC_T-0.75):
    o.append(rect(cx-RH*s,Y(top),(RH-0.66)*s,0.75*s,"wood"))
    o.append(rect(cx+0.66*s,Y(top),(RH-0.66)*s,0.75*s,"wood"))
for bx in (-2.2,2.2): o.append(rect(cx+bx*s-1.5,Y(H_DISC_T)-3,3,(1.5+0.45)*s+6,"bolt"))
# front strip: up the hub edge, over the top, screw + washer
ang=math.atan2(run,vert); dx=-math.sin(ang); dy=math.cos(ang)
ex0=cx-RH*s-2
pts=[(ex0+dx*8*s,Y(H_DISC_B)+dy*8*s),(ex0,Y(H_DISC_B)),(ex0,Y(H_DISC_T)-2),(cx-(RH-1.0)*s,Y(H_DISC_T)-2)]
o.append('<polyline points="'+" ".join(f"{f(a)},{f(b)}" for a,b in pts)+'" class="stripl" fill="none"/>')
scx=cx-(RH-0.6)*s
o.append(rect(scx-0.375*s,Y(H_DISC_T)-6,0.75*s,2.5,"washer")); o.append(line(scx,Y(H_DISC_T)-6,scx,Y(H_DISC_T-1.25),"shank"))
nxp,nyp=-math.cos(ang),-math.sin(ang)
for dist in (1,3,5,7):
    px0,py0=ex0+dx*dist*s,Y(H_DISC_B)+dy*dist*s
    o.append(line(px0,py0,px0+nxp*0.8*s,py0+nyp*0.8*s,"pixel"))
# guy eye at the back
gex,gey=cx+(RH-1.0)*s,Y(H_DISC_B)
o.append(line(gex,gey,gex,gey+6,"ln")); o.append(f'<circle cx="{f(gex)}" cy="{f(gey+10)}" r="4" class="eye"/>')
o.append(line(gex+3,gey+13,gex+55,gey+65,"guy"))
for yb in (pb,stt): o.append(f'<path d="M{cx-22} {f(yb)} l8 -4 l6 8 l8 -4" class="ln"/>')
def bal(bx,by,px,py,n):
    return line(bx,by,px,py,"ld")+f'<circle cx="{f(px)}" cy="{f(py)}" r="1.6" class="dot"/><circle cx="{f(bx)}" cy="{f(by)}" r="9" class="bal"/>'+text(bx,by+3.5,str(n),"middle","bn")
o.append(bal(22,Y(H_DISC_T)-30,scx,Y(H_DISC_T)-6,3))
o.append(bal(22,Y(H_DISC_T)+4,cx-3.5*s,Y(H_DISC_T-0.4),1))
o.append(bal(22,Y(H_DISC_B)+40,ex0+dx*4*s,Y(H_DISC_B)+dy*4*s,2))
o.append(bal(378,Y(htop)+10,cx+0.66*s,Y(htop-1.4),4))
o.append(bal(378,Y(H_DISC_B)+12,cx+2.6*s,Y(H_DISC_B-0.2),5))
o.append(bal(378,Y(POLE-3.5),cx+0.95*s,Y(POLE-4),6))
o.append(bal(378,Y(POLE-6),cx+0.72*s,Y(POLE-6.5),7))
o.append(bal(330,Y(H_DISC_B)+36,gex+4,gey+10,8))
o.append(text(20,14,"← FRONT (STREET)","start","lab"))
o.append(text(380,14,"BACK →","end","lab"))
# ---- hub plan: 20 strip tails screwed to the top face
k=10.0; pcx=cx; pcy=pb+40+RH*k+6
o.append(text(20,pb+28,"HUB FROM ABOVE","start","lab"))
o.append(f'<circle cx="{f(pcx)}" cy="{f(pcy)}" r="{f(RH*k)}" class="wood"/>')
def PP(r,a): ar=math.radians(a); return pcx+r*math.sin(ar)*k, pcy+r*math.cos(ar)*k
for a in angs:
    ar=math.radians(a); ux,uy=math.sin(ar),math.cos(ar); vx,vy=uy,-ux; hw=0.59
    q=[(pcx+(RH*ux+hw*vx)*k,pcy+(RH*uy+hw*vy)*k),(pcx+(RH*ux-hw*vx)*k,pcy+(RH*uy-hw*vy)*k),(pcx+((RH-1)*ux-hw*vx)*k,pcy+((RH-1)*uy-hw*vy)*k),(pcx+((RH-1)*ux+hw*vx)*k,pcy+((RH-1)*uy+hw*vy)*k)]
    o.append('<polygon points="'+" ".join(f"{f(x)},{f(y)}" for x,y in q)+'" class="strip"/>')
    x,y=PP(RH-0.6,a); o.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="3.6" class="washer"/><circle cx="{f(x)}" cy="{f(y)}" r="1.4" class="screw"/>')
o.append(f'<circle cx="{f(pcx)}" cy="{f(pcy)}" r="{f(0.66*k)}" class="pvc2"/>')
gxe,gye=PP(RH-1.0,180); o.append(f'<circle cx="{f(gxe)}" cy="{f(gye)}" r="3" class="eye"/>')
lx,ly=PP(RH-0.5,95); o.append(leader(268,ly-34,lx,ly,"Strip tail, 1\""))
sx,sy=PP(RH-0.6,angs[13]); o.append(leader(268,sy+10,sx,sy,"Screw + washer"))
o.append(leader(20,gye-10,gxe,gye,"Guy eye"))
o.append(text(pcx,pcy+RH*k+24,"FRONT · STREET","middle","lab"))
H3=pcy+RH*k+36
D3=f'<svg viewBox="0 0 400 {f(H3)}" role="img" aria-label="Top hub section"><title>Top hub section</title>'+"".join(o)+'</svg>'

# ---------- D4 panel
s=13.0; cx=200; cy=34+PANEL/2*s
o=[]
o.append(line(cx,cy-10*s,cx,cy+10*s,"frame")); o.append(line(cx-10*s,cy,cx+10*s,cy,"frame"))
o.append(f'<circle cx="{cx}" cy="{f(cy)}" r="{f(PANEL/2*s)}" class="panel"/>')
for rad,n in RINGS: o.append(f'<circle cx="{cx}" cy="{f(cy)}" r="{f(rad*s)}" class="rg"/>')
P=star_pts(cx,cy+0.6*s,STAR_R*s,star_r*s)
for k,(x,y) in enumerate(GRID): o.append(f'<circle cx="{f(cx+x*s)}" cy="{f(cy+y*s)}" r="{5 if k in LIT else 3.2}" class="{'sb' if k in LIT else 'so'}"/>')
o.append(dimh(cx-PANEL/2*s,cx+PANEL/2*s,cy+PANEL/2*s+20,'Ø22" disc'))
o.append(dimv(cx+PANEL/2*s+12,cy,cy-9.6*s,'R9.6"'))
o.append(text(8,cy+PANEL/2*s+46,f'4 rings: 10 + 20 + 30 + 40 = {len(GRID)} · {len(LIT)} lit',"start","lt"))
H4=cy+PANEL/2*s+58
D4=f'<svg viewBox="0 0 400 {f(H4)}" role="img" aria-label="Pixel panel layout"><title>Pixel panel layout</title>'+"".join(o)+'</svg>'

# ---------- D5 side elevation (guy)
s=2.1; cx=150; top=H_STAR_TOP+4
Y=lambda h: 18+(top-h)*s
o=[]; gy=Y(0)
o.append(line(10,gy,390,gy,"gr"))
o.append(rect(cx-SPOKE*0.7071*s,Y(3.5),2*SPOKE*0.7071*s,3.5*s,"wood"))
for a in (0,45,90,135):
    ar=math.radians(a)
    o.append(line(cx-R*math.cos(ar)*s,Y(H_RING),cx-RH*math.cos(ar)*s,Y(H_RIBTOP),"rib"+(" hid" if a>90 else "")))
o.append(rect(cx-0.95*s,Y(POLE),1.9*s,POLE*s,"pvc"))
o.append(rect(cx-RH*s,Y(H_DISC_T),2*RH*s,1.5*s,"wood"))
o.append(line(cx,Y(H_DISC_T),cx,Y(H_DISC_T+18),"ln"))
o.append(rect(cx-1.5*s,Y(H_STAR_TOP),1.5*s,PANEL*s,"star"))
gx=cx+60*s
o.append(line(cx+RH*s,Y(H_DISC_B)+2,gx,gy,"guy"))
o.append(line(gx,gy,gx-6,gy+14,"ln"))
o.append(dimh(cx,gx,gy+24,'60"'))
L=math.hypot(60-RH,H_DISC_B)
o.append(text(cx+40*s,Y(52),f'Guy ≈{L:.0f}" + turnbuckle',"start","lt"))
o.append(text(cx-24*s-4,gy+40,"← STREET","start","lab"))
o.append(dimv(36,gy,Y(POLE),'100"'))                     # grade to top of pole
o.append(text(42,(gy+Y(POLE))/2+17,"pole","start","dt"))
o.append(line(36,Y(POLE),cx-1,Y(POLE),"ld"))
o.append(dimv(cx+16,Y(H_DISC_T),Y(H_DISC_T+18),'18" stub'))
H5=gy+50
D5=f'<svg viewBox="0 0 400 {f(H5)}" role="img" aria-label="Side elevation with guy line"><title>Side elevation</title>'+"".join(o)+'</svg>'

# ---------- D6 strip ends (side views, street to the left)
s=18.0; o=[]
ang=math.atan2(run,vert); dx=-math.sin(ang); dy=math.cos(ang); nxp,nyp=-math.cos(ang),-math.sin(ang)
o.append(text(105,22,"TOP: SCREWED TO HUB","middle","lab")); o.append(text(312,22,"BOTTOM: WRAPS RING","middle","lab"))
o.append(line(214,30,214,250,"ld"))
# top end
Ax,Ht=150,58; Hb=Ht+1.5*s
o.append(rect(Ax,Ht,206-Ax,1.5*s,"wood")); o.append(line(Ax,Ht+0.75*s,206,Ht+0.75*s,"ln thin"))
Ls=7.4
pts=[(Ax-2+dx*Ls*s,Hb+dy*Ls*s),(Ax-2,Hb),(Ax-2,Ht-2),(Ax+1.0*s,Ht-2)]
o.append('<polyline points="'+" ".join(f"{f(a)},{f(b)}" for a,b in pts)+'" class="stripl" fill="none"/>')
scx=Ax+0.6*s
o.append(rect(scx-0.375*s,Ht-7,0.75*s,3,"washer")); o.append(line(scx,Ht-7,scx,Ht+1.25*s,"shank"))
P=[]
for dist in (1,3,5,7):
    px0,py0=Ax-2+dx*dist*s,Hb+dy*dist*s
    o.append(line(px0,py0,px0+nxp*0.85*s,py0+nyp*0.85*s,"pixel")); P.append((px0,py0))
o.append(leader(8,Ht-14,scx-8,Ht-6,"#10 × 1¼\" + washer"))
o.append(leader(8,Ht+16,Ax-3,Ht+0.75*s,"Over hub edge"))
o.append(leader(8,Hb+30,P[0][0]+nxp*0.85*s,P[0][1]+nyp*0.85*s,"Pixel 1 (1\" down)"))
o.append(dimv(198,Ht,Hb,'1½"',-1))
o.append(dimv(Ax+14,P[1][1],P[2][1],'2"'))
o.append(dimv(Ax+14,P[2][1],P[3][1],'2"'))
# bottom end
Bx,By=318,196; pr=0.42*s; ra=pr+2; L2=7.6
sx0,sy0=Bx-dx*L2*s,By-ra-dy*L2*s
o.append(f'<path d="M{f(sx0)} {f(sy0)} L{f(Bx)} {f(By-ra)} A{f(ra)} {f(ra)} 0 0 0 {f(Bx-ra)} {f(By)} A{f(ra)} {f(ra)} 0 0 0 {f(Bx)} {f(By+ra)}" class="stripl" fill="none"/>')
o.append(f'<circle cx="{f(Bx)}" cy="{f(By)}" r="{f(pr)}" class="pvc"/>')
o.append(rect(Bx-ra-6,By-0.375*s,3,0.75*s,"washer")); o.append(line(Bx-ra-6,By,Bx-2,By,"shank"))
Q=[]
for dist in (1.6,3.6,5.6):
    px0,py0=Bx-dx*dist*s,By-ra-dy*dist*s
    o.append(line(px0,py0,px0+nxp*0.85*s,py0+nyp*0.85*s,"pixel")); Q.append((px0,py0))
o.append(leader(396,Q[1][1]-24,Q[0][0]+4,Q[0][1],"Pixel 50","end"))
o.append(leader(396,By-6,Bx+pr,By,"½\" ring","end"))
o.append(text(Bx-6,By+pr+20,"#8 × ½\" + washer","middle","lt"))
o.append(text(Bx-6,By+pr+34,"into the side of the ring","middle","lt"))
H6=By+pr+60
o.append(text(8,H6-8,'Strip: 105 holes · ~100" free span · 50 pixels',"start","lt"))
D6=f'<svg viewBox="0 0 400 {f(H6)}" role="img" aria-label="Strip end details"><title>Strip ends</title>'+"".join(o)+'</svg>'

ring_marks=[1+i*(2*math.pi*R*0.75)/19 for i in range(20)]
import json
json.dump({"D6":D6,"D1":D1,"D2":D2,"D3":D3,"D4":D4,"D5":D5,"angs":angs,"marks":ring_marks,"holes":len(GRID),"vert":vert,"startop":H_STAR_TOP,"disct":H_DISC_T,"guy":L,"ribang":math.degrees(ang),"rib":RIB,"starR":STAR_R,"lit":len(LIT),"px":len(GRID)},open("/home/claude/tree/svgs.json","w"))
