import json, urllib.request, time
RPC="https://rpc.hydradx.cloud"; FEED="0xFBCa0A6dC5B74C042DF23025D99ef0F1fcAC6702"
HDRS={'content-type':'application/json','user-agent':'curl/8.5.0'}
def rpc(calls,retries=5):
    for a in range(retries):
        try:
            req=urllib.request.Request(RPC,data=json.dumps(calls).encode(),headers=HDRS)
            return json.load(urllib.request.urlopen(req,timeout=120))
        except Exception:
            if a==retries-1: raise
            time.sleep(3*(a+1))
head=rpc([{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",False]}])[0]['result']
HEAD=int(head['number'],16); T_HEAD=int(head['timestamp'],16)
def blk_ts(b): return int(rpc([{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":[hex(b),False]}])[0]['result']['timestamp'],16)
TARGET=1788000000  # 2026-09-09 ~04:40 UTC, just after pool seeding
lo,hi=13800000,HEAD
while hi-lo>1:
    mid=(lo+hi)//2
    if blk_ts(mid)<TARGET: lo=mid
    else: hi=mid
START=hi; N=800
blocks=[START+int((HEAD-START)*i/N) for i in range(N+1)]
prices=[]
for i in range(0,len(blocks),25):
    ch=blocks[i:i+25]
    res=rpc([{"jsonrpc":"2.0","id":j,"method":"eth_call","params":[{"to":FEED,"data":"0x50d25bcd"},hex(b)]} for j,b in enumerate(ch)])
    res.sort(key=lambda r:r['id'])
    for b,r in zip(ch,res): prices.append((b,int(r['result'],16)/1e8 if r.get('result') else None))
    time.sleep(0.05)
anchors={}
tsb=blocks[::20]+[blocks[-1]]
for i in range(0,len(tsb),25):
    ch=tsb[i:i+25]
    res=rpc([{"jsonrpc":"2.0","id":j,"method":"eth_getBlockByNumber","params":[hex(b),False]} for j,b in enumerate(ch)])
    res.sort(key=lambda r:r['id'])
    for b,r in zip(ch,res): anchors[b]=int(r['result']['timestamp'],16)
    time.sleep(0.05)
import bisect
ab=sorted(anchors)
def ts(b):
    if b in anchors: return anchors[b]
    i=bisect.bisect_left(ab,b); lo2,hi2=ab[max(0,i-1)],ab[min(len(ab)-1,i)]
    if hi2==lo2: return anchors[lo2]
    return anchors[lo2]+(anchors[hi2]-anchors[lo2])*(b-lo2)/(hi2-lo2)
out=[{"block":b,"t":ts(b),"price":p} for b,p in prices if p]
json.dump(out,open("dia_live_tape.json","w"))
print("done",len(out),"| span days",(out[-1]['t']-out[0]['t'])/86400,"|",out[0]['price'],"->",out[-1]['price'],"| min",min(o['price'] for o in out),"max",max(o['price'] for o in out))
