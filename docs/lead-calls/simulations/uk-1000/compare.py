# usage: python3 -I compare.py <tagA> <tagB>   -> side-by-side quality metrics for two result tags in results2.jsonl / runs2/
import json, glob, re, sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run2 import bookable, tools_called
HERE=os.path.dirname(os.path.abspath(__file__))
FILL=re.compile(r"\b(fair enough|fair challenge|fair question|fair point|that's fair|good question|great question|good one|absolutely|I won't guess|I can't|I don't have)\b",re.I)
LEAK=re.compile(r"\b(tool|knowledge base|background (notes|material)|instruction|my notes say|cut-?off|three-month window|I've already used|don't-know|rule)\b",re.I)
ECHO=re.compile(r"^(so you're|so you|right, so you|okay, so you|got it, so)",re.I)
def metrics(tag):
    rows=[json.loads(l) for l in open(os.path.join(HERE,'results2.jsonl')) if json.loads(l).get('tag')==tag]
    files=glob.glob(os.path.join(HERE,f"runs2/*-{tag}.json"))
    m=collections.Counter(); sb=0;b=0;nf=0;nfl=0;lost=0;turns=0;longt=0;calls=0
    for f in files:
        d=json.load(open(f)); key=os.path.basename(f).split('-v4')[0]; calls+=1
        ts=d['transcript_snapshot']['transcript']; names=[n for n,_ in tools_called(d['transcript_snapshot'])]
        for x in ts:
            if x.get('role')=='agent':
                c=x['content']; turns+=1
                if len(re.findall(r'[.!?]+',c))>3: longt+=1
                for w in FILL.findall(c): m['filler:'+w.lower()]+=1
                if LEAK.search(c): m['leak']+=1
                if ECHO.search(c.strip()): m['echo-opener']+=1
        if bookable(key):
            if '-none_fit' in key: nf+=1; nfl+=('send_booking_link' in names or 'book_consult' in names)
            else:
                sb+=1; b+=('book_consult' in names)
                if 'book_consult' not in names and 'send_booking_link' not in names: lost+=1
    p=sum(r['status']=='pass' for r in rows); e=sum(r['status']=='error' for r in rows)
    return dict(calls=calls,judge_pass=p,errors=e,should_book=sb,booked=b,lost_entirely=lost,link_wanters=nf,link_ok=nfl,agent_turns=turns,long_turns=longt,
                filler=sum(v for k,v in m.items() if k.startswith('filler:') and 'can' not in k and 'have' not in k and 'guess' not in k),
                i_cant=m["filler:i can't"], leak=m['leak'], echo_opener=m['echo-opener'])
a,bt=sys.argv[1],sys.argv[2]; A=metrics(a); B=metrics(bt)
print(f"{'metric':<16}{a:>14}{bt:>14}")
for k in A: print(f"{k:<16}{str(A[k]):>14}{str(B[k]):>14}")
