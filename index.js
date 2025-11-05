// index.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

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

// ---------- Helpers to normalize payload ------------
const pick = (obj, key, fallback = '') =>
  (obj && typeof obj === 'object' && obj[key] != null ? String(obj[key]) : fallback);

function extractLead(p = {}) {
  // 1) Preferred: Structured Outputs (you created "lead")
  //    Vapi may send as object or array. Handle both.
  const so =
    p.structured_outputs ||
    p.structuredOutputs ||
    p.outputs ||
    p.output ||
    null;

  let leadFromSO = null;

  // If it's an object with "lead"
  if (so && typeof so === 'object' && !Array.isArray(so) && so.lead) {
    leadFromSO = so.lead;
  }

  // If it's an array of structured outputs
  if (!leadFromSO && Array.isArray(so)) {
    for (const item of so) {
      // some shapes: { name:"lead", data:{...} } OR { lead:{...} }
      if (item && item.name === 'lead' && item.data) {
        leadFromSO = item.data;
        break;
      }
      if (item && item.lead) {
        leadFromSO = item.lead;
        break;
      }
    }
  }

  // 2) Older shapes (no structured outputs)
  const caller = p.caller || {};
  const quals = p.qualifications || {};
  const summary = p.summary || p.final_summary || p.analysis?.summary || '';

  // Map into a unified shape
  const mapped = {
    name: '',
    phone: '',
    email: '',
    role: '',
    inquiry: '',
    market: '',
    dealSize: '',
    urgency: '',
    summary,
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
    // fallback to older keys
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
  // Only keep a tiny raw for debugging (no megabytes!)
  try {
    const keep = {
      lead: {
        name: obj.name || '',
        phone: obj.phone || '',
        email: obj.email || '',
        role: obj.role || '',
        inquiry: obj.inquiry || '',
        market: obj.market || '',
        dealSize: obj.dealSize || '',
        urgency: obj.urgency || '',
      },
    };
    return JSON.stringify(keep);
  } catch {
    return '{}';
  }
}
// ----------------------------------------------------

app.post('/vapi/webhook', async (req, res) => {
  try {
    const p = req.body || {};
    const brokerage =
      p?.assistant?.metadata?.brokerageName ||
      p?.assistant?.brokerageName ||
      'Ariel Property Advisors';

    const lead = extractLead(p);

    // Build one clean row (no huge raw)
    const row = [
      new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'), // A: Timestamp
      brokerage,                                                      // B: Brokerage
      lead.name,                                                      // C: Name
      lead.phone,                                                     // D: Phone
      lead.email,                                                     // E: Email
      lead.role,                                                      // F: Role
      lead.inquiry,                                                   // G: Inquiry
      lead.market,                                                    // H: Market
      lead.dealSize,                                                  // I: Deal Size
      lead.urgency,                                                   // J: Urgency
      lead.summary || '',                                             // K: Summary
      smallRaw(lead),                                                 // L: Raw (tiny)
    ];

    // Append to A:L — your header row must have 12 columns
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

app.get('/', (_req, res) => res.send('Webhook running'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ Server listening on', PORT));
