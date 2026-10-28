import json, wave, sys, numpy as np, glob
CONFIG={0:"orig clone, v4_turbo, t1.0",5:"orig clone, v4_turbo, t1.0",6:"Zee-copy clone, v4_turbo, t1.0",10:"Zee-copy clone, v4_turbo, t1.0",
        24:"Zee-copy clone, v4_turbo, t1.0",30:"lossless clone, v3_conv, t1.3",31:"lossless clone, v3_conv, t1.3",33:"clean clone, v3_conv, t0.8",
        35:"clean clone, multiling_v2, t1.2",41:"levelled clone, multiling_v2, t0.9",42:"levelled clone, multiling_v2, t0.9"}
def f0(frame, sr):
    frame=frame-frame.mean()
    if np.sqrt((frame**2).mean())<200: return None
    ac=np.correlate(frame,frame,'full')[len(frame)-1:]
    lo,hi=int(sr/400),int(sr/120)
    if hi>=len(ac): return None
    lag=lo+np.argmax(ac[lo:hi]); 
    if ac[lag]<0.35*ac[0]: return None
    return sr/lag
rows=[]
for jf in sorted(glob.glob('call_*.json')):
    c=jf[:-5]; d=json.load(open(jf)); v=d.get('agent_version')
    try: w=wave.open(c+'.wav')
    except: continue
    sr=w.getframerate(); ch=w.getnchannels(); x=np.frombuffer(w.readframes(w.getnframes()),dtype=np.int16).reshape(-1,ch).astype(float)
    # find agent channel: energy during agent words
    ag=[u for u in d.get('transcript_object') or [] if u['role']=='agent' and u.get('words')]
    if not ag: continue
    def seg_energy(chn):
        e=0
        for u in ag[:6]:
            a,b=int(u['words'][0]['start']*sr),int(u['words'][-1]['end']*sr); e+=np.sqrt((x[a:b,chn]**2).mean()+1e-9)
        return e
    chn=max(range(ch),key=seg_energy); sig=x[:,chn]
    # split agent turns into sentences by punctuation on words
    sents=[]
    for u in ag:
        cur=[]
        for wd in u['words']:
            cur.append(wd)
            if wd['word'].strip().endswith(('.','?','!')):
                sents.append(cur); cur=[]
        if cur: sents.append(cur)
    db=[];pitch=[];jumps_db=[];jumps_pt=[];within=[]
    prev=None
    for s in sents:
        a,b=int(s[0]['start']*sr),int(s[-1]['end']*sr)
        if b-a<sr*0.6: continue
        seg=sig[a:b]; frame=int(0.04*sr); hop=int(0.02*sr)
        frms=[seg[i:i+frame] for i in range(0,len(seg)-frame,hop)]
        rms=[np.sqrt((f**2).mean()) for f in frms]; voiced=[r for r in rms if r>200]
        if len(voiced)<10: continue
        L=20*np.log10(np.median(voiced)/32768)
        ps=[p for p in (f0(f,sr) for f in frms) if p]
        if len(ps)<8: continue
        P=12*np.log2(np.median(ps)/200)  # semitones re 200 Hz
        wv=np.std(12*np.log2(np.array(ps)/200))
        db.append(L); pitch.append(P); within.append(wv)
        if prev is not None and prev[2] is u: pass
        if prev is not None: jumps_db.append(abs(L-prev[0])); jumps_pt.append(abs(P-prev[1]))
        prev=(L,P,u)
    if len(db)<4: continue
    rows.append((v,CONFIG.get(v,"?"),len(db),np.std(db),np.mean(jumps_db),np.std(pitch),np.mean(jumps_pt),np.mean(within),np.median(pitch)))
print(f"{'ver':>3} {'config':38} {'sents':>5} | loud sd dB | loud jump dB | pitch sd st | pitch jump st | in-sent pitch sd | median pitch st")
for r in sorted(rows):
    print(f"{r[0]:>3} {r[1]:38} {r[2]:>5} | {r[3]:10.2f} | {r[4]:12.2f} | {r[5]:11.2f} | {r[6]:13.2f} | {r[7]:16.2f} | {r[8]:6.2f}")
