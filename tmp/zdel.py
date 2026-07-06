import re, sys

path = "server.js"
with open(path) as f:
    lines = f.readlines()

FUNCS = [
 # origin
 "resolveZohoRecruitOrigin","resolveZohoAccountsOrigin","isAllowedZohoDomain",
 # cron auth
 "requireZohoRecruitCronAuth",
 # config/scope
 "isZohoRecruitConfigured","getZohoRecruitAccountsServer","getZohoRecruitLegacyAppRedirectUri",
 "getZohoRecruitOauthRedirectUri","normalizeZohoRecruitScope","parseZohoRecruitScopes",
 "mergeZohoRecruitScopes","getConfiguredZohoRecruitScopes","doesZohoRecruitScopeGrant",
 "isZohoRecruitWriteScope","getZohoRecruitScopeStatus","getZohoRecruitScopes","getZohoRecruitCandidateBases",
 # oauth state
 "getZohoOauthStateKey","createZohoOauthState","consumeZohoOauthState",
 # form/conn
 "zohoFormRequest","getZohoErrorMessage","mapZohoConnectionRow","sanitizeConnectionForResponse",
 "getZohoRecruitConnection","upsertZohoRecruitConnection",
 # token/api
 "exchangeZohoRecruitAuthorizationCode","refreshZohoRecruitAccessToken","zohoRecruitApiGet",
 "zohoRecruitApiPost","zohoRecruitApiUploadAttachment","zohoRecruitApiDeleteAttachment",
 "fetchZohoRecruitJobOpenings","buildCareerRoleRecordFromZoho","upsertCareerRoleBatch",
 # webhooks
 "handleZohoRecruitWebhook","handleZohoRecruitCandidateHiredWebhook",
 # sync
 "syncZohoRecruitRoles","backfillPhonesFromZoho","discoverUnlinkedZohoApplications",
 "syncZohoRecruitApplicationStatuses","runZohoRecruitScheduledSync",
 # access token
 "getZohoRecruitAccessTokenAndDomain",
 # candidate helpers
 "createZohoRecruitCandidate","searchZohoRecruitCandidatesByEmail","getZohoCandidateId",
 "ensureZohoRecruitCandidateIdForUser","linkUserToHiredZohoPosition","uploadDocumentsToZohoCandidate",
 "createZohoRecruitApplication","pickZohoRecruitClientContact","createZohoRecruitSubmission",
 # variant/module fetchers + test hooks
 "shouldTryNextZohoRecruitVariant","fetchZohoRecruitRecordsWithVariants","__setZohoRecordFetcherForTests",
 "fetchAllZohoRecruitModule","fetchAllZohoRecruitJobOpenings","fetchAllZohoRecruitClients","fetchAllZohoRecruitCandidates",
 # archive
 "__setSupabaseDbRequestForTests","archiveDb","writeZohoArchiveRecords","upsertCandidateLeads",
 "__setZohoAccessForTests","captureZohoArchive","materializePracticesFromArchive","backfillCareerRolesFromArchive",
 # attachment/binary/record fetchers + scorers + accessors
 "downloadZohoRecruitBinaryWithVariants","fetchZohoRecruitApplicationRecord","searchZohoRecruitApplicationsByEmail",
 "searchZohoRecruitApplicationsByCandidateId","fetchZohoRecruitJobOpeningRecord","fetchZohoRecruitClientContacts",
 "listZohoRecruitRecordAttachments","listZohoRecruitApplicationAttachments","listZohoRecruitCandidateAttachments",
 "downloadZohoRecruitRecordAttachment","downloadZohoRecruitApplicationAttachment","downloadZohoRecruitCandidateAttachment",
 "deleteZohoRecruitRecordAttachment","deleteZohoRecruitCandidateAttachment",
 "getZohoAttachmentId","getZohoAttachmentFileName","getZohoAttachmentCategory","getZohoAttachmentUpdatedAt",
 "buildZohoAttachmentSignature","scoreZohoContractAttachment","selectZohoContractAttachmentCandidates",
 "selectZohoCandidateCareerAttachment","getIsoTimestampValue",
 # doc sync
 "syncSingleAccountCareerDocumentToZoho","reconcileAccountCareerDocumentsWithZoho",
 # contract terms (only caller = buildCareerPlacementPayload, inlined to null separately)
 "resolveCareerContractTerms",
 # career applications live fetch
 "fetchZohoRecruitCareerApplicationsForUser",
 # D2 offer/contract
 "deliverOfferContract","scanContractSignatures","checkOfferContractAtOnboarding","checkZohoContractReupload",
 # doc-type helpers
 "getAccountCareerDocumentTypeByZohoCategory","getZohoCandidateCareerDocumentSyncKey",
]

ROUTES = [
 "/api/webhooks/zoho-recruit","/api/webhooks/zoho-recruit/candidate-hired",
 "/api/integrations/zoho-recruit/status","/api/integrations/zoho-recruit/connect",
 "/api/integrations/zoho-recruit/callback","/api/integrations/zoho-recruit/sync",
 "/api/integrations/zoho-recruit/cron-sync","/api/integrations/zoho-recruit/archive-capture",
 "/api/admin/integrations/zoho-recruit/status","/api/admin/integrations/zoho-recruit/connect",
 "/api/admin/integrations/zoho-recruit/callback","/api/integrations/zoho-recruit/debug-discover",
 "/api/admin/integrations/zoho-recruit/disconnect","/api/cron/enrich-placement",
 "/api/admin/link-zoho-position","/api/admin/integrations/zoho-recruit/sync",
 "/api/admin/redeliver-offer-contract","/api/cron/check-contract-signatures",
]

VAR_PREFIXES = [
 "let _zohoRecordFetcherForTests = null;",
 "let _supabaseDbRequestForTests = null;",
 "let _zohoAccessForTests = null;",
 "var _zohoAccessTokenCache = ",
 "var _zohoRefreshInFlight = null;",
 "const PRACTICE_BACKFILL_FILL_ONLY_IF_EMPTY = ",
]

def brace_end(i):
    line=lines[i]
    indent=line[:len(line)-len(line.lstrip())]
    # single-line (balanced on the def line itself)
    if '{' in line and line.count('{')==line.count('}'):
        return i
    closer=indent+'}'
    j=i+1
    while j < len(lines):
        if lines[j].rstrip('\n').rstrip()==closer:
            return j
        j+=1
    raise RuntimeError("no end for line %d" % i)

def preceding_comment_start(i):
    start=i
    k=i-1
    while k>=0:
        s=lines[k].strip()
        if s.startswith('//') and ('zoho' in s.lower() or '─' in s or 'offer/contract' in s.lower() or 'contract signature' in s.lower()):
            start=k; k-=1
        else:
            break
    return start

ranges=[]

def add_func(name):
    pat=re.compile(r'^(async\s+)?function\s+'+re.escape(name)+r'\s*\(')
    idx=[k for k,l in enumerate(lines) if pat.match(l)]
    if len(idx)!=1:
        raise SystemExit("FUNC %s found %d times: %s"%(name,len(idx),idx))
    i=idx[0]; j=brace_end(i)
    start=preceding_comment_start(i)
    end=j
    if end+1<len(lines) and lines[end+1].strip()=='':
        end+=1
    ranges.append((start,end,"func:"+name))

def add_route(pathstr):
    marker="pathname === '%s'"%pathstr
    idx=[k for k,l in enumerate(lines) if l.lstrip().startswith('if (') and marker in l and ('&&' in l)]
    # exact match: ensure the pathname token is exactly this path (not a prefix of a longer one)
    idx=[k for k in idx if ("'%s'"%pathstr) in lines[k]]
    if len(idx)!=1:
        raise SystemExit("ROUTE %s found %d: %s"%(pathstr,len(idx),idx))
    i=idx[0]; j=brace_end(i)
    start=preceding_comment_start(i)
    end=j
    if end+1<len(lines) and lines[end+1].strip()=='':
        end+=1
    ranges.append((start,end,"route:"+pathstr))

def add_var(prefix):
    idx=[k for k,l in enumerate(lines) if l.strip().startswith(prefix.strip())]
    if len(idx)<1:
        raise SystemExit("VAR %s found 0"%prefix)
    i=idx[0]; j=brace_end(i) if '{' in lines[i] and lines[i].count('{')>lines[i].count('}') else i
    start=preceding_comment_start(i)
    end=j
    ranges.append((start,end,"var:"+prefix[:30]))

for n in FUNCS: add_func(n)
for r in ROUTES: add_route(r)
for v in VAR_PREFIXES: add_var(v)

# sort by start desc, ensure no overlaps
ranges.sort(key=lambda t:t[0], reverse=True)
prev_start=None
for (s,e,tag) in ranges:
    if prev_start is not None and e>=prev_start:
        raise SystemExit("OVERLAP %s end=%d prev_start=%d"%(tag,e,prev_start))
    prev_start=s

deleted=0
for (s,e,tag) in ranges:
    deleted += (e-s+1)
    del lines[s:e+1]

with open(path,"w") as f:
    f.writelines(lines)

print("deleted %d line-blocks, %d lines total"%(len(ranges),deleted))
