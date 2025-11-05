// ---------- Imports & App ----------
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ---------- Env ----------
const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.SHEET_ID; // required
if (!SHEET_ID) {
  console.error('❌ Missing SHEET_ID env');
  process.exit(1);
}

// Auth: either GOOGLE_APPLICATION_CREDENTIALS (file path) OR GOOGLE_CREDENTIALS (inline JSON)
let auth;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
} catch (e) {
  console.error('❌ Google auth init failed:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });

// De-dupe memory (per-process). Good enough for Render.
const seenCallIds = new Set();

// ---------- Helpers ----------
const clean = (v) => (v == null ? '' : String(v).trim());

const smallRaw = (lead) => {
  try {
    const j = JSON.stringify(lead || {});
    return j.length > 500 ? j.slice(0, 497) + '...' : j;
  } catch {
    return '';
  }
};

// Pull a likely call/session identifier so we only write once per call
const getCallId = (p) =>
  clean(
    p.call_id ||
    p.callId ||
    p.session_id ||
    p.sessionId ||
    (p.metadata && (p.metadata.call_id || p.metadata.session_id)) ||
    ''
  );

// Find any “lead” structured output regardless of where Vapi put it
const extractLead = (p) => {
  // 1) Direct `lead` object (some screens send it this way)
  if (p && typeof p.lead === 'object' && p.lead) {
    return normalizeLead(p.lead, p.summary);
  }

  // 2) Top-level structured outputs
  const tryCollections = [];
  if (Array.isArray(p?.structured_outputs)) tryCollections.push(p.structured_outputs);
  if (Array.isArray(p?.assistant?.structured_outputs)) tryCollections.push(p.assistant.structured_outputs);
  if (Array.isArray(p?.data?.structured_outputs)) tryCollections.push(p.data.structured_outputs);

  for (const arr of tryCollections) {
    const hit =
      arr.find((x) => (x?.name || '').toLowerCase() === 'lead') ||
      arr.find((x) => x?.type === 'lead' || x?.id === 'lead') ||
      arr.find((x) => x && typeof x === 'object' && (
        x.lead || x.data?.lead || x.data
      ));

    if (hit) {
      // Common shapes:
      // { name:'lead', data:{...} }
      // { lead:{...} }
      // {...fields...}
      const payload = hit.lead || hit.data?.lead || hit.data || hit;
      return normalizeLead(payload, p.summary);
    }
  }

  // Nothing found → return empty
  return normalizeLead({}, p.summary);
};

const normalizeLead = (raw, summary) => {
  // Map & trim everything we care about
  const out = {
    name: clean(raw.name),
    phone: clean(raw.phone),
    email: clean(raw.email),
    role: clean(raw.role),
    inquiry: clean(raw.inquiry),
    market: clean(raw.market),
    dealSize: clean(raw.dealSize || raw.deal_size || raw.budget),
    urgency: clean(raw.urgency || raw.timeline),
    summary: clean(summary || raw.summary),
  };
  return out;
};

const hasAnyLeadField = (lead) =>
  Object.entries(lead).some(([k, v]) => k !== 'summary' && clean(v) !== '');

// ---------- Routes ----------
app.get('/', (req, res) => {
  res.send('OK');
});

app.post('/vapi/webhook', async (req, res) => {
  try {
    const p = req.body || {};

    // Pull brokerage label (you set this in Assistant metadata)
    const brokerage =
      clean(p?.assistant?.metadata?.brokerageName) ||
      clean(p?.assistant?.brokerageName) ||
      'Ariel Property Advisors';

    const callId = getCallId(p);
    const lead = extractLead(p);

    // Only write when a real structured output is present
    if (!hasAnyLeadField(lead)) {
      return res.status(200).json({ ok: true, skipped: 'no structured output yet' });
    }

    // De-dupe: write once per call/session
    if (callId) {
      if (seenCallIds.has(callId)) {
        return res.status(200).json({ ok: true, skipped: 'already wrote for this call' });
      }
      seenCallIds.add(callId);
    }

    // Row A–L
    const row = [
      new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'), // A Timestamp
      brokerage,                         // B Brokerage
      lead.name,                         // C
      lead.phone,                        // D
      lead.email,                        // E
      lead.role,                         // F
      lead.inquiry,                      // G
      lead.market,                       // H
      lead.dealSize,                     // I
      lead.urgency,                      // J
      lead.summary || '',                // K Summary
      smallRaw(lead),                    // L Raw (tiny JSON)
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    return res.status(200).json({ ok: true, wrote: true, callId });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    // Always 200 so Vapi doesn’t retry, but include the error for visibility
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
