import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ====== ENV ======
const SHEET_ID  = process.env.SPREADSHEET_ID;                   // REQUIRED
const KEY_JSON  = process.env.GCP_SERVICE_ACCOUNT_JSON || '';   // Option A (paste full JSON)
const KEY_FILE  = process.env.GCP_SERVICE_ACCOUNT_FILE  || '';  // Option B (/etc/secrets/service-account.json)

if (!SHEET_ID) {
  console.error('❌ Missing SPREADSHEET_ID');
  process.exit(1);
}

// ====== GOOGLE AUTH (supports JSON or FILE) ======
let auth;
try {
  if (KEY_JSON.trim().startsWith('{')) {
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
    throw new Error('Set GCP_SERVICE_ACCOUNT_JSON (full JSON) OR GCP_SERVICE_ACCOUNT_FILE (/etc/secrets/service-account.json)');
  }
} catch (e) {
  console.error('❌ Google auth error:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });

// ====== HELPERS ======
const safe = (v) => (v ?? '').toString().trim();
const oneLine = (v) => safe(v).replace(/\s+/g, ' ').slice(0, 800);   // short Raw
const nowUTC = () => new Date().toISOString().replace('T',' ').replace('Z',' UTC');

// fallback regex from transcript if Vapi didn’t parse some fields
const extractFromText = (txt='') => {
  const email = (txt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0];
  const phone = (txt.match(/(\+?\d[\d\s\-().]{8,}\d)/) || [])[0];
  const name  = (txt.match(/(?:my name is|this is)\s+([A-Za-z][A-Za-z .'-]{1,40})/i) || [])[1];
  return { name, phone, email };
};

const pick = (...vals) => safe(vals.find(v => v && safe(v).length > 0));

// ====== WEBHOOK ======
app.post('/vapi/webhook', async (req, res) => {
  try {
    const body = req.body || {};

    // Vapi fields (covering multiple versions/keys)
    const a   = body.assistant || {};
    const meta= a.metadata || {};
    const caller = body.caller || {};
    const q   = body.qualifications || {};
    const s   = body.structuredData || {};
    const analysis = body.analysis || {};

    const summary =
      pick(body.summary, body.final_summary, analysis.summary, analysis.callSummary);

    const transcript = safe(analysis.transcript);
    const fb = extractFromText(`${summary} ${transcript}`);

    const row = [
      nowUTC(),                                                       // A Timestamp
      pick(meta.brokerageName, 'Ariel Property Advisors'),            // B Brokerage
      pick(caller.name, q.name, s.name, fb.name),                     // C Name
      pick(caller.phone, q.phone, s.phone, fb.phone),                 // D Phone
      pick(caller.email, q.email, s.email, fb.email),                 // E Email
      pick(q.role, s.role),                                           // F Role
      pick(q.inquiry, s.inquiry),                                     // G Inquiry
      pick(q.market, s.market),                                       // H Market
      pick(q.deal_size, s.deal_size),                                 // I Deal Size
      pick(q.urgency, s.urgency),                                     // J Urgency
      oneLine(summary),                                               // K Summary
      oneLine(JSON.stringify({                                        // L Raw (short)
        name: pick(caller.name, q.name, s.name, fb.name),
        phone: pick(caller.phone, q.phone, s.phone, fb.phone),
        email: pick(caller.email, q.email, s.email, fb.email),
        role: pick(q.role, s.role),
        inquiry: pick(q.inquiry, s.inquiry),
        market: pick(q.market, s.market),
        deal_size: pick(q.deal_size, s.deal_size),
        urgency: pick(q.urgency, s.urgency),
        summary: oneLine(summary)
      }))
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });

    console.log('✅ Appended row to Google Sheet');
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.json({ ok: false, error: String(err) });
  }
});

app.get('/', (_req, res) => res.send('Webhook running ✅'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server listening on port', PORT));
