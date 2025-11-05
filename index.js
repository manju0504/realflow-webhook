// index.js (CommonJS) — FINAL
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ===== ENV =====
const SHEET_ID = process.env.SHEET_ID || process.env.SPREADSHEET_ID;
const SHEET_RANGE = process.env.SHEET_RANGE || 'Sheet1!A:L'; // <-- change tab/range here if needed

if (!SHEET_ID) {
  console.error('❌ Missing SHEET_ID / SPREADSHEET_ID env var');
  process.exit(1);
}

// ===== GOOGLE AUTH =====
// Option A: GOOGLE_CREDENTIALS (full JSON as a single line)
// Option B: GOOGLE_APPLICATION_CREDENTIALS (path to file, e.g., /etc/secrets/service-account.json)
let auth;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else {
    auth = new google.auth.GoogleAuth({
      // uses GOOGLE_APPLICATION_CREDENTIALS if set, else default ADC
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }
} catch (e) {
  console.error('❌ Google auth init failed:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });

// ===== HELPERS =====
const clean = (v) => (v == null ? '' : String(v).trim());
const smallRaw = (obj) => {
  try {
    const j = JSON.stringify(obj || {});
    return j.length > 1000 ? j.slice(0, 997) + '...' : j; // keep Raw compact
  } catch { return ''; }
};

const getCallId = (p) =>
  clean(
    p.call_id || p.callId || p.session_id || p.sessionId ||
    p?.metadata?.call_id || p?.metadata?.session_id || p?.assistant?.callId || ''
  );

// Try to pull a “lead” object from typical structured output containers
const tryExtractLeadSO = (p) => {
  if (p && typeof p.lead === 'object' && p.lead) return p.lead;

  const bags = [
    p?.structured_outputs,
    p?.assistant?.structured_outputs,
    p?.data?.structured_outputs,
    p?.outputs,
    p?.assistant?.outputs
  ].filter(Array.isArray);

  for (const arr of bags) {
    const hit =
      arr.find((x) => (x?.name || '').toLowerCase() === 'lead') ||
      arr.find((x) => x?.type === 'lead' || x?.id === 'lead') ||
      arr.find((x) => x?.lead) ||
      arr.find((x) => x?.data?.lead) ||
      arr.find((x) => x?.data);

    if (hit) return hit.lead || hit.data?.lead || hit.data || hit;
  }
  return null;
};

// Extract from caller/qualifications style
const tryExtractCQ = (p) => {
  const caller = p?.caller || {};
  const q = p?.qualifications || {};
  return {
    name: caller.name,
    phone: caller.phone || caller.number,
    email: caller.email,
    role: q.role,
    inquiry: q.inquiry,
    market: q.market,
    dealSize: q.deal_size || q.dealSize || q.budget,
    urgency: q.urgency || q.timeline
  };
};

const normalize = (raw, summary) => ({
  name: clean(raw?.name),
  phone: clean(raw?.phone),
  email: clean(raw?.email),
  role: clean(raw?.role),
  inquiry: clean(raw?.inquiry),
  market: clean(raw?.market),
  dealSize: clean(raw?.dealSize || raw?.deal_size || raw?.budget),
  urgency: clean(raw?.urgency || raw?.timeline),
  summary: clean(summary || raw?.summary)
});

const hasAnyLeadField = (lead) =>
  ['name', 'phone', 'email', 'role', 'inquiry', 'market', 'dealSize', 'urgency']
    .some((k) => clean(lead[k]) !== '');

// ===== ROUTES =====
app.get('/', (_req, res) => res.send('Realflow Vapi Webhook ✅'));
app.get('/health', (_req, res) => res.json({ ok: true, sheetId: SHEET_ID, range: SHEET_RANGE }));

const seenCallIds = new Set();

app.post('/vapi/webhook', async (req, res) => {
  try {
    const p = req.body || {};

    const brokerage =
      clean(p?.assistant?.metadata?.brokerageName) ||
      clean(p?.assistant?.brokerageName) ||
      'Ariel Property Advisors';

    const callId = getCallId(p);

    // Prefer structured output “lead”, else merge with caller/qualifications
    const leadSO = tryExtractLeadSO(p);
    const cq = tryExtractCQ(p);
    const merged = normalize({ ...(leadSO || {}), ...cq }, p?.summary);

    // No fields yet? This could be an early event — skip silently
    if (!hasAnyLeadField(merged)) {
      return res.status(200).json({ ok: true, skipped: 'no useful fields yet' });
    }

    // Deduplicate per call/session
    if (callId) {
      if (seenCallIds.has(callId)) {
        return res.status(200).json({ ok: true, skipped: 'already wrote for this call' });
      }
      seenCallIds.add(callId);
    }

    // Build row (A:L)
    const row = [
      new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'), // Timestamp
      brokerage,             // B: Brokerage
      merged.name,           // C: Name
      merged.phone,          // D: Phone
      merged.email,          // E: Email
      merged.role,           // F: Role
      merged.inquiry,        // G: Inquiry
      merged.market,         // H: Market
      merged.dealSize,       // I: Deal Size
      merged.urgency,        // J: Urgency
      merged.summary,        // K: Summary
      smallRaw({ lead: merged, callId }) // L: Raw (compact)
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });

    return res.status(200).json({ ok: true, wrote: true, callId });
  } catch (e) {
    console.error('❌ Webhook error:', e);
    // still return 200 so upstream doesn't spam retries
    return res.status(200).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on :${PORT} | range=${SHEET_RANGE}`));
