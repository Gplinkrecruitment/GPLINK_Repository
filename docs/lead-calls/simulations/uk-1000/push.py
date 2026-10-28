# Push sim/prompt.md (+ optional tool tweaks) to draft llm version and verify. usage: python3 push.py <llm_version>
import json, urllib.request, sys
K="key_7babd72691896d785143f0e4f00e"; BASE="https://api.retellai.com"; LLM="llm_60e6464643745b072c0df85114d8"
v=int(sys.argv[1])
def req(method, path, body=None):
    r=urllib.request.Request(BASE+path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization":"Bearer "+K,"Content-Type":"application/json"})
    with urllib.request.urlopen(r, timeout=60) as resp: raw=resp.read(); return resp.status, (json.loads(raw) if raw else {})
prompt=open('/Users/gplinkrecruitment/.claude/jobs/daeb503c/tmp/sim/prompt.md').read()
s,l=req("GET",f"/get-retell-llm/{LLM}?version={v}"); tools=l["general_tools"]
for t in tools:
    if t["name"]=="mark_outcome":
        t["description"]=("Record how the call went when it did not end in a booking. Call once, just before ending. Outcomes: "
          "callback_requested (they asked to be rung back, or a trainee more than three months from finishing; pass callback_hours if they said when); "
          "not_interested (the doctor who enquired doesn't want to go ahead); "
          "not_a_gp (they did enquire but aren't a GP: a hospital doctor, registrar, consultant, or not a doctor at all); "
          "wrong_number (ONLY when the person on the line isn't the doctor you asked for, or flatly says they never enquired and isn't a doctor; a doctor who just doesn't remember the form is not a wrong number); "
          "already_booked (they already have a call booked).")
s,d=req("PATCH",f"/update-retell-llm/{LLM}?version={v}",{"general_prompt":prompt,"general_tools":tools})
ok = d["general_prompt"]==prompt
print(f"pushed to llm v{v}: status {s} | prompt matches: {ok} | begin: {d.get('begin_message')} | model: {d['model_config']['primary']['model']}")
if not ok: sys.exit(1)
