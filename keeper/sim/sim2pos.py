"""Two-position (base + limit) vault simulator for fold-at-balance evaluation.

Models the live keeper mechanics: mult-16 base and limit, re-center trigger
(660tk/30min/6h), limit refresh (120tk outside/30min/shared 6h), and optional
fold-at-balance variants. Oracle series = real DIA tape; pool price chases the
oracle with a 0.3% fee dead-band; fees accrue on input volume across whichever
positions the crossing traverses. Rebalances never swap: base minted to the
scarce side at the current price, surplus to a one-sided 960-tick limit.
"""
import json, math

FEE=0.003; SPACING=60; HALF=960; TRIG=660; REFRESH_T=120; DWELL_S=1800; COOL=6*3600
LOG=math.log(1.0001)
tick=lambda p: math.log(p*1e8)/LOG
px=lambda t: 1.0001**t*1e-8
sq=lambda t: 1.0001**(t/2)
align=lambda t: round(t/SPACING)*SPACING

class Pos:
    __slots__=("L","a","b")
    def __init__(self,L=0.0,a=0,b=0): self.L,self.a,self.b=L,a,b
    def amounts(self,s):     # returns (aDOT_raw/1e10-units human, HOLLAR human)
        if self.L==0: return 0.0,0.0
        sc=min(max(s,sq(self.a)),sq(self.b))
        x=self.L*(1/sc-1/sq(self.b))/1e10        # human aDOT (10 dec)
        y=self.L*(sc-sq(self.a))/1e18            # human HOLLAR (18 dec)
        return x,y
    def value(self,s,P):
        x,y=self.amounts(s); return x*P+y

def mint_base(x,y,t,a,b):
    """L for two-sided mint at price-tick t constrained by the scarce side; returns (L, used_x, used_y)."""
    s=min(max(sq(t),sq(a)),sq(b))
    xr=(1/s-1/sq(b))/1e10; yr=(s-sq(a))/1e18
    if xr<=0: L=y/yr if yr>0 else 0
    elif yr<=0: L=x/xr
    else: L=min(x/xr if xr>0 else 1e30, y/yr if yr>0 else 1e30)
    return L, L*xr, L*yr

def mint_limit(x,y,t,P):
    """Surplus single-sided 960-tick limit adjacent to tick t. Returns Pos."""
    if x*P>=y and x>1e-9:
        lo=align(t)+SPACING; hi=lo+HALF
        L=x*1e10/(1/sq(lo)-1/sq(hi))
        return Pos(L,lo,hi),0.0,y   # leftover y stays idle
    if y>1e-9:
        hi=align(t)-SPACING; lo=hi-HALF
        L=y*1e18/(sq(hi)-sq(lo))
        return Pos(L,lo,hi),x,0.0
    return Pos(),x,y

def legratio(d,w):
    """Value ratio token0:token1 a band [t-d, t+w] wants at its placement tick t
    (PR7's legValueRatio, float domain)."""
    kd=1.0001**(d/2); kw=1.0001**(w/2)
    return (kw-1)/kw/((kd-1)/kd)

def skewed(t, share0, minleg=8*SPACING, maxratio=8.0):
    """PR7's skewedBand: rotate [t-d, t+w] at fixed total width 2*HALF so the
    band's own preferred ratio matches the vault's share0; legs floored at
    `minleg`, wanted ratio capped at `maxratio`. Bisection on legratio."""
    TOTAL=2*HALF
    if not (share0==share0): return (align(t)-HALF, align(t)+HALF)
    s=min(max(share0,0),1)
    wanted=maxratio if s>=1 else min(max(s/(1-s),1/maxratio),maxratio)
    lo,hi=minleg,TOTAL-minleg
    if wanted>=legratio(lo,TOTAL-lo): d=lo
    elif wanted<=legratio(hi,TOTAL-hi): d=hi
    else:
        a,b=lo,hi
        for _ in range(80):
            m=(a+b)/2
            if legratio(m,TOTAL-m)>wanted: a=m
            else: b=m
        d=(a+b)/2
    dT=round(d); wT=2*HALF-dT
    fl=lambda x: math.floor(x/SPACING)*SPACING
    ce=lambda x: math.ceil(x/SPACING)*SPACING
    return (fl(t-dT), ce(t+wT))

def run(series, fold=False, confirm=False, fold_frac=0.40, skew=False):
    P0=series[0]['price']; T0=series[0]['t']
    V0=100_000.0
    if skew:
        ba,bb=skewed(tick(P0),0.5); base=Pos(0,ba,bb)
    else:
        mid=align(tick(P0)); base=Pos(0,mid-HALF,mid+HALF)
    L,ux,uy=mint_base(V0/2/P0, V0/2, tick(P0), base.a, base.b); base.L=L
    limit,ix,iy=mint_limit(V0/2/P0-ux, V0/2-uy, tick(P0), P0)
    idle=[ix,iy]
    s_pool=sq(tick(P0)); fees=0.0; vol=0.0
    last_reb=-1e18; dw=dwr=dwf=0; n_rec=n_ref=n_fold=0
    tw_base=0.0; tw=0.0; prev_t=T0
    for i in range(1,len(series)):
        P=series[i]['price']; t=series[i]['t']; tk=tick(P); dt=t-series[i-1]['t']
        # --- pool chases oracle with fee dead-band across both positions ---
        if abs(math.log((s_pool**2)*1e-8/ (P*1e-8*1e8) if False else (s_pool**2)/(P*1e8)))>FEE:
            tgt=sq(tick(P*math.exp(-FEE)) if s_pool**2<P*1e8 else tick(P*math.exp(FEE)))
            for pos in (base,limit):
                if pos.L==0: continue
                x1,y1=pos.amounts(s_pool); x2,y2=pos.amounts(tgt)
                if tgt>s_pool: inp=(y2-y1)          # HOLLAR in
                else: inp=(x2-x1)*P                  # aDOT in, valued
                if inp>0: fees+=inp*FEE; vol+=inp
            s_pool=tgt
        # --- time-weighted base share ---
        vb=base.value(s_pool,P); vl=limit.value(s_pool,P)+idle[0]*P+idle[1]
        tot=vb+vl
        tw_base+=vb/tot*dt if tot>0 else 0; tw+=dt
        # --- triggers ---
        drift=abs(tk-(base.a+base.b)/2)
        rec = drift>TRIG
        away = (limit.a - tk) if tk<limit.a else (tk-limit.b) if tk>limit.b else 0
        ref = (limit.L>0) and (not rec) and away>REFRESH_T
        fx,fy=limit.amounts(s_pool)
        lv=fx*P+fy
        minshare = min(fx*P,fy)/lv if lv>1 else 0
        fold_ok = fold and (limit.L>0) and (not rec) and (not ref) and minshare>=fold_frac
        if fold_ok and confirm:
            # confirmation: last-30min move heads back toward band mid
            j=i
            while j>0 and t-series[j]['t']<1800: j-=1
            toward = abs(tick(series[j]['price'])-(base.a+base.b)/2) > abs(tk-(base.a+base.b)/2)
            fold_ok = toward
        dw  = dw+1  if rec else 0
        dwr = dwr+1 if ref else 0
        dwf = dwf+1 if fold_ok else 0
        # dwell measured in samples; series ~15min → 2 samples ≈ 30 min
        def cooled(): return t-last_reb>=COOL
        act=None
        if rec and dw>=2 and cooled(): act='rec'
        elif ref and dwr>=2 and cooled(): act='ref'
        elif fold_ok and dwf>=2 and cooled(): act='fold'
        if act:
            bx,by=base.amounts(s_pool); lx,ly=limit.amounts(s_pool)
            x=bx+lx+idle[0]; y=by+ly+idle[1]
            share0=x*P/(x*P+y) if x*P+y>0 else 0.5
            if act=='rec':
                if skew: ba,bb=skewed(tk,share0); base=Pos(0,ba,bb)
                else: m=align(tk); base=Pos(0,m-HALF,m+HALF)
                n_rec+=1
            else:
                # refresh keeps the base ticks; a fold does too, except under
                # skew where the re-place re-derives the rotation (variant E)
                if act=='fold' and skew: ba,bb=skewed(tk,share0); base=Pos(0,ba,bb)
                else: base=Pos(0,base.a,base.b)
                n_ref+= act=='ref'; n_fold+= act=='fold'
            L,ux,uy=mint_base(x,y,tk,base.a,base.b); base.L=L
            limit,ix,iy=mint_limit(x-ux,y-uy,tk,P)
            idle=[ix,iy]
            s_pool=sq(tk); last_reb=t; dw=dwr=dwf=0
    Pend=series[-1]['price']
    end=base.value(s_pool,Pend)+limit.value(s_pool,Pend)+idle[0]*Pend+idle[1]+fees
    hodl=50_000+50_000/P0*Pend
    days=(series[-1]['t']-T0)/86400
    return dict(end=end,hodl=hodl,vs_hodl=end/hodl-1,vs_start=end/1e5-1,fees=fees,
                rec=n_rec,ref=n_ref,fold=n_fold,base_share=tw_base/tw,days=days,
                P0=P0,Pend=Pend)

def report(fname,label):
    d=json.load(open(fname))
    print(f"\n=== {label}: DOT {d[0]['price']:.4f}->{d[-1]['price']:.4f} ({(d[-1]['price']/d[0]['price']-1)*100:+.1f}%), {(d[-1]['t']-d[0]['t'])/86400:.1f}d ===")
    for name,kw in [("A: current (recenter+refresh)",dict()),
                    ("B: + fold-at-balance",dict(fold=True)),
                    ("C: + fold w/ confirmation",dict(fold=True,confirm=True)),
                    ("D: inventory-skewed base (PR7)",dict(skew=True)),
                    ("E: skew + fold",dict(skew=True,fold=True))]:
        r=run(d,**kw)
        print(f"{name:31s} rec {r['rec']:2d} ref {r['ref']:2d} fold {r['fold']:2d} | fees ${r['fees']:>7,.0f} | base-share {r['base_share']*100:4.1f}% | end ${r['end']:>9,.0f} | vs HODL {r['vs_hodl']*100:+6.2f}%")
    r=run(d)
    print(f"{'50/50 HODL':31s}{'':46s}${r['hodl']:>9,.0f}")

if __name__=='__main__':
    report('dia_true.json','30d whipsaw (Jul27-Aug26)')
    report('dia_true_90d.json','90d bear+bounce (May28-Aug26)')
    report('dia_live_tape.json','launch tape (Aug29-Sep16)')
