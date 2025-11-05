import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();
app.use(bodyParser.json({ limit: '2mb', type: ['application/json','text/json','application/*+json'] }));
app.use(bodyParser.urlencoded({ extended: true }));

// ---- ENV ----
const SHEET_ID = process.env.SPREADSHEET_ID;
const KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON || '';
const KEY_FILE = process.env.GCP_SERVICE_ACCOUNT_FILE  || '';
if (!SHEET_ID) { console.error('❌ Missing SPREADSHEET_ID'); process.exit(1); }

// ---- GOOGLE AUTH ----
let auth;
try {
  if (KEY_JSON.trim().startsWith('{')) {
    auth = new google.auth.GoogleAuth({ credentials: JSON.parse(KEY_JSON), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  } else if (KEY_FILE) {
    auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  } else {
    throw new Error('Set GCP_SERVICE_ACCOUNT_JSON or GCP_SERVICE_ACCOUNT_FILE');
  }
} catch (e) { console.error('❌ Google auth error', e); process.exit(1); }

const sheets = google.sheets({ version: 'v4', auth });

// ---- HELPERS ----
const safe = (v) => (v ?? '').toString().trim();
const oneLine = (v) => safe(v).replace(/\s+/g, ' ').slice(0, 380); // keep Raw < 400
const nowUTC = () => new Date().toISOString().replace('T',' ').replace('Z',' UTC');

const pickPath = (obj, paths) => {
  for (const p of paths) {
    try {
      const val = p.split('.').reduce((a, k) => (a ? a[k] : undefined), obj);
      if (val !== undefined && safe(val) !== '') return val;
    } catch {}
  }
  return '';
};

// stricter phone (>=10 digits), ignores $3–5M etc.
const cleanPhone = (s) => {
  const candidates = []
    .concat(safe(s))
    .flatMap(str => (str.match(/(\+?\d[\d\s().\-]{8,}\d)/g) || []));
  for (const cand of candidates) {
    const digits = cand.replace(/\D/g, '');
    if (digits.length >= 10) return cand.trim();
  }
  return '';
};

// name: drop role words, keep first 2–3 tokens
const cleanName = (s) => {
  let n = safe(s)
    .replace(/\b(owner|buyer|lender|general|inquiry)\b/ig, '')
    .replace(/\s+/g,' ')
    .trim();
  const parts = n.split(' ').filter(Boolean).slice(0,3);
  n = parts.join(' ');
  // Title-case
  n = n.replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return n;
};

const normalizeRole = (r) => {
  const t = safe(r).toLowerCase();
  if (/owner/.test(t))   return 'owner';
  if (/buyer/.test(t))   return 'buyer';
  if (/lender/.test(t))  return 'lender';
  if (/general|inquiry/.test(t)) return 'general';
  return '';
};

// ---- WEBHOOK ----
app.post('/vapi/webhook', async (req, res) => {
  try {
    const payload = (typeof req.body === 'string') ? JSON.parse(req.body) : (req.body || {});

    // Prefer structured_output from Vapi assistant
    const so = pickPath(payload, [
      'structured_output', 'structuredOutput', 'result.structured_output', 'result.structuredOutput'
    ]) || {};

    const brokerage = pickPath(payload, [
      'assistant.metadata.brokerageName','metadata.brokerageName','brokerageName'
    ]) || 'Ariel Property Advisors';

    const summary = pickPath(payload, ['summary','final_summary','analysis.summary','result.summary']);
    const transcript = pickPath(payload, ['analysis.transcript','transcript','result.transcript']);

    // Primary fields from structured_output; fallbacks from caller / quals
    let name  = safe(so.name)  || pickPath(payload, ['caller.name','qualifications.name']);
    let phone = safe(so.phone) || pickPath(payload, ['caller.phone','qualifications.phone']);
    let email = safe(so.email) || pickPath(payload, ['caller.email','qualifications.email']);
    let role  = safe(so.role)  || pickPath(payload, ['qualifications.role']);
    let inquiry = safe(so.inquiry) || pickPath(payload, ['qualifications.inquiry']);
    let market  = safe(so.market)  || pickPath(payload, ['qualifications.market']);
    let dealSize= safe(so.deal_size) || safe(so.dealSize) || pickPath(payload, ['qualifications.deal_size','qualifications.dealSize']);
    let urgency = safe(so.urgency) || pickPath(payload, ['qualifications.urgency','timeline']);

    // If still missing, extract gently from text blobs
    const textBlob = `${summary} ${transcript}`;
    if (!email) email = (textBlob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
    if (!phone) phone = cleanPhone(textBlob);
    if (!name)  name  = cleanName((textBlob.match(/(?:my name is|this is)\s+([A-Za-z][A-Za-z .'-]{1,40})/i) || [])[1] || '');

    // Final hygiene
    name = cleanName(name);
    phone = cleanPhone(phone);
    role = normalizeRole(role);

    const row = [
      nowUTC(),                       // A Timestamp
      brokerage,                      // B Brokerage
      name,                           // C Name
      phone,                          // D Phone
      email,                          // E Email
      role,                           // F Role
      inquiry,                        // G Inquiry
      market,                         // H Market
      dealSize,                       // I Deal Size
      urgency,                        // J Urgency
      oneLine(summary || transcript), // K Summary
      oneLine(JSON.stringify({ name, phone, email, role, inquiry, market, dealSize, urgency })) // L Raw
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });

    console.log('✅ Row appended:', row);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(200).json({ ok: false, error: String(err) });
  }
});

app.get('/', (_, res) => res.send('Webhook running ✅'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server listening on', PORT));
