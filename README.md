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
3. **Model:** OpenAI `gpt-4o`, Temperature `0.1`.
4. Paste the contents of [`vapi/system_prompt.txt`](vapi/system_prompt.txt) into the System Prompt field.
5. **Voice:** ElevenLabs/Cartesia — a professional female voice.
6. **First Message:** `"Hello, this is Maya calling from Kapture Finance. Am I speaking with Mr. Rahul Sharma?"`
7. Go to **Tools** (global, left sidebar — not the assistant's own Tools tab) → **Create Tool** → type **apiRequest**. Create one tool per entry in [`vapi/tool_definitions.json`](vapi/tool_definitions.json): set its Name, Description, Request URL (your ngrok URL + the tool's dedicated path, e.g. `/webhook/verify-customer`), Method `POST`, and build the Request Body schema from the `body` field in that JSON. Repeat for all 5 tools.
8. Go back to the Assistant → its own **Tools** tab → attach all 5 tools you just created.
9. Publish the assistant.

> **Why `apiRequest` tools with 5 separate URLs, not one shared webhook?** Vapi's `apiRequest` tool type POSTs its defined body directly to the URL you configure — it doesn't include the tool's name in the payload the way a wrapped function-call webhook would. So each tool needs its own URL path (`/webhook/verify-customer`, `/webhook/log-promise-to-pay`, etc.) for the mock server to know which handler to run. `mock-server/server.js` implements both: the original `/webhook` route (wrapped `tool-calls` format, for reference/portability) and the 5 dedicated `apiRequest`-style routes actually used in this build.

### 3.4.1 Why these providers

- **Deepgram Nova-2 (STT):** low-latency streaming transcription (~200ms) purpose-built for telephony audio, with solid English + Hindi/English code-switch support via the `multi` language mode — matches the bilingual requirement without a second transcriber.
- **GPT-4o @ temperature 0.1 (LLM):** strong instruction-following for a state-locked script, and a low temperature specifically to suppress improvisation — critical since the agent must never disclose debt pre-auth or offer an unauthorized waiver. `gpt-4o-mini` was considered for lower latency/cost but `gpt-4o` was kept for this build for stronger adherence to the multi-branch negotiation logic.
- **ElevenLabs/Cartesia (TTS):** natural, low-latency conversational voices; a calm, professional female voice was chosen to match the "polite, respectful" tone mandated by the compliance guardrails (RBI Fair Practices Code) rather than a more clearly synthetic default voice.

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

## 5. Bugs / Issues Faced (and how they were debugged)

- **Port already in use (`EADDRINUSE: address already in use :::3000`):** happened after an earlier server process was left running in a closed/orphaned terminal. Diagnosed with `netstat -ano | findstr :3000` to get the PID, then killed it with `taskkill /PID <pid> /F` before restarting `npm start` cleanly.
- **`ngrok` not recognized as a command:** the binary wasn't on the Windows PATH after a fresh install. Installed via the Microsoft Store instead, which registers it automatically — verified with `ngrok version` in a **new** terminal window (old windows don't pick up a PATH change).
- **Vapi `apiRequest` tool payload shape mismatch:** the initial `tool_definitions.json` was written assuming Vapi's function-calling webhook format — a single shared `/webhook` URL receiving a wrapped `{ message: { type: "tool-calls", toolCalls: [...] } }` payload. When actually building the tool in the Vapi dashboard, the available type was `apiRequest`, which POSTs its request body directly to a URL with no wrapper and no tool name in the payload. Fixed by giving each of the 5 tools its own dedicated route (`/webhook/verify-customer`, `/webhook/log-promise-to-pay`, etc.) in `server.js`, so the correct handler can be selected purely from the URL path. The original wrapped `/webhook` route was kept in the server for portability to a true function-calling setup.
- **ngrok free-tier URL persistence:** the forwarding URL turned out to stay the same across restarts in this session (`https://untaken-slot-swampland.ngrok-free.dev`), but this isn't guaranteed on the free tier — a URL change would require updating all 5 tool URLs in Vapi again. A paid static domain would remove this fragility for a longer-running deployment.

## 6. Future Enhancements

- Move the auth-gate enforcement from prompt-only to a code-level guard (reject any LLM function call to disclose debt fields unless a `verified` session flag is set server-side).
- Add real payment gateway integration (Razorpay/PayU) behind `send_payment_link`.
- Persist call transcripts + dispositions to a real database (Postgres) instead of in-memory mock responses.
- Add real-time observability dashboard for Containment Rate, PTP Rate, and FCR (see HLD §8).
- Add automatic retry/callback scheduling for `NO_RESPONSE` dispositions within the compliant calling window (08:00–19:00 local time).