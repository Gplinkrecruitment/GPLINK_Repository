# Generates 1000 unique GP personas for Hazel. Deterministic (seeded).
import random, json
R = random.Random(20261029)
FIRST_F = ["Sarah","Aoife","Priya","Hina","Chloe","Fatima","Emma","Niamh","Grace","Aisha","Sofia","Rachel","Mei","Olivia","Zara","Leah","Siobhan","Amara","Kate","Nadia","Ruth","Hannah","Ines","Yasmin","Claire"]
FIRST_M = ["Tom","James","Raj","Ben","Daniel","Michael","Owen","Rito","Hemi","Carlos","Liam","Omar","Sean","Arjun","David","Kwame","Ciaran","Ahmed","Luke","Tariq","Chris","Mateo","Niall","Samuel","Ravi"]
LAST = ["Patel","Hughes","Okafor","Mehta","Shah","Carter","Byrne","Walker","Ellis","Grant","Khan","Brooks","Adams","Samaan","Malik","Price","Rivas","Murphy","O'Brien","Nguyen","Ahmed","Evans","Kelly","Singh","Wilson","Doyle","Mensah","Ali","Taylor","Reid"]
UK_TOWNS = ["Manchester","Leeds","Birmingham","Bristol","Glasgow","Cardiff","Leicester","Nottingham","Sheffield","Newcastle","Coventry","Croydon","Kent","Essex","Brighton","Belfast","Edinburgh","Swansea","Bath","Norwich"]
IE_TOWNS = ["Dublin","Cork","Galway","Limerick","Waterford"]
NZ_TOWNS = ["Auckland","Wellington","Christchurch","Hamilton","Dunedin"]
COUNTRY = {"uk":("the UK","Europe/London","Thursday 6:15pm"),"ie":("Ireland","Europe/Dublin","Thursday 6:15pm"),"nz":("New Zealand","Pacific/Auckland","Friday 10:15am")}
# --- qualification profiles: (key, description, expected outcome class) ---
def quals(country):
    q=[]
    if country=="uk":
        for y in (2008,2011,2014,2016,2019,2021,2023,2025): q.append((f"mrcgp{y}", f"Fully qualified GP, MRCGP and CCT {y}.", "book"))
        for y in (1998,2003,2005): q.append((f"mrcgp{y}", f"Senior GP, MRCGP {y}, many years as a GP.", "book_old"))
        q.append(("img_performer","Trained as a family doctor overseas (e.g. India, Pakistan, Nigeria, Egypt or Spain), now on the UK performers list via international recruitment, no MRCGP.", "book_img"))
    if country=="ie":
        for y in (2010,2015,2020): q.append((f"micgp{y}", f"Fully qualified GP, MICGP {y}.", "book"))
        q.append(("micgp2005","Senior GP, MICGP 2005.", "book_old"))
    if country=="nz":
        for y in (2013,2017,2022): q.append((f"frnzcgp{y}", f"Fully qualified GP, FRNZCGP {y}.", "book"))
    for m in (1,2,3): q.append((f"trainee{m}m", f"GP trainee in the final year; CCT/fellowship due in about {m} month{'s' if m>1 else ''}.", "book_trainee_soon"))
    for m in (5,8,12,20): q.append((f"trainee{m}m", f"GP trainee; you finish training in about {m} months.", "trainee_late"))
    q.append(("hospital_doc","Hospital doctor (a medical registrar), not a GP and not training in general practice. You did fill in the form out of curiosity.", "not_gp"))
    q.append(("wrong_number","You are NOT a doctor at all and never filled in any form; it's a wrong number. You work as something unrelated.", "wrong"))
    return q
PERSONALITY = [
 ("friendly","Warm and chatty, easy to talk to."),
 ("curt","Very short answers, one to five words, not rude, just busy."),
 ("sceptical","Sceptical of recruiters; you test whether she gives straight answers and dislike sales talk."),
 ("rushed","Between patients, keen to keep it short."),
 ("hostile_softens","Irritated at first ('who is this, how did you get my number') but soften if she is calm and clear."),
 ("chatty_rambler","You talk a lot and go off on tangents about family, the NHS and your plans."),
 ("confused","A bit confused about what this is and need it explained simply."),
 ("esl","English is your second language; you speak simply, sometimes misunderstand, and ask her to repeat things."),
 ("analytical","Methodical; you ask precise follow-up questions and want specifics."),
 ("warm_but_indecisive","Friendly but indecisive; you hedge and need a gentle nudge."),
]
OBJECTION = [
 ("none","No particular objection."),
 ("money","You keep asking what you'd earn and push for a figure."),
 ("timing","You say now isn't the right time, maybe in a year or two."),
 ("partner","You need to talk to your partner before booking anything."),
 ("other_agency","You're already talking to another agency."),
 ("ai_suspicion","At some point you ask directly whether you're talking to a real person or an AI."),
 ("remote_fear","You worry you'd be sent somewhere remote in the outback."),
 ("scam","You're wary it might be a scam or a sales trap and ask what the catch is / who pays."),
 ("cost","You worry about the costs of moving (visa, registration, flights)."),
 ("process","You want to understand the full process (registration, visa, timeline) before booking."),
 ("family_school","You have kids and want to know about schooling and family visas."),
 ("english_test","You ask whether your old English test (OET/IELTS) still counts."),
 ("parttime","You only want to work part-time and ask if that's possible."),
 ("specific_city","You only want a specific big city (Sydney or Melbourne CBD)."),
]
SCHED = [
 ("any","Any of the offered times is fine; pick one."),
 ("evening","You can only do evenings."),
 ("morning","You can only do mornings."),
 ("none_fit","None of the times offered suit you; you'd rather pick a time yourself from a link."),
 ("specific_day","You ask for a specific day (e.g. Wednesday) and accept the closest offer."),
 ("change_email","When she confirms your email, give a different personal email to use instead."),
]
FAMILY = ["single","married, no kids","married with two kids","partner, one toddler","married, kids in secondary school","divorced, one child"]
def make(i):
    country = "uk"
    gender = R.choice(["f","m"]); first = R.choice(FIRST_F if gender=="f" else FIRST_M); last = R.choice(LAST)
    town = R.choice(UK_TOWNS if country=="uk" else IE_TOWNS if country=="ie" else NZ_TOWNS)
    qkey, qdesc, qclass = R.choice(quals(country))
    pkey, pdesc = R.choice(PERSONALITY); okey, odesc = R.choice(OBJECTION); skey, sdesc = R.choice(SCHED)
    fam = R.choice(FAMILY)
    firm_no = (R.random() < 0.06) and qclass not in ("wrong","not_gp")
    bad_time = (R.random() < 0.05) and qclass not in ("wrong",)
    spoken, tz, now = COUNTRY[country]
    email = f"{first.lower()}.{last.lower().replace(chr(39),'')}{R.randint(1,99)}@gmail.com"
    who = f"You are Dr {first} {last}, based in {town}. {qdesc} Family: {fam}." if qclass!="wrong" else f"You are {first} {last} from {town}. {qdesc}"
    goal_parts=[]
    if qclass=="wrong": goal_parts.append("Make clear you're not a doctor and don't know what this is about.")
    elif bad_time: goal_parts.append("Say it's a bad time (driving / in clinic) and ask to be called back tomorrow afternoon.")
    elif firm_no: goal_parts.append("You filled in the form but have decided not to move. Say no politely; if she pushes more than once, get annoyed.")
    else:
        goal_parts.append(f"Objection or theme: {odesc}")
        if qclass in ("trainee_late","book_trainee_soon"): goal_parts.append("Mention you're still in training only when it naturally comes up or when asked; give your finish date if asked.")
        if qclass=="not_gp": goal_parts.append("If asked, say honestly you're a hospital registrar, not a GP.")
        goal_parts.append("You WILL book a consultation if she handles you well: answers your questions straight, is not pushy or robotic. If she dodges, repeats herself, or sounds scripted, become less willing.")
        goal_parts.append(f"Scheduling: {sdesc}")
    user_prompt = ("## Who you are\n"+who+"\n\n## Personality\n"+pdesc+"\n\n## What you want\n"+" ".join(goal_parts)+
        "\n\n## How you talk\nThis is a real phone call answered on your mobile. Speak naturally and briefly, one or two sentences per turn, like a real person, not a chatbot. React honestly. End the call when it's naturally done.")
    if qclass=="wrong": expect="The agent apologises, does not pitch, calls mark_outcome with wrong_number, and ends the call."
    elif bad_time: expect="The agent does not pitch, agrees to call back, calls mark_outcome with callback_requested (with callback_hours if a time was given), and ends quickly."
    elif firm_no: expect="The agent makes at most one gentle attempt after the first no, then respects it, calls mark_outcome with not_interested, and ends warmly."
    elif qclass=="not_gp": expect="Once it's clear the person is not a GP (a hospital registrar), the agent does not book a GP consultation as if they were a GP; she ends politely and calls mark_outcome with not_a_gp."
    elif qclass=="trainee_late": expect="Because the doctor finishes training more than three months from now, the agent does NOT book and does NOT send the booking link; she explains briefly, mentions the GP Link app sign-up will be sent, and calls mark_outcome with callback_requested and a note starting TRAINEE."
    elif skey=="none_fit": expect="The doctor is qualified to book. When none of the offered times suit, the agent sends the booking link (send_booking_link) rather than leaving it, and does not pressure."
    else:
        extra = {"book_old":" If the route comes up, she says a pre-August-2007 MRCGP or pre-2009 MICGP goes via the slower comparability route.",
                 "book_img":" If the route comes up, she says training outside the UK/Ireland/NZ usually goes via the slower comparability route."}.get(qclass,"")
        expect = "The doctor is a qualified lead (or within three months of finishing). The call ends with a booked consultation: the agent calls check_availability and then book_consult with an offered slot_id, and confirms the time in the doctor's local time." + extra
    vars = {"agent_name":"Hazel","director_name":"Khaleed","attempt":"1","enquiry_when":"yesterday","enquiry_source":"our website","enquiry_question":"",
            "country_spoken":spoken,"lead_timezone":tz,"local_time_now":now,"system_timezone":tz,"first_name":first,"full_name":f"Dr {first} {last}",
            "email_on_file":email,"phone_on_file":"+447700900123"}
    key=f"{i:04d}-{country}-{qkey}-{pkey}-{okey}-{skey}" + ("-firmno" if firm_no else "") + ("-badtime" if bad_time else "")
    return {"key":key,"vars":vars,"user_prompt":user_prompt,"extra":expect,"tz":tz}
if __name__=="__main__":
    cases=[make(i) for i in range(1000)]
    json.dump(cases, open("cases.json","w"), indent=0)
    from collections import Counter
    print("cases:", len(cases), "| unique keys:", len(set(c['key'] for c in cases)))
    print(Counter(c['key'].split('-')[1] for c in cases))
    print(Counter(c['extra'].split('.')[0][:60] for c in cases).most_common(8))
