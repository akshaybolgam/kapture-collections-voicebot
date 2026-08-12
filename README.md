# Kapture Collections Voicebot — "Maya"

An automated outbound Voice AI Collections Agent built on **Vapi.ai** for **Kapture Finance**. Maya authenticates a customer before disclosing any debt information, negotiates a Promise-to-Pay (PTP), dispatches payment links, and logs a compliant call disposition — all through a strict, state-locked conversation flow.

---

## 1. Architecture Overview

```
Customer (Phone) 
      │
      ▼
Telephony / SIP  ──►  Vapi Engine
      │                    │
      ▼                    ▼
Deepgram STT (nova-2)   Orchestrator (GPT-4o, temp=0.1)
      │                    │
      │                    ├──► Tool Calls ──► Mock Webhook Server (Express)
      │                    │                        │
      │                    ◄────────────────────────┘ (JSON results)
      ▼                    ▼
ElevenLabs / Cartesia TTS  ──►  Customer (Phone)
```

The full sequence diagram (Mermaid) lives in [`docs/HLD_Document.md`](docs/HLD_Document.md).

**Pipeline:** Telephony (SIP/PSTN) → STT (Deepgram Nova-2) → Orchestrator/LLM (GPT-4o) → Tool calls to mock server → TTS (ElevenLabs/Cartesia) → Telephony out.

**Target end-to-end latency:** < 1.2s (STT ~200ms, LLM first byte ~400ms, TTS ~300ms, network ~200ms).

---

## 2. Repository Structure

```
kapture-collections-voicebot/
├── README.md
├── docs/
│   ├── HLD_Document.md
│   └── System_Architecture.png
├── vapi/
│   ├── system_prompt.txt
│   └── tool_definitions.json
├── mock-server/
│   ├── package.json
│   ├── server.js
│   └── .env.example
└── tests/
    └── test_cases.json
```

---

## 3. Setup Guide

### 3.1 Prerequisites
- Node.js v18+
- A free [Vapi.ai](https://vapi.ai) account
- [ngrok](https://ngrok.com) account (free tier is fine)
- API keys for Deepgram, OpenAI (or Anthropic), and ElevenLabs/Cartesia — Vapi lets you use its own trial credits, so you don't strictly need your own keys for a demo.

### 3.2 Run the mock webhook server

```bash
cd mock-server
npm install
cp .env.example .env
npm start
```

The server starts on `http://localhost:3000` and exposes `POST /webhook`.

### 3.3 Expose it publicly with ngrok

```bash
ngrok http 3000
```

Copy the generated HTTPS forwarding URL, e.g. `https://abcd-1234.ngrok-free.app`. Your Vapi webhook URL becomes:

```
https://abcd-1234.ngrok-free.app/webhook
```

### 3.4 Configure the Vapi Assistant

1. Log in to the Vapi dashboard → **Assistants** → **Create Assistant** → **Blank Template**.
2. **Transcriber:** Deepgram, model `nova-2`, language `en` (or `multi` for Hindi/English switching).
3. **Model:** OpenAI `gpt-4o` (or `gpt-4o-mini`), Temperature `0.1`.
4. Paste the contents of [`vapi/system_prompt.txt`](vapi/system_prompt.txt) into the System Prompt field.
5. **Voice:** ElevenLabs or Cartesia — pick a professional female voice (e.g. "Sarah" / "Rachel").
6. **First Message:** `"Hello, this is Maya calling from Kapture Finance. Am I speaking with Mr. Rahul Sharma?"`
7. Go to the **Tools** tab and add each function from [`vapi/tool_definitions.json`](vapi/tool_definitions.json). Set every tool's **Server URL** to your ngrok webhook URL from step 3.3.
8. Save the assistant.

### 3.5 Test it

Use Vapi's **Web Call** (talk directly in the browser) or link a phone number under **Phone Numbers**, then call it.

**Scenario A — Happy Path (PTP):**
> "Yes, this is Rahul" → "1234" (verification code) → agrees to pay Friday → link sent → disposition logged.

**Scenario B — Already Paid:**
> "Yes, this is Rahul" → "1234" → "I already paid yesterday via UPI!" → disposition `ALREADY_PAID` logged.

Watch your terminal running `server.js` — every tool call is logged there in real time.

### 3.6 Record the demo

Use Loom/OBS to record a 2–4 minute video showing both scenarios above, then export it alongside this repo.

---

## 4. Design Choices

- **Low temperature (0.1):** Minimizes hallucinated debt amounts, unauthorized waivers, or off-script disclosures — critical for a regulated collections use case.
- **Hard state lock on `AUTH_PENDING → AUTHENTICATED`:** The system prompt explicitly forbids any debt-related vocabulary until `verify_customer` returns `verified: true`. This is enforced at the prompt layer today; a production system should also enforce it at the orchestration/code layer (see Future Enhancements).
- **Mock server returns synchronous JSON:** Matches Vapi's expected `results[].toolCallId / result` response shape so tool calls resolve inline during the live call with no added latency.
- **Disposition enum is closed:** `mark_disposition` only accepts a fixed set of statuses so downstream reporting/analytics stay consistent.

## 5. Bugs / Issues Faced

- Vapi requires the webhook to respond within a few seconds or the tool call will time out mid-call — keep the mock server's logic synchronous and fast.
- ngrok free-tier URLs rotate on every restart; the Vapi tool Server URLs must be updated each time ngrok is restarted (a paid static domain avoids this).
- Deepgram `nova-2` in `multi` language mode occasionally misses fast Hindi-English code-switching; a stronger fallback prompt instruction was added to keep state even if a turn's transcript is partially garbled.

## 6. Future Enhancements

- Move the auth-gate enforcement from prompt-only to a code-level guard (reject any LLM function call to disclose debt fields unless a `verified` session flag is set server-side).
- Add real payment gateway integration (Razorpay/PayU) behind `send_payment_link`.
- Persist call transcripts + dispositions to a real database (Postgres) instead of in-memory mock responses.
- Add real-time observability dashboard for Containment Rate, PTP Rate, and FCR (see HLD §8).
- Add automatic retry/callback scheduling for `NO_RESPONSE` dispositions within the compliant calling window (08:00–19:00 local time).