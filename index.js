import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();

// Accept JSON, urlencoded, and plain text (some providers send text/json)
app.use(bodyParser.json({ limit: '2mb', type: ['application/json', 'text/json', 'application/*+json'] }));
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Env =====
const SHEET_ID = process.env.SPREADSHEET_ID;
const KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON || '';
const KEY_FILE = process.env.GCP_SERVICE_ACCOUNT_FILE  || '';

if (!SHEET_ID) { console.error('❌ Missing SPREADSHEET_ID'); process.exit(1); }

// ===== Google Auth (JSON or file) =====
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
    throw new Error('Set GCP_SERVICE_ACCOUNT_JSON or GCP_SERVICE_ACCOUNT_FILE');
  }
} catch (e) { console.error('❌ Google auth error', e); process.exit(1); }

const sheets = google.sheets({ version: 'v4', auth });

// ===== Helpers =====
const safe = (v) => (v ?? '').toString().trim();
const oneLine = (v) => safe(v).replace(/\s+/g, ' ').slice(0, 400);
const nowUTC = () => new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');

// robust getter: finds first non-empty among many paths
const pickPath = (obj, paths) => {
  for (const p of paths) {
    try {
      const val = p.split('.').reduce((a, k) => (a ? a[k] : undefined), obj);
      if (val !== undefined && safe(val) !== '') return val;
    } catch (_) {}
  }
  return '';
};

// fallback extractors from free text
const extractFromText = (txt = '') => {
  const email = (txt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
  const phone = (txt.match(/(\+?\d[\d\s\-().]{8,}\d)/) || [])[0] || '';
  const name  = (txt.match(/(?:my name is|this is)\s+([A-Za-z][A-Za-z .'-]{1,40})/i) || [])[1] || '';
  return { name, phone, email };
};

// ===== Webhook =====
app.post('/vapi/webhook', async (req, res) => {
  try {
    // Some hosts send the whole payload as a string — parse if so
    const payload = (typeof req.body === 'string')
      ? JSON.parse(req.body)
      : (req.body || {});

    // Try all the likely places Vapi/OpenAI-style payloads use
    const summary = pickPath(payload, [
      'summary', 'final_summary',
      'analysis.summary', 'analysis.callSummary',
      'result.summary', 'result.final_summary',
      'assistant.summary',
      'structuredOutput.summary', 'structured_output.summary', 'structuredData.summary'
    ]);

    const transcript = pickPath(payload, [
      'analysis.transcript', 'transcript', 'result.transcript'
    ]);

    const textAll = `${summary} ${transcript} ${JSON.stringify(payload)}`;
    const fb = extractFromText(textAll);

    const brokerage = pickPath(payload, [
      'assistant.metadata.brokerageName',
      'metadata.brokerageName',
      'brokerageName'
    ]) || 'Ariel Property Advisors';

    const name  = pickPath(payload, [
      'caller.name', 'qualifications.name',
      'structuredData.name', 'structured_output.name',
      'structuredOutput.name', 'result.name'
    ]) || fb.name;

    const phone = pickPath(payload, [
      'caller.phone', 'qualifications.phone',
      'structuredData.phone', 'structured_output.phone',
      'structuredOutput.phone', 'result.phone'
    ]) || fb.phone;

    const email = pickPath(payload, [
      'caller.email', 'qualifications.email',
      'structuredData.email', 'structured_output.email',
      'structuredOutput.email', 'result.email'
    ]) || fb.email;

    const role = pickPath(payload, [
      'qualifications.role', 'structuredData.role',
      'structuredOutput.role', 'structured_output.role'
    ]);

    const inquiry = pickPath(payload, [
      'qualifications.inquiry', 'structuredData.inquiry',
      'structuredOutput.inquiry', 'structured_output.inquiry'
    ]);

    const market = pickPath(payload, [
      'qualifications.market', 'structuredData.market',
      'structuredOutput.market', 'structured_output.market'
    ]);

    const dealSize = pickPath(payload, [
      'qualifications.deal_size', 'qualifications.dealSize',
      'structuredData.deal_size', 'structuredData.dealSize',
      'structuredOutput.deal_size', 'structured_output.deal_size'
    ]);

    const urgency = pickPath(payload, [
      'qualifications.urgency', 'structuredData.urgency',
      'structuredOutput.urgency', 'structured_output.urgency',
      'timeline'
    ]);

    const row = [
      nowUTC(),                        // A Timestamp
      safe(brokerage),                 // B Brokerage
      safe(name),                      // C Name
      safe(phone),                     // D Phone
      safe(email),                     // E Email
      safe(role),                      // F Role
      safe(inquiry),                   // G Inquiry
      safe(market),                    // H Market
      safe(dealSize),                  // I Deal Size
      safe(urgency),                   // J Urgency
      oneLine(summary),                // K Summary (short)
      oneLine(JSON.stringify({         // L Raw (short & structured)
        name, phone, email, role, inquiry, market, dealSize, urgency
      }))
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
    console.error('❌ Webhook error', err);
    res.status(200).json({ ok: false, error: String(err) });
  }
});

app.get('/', (_req, res) => res.send('Webhook running ✅'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server listening on', PORT));
