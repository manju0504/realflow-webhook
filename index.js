import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ---- Google Sheets Auth (supports JSON in env or key file) ----
const SHEET_ID = process.env.SPREADSHEET_ID;
const KEY_FILE = process.env.GCP_SERVICE_ACCOUNT_FILE;     // optional (local)
const KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON;     // preferred (Render)

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

// ---------- helpers: find structured output & build a clean record ----------
function first(obj, paths = []) {
  for (const p of paths) {
    try {
      const val = p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
      if (val !== undefined && val !== null) return val;
    } catch {}
  }
  return undefined;
}

function getStructuredOutput(payload) {
  // Try the common Vapi shapes for structured output:
  // - payload.structured_output / structuredOutput / output
  // - payload.result.structured_output
  // - payload.message.structured_output
  // - payload.message.artifact.structured_output
  // - payload.message.artifact.structured_outputs[0]
  // If none, fall back to combining caller + qualifications.
  const so =
    first(payload, [
      'structured_output',
      'structuredOutput',
      'output',
      'result.structured_output',
      'message.structured_output',
      'message.artifact.structured_output',
    ]) ||
    first(payload, ['message.artifact.structured_outputs'])?.[0] ||
    {};

  // Pull pieces from both SO and the classic fields as fallback
  const caller = payload?.caller || {};
  const quals  = payload?.qualifications || {};
  const combined = {
    name:     so.name     ?? caller.name     ?? '',
    phone:    so.phone    ?? caller.phone    ?? '',
    email:    so.email    ?? caller.email    ?? '',
    role:     so.role     ?? quals.role      ?? '',
    inquiry:  so.inquiry  ?? quals.inquiry   ?? '',
    market:   so.market   ?? quals.market    ?? '',
    dealSize: so.deal_size ?? so.dealSize ?? quals.deal_size ?? '',
    urgency:  so.urgency  ?? quals.urgency   ?? '',
  };

  return combined;
}

function buildSummary(rec) {
  const bits = [];
  if (rec.role)    bits.push(rec.role);
  if (rec.inquiry) bits.push(rec.inquiry);
  if (rec.market)  bits.push(`in ${rec.market}`);
  if (rec.dealSize) bits.push(rec.dealSize);
  if (rec.urgency) bits.push(rec.urgency);
  return bits.join(', ');
}

// --------------------------- webhook route ---------------------------
app.post('/vapi/webhook', async (req, res) => {
  try {
    const p = req.body || {};
    const meta = p?.assistant?.metadata || {};
    const rec  = getStructuredOutput(p);

    // Gate: only append when we actually have meaningful data
    const evtType = p?.type || p?.message?.type || '';
    const hasAny =
      rec.role || rec.name || rec.phone || rec.email || rec.inquiry || rec.market || rec.dealSize || rec.urgency;

    if (!hasAny) {
      // Avoid spamming rows on intermediate events like "speech-update"
      return res.json({ ok: true, skipped: `no structured data (event=${evtType || 'unknown'})` });
    }

    // Final summary (prefer Vapi summary if present)
    const summary = p?.summary || p?.final_summary || buildSummary(rec);

    // Your sheet header order:
    // Timestamp | Brokerage | Name | Phone | Email | Role | Inquiry | Market | Deal Size | Urgency | Summary | Raw
    const row = [
      new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
      meta.brokerageName || 'Ariel Property Advisors',
      rec.name,
      rec.phone,
      rec.email,
      rec.role,
      rec.inquiry,
      rec.market,
      rec.dealSize,
      rec.urgency,
      summary,
      JSON.stringify({
        name: rec.name,
        phone: rec.phone,
        email: rec.email,
        role: rec.role,
        inquiry: rec.inquiry,
        market: rec.market,
        dealSize: rec.dealSize,
        urgency: rec.urgency,
      }),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
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
