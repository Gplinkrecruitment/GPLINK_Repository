# Phone calling for Hazel, and Twilio vs DoubleTick for WhatsApp (29 October 2026)

## Bottom line

1. Retell does not require Twilio, but it does require a carrier of your own for UK and Australian numbers: Retell only sells US and Canadian numbers, and a +1 caller ID on a UK mobile gets ignored. You bring a number in over a SIP trunk from Twilio, Telnyx or Vonage; Retell charges nothing for that. Twilio is the least paperwork: a UK mobile number is USD 2.50 a month with no documents for a non-UK business, an AU mobile is USD 8.25 a month. That is the plan already written up in docs/lead-calls/SETUP.md.
2. Twilio can send WhatsApp, and Meta's per-message fees are identical whoever you use, but Twilio is an API, not a product. It has no team inbox, no broadcast screen, no chatbot builder and no WhatsApp forms unless you buy Flex (from USD 35 per user per month) or build them into the app. At your volumes the switch saves little or nothing and costs weeks of development. Keep DoubleTick.

## What the GP Link app actually uses DoubleTick for

From the code in server.js (about 770 lines touch DoubleTick or WhatsApp):
- nine approved templates (match accepted, interview times ready, interview confirmed for GP and for practice, AHPRA docs complete, the AHPRA, AMC and MyIntealth introductory messages, RSO welcome), sent through public.doubletick.io
- free-text session replies
- an inbound webhook with signature checks (and a test that inbound messages are never left unanswered)
- conversations created and assigned to the GP's RSO, with tags and custom fields
- the DoubleTick inbox embedded inside the app (doubletick.io/embed/conversations/...) so RSOs reply without leaving GP Link
- nudges, consult follow-ups, call reminders and Zoom invites that all go out as WhatsApp messages

Moving to Twilio means rewriting every one of those calls, re-approving templates under a new WhatsApp Business Account, rebuilding assignment and tags, and replacing the embedded inbox with Flex or something you build. Chat history does not migrate.

## Calling: the numbers (USD)

| | Twilio UK | Twilio AU | Telnyx |
|---|---|---|---|
| Mobile number | 2.50 a month, no documents | 8.25 a month, address plus registry proof | UK from 1 a month; AU mobiles need an AU address, utility bill and ID check |
| Local number | 3.50 a month, needs a UK address | 3.00 a month, needs AU address, ASIC extract, ABN and ID | similar paperwork |
| Outbound to a mobile | 0.0305 a minute | 0.075 a minute | about 0.022 a minute (UK) |
| Outbound to a landline | 0.0158 a minute | 0.0252 a minute | about 0.006 a minute (UK) |

So telephony adds about 3 cents a minute on a UK call on top of Hazel's own cost. Retell's own numbers would cost 0.10 a minute to the UK and show a US number, so they are the wrong choice. For Australia, enable Australia under Twilio Voice Geo Permissions and in the number's allowed outbound countries, or calls fail with SIP 403. You can also present GP Link's existing mobile as the caller ID after verifying it in Twilio. UK rule: automated marketing calls need consent, so keep Hazel to people who enquired.

## WhatsApp: Twilio vs DoubleTick

| | DoubleTick | Twilio |
|---|---|---|
| Template sends via API | yes (Pro plan) | yes |
| Two-way inbox for the team | built in, web and mobile apps | Flex (paid) or build your own |
| Broadcasts to lists | UI with segments and scheduling | API only, no screen |
| Sequences and chatbots | Bot Studio, drip flows, AI agents | Studio flows (code-like) |
| WhatsApp forms, catalogue | yes | build them |
| Analytics | campaign and agent dashboards | raw logs |
| Per-message platform fee | wallet pass-through of Meta fees | 0.005 per message plus Meta fees |
| Meta fees (UK) | marketing 0.0635, utility 0.022 | same |
| Rough monthly cost at 2,000 messages | plan 35 to 140 plus Meta about 68 = 105 to 210 | Meta 68 plus Twilio 10 plus Conversations 15 plus Flex 70 to 160 = 165 to 255 (about 95 if you build the inbox yourself) |
| Rough monthly cost at 10,000 messages | about 400 to 510 | about 600 to 690 (about 440 self-built) |
| Setup effort | done | weeks, plus ongoing development |

DoubleTick's published pricing is quote-based; use your invoice for the exact plan figure. Migrating the WhatsApp number from one provider to another keeps the display name, quality rating and approved templates but loses chat history and anything pending.

## Recommendation

- Calling: Twilio UK mobile plus AU mobile numbers on an Elastic SIP trunk to Retell, exactly as SETUP.md describes. About 20 minutes of setup plus the approval wait. Telnyx is cheaper per minute but the AU paperwork is heavier; worth revisiting only at high volume.
- WhatsApp: stay on DoubleTick. The "one provider" goal is already met at the integration layer, because the app drives DoubleTick through its API and webhooks. Revisit if volume passes roughly 20,000 messages a month, if DoubleTick's per-agent pricing climbs, or if you decide to build the inbox into the app anyway.

Sources: Retell pricing and telephony docs (retellai.com/pricing, docs.retellai.com/deploy/custom-telephony, /deploy/twilio, /deploy/telnyx, /deploy/international-call), Twilio voice pricing for GB and AU, Twilio UK and AU regulatory guidelines, Twilio WhatsApp pricing, Flex and Conversations pricing, Meta WhatsApp pricing (developers.facebook.com/docs/whatsapp/pricing), Telnyx number and SIP pricing, DoubleTick pricing and docs.
