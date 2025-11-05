// index.js  (CommonJS)
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ---------- ENV ----------
const SHEET_ID = process.env.SHEET_ID || process.env.SPREADSHEET_ID;
if (!SHEET_ID) {
  console.error('❌ Missing SHEET_ID / SPREADSHEET_ID env var');
  process.exit(1);
}

// Google auth: choose one of these approaches via envs
// 1) GOOGLE_CREDENTIALS: full JSON (minified one-line)
// 2) GOOGLE_APPLICATION_CREDENTIALS: absolute path to service-account.json (e.g., /etc/secrets/service-account.json)
let auth;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    // This uses GOOGLE_APPLICATION_CREDENTIALS if set, or falls back to default ADC.
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
} catch (e) {
  console.error('❌ Google auth init failed:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });

// ---------- HELPERS ----------
const clean = (v) => (v == null ? '' : String(v).trim());
const smallRaw = (obj) => {
  try {
    const j = JSON.stringify(obj || {});
    return j.length > 500 ? j.slice(0, 497) + '...' : j;
  } catch { return ''; }
};
const getCallId = (p) =>
  clean(
    p.call_id || p.callId || p.session_id || p.sessionId ||
    p?.metadata?.call_id || p?.metadata?.session_id || ''
  );

// Try to pull a “lead” object from Vapi structured outputs
const tryExtractLeadSO = (p) => {
  if (p && typeof p.lead === 'object' && p.lead) return p.lead;

  const bags = [
    p?.structured_outputs,
    p?.assistant?.structured_outputs,
    p?.data?.structured_outputs
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

// Extract from caller/qualifications style (your current screenshot)
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
    urgency: q.urgency || q.timeline,
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
  summary: clean(summary || raw?.summary),
});

const hasAnyLeadField = (lead) =>
  ['name','phone','email','role','inquiry','market','dealSize','urgency']
    .some((k) => clean(lead[k]) !== '');

// ---------- ROUTES ----------
app.get('/', (_req, res) => res.send('Realflow Vapi Webhook ✅'));

const seenCallIds = new Set();

app.post('/vapi/webhook', async (req, res) => {
  try {
    const p = req.body || {};

    const brokerage =
      clean(p?.assistant?.metadata?.brokerageName) ||
      clean(p?.assistant?.brokerageName) ||
      'Ariel Property Advisors';

    const callId = getCallId(p);

    // Prefer structured output “lead”, else fall back to caller/qualifications
    const leadSO = tryExtractLeadSO(p);
    const cq = tryExtractCQ(p);
    const merged = normalize({ ...(leadSO || {}), ...cq }, p?.summary);

    // If we don't have any meaningful fields yet, skip (Vapi may fire multiple events)
    if (!hasAnyLeadField(merged)) {
      return res.status(200).json({ ok: true, skipped: 'no useful fields yet' });
    }

    // Avoid double-writes per call
    if (callId) {
      if (seenCallIds.has(callId)) {
        return res.status(200).json({ ok: true, skipped: 'already wrote for this call' });
      }
      seenCallIds.add(callId);
    }

    const row = [
      new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'), // Timestamp
      brokerage,
      merged.name,
      merged.phone,
      merged.email,
      merged.role,
      merged.inquiry,
      merged.market,
      merged.dealSize,
      merged.urgency,
      merged.summary,
      smallRaw({ lead: merged }), // Raw (compact)
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    return res.status(200).json({ ok: true, wrote: true, callId });
  } catch (e) {
    console.error('❌ Webhook error:', e);
    // Return 200 so Vapi doesn’t retry aggressively
    return res.status(200).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on :${PORT}`));
