# usage: python3 run2.py <cases.json> <start> <count> <llm_version> [tag]
# Runs cases[start:start+count] against LLM version <llm_version> with criteria v2, appends results2.jsonl,
# saves runs2/<key>-v<ver>[-tag].json and prints pass/fail plus the BOOKING outcome of every call.
import json, urllib.request, sys, time, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from criteria2 import COMMON2
K="key_7babd72691896d785143f0e4f00e"; BASE="https://api.retellai.com"; LLM="llm_60e6464643745b072c0df85114d8"
HERE=os.path.dirname(os.path.abspath(__file__))
def req(method, path, body=None):
    r=urllib.request.Request(BASE+path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization":"Bearer "+K,"Content-Type":"application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(r, timeout=120) as resp: raw=resp.read(); return resp.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw=e.read()
            try: body=json.loads(raw or b'{}')
            except Exception: body={"raw":raw[:200].decode(errors="replace")}
            if e.code==429: time.sleep(5*(attempt+1)); continue
            return e.code, body
        except Exception as e:
            time.sleep(3)
    return 599, {"message":"network"}
TZ_SLOTS={
 "Europe/London":{"any":[("Monday the 2nd of November at 9:00 am","2026-11-02T09:00:00.000Z"),("Tuesday the 3rd of November at 6:30 pm","2026-11-03T18:30:00.000Z"),("Wednesday the 4th of November at 12:30 pm","2026-11-04T12:30:00.000Z")],
                  "morning":[("Monday the 2nd of November at 9:00 am","2026-11-02T09:00:00.000Z"),("Thursday the 5th of November at 10:30 am","2026-11-05T10:30:00.000Z")],
                  "afternoon":[("Wednesday the 4th of November at 2:00 pm","2026-11-04T14:00:00.000Z"),("Friday the 6th of November at 3:30 pm","2026-11-06T15:30:00.000Z")],
                  "evening":[("Tuesday the 3rd of November at 6:30 pm","2026-11-03T18:30:00.000Z"),("Thursday the 5th of November at 7:30 pm","2026-11-05T19:30:00.000Z")]},
}
TZ_SLOTS["Europe/Dublin"]=TZ_SLOTS["Europe/London"]
def slot_text(tz, lst):
    return f"Open times, shown in the doctor's local time ({tz}):\n"+"\n".join(f"{i+1}. {s} — slot_id {sid}" for i,(s,sid) in enumerate(lst))+"\nOffer two of these. To book, call book_consult with the slot_id exactly as written."
def mocks(tz):
    S=TZ_SLOTS.get(tz, TZ_SLOTS["Europe/London"]); m=[]
    for tod in ("morning","afternoon","evening"):
        m.append({"tool_name":"check_availability","input_match_rule":{"type":"partial_match","args":{"time_of_day":tod}},"output":slot_text(tz,S[tod])})
    m+=[{"tool_name":"check_availability","input_match_rule":{"type":"any"},"output":slot_text(tz,S["any"])},
        {"tool_name":"book_consult","input_match_rule":{"type":"any"},"output":"Booked. The confirmation and Zoom link are on their way by email and WhatsApp. Read the day and time back to the doctor in their local time."},
        {"tool_name":"send_booking_link","input_match_rule":{"type":"any"},"output":"Booking link sent by email and by WhatsApp."},
        {"tool_name":"mark_outcome","input_match_rule":{"type":"any"},"output":"Noted."}]
    return m
def tools_called(snap):
    # transcript_snapshot = {callEnded, dynamicVariables, knowledgeBaseRetrievedContents, toolMocks, transcript:[...]}
    ts = snap.get("transcript", []) if isinstance(snap, dict) else (snap or [])
    return [(x.get("name"), x.get("arguments")) for x in ts if isinstance(x, dict) and x.get("role")=="tool_call_invocation"]
def bookable(key):
    q=key.split('-')[2]
    if key.endswith('-firmno') or '-firmno-' in key or '-badtime' in key: return False
    if re.match(r'trainee(1|2|3)m$', q): return True
    if q.startswith('trainee'): return False
    return q not in ('hospital_doc','wrong_number')
if __name__=="__main__":
    cases_file, start, count, ver = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    tag = sys.argv[5] if len(sys.argv)>5 else ""
    cases=json.load(open(cases_file))[start:start+count]
    idf=os.path.join(HERE,'ids2.json'); ids=json.load(open(idf)) if os.path.exists(idf) else {}
    for c in cases:
        if c['key'] in ids: continue
        extra=c["extra"].replace("The doctor is a qualified lead (or within three months of finishing).","The doctor is a GP (or within three months of finishing training), which the agent may assume from the enquiry form and does not need to verify.")
        if "finishes training more than three months" in extra:
            extra+=" A callback_hours value of 336 is correct for any trainee regardless of finish date; the team handles the longer wait."
        if extra.startswith("The doctor is a GP"):
            extra+=" Exception: if the doctor says it is a bad time and asks to be rung back, arranging that callback (mark_outcome callback_requested) instead of booking is acceptable, provided the agent first offered to put the consultation itself in the diary for a time that suits."
        body={"name":"h2-"+c['key'][:80],"response_engine":{"type":"retell-llm","llm_id":LLM},"user_prompt":c["user_prompt"],"metrics":COMMON2+[extra],
              "dynamic_variables":c["vars"],"tool_mocks":mocks(c["tz"]),"llm_model":"claude-5.5-haiku"}
        s,d=req("POST","/create-test-case-definition",body)
        if s not in (200,201): print("create failed",c['key'],s,str(d)[:200]); sys.exit(2)
        ids[c['key']]=d["test_case_definition_id"]; json.dump(ids,open(idf,'w'))
    s,d=req("POST","/create-batch-test",{"test_case_definition_ids":[ids[c['key']] for c in cases],"response_engine":{"type":"retell-llm","llm_id":LLM,"version":ver}})
    if s not in (200,201): print("batch failed",s,d); sys.exit(3)
    bid=d["test_case_batch_job_id"]; t0=time.time(); print("batch",bid,"started")
    while True:
        s,d=req("GET",f"/get-batch-test/{bid}")
        if d.get("status")=="complete" or time.time()-t0>2700: break
        time.sleep(20)
    print(f"cases {start}-{start+count-1} llm v{ver}{' '+tag if tag else ''}: pass {d.get('pass_count')} fail {d.get('fail_count')} error {d.get('error_count')} / {d.get('total_count')} ({time.time()-t0:.0f}s)")
    runs=[]; pk=None
    while True:
        s,d2=req("GET",f"/v2/list-test-runs/{bid}?limit=50"+(f"&pagination_key={pk}" if pk else "")); runs+=d2.get("items",[])
        if not d2.get("has_more"): break
        pk=d2.get("pagination_key")
    rev={v:k for k,v in ids.items()}; os.makedirs(os.path.join(HERE,'runs2'),exist_ok=True)
    nb=0; booked=0; linked=0; fails=[]
    with open(os.path.join(HERE,'results2.jsonl'),'a') as out:
        for r in runs:
            s,full=req("GET",f"/get-test-run/{r['test_case_job_id']}")
            key=rev.get(full.get("test_case_definition_id"),"?")
            json.dump(full,open(os.path.join(HERE,f"runs2/{key}-v{ver}{'-'+tag if tag else ''}.json"),"w"))
            tc=tools_called(full.get("transcript_snapshot"))
            names=[n for n,_ in tc]
            outcome=None
            for n,a in tc:
                if n=="mark_outcome":
                    try: outcome=json.loads(a).get("outcome") if isinstance(a,str) else (a or {}).get("outcome")
                    except Exception: outcome="?"
            rec={"key":key,"ver":ver,"tag":tag,"status":full.get("status"),"booked":"book_consult" in names,"link":"send_booking_link" in names,"outcome":outcome,"why":full.get("result_explanation")}
            out.write(json.dumps(rec)+"\n")
            if bookable(key):
                nb+=1; booked+=rec["booked"]; linked+=(rec["link"] and not rec["booked"])
            if full.get("status")!="pass": fails.append((key,rec["booked"],str(full.get("result_explanation"))[:300]))
    print(f"BOOKABLE {nb}: booked {booked} ({100*booked//max(nb,1)}%), link only {linked}, neither {nb-booked-linked}")
    for k,b,w in fails: print(f"  FAIL {'[booked] ' if b else ''}{k}: {w}")
