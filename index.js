import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// -------- ENV SETUP --------
const SHEET_ID = process.env.SPREADSHEET_ID;
const KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON;

if (!SHEET_ID || !KEY_JSON) {
  console.error('❌ Missing SPREADSHEET_ID or GCP_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

// -------- GOOGLE AUTH --------
let auth;
try {
  auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(KEY_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
} catch (e) {
  console.error('❌ Invalid Google credentials:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });

// -------- CLEAN HELPERS --------
const safe = (v) => (v ?? '').toString().trim();
const oneLine = (v) => safe(v).replace(/\s+/g, ' ').slice(0, 3000);
const utcNow = () => new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');

const extractFallbacks = (text = '') => {
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0];
  const phone = (text.match(/(\+?\d[\d\s\-().]{8,}\d)/) || [])[0];
  const name = (text.match(/(?:my name is|this is)\s+([A-Za-z][A-Za-z .'-]{1,40})/i) || [])[1];
  return { name, phone, email };
};

// -------- MAIN WEBHOOK --------
app.post('/vapi/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const type = body.type || body.event || '';

    // Only log after call is completed
    if (!/completed/i.test(type)) return res.json({ ok: true, skipped: true });

    const a = body.assistant || {};
    const meta = a.metadata || {};
    const caller = body.caller || {};
    const q = body.qualifications || {};
    const s = body.structuredData || {};
    const analysis = body.analysis || {};
    const summaryText =
      safe(body.summary) ||
      safe(body.final_summary) ||
      safe(analysis.summary) ||
      safe(analysis.callSummary);

    const transcriptText = safe(analysis.transcript || '');
    const textCombined = `${summaryText} ${transcriptText}`;
    const fb = extractFallbacks(textCombined);

    // pick first available value among all paths
    const pick = (...arr) => safe(arr.find((v) => v && v.length > 0));

    const row = [
      utcNow(),
      pick(meta.brokerageName, 'Ariel Property Advisors'),
      pick(caller.name, q.name, s.name, fb.name),
      pick(caller.phone, q.phone, s.phone, fb.phone),
      pick(caller.email, q.email, s.email, fb.email),
      pick(q.role, s.role),
      pick(q.inquiry, s.inquiry),
      pick(q.market, s.market),
      pick(q.deal_size, s.deal_size),
      pick(q.urgency, s.urgency),
      oneLine(summaryText),
      oneLine(JSON.stringify({
        name: pick(caller.name, q.name, s.name, fb.name),
        phone: pick(caller.phone, q.phone, s.phone, fb.phone),
        email: pick(caller.email, q.email, s.email, fb.email),
        role: pick(q.role, s.role),
        inquiry: pick(q.inquiry, s.inquiry),
        market: pick(q.market, s.market),
        deal_size: pick(q.deal_size, s.deal_size),
        urgency: pick(q.urgency, s.urgency),
        summary: oneLine(summaryText)
      }))
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    console.log('✅ Row added successfully');
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.json({ ok: false, error: String(err) });
  }
});

app.get('/', (_, res) => res.send('Webhook running ✅'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server listening on port', PORT));
