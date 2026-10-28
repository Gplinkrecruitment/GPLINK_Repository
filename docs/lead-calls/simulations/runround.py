# usage: python3 runround.py <round_no> <llm_version> <comma-separated persona keys | half1 | half2 | all>
import json, urllib.request, sys, time, os
K="key_7babd72691896d785143f0e4f00e"; BASE="https://api.retellai.com"; LLM="llm_60e6464643745b072c0df85114d8"
def req(method, path, body=None):
    r=urllib.request.Request(BASE+path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization":"Bearer "+K,"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            raw=resp.read(); return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
rnd, ver, sel = sys.argv[1], int(sys.argv[2]), sys.argv[3]
ids=json.load(open('case_ids.json')); keys=list(ids)
if sel=="half1": chosen=keys[:10]
elif sel=="half2": chosen=keys[10:]
elif sel=="all": chosen=keys
else: chosen=sel.split(',')
s,d=req("POST","/create-batch-test",{"test_case_definition_ids":[ids[k] for k in chosen],"response_engine":{"type":"retell-llm","llm_id":LLM,"version":ver}})
if s not in (200,201): print("batch create failed",s,d); sys.exit(1)
bid=d["test_case_batch_job_id"]; print("round",rnd,"batch",bid,"llm v",ver,"cases",len(chosen),flush=True)
t0=time.time()
while True:
    s,d=req("GET",f"/get-batch-test/{bid}")
    if d.get("status")=="complete": break
    if time.time()-t0>1500: print("timeout waiting"); break
    time.sleep(20)
print(f"done in {time.time()-t0:.0f}s: pass {d.get('pass_count')} fail {d.get('fail_count')} error {d.get('error_count')} / {d.get('total_count')}",flush=True)
runs=[]; pk=None
while True:
    q=f"/v2/list-test-runs/{bid}?limit=50"+(f"&pagination_key={pk}" if pk else "")
    s,d2=req("GET",q); runs+=d2.get("items",[]); 
    if not d2.get("has_more"): break
    pk=d2.get("pagination_key")
os.makedirs(f"r{rnd}",exist_ok=True)
rev={v:k for k,v in ids.items()}
summary=[]
for r in runs:
    s,full=req("GET",f"/get-test-run/{r['test_case_job_id']}")
    key=rev.get(full.get("test_case_definition_id"),"?")
    snap=full.get("transcript_snapshot") or {}
    json.dump(full,open(f"r{rnd}/{key}.json","w"),indent=1)
    lines=[]
    for m in (snap.get("transcript") or snap.get("messages") or snap.get("transcript_object") or []):
        if isinstance(m,dict):
            role=m.get("role"); c=m.get("content") or m.get("arguments") or ""
            if role in ("tool_call_invocation",): lines.append(f"   >> {m.get('name')} {c}")
            elif role in ("tool_call_result",): lines.append(f"   << {str(c)[:120]}")
            else: lines.append(f"{str(role).upper()}: {c}")
    open(f"r{rnd}/{key}.txt","w").write(f"STATUS: {full.get('status')}\nJUDGE: {full.get('result_explanation')}\n\n"+"\n".join(lines))
    summary.append((key,full.get("status")))
print("\n".join(f"  {k}: {st}" for k,st in sorted(summary)))
