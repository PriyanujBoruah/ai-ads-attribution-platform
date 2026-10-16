# TrueSignal — Deployment & Infrastructure Guide

Technical deployment guide, database provisioning, edge worker configuration, and integration setup for the TrueSignal marketing attribution and unit-economics platform.

---

## Prerequisites
- **Node.js** v18+ (for local proxy / self-hosted Node server)
- **Supabase Account** (PostgreSQL cloud database)
- **Cloudflare Account** (Pages & D1 edge deployment)
- **Shopify Partner / Admin Account** (Store order & session sync)
- **Meta Developers Account** (Graph API / Marketing API)

---

## 1. Database Setup (Supabase PostgreSQL)

1. Create a project in [Supabase](https://supabase.com).
2. Open the **SQL Editor** in your Supabase dashboard.
3. Paste and run the schema from `supabase_schema.sql`.
4. This initializes:
   - `store_settings`: Multi-tenant store configurations and retention limits.
   - `shopify_orders`: Unified order ledger (net profit, COGS, VAT, tracking params).
   - `meta_ads_daily`: Daily ad spend, impressions, CTR, CPC, ROAS, and creative metadata.
   - Stored procedures: `get_daily_overview_ledger`, `get_creatives_stats_ledger`, `get_campaign_stats_ledger`, and `prune_store_orders`.
5. Retrieve your **Project URL** and **Anon Key** from **Project Settings > API**.

---

## 2. Environment Configuration

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Configure the environment variables with your Supabase, Meta App, and Shopify credentials.

---

## 3. Deployment Targets

### Option A: Cloudflare Pages (Production Edge)
1. Push this repository to GitHub/GitLab.
2. Link the repository to **Cloudflare Pages**.
3. Build Settings:
   - Framework preset: `None`
   - Build output directory: `./` (Root)
4. Add the environment variables in **Settings > Environment Variables**.
5. Deploy.

### Option B: Self-Hosted Node.js (Internal / Staging)
1. Start the proxy server:
   ```bash
   node server.js
   ```
2. The server runs on `http://localhost:8000` (or configured `PORT`).

---

## 4. Shopify Tracking Pixel Installation

To capture 1st-party `click_id`, `fbclid`, and UTM session data:

### Method 1: Theme.liquid
In Shopify Admin > **Online Store > Themes > Edit Code > theme.liquid**, place inside `<head>`:
```html
<script src="https://your-domain.com/shopify-tracking-pixel.js" data-endpoint="https://your-domain.com/api/proxy/ingest" async></script>
```

### Method 2: Customer Events (Shopify Web Pixel)
In Shopify Admin > **Settings > Customer Events > Add Custom Pixel**, paste `shopify-tracking-pixel.js` and activate.

---

## 5. Meta Graph API Configuration

1. Create a **Business App** in [developers.facebook.com](https://developers.facebook.com).
2. Add the **Marketing API** product.
3. Set OAuth Redirect URI:
   `https://your-domain.com/api/auth/meta/callback`
4. Permissions required: `ads_read`, `business_management`.
