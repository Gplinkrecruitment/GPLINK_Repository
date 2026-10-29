# Create (or reuse) test-case definitions for a case file without running them. usage: python3 -I mkdefs.py reg20.json reg_ids.json
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run2
cases=json.load(open(sys.argv[1])); outf=sys.argv[2]
ids=json.load(open(outf)) if os.path.exists(outf) else {}
for c in cases:
    if c['key'] in ids: continue
    extra=c["extra"].replace("The doctor is a qualified lead (or within three months of finishing).","The doctor is a GP (or within three months of finishing training), which the agent may assume from the enquiry form and does not need to verify.")
    if "finishes training more than three months" in extra:
        extra+=" A callback_hours value of 336 is correct for any trainee regardless of finish date; the team handles the longer wait."
    if extra.startswith("The doctor is a GP"):
        extra+=" Exception: if the doctor says it is a bad time and asks to be rung back, arranging that callback (mark_outcome callback_requested) instead of booking is acceptable, provided the agent first offered to put the consultation itself in the diary for a time that suits."
    body={"name":"hreg-"+c['key'][:80],"response_engine":{"type":"retell-llm","llm_id":run2.LLM},"user_prompt":c["user_prompt"],"metrics":run2.COMMON2+[extra],
          "dynamic_variables":c["vars"],"tool_mocks":run2.mocks(c["tz"]),"llm_model":"claude-5.5-haiku"}
    s,d=run2.req("POST","/create-test-case-definition",body)
    if s not in (200,201): print("create failed",c['key'],s,str(d)[:200]); sys.exit(2)
    ids[c['key']]=d["test_case_definition_id"]; json.dump(ids,open(outf,'w'),indent=0)
print(len(ids),"definitions:"); print(json.dumps(ids,indent=0))
