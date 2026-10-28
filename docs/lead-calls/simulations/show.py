import json, sys
for f in sys.argv[1:]:
    d=json.load(open(f)); snap=d.get('transcript_snapshot') or {}
    print("="*100); print(f, "|", d.get('status')); print("JUDGE:", d.get('result_explanation')); print("-"*40)
    for m in snap.get('transcript') or []:
        r=m.get('role')
        if r in ('agent','user'): print(f"{r.upper():5}: {m.get('content')}")
        elif r=='tool_call_invocation': print(f"   >> {m.get('name')} {m.get('arguments')}")
        elif r=='tool_call_result': print(f"   << {str(m.get('content'))[:100]}")
        else: print(f"   [{r}] {str(m)[:160]}")
