import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();

// Vapi sometimes posts large payloads; 2mb is plenty.
app.use(bodyParser.json({ limit: '2mb' }));

// ---------- ENV ----------
const SHEET_ID = process.env.SPREADSHEET_ID;
const KEY_FILE = process.env.GCP_SERVICE_ACCOUNT_FILE;   // local dev optional
const KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON;   // Render recommended
const SHEET_LAYOUT = (process.env.SHEET_LAYOUT || 'multi').toLowerCase(); // 'multi' | 'single'

if (!SHEET_ID) {
  console.error('Missing SPREADSHEET_ID');
  process.exit(1);
}

// ---------- Google Auth ----------
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
  console.error('Failed to load Google credentials:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });

// ---------- Helpers ----------
const safe = (v) => (v ?? '').toString().trim();
const oneLine = (v) => safe(v).replace(/\s+/g, ' ').slice(0, 7000);
const utcNow = () => new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');

function fallbackParseFromText(text) {
  const out = {};
  if (!text) return out;

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) out.email = emailMatch[0];

  const phoneMatch = text.match(/(\+?\d[\d\s\-().]{8,}\d)/);
  if (phoneMatch) out.phone = phoneMatch[0];

  // Very light name heuristic: look for "my name is X" or "this is X"
  const nameMatch = text.match(/(?:my name is|this is)\s+([A-Za-z][A-Za-z .'-]{1,40})/i);
  if (nameMatch) out.name = nameMatch[1].trim();

  return out;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safe(v);
    if (s) return s;
  }
  return '';
}

// ---------- Webhook ----------
app.post('/vapi/webhook', async (req, res) => {
  try {
    const p = req.body || {};

    // Only log once the call has actually finished
    const eventType = p?.type || p?.event || '';
    if (eventType && !/completed|call\.completed/i.test(eventType)) {
      return res.json({ ok: true, skipped: true });
    }

    // Common nests seen in Vapi payloads
    const call = p.call || p;  // sometimes the root is already the call
    const analysis = call.analysis || p.analysis || {};
    const structured = analysis.structuredData || p.structuredData || p.data || {};
    const quals = p.qualifications || call.qualifications || structured || {};
    const meta = (p.assistant && p.assistant.metadata) || (call.assistant && call.assistant.metadata) || {};
    const caller = p.caller || call.caller || {};

    // Pull text sources for fallback extraction
    const summaryText = firstNonEmpty(p.summary, p.final_summary, analysis.summary, analysis.callSummary);
    const transcriptText = firstNonEmpty(analysis.transcript, p.transcript, p.text);

    // Backfill from transcript if missing
    const fromText = fallbackParseFromText([summaryText, transcriptText].filter(Boolean).join('  '));

    const rowObj = {
      timestamp: utcNow(),
      brokerage: firstNonEmpty(meta.brokerageName, 'Ariel Property Advisors'),
      name: firstNonEmpty(caller.name, structured.name, quals.name, fromText.name),
      phone: firstNonEmpty(caller.phone, structured.phone, quals.phone, fromText.phone),
      email: firstNonEmpty(caller.email, structured.email, quals.email, fromText.email),
      role: firstNonEmpty(quals.role, structured.role),
      inquiry: firstNonEmpty(quals.inquiry, structured.inquiry, structured.assetType, structured.asset),
      market: firstNonEmpty(quals.market, structured.market, structured.location, structured.neighborhood),
      deal_size: firstNonEmpty(quals.deal_size, structured.deal_size, structured.budget, structured.loan_size),
      urgency: firstNonEmpty(quals.urgency, structured.urgency, structured.timeline),
      summary: oneLine(summaryText),
      raw_json: oneLine(JSON.stringify(p)),
    };

    // Build values depending on layout
    let values;
    if (SHEET_LAYOUT === 'single') {
      const line =
        `[${rowObj.timestamp}] ${rowObj.brokerage} | ` +
        `Name: ${rowObj.name} | Phone: ${rowObj.phone} | Email: ${rowObj.email} | Role: ${rowObj.role} | ` +
        `Inquiry: ${rowObj.inquiry} | Market: ${rowObj.market} | Deal: ${rowObj.deal_size} | ` +
        `Urgency: ${rowObj.urgency} | Summary: ${rowObj.summary}`;
      values = [[line]];
    } else {
      values = [[
        rowObj.timestamp,
        rowObj.brokerage,
        rowObj.name,
        rowObj.phone,
        rowObj.email,
        rowObj.role,
        rowObj.inquiry,
        rowObj.market,
        rowObj.deal_size,
        rowObj.urgency,
        rowObj.summary,
        rowObj.raw_json
      ]];
    }

    const range = (SHEET_LAYOUT === 'single') ? 'Sheet1!A:A' : 'Sheet1!A:L';

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.json({ ok: false, error: String(err) });
  }
});

// Health checks
app.get('/', (_, res) => res.send('Webhook running'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on port', PORT));
