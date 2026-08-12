/**
 * Kapture Finance Collections Voicebot — Mock Webhook Server
 * ------------------------------------------------------------
 * Implements the 5 tools Maya (the Vapi assistant) calls during a live call:
 *   - verify_customer
 *   - log_promise_to_pay
 *   - send_payment_link
 *   - escalate_to_agent
 *   - mark_disposition
 *
 * Responds in the shape Vapi expects for tool-call results:
 *   { results: [ { toolCallId, result } ] }
 *
 * Run:
 *   npm install
 *   cp .env.example .env
 *   npm start
 *
 * Then expose publicly for Vapi with:
 *   ngrok http 3000
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const VALID_CODES = (process.env.MOCK_VALID_VERIFICATION_CODES || '1234,1995')
  .split(',')
  .map((c) => c.trim());
const MOCK_ACCOUNT_ID = process.env.MOCK_ACCOUNT_ID || 'ACC-88392';
const MOCK_OUTSTANDING_AMOUNT = Number(process.env.MOCK_OUTSTANDING_AMOUNT || 8499);

// --- In-memory "database" (mock only — replace with real persistence in production) ---
const db = {
  verifications: {}, // account_id -> { verified, attempts, verifiedAt }
  promisesToPay: [], // { id, account_id, ptp_date, amount, createdAt }
  paymentLinks: [], // { account_id, channel, sentAt }
  escalations: [], // { account_id, reason, queuedAt }
  dispositions: [], // { account_id, status, notes, timestamp }
};

// --- Helpers -------------------------------------------------------------

/** Masks a name for safe logging, e.g. "Rahul Sharma" -> "Rahul S****" */
function maskName(fullName) {
  if (!fullName) return fullName;
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const maskedLast = last[0] + '*'.repeat(Math.max(last.length - 1, 1));
  return [...parts.slice(0, -1), maskedLast].join(' ');
}

function nowIso() {
  return new Date().toISOString();
}

function generatePtpId() {
  return `PTP-${Math.floor(1000 + Math.random() * 9000)}`;
}

function logToolCall(name, args) {
  // Never log the raw verification_code value — mask it.
  const safeArgs = { ...args };
  if (safeArgs.verification_code) safeArgs.verification_code = '****';
  console.log(`[${nowIso()}] [Tool Call] ${name}`, JSON.stringify(safeArgs));
}

// --- Tool handlers ---------------------------------------------------------

function handleVerifyCustomer(args) {
  const { account_id, verification_code } = args;
  const record = db.verifications[account_id] || { verified: false, attempts: 0 };
  record.attempts += 1;

  const isValid = VALID_CODES.includes(String(verification_code));
  record.verified = isValid;
  if (isValid) record.verifiedAt = nowIso();
  db.verifications[account_id] = record;

  if (isValid) {
    return {
      verified: true,
      message: 'Identity verified successfully.',
      customer_name: 'Rahul Sharma',
      attempts_used: record.attempts,
    };
  }

  return {
    verified: false,
    message: 'Verification failed. Incorrect code.',
    attempts_used: record.attempts,
  };
}

function handleLogPromiseToPay(args) {
  const { account_id, ptp_date, amount } = args;

  if (!ptp_date || !amount) {
    return { success: false, message: 'Missing ptp_date or amount.' };
  }

  const ptp = {
    id: generatePtpId(),
    account_id,
    ptp_date,
    amount,
    createdAt: nowIso(),
  };
  db.promisesToPay.push(ptp);

  return {
    success: true,
    ptp_id: ptp.id,
    confirmed_date: ptp.ptp_date,
    amount: ptp.amount,
  };
}

function handleSendPaymentLink(args) {
  const { account_id, channel } = args;
  const allowed = ['SMS', 'WhatsApp', 'BOTH'];

  if (!allowed.includes(channel)) {
    return { success: false, message: `Invalid channel. Must be one of: ${allowed.join(', ')}` };
  }

  db.paymentLinks.push({ account_id, channel, sentAt: nowIso() });

  return {
    success: true,
    message: `Payment link sent successfully via ${channel} to registered mobile number.`,
    // Mock link — replace with a real payment gateway URL in production.
    link: `https://pay.kapturefinance.example/${account_id}?ref=${generatePtpId()}`,
  };
}

function handleEscalateToAgent(args) {
  const { account_id, reason } = args;
  const allowed = ['HARDSHIP_REQUEST', 'DISPUTE'];

  if (!allowed.includes(reason)) {
    return { success: false, message: `Invalid reason. Must be one of: ${allowed.join(', ')}` };
  }

  db.escalations.push({ account_id, reason, queuedAt: nowIso() });

  return {
    success: true,
    queued: true,
    message: `Case escalated to human agent queue (${reason}).`,
    queue_position: db.escalations.length,
  };
}

function handleMarkDisposition(args) {
  const { account_id, status, notes } = args;
  const allowed = [
    'PTP_AGREED',
    'ALREADY_PAID',
    'DISPUTED',
    'HARDSHIP_ESCALATED',
    'WRONG_PERSON',
    'DO_NOT_CALL',
    'NO_RESPONSE',
  ];

  if (!allowed.includes(status)) {
    return { success: false, message: `Invalid status. Must be one of: ${allowed.join(', ')}` };
  }

  const disposition = { account_id, status, notes: notes || '', timestamp: nowIso() };
  db.dispositions.push(disposition);

  return {
    success: true,
    disposition_logged: disposition.status,
    timestamp: disposition.timestamp,
  };
}

// Dispatch table: tool name -> handler
const TOOL_HANDLERS = {
  verify_customer: handleVerifyCustomer,
  log_promise_to_pay: handleLogPromiseToPay,
  send_payment_link: handleSendPaymentLink,
  escalate_to_agent: handleEscalateToAgent,
  mark_disposition: handleMarkDisposition,
};

// --- Routes ----------------------------------------------------------------

// Health check — useful for confirming ngrok/deploy is reachable before wiring up Vapi.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', time: nowIso() });
});

// Main webhook endpoint Vapi calls for tool execution and other call events.
app.post('/webhook', (req, res) => {
  const { message } = req.body || {};

  if (!message) {
    return res.status(400).json({ status: 'error', message: 'Missing "message" in request body.' });
  }

  // Vapi sends various event types on this same webhook (status updates, end-of-call
  // reports, etc). We only need to act on 'tool-calls'; everything else is acknowledged.
  if (message.type === 'tool-calls') {
    const toolCalls = message.toolCalls || [];

    const results = toolCalls.map((toolCall) => {
      const { name, arguments: args } = toolCall.function || {};
      const callId = toolCall.id;

      logToolCall(name, args || {});

      const handler = TOOL_HANDLERS[name];
      const result = handler
        ? handler(args || {})
        : { success: false, message: `Unknown function: ${name}` };

      return {
        toolCallId: callId,
        result: JSON.stringify(result),
      };
    });

    return res.status(200).json({ results });
  }

  // Fallback for non tool-call events (status-update, end-of-call-report, etc).
  console.log(`[${nowIso()}] [Event] ${message.type || 'unknown'}`);
  return res.status(200).json({ status: 'acknowledged' });
});

// --- Dedicated per-tool routes ---------------------------------------------
// Vapi's "apiRequest" tool type POSTs the plain request body you define
// directly to a URL you set per-tool — it does NOT use the wrapped
// { message: { type: 'tool-calls', ... } } format above. Point each of the
// 5 tools in Vapi at its own path below instead of sharing /webhook.

function makeApiRequestRoute(toolName, handler) {
  return (req, res) => {
    const args = req.body || {};
    logToolCall(toolName, args);
    const result = handler(args);
    return res.status(200).json(result);
  };
}

app.post('/webhook/verify-customer', makeApiRequestRoute('verify_customer', handleVerifyCustomer));
app.post('/webhook/log-promise-to-pay', makeApiRequestRoute('log_promise_to_pay', handleLogPromiseToPay));
app.post('/webhook/send-payment-link', makeApiRequestRoute('send_payment_link', handleSendPaymentLink));
app.post('/webhook/escalate-to-agent', makeApiRequestRoute('escalate_to_agent', handleEscalateToAgent));
app.post('/webhook/mark-disposition', makeApiRequestRoute('mark_disposition', handleMarkDisposition));

// Simple read-only endpoint to eyeball what's been logged during a demo/test run.
app.get('/debug/state', (req, res) => {
  res.status(200).json({
    account_id: MOCK_ACCOUNT_ID,
    outstanding_amount: MOCK_OUTSTANDING_AMOUNT,
    verifications: db.verifications,
    promisesToPay: db.promisesToPay,
    paymentLinks: db.paymentLinks,
    escalations: db.escalations,
    dispositions: db.dispositions,
  });
});

// Basic error handler.
app.use((err, req, res, next) => {
  console.error(`[${nowIso()}] [Error]`, err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Kapture Mock Collections Webhook Server running on port ${PORT}`);
  console.log(`Health check:   http://localhost:${PORT}/health`);
  console.log(`Debug state:    http://localhost:${PORT}/debug/state`);
  console.log(`Webhook (Vapi): http://localhost:${PORT}/webhook`);
});