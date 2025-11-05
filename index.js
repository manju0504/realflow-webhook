// index.js
import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';

const app = express();

// ✅ Accept ANY content-type as JSON and allow larger payloads (Vapi sends big data)
app.use(express.json({ limit: '10mb', type: () => true }));

// ---------------- Google Sheets Auth ----------------
const SHEET_ID = process.env.SPREADSHEET_ID;
const KEY_FILE = process.env.GCP_SERVICE_ACCOUNT_FILE;
const KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON;

if (!SHEET_ID) {
  console.error('❌ Missing SPREADSHEET_ID');
  process.exit(1);
}

let auth;
try {
  if (KEY_JSON && KEY_JSON.trim().startsWith('{')) {
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(KEY_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else if (KEY_FILE) {
    auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    throw new Error('Set GCP_SERVICE_ACCOUNT_JSON (Render) or GCP_SERVICE_ACCOUNT_FILE (local).');
  }
} catch (e) {
  console.error('❌ Failed to load Google credentials:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });
// ----------------------------------------------------

// ---------- Helpers ----------
const pick = (obj, key, fallback = '') =>
  (obj && typeof obj === 'object' && obj[key] != null ? String(obj[key]) : fallback);

function extractLead(payload = {}) {
  const so =
    payload.structured_outputs ||
    payload.structuredOutputs ||
    payload.outputs ||
    payload.output ||
    null;

  let leadFromSO = null;

  if (so && typeof so === 'object' && !Array.isArray(so) && so.lead) {
    leadFromSO = so.lead;
  }
  if (!leadFromSO && Array.isArray(so)) {
    for (const item of so) {
      if (item && item.name === 'lead' && item.data) { leadFromSO = item.data; break; }
      if (item && item.lead) { leadFromSO = item.lead; break; }
    }
  }

  const caller = payload.caller || {};
  const quals = payload.qualifications || {};
  const summary = payload.summary || payload.final_summary || payload.analysis?.summary || '';

  const mapped = {
    name: '', phone: '', email: '', role: '',
    inquiry: '', market: '', dealSize: '', urgency: '', summary
  };

  if (leadFromSO) {
    mapped.name    = pick(leadFromSO, 'name');
    mapped.phone   = pick(leadFromSO, 'phone');
    mapped.email   = pick(leadFromSO, 'email');
    mapped.role    = pick(leadFromSO, 'role');
    mapped.inquiry = pick(leadFromSO, 'inquiry');
    mapped.market  = pick(leadFromSO, 'market');
    mapped.dealSize= pick(leadFromSO, 'dealSize') || pick(leadFromSO, 'deal_size');
    mapped.urgency = pick(leadFromSO, 'urgency');
  } else {
    mapped.name    = pick(caller, 'name');
    mapped.phone   = pick(caller, 'phone');
    mapped.email   = pick(caller, 'email');
    mapped.role    = pick(quals,  'role');
    mapped.inquiry = pick(quals,  'inquiry');
    mapped.market  = pick(quals,  'market');
    mapped.dealSize= pick(quals,  'deal_size') || pick(quals, 'dealSize');
    mapped.urgency = pick(quals,  'urgency');
  }

  return mapped;
}

function smallRaw(obj) {
  try {
    const keep = { lead: {
      name: obj.name || '', phone: obj.phone || '', email: obj.email || '',
      role: obj.role || '', inquiry: obj.inquiry || '', market: obj.market || '',
      dealSize: obj.dealSize || '', urgency: obj.urgency || ''
    }};
    return JSON.stringify(keep);
  } catch { return '{}'; }
}
// ----------------------------------------------------

// ---------- Main Webhook ----------
app.post('/vapi/webhook', async (req, res) => {
  try {
    // 🧠 Debug logs — don’t remove yet!
    console.log(
      'INCOMING PAYLOAD content-type=%s length=%s',
      req.headers['content-type'],
      req.headers['content-length']
    );
    const preview = (() => {
      try {
        const src = req.body?.structured_outputs ?? req.body?.structuredOutputs ?? req.body;
        return JSON.stringify(src, null, 2).slice(0, 2000);
      } catch { return '<unserializable>'; }
    })();
    console.log('INCOMING BODY (trimmed):', preview);

    const p = req.body || {};
    const brokerage =
      p?.assistant?.metadata?.brokerageName ||
      p?.assistant?.brokerageName ||
      'Ariel Property Advisors';

    const lead = extractLead(p);

    const row = [
      new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
      brokerage,
      lead.name,
      lead.phone,
      lead.email,
      lead.role,
      lead.inquiry,
      lead.market,
      lead.dealSize,
      lead.urgency,
      lead.summary || '',
      smallRaw(lead),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});
// ----------------------------------------------------

// ---------- Health Routes ----------
app.get('/', (_req, res) => res.send('Webhook running'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---------- Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ Server listening on', PORT));
