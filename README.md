# TrueSignal AI | Autonomous Shopify & Meta Ads Attribution Platform

> **Autonomous multi-touch attribution (MTA), Meta CAPI server-side sync, and LLM-powered marketing intelligence copilot for Shopify brands, media buyers, and DTC aggregators.**

---

## 🚀 Key Highlights for Acquirers & AI Investors

* **🤖 Autonomous AI Marketing Copilot:** Embedded LLM reasoning agent powered by **Mistral Large (`mistral-large-2512`)**, **Codestral (`codestral-2508`)**, and lightweight edge models (**`ministral-14b-2512`** & **`ministral-8b-2512`**) with agentic function calling for natural language audits, causal ROAS analysis, ad fatigue detection, and automated budget reallocation recommendations.
* **🛠️ Agentic Tool-Calling Schema:** Includes dedicated analytical tools (`query_creatives_performance`, `query_campaign_attribution`, `get_executive_metrics`) that allow the AI agent to query the attribution matrix deterministically with zero mathematical hallucination.
* **⚡ Instant Interactive Sandbox Demo:** Preloaded with 90 days of realistic DTC e-commerce orders, customer journeys, Meta/TikTok ad spend, and multi-touch attribution. Launch immediately without external credentials via `?demo=true`.
* **🎯 Granular Ad Creative & Campaign Discrepancy Engine:** Isolates true first-party incremental conversions from ad platform over-reporting at both the campaign container and individual ad creative variation level.
* **🛡️ Zero-Burn Edge Infrastructure:** Built on Cloudflare Pages, Cloudflare D1 serverless SQLite, and DuckDB WASM. Baseline monthly server cost is **$0.00**.

---

## 🧠 AI Agent Architecture

The AI Copilot operates on an agentic architecture:
- **System Context Layer:** Injects real-time brand configuration, localization currency, active date boundaries, and data source health.
- **Multi-Model Inference:** 
  - **`mistral-large-2512`:** Flagship reasoning agent for interactive media-buyer strategic audits and tool-calling.
  - **`codestral-2508`:** High-precision data ledger math, schema exploration, and causal regression code generation.
  - **`ministral-14b-2512`:** Deep multi-page CFO Board Audit PDF report generation.
  - **`ministral-8b-2512`:** Sub-second edge directives and real-time capital allocation alerts.
- **Deterministic Tool-Calling:** Connects directly into local IndexedDB and cloud PostgreSQL/D1 tables through structured tool definitions.
- **Causal Reasoning Engine:** Translates raw conversion deltas and view-through overlap into plain-English marketing strategy for founders and media buyers.
- **Dual Inference Modes:** Works out-of-the-box in zero-API-key demo mode via deterministic local query parsing, or connects to live Mistral API keys for unbounded conversational analysis.

---

## Architecture Overview

- **AI Copilot & Frontend Coordinator:** Client-side analytical engine ([`app.js`](app.js)), IndexedDB caching ([`db.js`](db.js)), and reactive chart rendering.
- **Attribution & Intelligence Engines:**
  - [`attribution-engine.js`](attribution-engine.js): 5-tier attribution confidence scoring and journey tracking.
  - [`profitability-engine.js`](profitability-engine.js): Net profit, UK VAT modes, gateway fees, and POAS calculations.
  - [`family-engine.js`](family-engine.js): Creative fingerprinting, concept clustering, and ad grouping.
  - [`maturity-engine.js`](maturity-engine.js): Refund cohort aging and reporting window adjustments.
- **Data Ingestion & Server-Side Tracking:**
  - [`shopify-tracking-pixel.js`](shopify-tracking-pixel.js): 1st-party cookie tracker (`SameSite=Lax; Secure`) preserving click IDs and UTM context.
  - [`supabase-client.js`](supabase-client.js) / [`supabase_schema.sql`](supabase_schema.sql): PostgreSQL cloud data warehouse.
  - [`functions/api/proxy/`](functions/api/proxy/): Cloudflare Pages Edge proxy for CORS bypass and D1 database routing.

---

## ⚙️ Single Master Configuration (`platform.config.js`)

When acquiring or deploying the platform, **all primary API keys and settings are edited in one single file** in the project root:
[`platform.config.js`](platform.config.js)

```javascript
const PLATFORM_CONFIG = {
  mistral: {
    apiKey: "your_mistral_api_key_here",
    defaultModel: "ministral-14b-2512"
  },
  firebase: {
    apiKey: "AIzaSy...",
    authDomain: "your-app.firebaseapp.com",
    projectId: "your-app-id"
  },
  cloudflare: {
    accountId: "your_cloudflare_account_id",
    d1DatabaseId: "your_d1_database_id"
  },
  brand: {
    appName: "TrueSignal",
    primaryColor: "#4338ca",
    currency: "GBP",
    currencySymbol: "£"
  }
};
```
Editing this one file automatically configures Firebase Authentication, Mistral AI Copilot, Cloudflare Edge functions, and branding across the entire application.

---

## Getting Started

1. **Launch Sandbox Demo:** Open `index.html` in any browser or launch local server and append `?demo=true`:
   ```bash
   node server.js
   # Visit: http://localhost:8000/?demo=true#assistant
   ```
2. **Review Environment Variables:**
   ```bash
   cp .env.example .env
   ```
3. **Deployment:** Ready for instant 1-click deployment on Cloudflare Pages or Vercel.

