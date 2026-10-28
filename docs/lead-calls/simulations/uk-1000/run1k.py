# usage: python3 run1k.py <start> <count> <llm_version>   -> runs cases[start:start+count], appends results.jsonl, prints failures
import json, urllib.request, sys, time, os
sys.path.insert(0,'/Users/gplinkrecruitment/.claude/jobs/daeb503c/tmp/sim')
from personas import COMMON
K="key_7babd72691896d785143f0e4f00e"; BASE="https://api.retellai.com"; LLM="llm_60e6464643745b072c0df85114d8"
def req(method, path, body=None):
    r=urllib.request.Request(BASE+path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization":"Bearer "+K,"Content-Type":"application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(r, timeout=120) as resp: raw=resp.read(); return resp.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            body=json.loads(e.read() or b'{}')
            if e.code==429: time.sleep(5*(attempt+1)); continue
            return e.code, body
        except Exception as e:
            time.sleep(3); err=str(e)
    return 599, {"message":"network"}
TZ_SLOTS={
 "Europe/London":{"any":[("Monday the 2nd of November at 9:00 am","2026-11-02T09:00:00.000Z"),("Tuesday the 3rd of November at 6:30 pm","2026-11-03T18:30:00.000Z"),("Wednesday the 4th of November at 12:30 pm","2026-11-04T12:30:00.000Z")],
                  "morning":[("Monday the 2nd of November at 9:00 am","2026-11-02T09:00:00.000Z"),("Thursday the 5th of November at 10:30 am","2026-11-05T10:30:00.000Z")],
                  "afternoon":[("Wednesday the 4th of November at 2:00 pm","2026-11-04T14:00:00.000Z"),("Friday the 6th of November at 3:30 pm","2026-11-06T15:30:00.000Z")],
                  "evening":[("Tuesday the 3rd of November at 6:30 pm","2026-11-03T18:30:00.000Z"),("Thursday the 5th of November at 7:30 pm","2026-11-05T19:30:00.000Z")]},
}
TZ_SLOTS["Europe/Dublin"]=TZ_SLOTS["Europe/London"]
TZ_SLOTS["Pacific/Auckland"]={"any":[("Tuesday the 3rd of November at 9:30 am","2026-11-02T20:30:00.000Z"),("Wednesday the 4th of November at 7:00 pm","2026-11-04T06:00:00.000Z"),("Thursday the 5th of November at 1:00 pm","2026-11-05T00:00:00.000Z")],
  "morning":[("Tuesday the 3rd of November at 9:30 am","2026-11-02T20:30:00.000Z"),("Friday the 6th of November at 10:00 am","2026-11-05T21:00:00.000Z")],
  "afternoon":[("Thursday the 5th of November at 1:00 pm","2026-11-05T00:00:00.000Z"),("Monday the 9th of November at 3:00 pm","2026-11-09T02:00:00.000Z")],
  "evening":[("Wednesday the 4th of November at 7:00 pm","2026-11-04T06:00:00.000Z"),("Monday the 9th of November at 6:30 pm","2026-11-09T05:30:00.000Z")]}
def slot_text(tz, lst):
    return f"Open times, shown in the doctor's local time ({tz}):\n"+"\n".join(f"{i+1}. {s} — slot_id {sid}" for i,(s,sid) in enumerate(lst))+"\nOffer two of these. To book, call book_consult with the slot_id exactly as written."
def mocks(tz):
    S=TZ_SLOTS[tz]; m=[]
    for tod in ("morning","afternoon","evening"):
        m.append({"tool_name":"check_availability","input_match_rule":{"type":"partial_match","args":{"time_of_day":tod}},"output":slot_text(tz,S[tod])})
    m+=[{"tool_name":"check_availability","input_match_rule":{"type":"any"},"output":slot_text(tz,S["any"])},
        {"tool_name":"book_consult","input_match_rule":{"type":"any"},"output":"Booked. The confirmation and Zoom link are on their way by email and WhatsApp. Read the day and time back to the doctor in their local time."},
        {"tool_name":"send_booking_link","input_match_rule":{"type":"any"},"output":"Booking link sent by email and by WhatsApp."},
        {"tool_name":"mark_outcome","input_match_rule":{"type":"any"},"output":"Noted."}]
    return m
start, count, ver = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
cases=json.load(open('cases.json'))[start:start+count]
ids=json.load(open('ids.json')) if os.path.exists('ids.json') else {}
for c in cases:
    if c['key'] in ids: continue
    body={"name":"h1k-"+c['key'][:80],"response_engine":{"type":"retell-llm","llm_id":LLM},"user_prompt":c["user_prompt"],"metrics":COMMON+[c["extra"]],
          "dynamic_variables":c["vars"],"tool_mocks":mocks(c["tz"]),"llm_model":"claude-5.5-haiku"}
    s,d=req("POST","/create-test-case-definition",body)
    if s not in (200,201): print("create failed",c['key'],s,str(d)[:200]); sys.exit(2)
    ids[c['key']]=d["test_case_definition_id"]
json.dump(ids,open('ids.json','w'))
s,d=req("POST","/create-batch-test",{"test_case_definition_ids":[ids[c['key']] for c in cases],"response_engine":{"type":"retell-llm","llm_id":LLM,"version":ver}})
if s not in (200,201): print("batch failed",s,d); sys.exit(3)
bid=d["test_case_batch_job_id"]; t0=time.time()
while True:
    s,d=req("GET",f"/get-batch-test/{bid}")
    if d.get("status")=="complete" or time.time()-t0>2400: break
    time.sleep(20)
print(f"cases {start}-{start+count-1} llm v{ver}: pass {d.get('pass_count')} fail {d.get('fail_count')} error {d.get('error_count')} / {d.get('total_count')} ({time.time()-t0:.0f}s)")
runs=[]; pk=None
while True:
    s,d2=req("GET",f"/v2/list-test-runs/{bid}?limit=50"+(f"&pagination_key={pk}" if pk else "")); runs+=d2.get("items",[])
    if not d2.get("has_more"): break
    pk=d2.get("pagination_key")
rev={v:k for k,v in ids.items()}; os.makedirs('runs',exist_ok=True)
with open('results.jsonl','a') as out:
    for r in runs:
        s,full=req("GET",f"/get-test-run/{r['test_case_job_id']}")
        key=rev.get(full.get("test_case_definition_id"),"?")
        json.dump(full,open(f"runs/{key}-v{ver}.json","w"))
        out.write(json.dumps({"key":key,"ver":ver,"status":full.get("status"),"why":full.get("result_explanation")})+"\n")
        if full.get("status")!="pass": print(f"  FAIL {key}: {str(full.get('result_explanation'))[:330]}")
