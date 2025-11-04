// index.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ---------------------- ENV ----------------------
const SHEET_ID = process.env.SPREADSHEET_ID;                // required
const KEY_FILE = process.env.GCP_SERVICE_ACCOUNT_FILE;      // optional (local)
const KEY_JSON_ENV = process.env.GCP_SERVICE_ACCOUNT_JSON;  // preferred (Render)

// ----------------- GOOGLE AUTH HELPER -----------------
function loadServiceAccountCreds() {
  // 1) If env contains a JSON blob
  if (KEY_JSON_ENV && KEY_JSON_ENV.trim().startsWith('{')) {
    return JSON.parse(KEY_JSON_ENV);
  }
  // 2) If env contains a file path (e.g., /etc/secrets/service-account.json)
  if (KEY_JSON_ENV && KEY_JSON_ENV.startsWith('/')) {
    const p = KEY_JSON_ENV;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  // 3) If GCP_SERVICE_ACCOUNT_FILE is provided (local dev)
  if (KEY_FILE) {
    const p = path.resolve(KEY_FILE);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error(
    'Set GCP_SERVICE_ACCOUNT_JSON (JSON or absolute file path) OR GCP_SERVICE_ACCOUNT_FILE (path).'
  );
}

if (!SHEET_ID) {
  console.error('Missing SPREADSHEET_ID');
  process.exit(1);
}

let auth;
try {
  const credentials = loadServiceAccountCreds();
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
} catch (e) {
  console.error('Failed to load Google credentials:', e);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });

// ----------------- NORMALIZERS -----------------
function safeStr(x) {
  if (x === null || x === undefined) return '';
  if (typeof x === 'string') return x.trim();
  return String(x);
}

function buildSummary({ role, inquiry, market, deal_size, urgency }) {
  const r = role ? role.toLowerCase() : 'caller';
  const parts = [];
  parts.push(`${r.charAt(0).toUpperCase() + r.slice(1)} interested in ${inquiry || 'a property transaction'}`);
  if (market) parts.push(`in ${market}`);
  if (deal_size) parts.push(`(budget/deal ${deal_size})`);
  if (urgency) parts.push(`timeline ${urgency}`);
  return parts.join(' ') + '.';
}

function trimRaw(p) {
  // Keep only compact essentials so the cell stays small
  const caller = p?.caller || {};
  const quals = p?.qualifications || {};
  const meta  = p?.assistant?.metadata || {};
  return {
    brokerage: meta?.brokerageName || '',
    caller: {
      name: caller?.name || '',
      phone: caller?.phone || '',
      email: caller?.email || '',
    },
    qualifications: {
      role: quals?.role || '',
      inquiry: quals?.inquiry || '',
      market: quals?.market || '',
      deal_size: quals?.deal_size || '',
      urgency: quals?.urgency || '',
    },
    summary: p?.summary || p?.final_summary || '',
    at: p?.timestamp || Date.now(),
  };
}

// ----------------- ROUTES -----------------
app.post('/vapi/webhook', async (req, res) => {
  try {
    const body = req.body || {};

    const meta   = body?.assistant?.metadata || {};
    const caller = body?.caller || {};
    const quals  = body?.qualifications || {};
    const summaryText = safeStr(body?.summary || body?.final_summary || '');

    const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');

    const row = [
      timestamp,                               // Timestamp
      safeStr(meta.brokerageName || ''),       // Brokerage
      safeStr(caller.name || ''),              // Name
      safeStr(caller.phone || ''),             // Phone
      safeStr(caller.email || ''),             // Email
      safeStr(quals.role || ''),               // Role
      safeStr(quals.inquiry || ''),            // Inquiry
      safeStr(quals.market || ''),             // Market
      safeStr(quals.deal_size || ''),          // Deal Size
      safeStr(quals.urgency || ''),            // Urgency
      safeStr(summaryText || buildSummary({
        role: quals.role,
        inquiry: quals.inquiry,
        market: quals.market,
        deal_size: quals.deal_size,
        urgency: quals.urgency
      })),                                     // Summary
      JSON.stringify(trimRaw(body))            // Raw (trimmed)
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.json({ ok: false, error: String(err) });
  }
});

app.get('/', (_, res) => res.send('Webhook running'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on port', PORT));
