import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.text({ type: ['text/*', '*/plain'], limit: '2mb' }));

const SHEET_ID = process.env.SPREADSHEET_ID;
const KEY_FILE = process.env.GCP_SERVICE_ACCOUNT_FILE;
const KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON;

if (!SHEET_ID) {
  console.error('Missing SPREADSHEET_ID');
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
    throw new Error('Set GCP_SERVICE_ACCOUNT_JSON or GCP_SERVICE_ACCOUNT_FILE');
  }
} catch (e) {
  console.error('Failed to load Google credentials:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });

function safeBody(req) {
  const b = req.body;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return {}; }
  }
  return b || {};
}

// prefer outputs.lead; fall back to older shapes if present
function extractLead(p) {
  const tryJSON = v => {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
    return v && typeof v === 'object' ? v : {};
  };

  const lead =
    tryJSON(p.outputs?.lead) ||
    tryJSON(p.lead) ||
    tryJSON(p.structuredData) ||
    tryJSON(p.analysis?.structuredData) ||
    {};

  // last-ditch fallback: map from caller/qualifications into lead shape
  const caller = p.outputs?.caller || p.caller || {};
  const quals  = p.outputs?.qualifications || p.qualifications || {};

  return {
    name:     lead.name     ?? caller.name     ?? '',
    phone:    lead.phone    ?? caller.phone    ?? '',
    email:    lead.email    ?? caller.email    ?? '',
    role:     lead.role     ?? quals.role      ?? '',
    inquiry:  lead.inquiry  ?? quals.inquiry   ?? '',
    market:   lead.market   ?? quals.market    ?? '',
    dealSize: lead.dealSize ?? lead.deal_size  ?? quals.deal_size ?? '',
    urgency:  lead.urgency  ?? quals.urgency   ?? '',
  };
}

function compactRaw(p) {
  const keep = {
    event: p.event || p.type || undefined,
    callId: p.callId || p.call_id || p.event?.call?.id || undefined,
    outputsKeys: p.outputs ? Object.keys(p.outputs) : undefined,
  };
  return JSON.stringify(keep).slice(0, 900);
}

app.post('/vapi/webhook', async (req, res) => {
  try {
    const p = safeBody(req);

    const brokerage =
      p.assistant?.metadata?.brokerageName ||
      p.metadata?.brokerageName ||
      'Ariel Property Advisors';

    const lead = extractLead(p);
    const summary =
      (p.summary || p.analysis?.summary || p.outputs?.summary || '')
        .toString()
        .slice(0, 300);

    const row = [
      new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
      brokerage,
      lead.name || '',
      lead.phone || '',
      lead.email || '',
      lead.role || '',
      lead.inquiry || '',
      lead.market || '',
      lead.dealSize || '',
      lead.urgency || '',
      summary,
      compactRaw(p)
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    // Always 200 so Vapi doesn't retry
    res.status(200).json({ ok: false, error: String(err) });
  }
});

app.get('/', (_, res) => res.send('Webhook running'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
