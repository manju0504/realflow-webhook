import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ---- Google Sheets Auth (supports FILE locally or JSON in env for Render) ----
const SHEET_ID = process.env.SPREADSHEET_ID;               // keep your current name
const KEY_FILE = process.env.GCP_SERVICE_ACCOUNT_FILE;     // local (optional)
const KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON;     // Render (preferred)

if (!SHEET_ID) {
  console.error('Missing SPREADSHEET_ID in .env');
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
  console.error('Failed to load Google credentials:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });
// ------------------------------------------------------------------------------

app.post('/vapi/webhook', async (req, res) => {
  try {
    const p = req.body || {};
    const meta = p?.assistant?.metadata || {};
    const caller = p?.caller || {};
    const quals  = p?.qualifications || {};
    const summary = p?.summary || p?.final_summary || '';

    const row = [
      new Date().toISOString().replace('T',' ').replace('Z',' UTC'), // UTC timestamp
      meta.brokerageName || '',
      caller.name || '',
      caller.phone || '',
      caller.email || '',
      quals.role || '',
      quals.inquiry || '',
      quals.market || '',
      quals.deal_size || '',
      quals.urgency || '',
      summary || '',
      JSON.stringify(p).slice(0, 50000)
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
    res.json({ ok: false, error: String(err) });
  }
});

app.get('/', (_, res) => res.send('Webhook running'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on port', PORT));
