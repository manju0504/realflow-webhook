🏗️ Realflow Webhook

This project logs AI Agent calls from Vapi into Google Sheets for a real-estate brokerage.

⚙️ Features

Receives webhook POST requests from Vapi

Extracts call metadata (brokerage name, caller details, role, inquiry type)

Appends the info into Google Sheets in real time

Deployable for free on Render

🧩 Tech Stack

Node.js + Express

Google Sheets API

Deployed on Render (Free Tier)

🪜 Setup Guide

Clone or upload the repo to your GitHub.

Add these Render Environment Variables:

Key	Value
PORT	3000
SPREADSHEET_ID	your Google Sheet ID
GCP_SERVICE_ACCOUNT_JSON	full service-account JSON (one line)
NODE_ENV	production

Deploy on Render → Copy the live URL.

In Vapi → Org Settings → Server URL, set
https://your-render-url.onrender.com/vapi/webhook

Make a test call → Check your Sheet → Data should appear 🎉

📋 API Route
POST /vapi/webhook


Body example:

{
  "assistant": {"metadata": {"brokerageName": "Ariel Property Advisors"}},
  "caller": {"name": "John Doe", "phone": "+1-555-0100", "email": "john@example.com"},
  "qualifications": {"role": "buyer", "market": "NYC", "deal_size": "$3M", "urgency": "2 weeks"},
  "summary": "Buyer interested in a Brooklyn property."
}

✅ Response
{ "ok": true }

🌐 Step 4 — Upload manually to GitHub

1️⃣ Go to github.com → New repository

Name: realflow-webhook

Public

Leave “Add README” unchecked

Click Create repository

2️⃣ On your new repo page → click “Add file → Upload files”

3️⃣ Drag these files from your folder:

index.js
package.json
env.example
.gitignore
README.md


4️⃣ Scroll down → click Commit changes.

✅ Your clean repo is now live — no errors, no warnings, no secrets.

🚀 Step 5 — Deploy on Render

Visit https://render.com

Click New → Web Service

Connect your GitHub → pick realflow-webhook

Fill the form:

Field	Value
Name	realflow-webhook
Region	Singapore
Branch	main
Build Command	npm install
Start Command	node index.js

Under Environment Variables, add:

Key	Value
PORT	3000
SPREADSHEET_ID	1DNqxHaUOgYoG1Lmx-mIYra5VzzoJKNKnAHnnoKCWFI4
GCP_SERVICE_ACCOUNT_JSON	(paste entire JSON in one line)
NODE_ENV	production

Click Create Web Service → wait 2–3 minutes until it says Live.
You’ll get a link like:
https://realflow-webhook-abcd.onrender.com

🧪 Step 6 — Verify

Open Command Prompt and run:

curl -X POST https://realflow-webhook-abcd.onrender.com/vapi/webhook ^
  -H "Content-Type: application/json" ^
  -d "{\"assistant\":{\"metadata\":{\"brokerageName\":\"Ariel Property Advisors\"}},\"caller\":{\"name\":\"Render Test\",\"phone\":\"+1-555-2000\",\"email\":\"render@example.com\"},\"qualifications\":{\"role\":\"buyer\",\"market\":\"Brooklyn\",\"deal_size\":\"$2M\",\"urgency\":\"this month\"},\"summary\":\"Buyer seeking mixed-use property.\"}"


If you see:

{"ok":true}


✅ Perfect! Check your Google Sheet → a new row should appear.