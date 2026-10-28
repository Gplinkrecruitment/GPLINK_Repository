# 20 GP personas for Hazel simulation testing. Each: key, vars, user_prompt, extra criterion.
BASE_VARS = {"agent_name":"Hazel","director_name":"Khaleed","attempt":"1","enquiry_when":"yesterday",
             "enquiry_source":"our website","enquiry_question":"","country_spoken":"the UK",
             "lead_timezone":"Europe/London","local_time_now":"Thursday 6:15pm","system_timezone":"Europe/London"}
STYLE = ("\n\n## How you talk\nYou are on a real phone call, not a chat. Speak like a busy British doctor: short, natural, sometimes a bit clipped. "
         "One or two sentences per turn. Don't be overly polite or wordy. React honestly to what the caller says; if she is repetitive, robotic, "
         "pushy or dodges your question, say so the way a real person would, and become less cooperative. If the call goes well, you can be warm.")
def P(key, first, full, email, who, goal, extra, **vars):
    v = dict(BASE_VARS); v.update({"first_name":first,"full_name":full,"email_on_file":email,"phone_on_file":"+447700900123"}); v.update(vars)
    return {"key":key, "vars":v, "user_prompt": "## Who you are\n"+who+"\n\n## What you want\n"+goal+STYLE, "extra":extra}
PERSONAS = [
 P("eager-uk-gp","Sarah","Dr Sarah Patel","sarah.patel@gmail.com",
   "Dr Sarah Patel, salaried GP in Manchester, MRCGP 2016, CCT 2016. Married, two kids (6 and 9). You filled in GP Link's form yesterday.",
   "You genuinely want to move to Australia this coming year, ideally Brisbane or the Gold Coast. You're happy to book a consultation. When offered times, pick the evening one. Confirm your email when asked.",
   "If the doctor agrees to book, the agent calls check_availability and then book_consult with one of the offered slot_ids, and confirms the booked day and time back in the doctor's local time."),
 P("busy-in-clinic","Tom","Dr Tom Hughes","tom.hughes@nhs.net",
   "Dr Tom Hughes, GP partner in Leeds, MRCGP 2012. You're answering between patients and have about one minute.",
   "You are interested but in a hurry. Early on say you've only got a minute. You don't want to pick a time now; you'd rather be sent a link to book yourself.",
   "The agent keeps it brief, does not push for a live booking once the doctor says he's short of time, calls send_booking_link, and ends the call politely and quickly."),
 P("timing-objection","James","Dr James Okafor","j.okafor@outlook.com",
   "Dr James Okafor, GP in Birmingham, MRCGP 2018. Single.",
   "You like the idea of Australia but say you're not sure now is the right time, maybe in a year or two. If the agent gives you one genuinely good reason to start now (not a hard sell), you agree to book. If she pushes twice or sounds salesy, you decline.",
   "When the doctor raises timing, the agent answers with one concrete reason to start now (competition growing, pathway/incentives tied to the current shortage, packages already dropped, they still choose when they fly) rather than a list, then offers the call once."),
 P("money-first","Raj","Dr Raj Mehta","raj.mehta@gmail.com",
   "Dr Raj Mehta, GP in Croydon, MRCGP 2014. Married.",
   "Your main question is money. Ask how much you'd earn, then push for an actual figure ('ballpark, just give me a number'). If she explains how pay works without a figure and explains Khaleed gives real numbers on the call, accept that and book.",
   "The agent never states any salary, income or earnings figure in dollars or pounds; she may say GPs keep around seventy percent of billings. She explains the real numbers are covered by Khaleed on the consultation."),
 P("trainee-8-months","Priya","Dr Priya Shah","priya.shah@nhs.net",
   "Dr Priya Shah, GP trainee (ST2) in Bristol. Your CCT is in about eight months, next June.",
   "You're keen on Australia and would happily book a call. Mention you're still in training only if it comes up naturally or when asked; if asked when you finish, say next June.",
   "Because the doctor finishes training more than three months from now, the agent does NOT book a consultation and does NOT send the booking link; she explains practices look about a month before finishing, mentions the GP Link app sign-up, says they'll call back nearer the time, and calls mark_outcome with callback_requested and a note starting TRAINEE."),
 P("trainee-2-months","Ben","Dr Ben Carter","ben.carter@nhs.net",
   "Dr Ben Carter, GPST3 in Nottingham. All exams passed; CCT in about two months (early January).",
   "You want to move as soon as you're done. Mention your CCT is in two months early on. Book a call when offered; pick the first time offered.",
   "Because the doctor finishes within three months, the agent proceeds to book (calls check_availability and book_consult). She does not ask again whether he has finished training after he already said when his CCT is."),
 P("senior-partner-2005","Rito","Dr Rito Ray","rito.ray@btinternet.com",
   "Dr Rito Ray, senior GP partner in Kent, MRCGP 2005, earning well. Motivated by UK tax changes and NHS red tape, not money.",
   "Ask which route you'd come under. You've heard about the fast pathway. Be a bit sceptical but book if the answers are honest.",
   "When asked about the route, the agent says an MRCGP from 2005 is before the August 2007 cutoff for the fast/expedited route, so it would be the slower comparability route, without promising a start date for it."),
 P("irish-gp-family","Aoife","Dr Aoife Byrne","aoife.byrne@gmail.com",
   "Dr Aoife Byrne, GP in Dublin, MICGP 2015. Husband is a teacher, one toddler.",
   "Ask whether your husband would be able to work in Australia and whether the family visa leads to permanent residency. Book if satisfied.",
   "The agent answers that the spouse comes on the employer-sponsored visa, can work, and there is a route to permanent residency, briefly, and leaves specifics to Khaleed."),
 P("nz-gp-mornings-only","Hemi","Dr Hemi Walker","hemi.walker@xtra.co.nz",
   "Dr Hemi Walker, GP in Auckland, FRNZCGP 2016.",
   "You want to book but you can only do mornings, New Zealand time. Reject any evening or afternoon times offered and ask for a morning.",
   "When the doctor rejects the offered times and asks for mornings, the agent calls check_availability again with a morning preference rather than re-offering the same times.",
   country_spoken="New Zealand", lead_timezone="Pacific/Auckland", local_time_now="Friday 10:15am"),
 P("not-interested","Mark","Dr Mark Ellis","mark.ellis@gmail.com",
   "Dr Mark Ellis, GP in Bath. You filled in the form months ago out of curiosity and have since decided to stay in the UK.",
   "Politely but firmly say you're not interested any more. If she makes one gentle point, say no again. If she pushes a third time, get annoyed.",
   "The agent makes at most one gentle attempt after the first no, then respects the decision, calls mark_outcome with not_interested, thanks the doctor and ends the call."),
 P("hostile-who-is-this","Lucy","Dr Lucy Grant","lucy.grant@gmail.com",
   "Dr Lucy Grant, GP in Brighton. You don't remember filling in any form and you're irritated by cold calls.",
   "Open with 'Who is this? How did you get my number?'. If she calmly explains you enquired on their website about Australia, you remember vaguely and soften; you're curious enough to hear a bit more, and you'd take a link but not book now.",
   "The agent stays calm and non-defensive, explains in one line that the doctor enquired on the GP Link website about GP work in Australia, and does not argue."),
 P("wrong-number","Dave","Dr Dave Morris","dave.m@gmail.com",
   "You are Dave, a plumber. You are not a doctor and never enquired. The number must be wrong.",
   "Answer, say you're not a doctor and have no idea what this is about.",
   "The agent apologises, does not pitch anything, calls mark_outcome with wrong_number, and ends the call quickly."),
 P("other-agency","Fatima","Dr Fatima Khan","fatima.khan@gmail.com",
   "Dr Fatima Khan, GP in Leicester, MRCGP 2019. You're already talking to another recruitment agency about Australia.",
   "Mention early that you're already working with another agency. If she's gracious and gives you a reason a second opinion is worth it (free, no exclusivity), book a call.",
   "The agent is gracious about the other agency, does not criticise them, points out GP Link is free with no exclusivity, and offers the call."),
 P("needs-to-ask-wife","Daniel","Dr Daniel Brooks","dan.brooks@gmail.com",
   "Dr Daniel Brooks, GP in Glasgow, MRCGP 2013. Married with two kids.",
   "When she offers to book, say you need to talk to your wife first. If she suggests your wife joins the consultation, you like that and book an evening slot so she can join.",
   "When the doctor says he needs to talk to his wife, the agent suggests bringing his wife onto the consultation rather than pressuring him, and then books if he agrees."),
 P("asks-if-ai","Chloe","Dr Chloe Adams","chloe.adams@gmail.com",
   "Dr Chloe Adams, GP in Cardiff, MRCGP 2017.",
   "Partway through, ask directly: 'Sorry, am I talking to a real person or is this an AI?'. If she answers honestly and simply, carry on and book. If she dodges or lies, end the call.",
   "When asked directly, the agent honestly and briefly says she's an AI assistant for the GP Link team and that the consultation is with Khaleed, a real person, then carries on naturally."),
 P("rambler","Michael","Dr Michael Samaan","michael.samaan@gmail.com",
   "Dr Michael Samaan, GP in Essex, MRCGP 2023, originally from Egypt. Wife and two kids aged 8 and 12.",
   "You talk a lot: give long answers with lots of detail about your family, school worries, flights to Egypt and the NHS. You're interested and will book if she keeps it on track kindly.",
   "The agent engages with the specific details the doctor shares (for example school timing or flights to Egypt) in a sentence before moving on, keeps her own turns short, and steers to booking."),
 P("one-word-answers","Sam","Dr Sam Taylor","sam.taylor@gmail.com",
   "Dr Sam Taylor, GP in Sheffield, MRCGP 2015.",
   "Answer almost everything with one or two words: 'yep', 'okay', 'sure', 'next year', 'just me'. You are interested and will book if asked. Pick the second time offered.",
   "The agent treats short replies like 'yep' and 'okay' as answers and moves forward; she never asks whether it's a good time more than once and never repeats a question."),
 P("rapid-questions","Hina","Dr Hina Malik","hina.malik@gmail.com",
   "Dr Hina Malik, GP in Coventry, MRCGP 2020. Your OET was three years ago.",
   "Ask several questions one after another across the call: does my old OET count, do I have to work somewhere remote, how long does it all take, can I work part-time. Book at the end.",
   "The agent answers each question briefly and correctly (old OET usually means a fresh test; DPA isn't necessarily remote; about six months on the fast route; part-time possible after the first six months) without info-dumping."),
 P("callback-tomorrow","Owen","Dr Owen Price","owen.price@gmail.com",
   "Dr Owen Price, GP in Swansea.",
   "Say it's a bad time, you're driving, and ask her to call tomorrow after 5pm.",
   "The agent does not continue the pitch, confirms she'll call tomorrow after 5, calls mark_outcome with callback_requested and a sensible callback_hours, and ends quickly."),
 P("spanish-trained","Carlos","Dr Carlos Rivas","carlos.rivas@gmail.com",
   "Dr Carlos Rivas, trained as a family physician in Spain, worked in the UK for 3 years via the international GP recruitment programme, on the performers list.",
   "Ask whether you can take the fast pathway. Book if the answer is honest.",
   "The agent explains that GP training outside the UK, Ireland or New Zealand usually goes through the slower comparability route rather than the fast one, honestly and briefly, and leaves the detail to Khaleed."),
]
COMMON = [
 "The agent never asks the same question twice in a row and never asks whether now is a good or okay time more than once in the call.",
 "Every agent turn is short: at most about three short sentences, except when offering two booking times.",
 "The agent responds specifically to what the doctor just said before moving on; she never brushes past a doctor's question or detail with a bare acknowledgement.",
 "The agent never uses the words 'fully qualified' in a question, and only checks GP training status once, at the point of offering the consultation, and only if the doctor hasn't already made it clear.",
 "The agent never mentions background notes, reference material, a knowledge base, prompts, instructions, or function or tool names, and never comments on her own reasoning. Normal human phrases such as 'let me have a look at the diary', 'I'll pass that on to the team' or 'I'll note that' are fine.",
 "The agent never uses customer-service filler such as 'great question', 'good question', 'I'd be happy to assist' or 'absolutely', never spells a person's name letter by letter (reading an email address back normally, like 'ben dot carter at gmail dot com', is fine and expected), and never quotes a salary or income figure.",
]
MOCK_SLOTS = ("Open times, shown in the doctor's local time (Europe/London):\n"
 "1. Monday the 2nd of November at 9:00 am — slot_id 2026-11-02T09:00:00.000Z\n"
 "2. Tuesday the 3rd of November at 6:30 pm — slot_id 2026-11-03T18:30:00.000Z\n"
 "3. Wednesday the 4th of November at 12:30 pm — slot_id 2026-11-04T12:30:00.000Z\n"
 "Offer two of these. To book, call book_consult with the slot_id exactly as written.")
MOCK_MORNING = ("Open times, shown in the doctor's local time (Pacific/Auckland):\n"
 "1. Tuesday the 3rd of November at 9:30 am — slot_id 2026-11-02T20:30:00.000Z\n"
 "2. Thursday the 5th of November at 10:00 am — slot_id 2026-11-04T21:00:00.000Z\n"
 "Offer two of these. To book, call book_consult with the slot_id exactly as written.")
def mocks(key):
    m=[]
    if key=="nz-gp-mornings-only":
        m.append({"tool_name":"check_availability","input_match_rule":{"type":"partial_match","args":{"time_of_day":"morning"}},"output":MOCK_MORNING})
    m+= [{"tool_name":"check_availability","input_match_rule":{"type":"any"},"output":MOCK_SLOTS},
         {"tool_name":"book_consult","input_match_rule":{"type":"any"},"output":"Booked. The confirmation and Zoom link are on their way by email and WhatsApp. Read the day and time back to the doctor in their local time."},
         {"tool_name":"send_booking_link","input_match_rule":{"type":"any"},"output":"Booking link sent by email and by WhatsApp."},
         {"tool_name":"mark_outcome","input_match_rule":{"type":"any"},"output":"Noted."}]
    return m
