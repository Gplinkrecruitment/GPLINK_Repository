# usage: python3 newdraft.py <prompt_file|-> ; creates a draft agent version from the latest, applies prompt, prints llm version
import json, urllib.request, sys
K="key_7babd72691896d785143f0e4f00e"; BASE="https://api.retellai.com"; AG="agent_44bd0d78c7126d93641eb8fcc6"; LLM="llm_60e6464643745b072c0df85114d8"
def req(method, path, body=None):
    r=urllib.request.Request(BASE+path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization":"Bearer "+K,"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            raw=resp.read(); return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
s,d=req("GET",f"/list-agent-versions/{AG}"); items=d.get('items') if isinstance(d,dict) else d
latest=max(v['version'] for v in items); pub=[v for v in items if v['version']==latest][0].get('is_published')
if pub:
    s,d=req("POST",f"/create-agent-version/{AG}",{"base_version":latest}); av=d["version"]
else: av=latest
s,d=req("GET",f"/get-agent/{AG}?version={av}"); lv=d["response_engine"]["version"]
if sys.argv[1]!='-':
    s,d=req("PATCH",f"/update-retell-llm/{LLM}?version={lv}",{"general_prompt":open(sys.argv[1]).read()}); assert s==200,d
print(json.dumps({"agent_version":av,"llm_version":lv}))
