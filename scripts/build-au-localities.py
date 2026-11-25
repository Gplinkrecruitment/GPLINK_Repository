# Builds data/au-localities.json from the Matthew Proctor "Australian Postcodes" CSV.
# Usage: python3 -I scripts/build-au-localities.py <australian_postcodes.csv> data/au-localities.json
# (see data/au-localities.README.md for the source, the licence note and what is stripped)
# The CSV is treated as data only: it is parsed with the csv module and nothing else.
import csv
import json
import re
import sys

SRC, OUT = sys.argv[1], sys.argv[2]
STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT']
KEEP_TYPES = {'delivery area', ''}
SMALL = {'of', 'and', 'the', 'on', 'at', 'in', 'upon'}
NAME_OK = re.compile(r"^[A-Za-z0-9 '\-\.\(\)&/]+$")


def title_word(w, first):
    lw = w.lower()
    if not first and lw in SMALL:
        return lw
    out = lw[:1].upper() + lw[1:]
    # McMahons, McKinnon (but leave "Mc" on its own alone)
    if len(out) > 3 and out.startswith('Mc') and out[2].isalpha():
        out = 'Mc' + out[2].upper() + out[3:]
    return out


def title_case(name):
    name = re.sub(r'\s+', ' ', name.strip())
    words = []
    for wi, word in enumerate(name.split(' ')):
        hy = []
        for hi, part in enumerate(word.split('-')):
            ap = part.split("'")
            done = []
            for ai, bit in enumerate(ap):
                if ai > 0 and len(bit) <= 1:
                    # "Land's End": the letter after the apostrophe stays small
                    done.append(bit.lower())
                else:
                    done.append(title_word(bit, wi == 0 and hi == 0 and ai == 0) if (ai == 0) else title_word(bit, True))
            hy.append("'".join(done))
        words.append('-'.join(hy))
    return re.sub(r'\(([a-z])', lambda m: '(' + m.group(1).upper(), ' '.join(words))


def slug(s):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', s.lower())).strip('-')


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:
        return None
    return f


def in_box(lat, lng):
    if lat is None or lng is None:
        return False
    if lat == 0 and lng == 0:
        return False
    return -44.5 <= lat <= -9 and 112 <= lng <= 154.5


# Postcode ranges Australia Post keeps for PO boxes, big mail receivers and
# competition mail: they are not places anyone lives or works "in".
NON_GEO_RANGES = [(200, 299), (900, 999), (1000, 1999), (5800, 5999), (6800, 6999), (7800, 7999), (8000, 8999), (9000, 9999)]
NON_GEO_NAME = re.compile(r"(\b(MC|DC|BC|MSC|MILPO|WESTFIELD|GPO|PLAZA|STREET|ROADSIDE DELIVERY|ROAD CENTRAL|ROAD MELBOURNE)$)|\b(MILPO|FORCES|HMAS|NAVY|BARRACKS|MILITARY)\b|\d", re.I)


def non_geographic(raw_name, pc):
    n = int(pc)
    if any(lo <= n <= hi for lo, hi in NON_GEO_RANGES):
        return True
    return bool(NON_GEO_NAME.search(raw_name))


counts = {'nongeo': 0, 'read': 0, 'type': 0, 'state': 0, 'postcode': 0, 'name': 0, 'coords': 0, 'dup': 0, 'precise': 0, 'rough': 0}
seen = {}
with open(SRC, encoding='utf-8-sig', newline='') as fh:
    for r in csv.DictReader(fh):
        counts['read'] += 1
        if (r.get('type') or '').strip().lower() not in KEEP_TYPES:
            counts['type'] += 1
            continue
        state = (r.get('state') or '').strip().upper()
        if state not in STATES:
            counts['state'] += 1
            continue
        pc = (r.get('postcode') or '').strip()
        if not re.match(r'^\d{3,4}$', pc):
            counts['postcode'] += 1
            continue
        pc = pc.zfill(4)
        raw_name = (r.get('locality') or '').strip()
        if len(raw_name) < 2 or len(raw_name) > 50 or not NAME_OK.match(raw_name) or not slug(raw_name):
            counts['name'] += 1
            continue
        if non_geographic(raw_name, pc):
            counts['nongeo'] += 1
            continue
        name = title_case(raw_name)
        lat, lng = num(r.get('Lat_precise')), num(r.get('Long_precise'))
        used = 'precise'
        if not in_box(lat, lng):
            lat, lng = num(r.get('lat')), num(r.get('long'))
            used = 'rough'
        if not in_box(lat, lng):
            counts['coords'] += 1
            continue
        key = (state, pc, slug(name))
        if key in seen:
            counts['dup'] += 1
            continue
        counts[used] += 1
        seen[key] = [name, state, pc, round(lat, 4), round(lng, 4)]

rows = sorted(seen.values(), key=lambda x: (STATES.index(x[1]), x[0].lower(), x[2]))
doc = {
    'v': 1,
    'source': 'Australian Postcodes by Matthew Proctor, https://github.com/matthewproctor/australianpostcodes (australian_postcodes.csv)',
    'generated': '2026-11-25',
    'rows': rows,
}
with open(OUT, 'w', encoding='utf-8') as fh:
    fh.write('{"v":1,"source":' + json.dumps(doc['source']) + ',"generated":"2026-11-25","rows":[\n')
    fh.write(',\n'.join(json.dumps(r, ensure_ascii=False, separators=(',', ':')) for r in rows))
    fh.write('\n]}\n')
print(json.dumps(counts), 'kept', len(rows))
