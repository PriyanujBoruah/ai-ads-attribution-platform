-- TrueSignal - Supabase PostgreSQL Schema & Multi-Tier Retention Policy

-- 1. Store Settings & Active Tier Configuration
CREATE TABLE IF NOT EXISTS store_settings (
    store_id TEXT PRIMARY KEY DEFAULT 'default_store',
    store_name TEXT DEFAULT 'Default Store',
    shopify_url TEXT DEFAULT 'default-store.myshopify.com',
    tier_name TEXT NOT NULL DEFAULT 'Growth',
    max_monthly_orders INTEGER NOT NULL DEFAULT 5000 CHECK (max_monthly_orders IN (3000, 5000, 12000, 30000)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS store_name TEXT;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS shopify_url TEXT;

ALTER TABLE store_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public anon access to store_settings" ON store_settings;
CREATE POLICY "Allow public anon access to store_settings" ON store_settings FOR ALL USING (true) WITH CHECK (true);

INSERT INTO store_settings (store_id, store_name, shopify_url, tier_name, max_monthly_orders)
VALUES ('default_store', 'Default Store', 'default-store.myshopify.com', 'Growth', 5000)
ON CONFLICT (store_id) DO NOTHING;


-- 2. Unified Master Shopify Orders & Attributions Table
CREATE TABLE IF NOT EXISTS shopify_orders (
    order_id TEXT PRIMARY KEY,
    master_order_id TEXT,
    order_name TEXT,
    store_id TEXT NOT NULL DEFAULT 'default_store',
    date TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    customer_id TEXT,
    payment_gateway_name TEXT DEFAULT 'Shopify Payments',
    fulfillment_status TEXT DEFAULT 'FULFILLED',
    financial_status TEXT DEFAULT 'PAID',
    gross_revenue TEXT,
    gross_amount NUMERIC(12,2) DEFAULT 0.00,
    discount TEXT,
    discount_amount NUMERIC(12,2) DEFAULT 0.00,
    currency TEXT DEFAULT 'USD',
    shipping_cost NUMERIC(12,2) DEFAULT 0.00,
    cost_of_goods NUMERIC(12,2) DEFAULT 0.00,
    processor_fee NUMERIC(12,2) DEFAULT 0.00,
    return_deduction NUMERIC(12,2) DEFAULT 0.00,
    reconciled_with_return BOOLEAN DEFAULT false,
    net_profit_formatted TEXT,
    net_profit NUMERIC(12,2) DEFAULT 0.00,
    cancelled_date TEXT DEFAULT '-',
    cancel_reason TEXT DEFAULT '-',
    click_id TEXT,
    fbclid TEXT,
    utm_campaign TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_content TEXT,
    creative_id TEXT,
    attributed_channel TEXT DEFAULT 'direct',
    attribution_model TEXT DEFAULT 'last_click',
    attribution_level TEXT DEFAULT 'DETERMINISTIC',
    confidence_score NUMERIC(5,2) DEFAULT 100.00,
    landing_page_url TEXT,
    event_id TEXT,
    raw_data JSONB,
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure all master order columns exist for upgrade safety
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS master_order_id TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS order_name TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS payment_gateway_name TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS financial_status TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS gross_revenue TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS discount TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC(12,2);
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS cost_of_goods NUMERIC(12,2);
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS processor_fee NUMERIC(12,2);
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS return_deduction NUMERIC(12,2);
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS reconciled_with_return BOOLEAN DEFAULT false;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS net_profit_formatted TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS net_profit NUMERIC(12,2);
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS cancelled_date TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS attributed_channel TEXT DEFAULT 'direct';
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS attribution_model TEXT DEFAULT 'last_click';
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS attribution_level TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(5,2);
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS landing_page_url TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS event_id TEXT;

DROP TABLE IF EXISTS master_order_attributions;

ALTER TABLE shopify_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public anon access to shopify_orders" ON shopify_orders;
CREATE POLICY "Allow public anon access to shopify_orders" ON shopify_orders FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_date ON shopify_orders(date);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_created_at ON shopify_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_campaign ON shopify_orders(utm_campaign);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_source ON shopify_orders(utm_source);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_click ON shopify_orders(click_id);


-- 3. Deduplicated Meta Ads Daily Metrics Table
CREATE TABLE IF NOT EXISTS meta_ads_daily (
    id TEXT PRIMARY KEY, -- Composite: store_id + date + ad_id
    store_id TEXT NOT NULL DEFAULT 'default_store',
    date TEXT NOT NULL,
    ad_id TEXT,
    ad_name TEXT,
    adset_id TEXT,
    adset_name TEXT,
    campaign_id TEXT,
    campaign_name TEXT,
    creative_id TEXT,
    creative_name TEXT,
    spend NUMERIC(12,2) DEFAULT 0.00,
    impressions BIGINT DEFAULT 0,
    clicks BIGINT DEFAULT 0,
    reach BIGINT DEFAULT 0,
    ctr NUMERIC(6,3) DEFAULT 0.00,
    cpc NUMERIC(10,2) DEFAULT 0.00,
    purchases BIGINT DEFAULT 0,
    purchase_value NUMERIC(12,2) DEFAULT 0.00,
    roas NUMERIC(8,2) DEFAULT 0.00,
    image_url TEXT,
    video_url TEXT,
    raw_data JSONB,
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure all metrics columns exist
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS adset_id TEXT;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS adset_name TEXT;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS creative_id TEXT;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS creative_name TEXT;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS reach BIGINT DEFAULT 0;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS ctr NUMERIC(6,3) DEFAULT 0.00;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS cpc NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS purchases BIGINT DEFAULT 0;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS purchase_value NUMERIC(12,2) DEFAULT 0.00;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS roas NUMERIC(8,2) DEFAULT 0.00;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE meta_ads_daily ADD COLUMN IF NOT EXISTS video_url TEXT;

ALTER TABLE meta_ads_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public anon access to meta_ads_daily" ON meta_ads_daily;
CREATE POLICY "Allow public anon access to meta_ads_daily" ON meta_ads_daily FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_meta_ads_date ON meta_ads_daily(date);
CREATE INDEX IF NOT EXISTS idx_meta_ads_campaign ON meta_ads_daily(campaign_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_ad ON meta_ads_daily(ad_id);


-- 4. Stored Function to Enforce Dynamic Tier Order Limits (Monthly Per-Month Cap)
CREATE OR REPLACE FUNCTION prune_store_orders(p_store_id TEXT DEFAULT 'default_store', p_max_orders INT DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_limit INT;
    v_deleted INT := 0;
BEGIN
    IF p_max_orders IS NOT NULL AND p_max_orders > 0 THEN
        v_limit := p_max_orders;
    ELSE
        v_limit := (SELECT max_monthly_orders FROM store_settings WHERE store_id = p_store_id LIMIT 1);
        IF v_limit IS NULL THEN
            v_limit := 5000;
        END IF;
    END IF;

    WITH ranked_orders AS (
        SELECT 
            order_id,
            ROW_NUMBER() OVER (
                PARTITION BY store_id, SUBSTRING(date, 1, 7) 
                ORDER BY created_at DESC, order_id DESC
            ) as month_rank
        FROM shopify_orders
        WHERE store_id = p_store_id
    )
    DELETE FROM shopify_orders
    WHERE order_id IN (
        SELECT order_id 
        FROM ranked_orders 
        WHERE month_rank > v_limit
    );

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;


-- 5. Trigger to Automatically Prune Extra Orders After Ingestion
CREATE OR REPLACE FUNCTION auto_prune_orders_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM prune_store_orders(NEW.store_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_prune_orders ON shopify_orders;
CREATE TRIGGER trg_auto_prune_orders
AFTER INSERT ON shopify_orders
FOR EACH STATEMENT
EXECUTE FUNCTION auto_prune_orders_trigger();


-- 6. RPC Function: Creatives Executive Daily Overview Ledger
CREATE OR REPLACE FUNCTION get_daily_overview_ledger(
    p_store_id TEXT DEFAULT '9fr0bx-1a.myshopify.com',
    p_start_date TEXT DEFAULT '2026-01-01',
    p_end_date TEXT DEFAULT '2026-12-31'
)
RETURNS TABLE (
    ad_date TEXT,
    ad_name TEXT,
    creative_id TEXT,
    campaign_name TEXT,
    daily_creative_spend_inr NUMERIC,
    pct_of_daily_meta_spend TEXT,
    meta_reported_purchases BIGINT,
    shopify_actual_orders BIGINT,
    creative_thumbnail_url TEXT
) 
LANGUAGE sql
AS $$
WITH meta_creative_lookup AS (
    SELECT 
        DISTINCT ON (LOWER(COALESCE(ad_id, creative_id, id)))
        ad_id,
        creative_id,
        TRIM(COALESCE(NULLIF(creative_name, ''), NULLIF(ad_name, ''))) AS resolved_creative_name
    FROM meta_ads_daily
    WHERE COALESCE(NULLIF(creative_name, ''), NULLIF(ad_name, '')) IS NOT NULL
),
meta_daily AS (
    SELECT 
        date AS ad_date,
        COALESCE(ad_name, 'Unknown Ad Name') AS ad_name,
        COALESCE(creative_id, ad_id) AS creative_id,
        COALESCE(campaign_name, 'Unknown Campaign') AS campaign_name,
        COALESCE(
            NULLIF(creative_name, ''), 
            NULLIF(ad_name, ''), 
            NULLIF(creative_id, ''),
            NULLIF(ad_id, ''),
            'Unassigned Creative'
        ) AS resolved_creative_name,
        REGEXP_REPLACE(LOWER(COALESCE(NULLIF(creative_name, ''), NULLIF(ad_name, ''), NULLIF(creative_id, ''), NULLIF(ad_id, ''), 'Unassigned Creative')), '[^a-z0-9]', '', 'g') AS clean_key,
        ROUND(SUM(spend), 2) AS daily_creative_spend_inr,
        SUM(purchases) AS meta_reported_purchases,
        MAX(image_url) AS creative_thumbnail_url
    FROM meta_ads_daily
    WHERE (store_id = p_store_id OR store_id = 'default_store' OR store_id = '362944455')
      AND date >= p_start_date AND date <= p_end_date
      AND LOWER(COALESCE(ad_id, '')) != 'overall'
      AND LOWER(COALESCE(creative_id, '')) != 'overall'
      AND LOWER(COALESCE(ad_name, '')) != 'overall'
      AND LOWER(COALESCE(creative_name, '')) != 'overall'
      AND ad_name IS NOT NULL
      AND ad_name != 'Unknown Ad Name'
    GROUP BY 
        date,
        COALESCE(ad_name, 'Unknown Ad Name'),
        COALESCE(creative_id, ad_id),
        COALESCE(campaign_name, 'Unknown Campaign'),
        COALESCE(
            NULLIF(creative_name, ''), 
            NULLIF(ad_name, ''), 
            NULLIF(creative_id, ''),
            NULLIF(ad_id, ''),
            'Unassigned Creative'
        )
),
deduplicated_shopify_orders AS (
    SELECT DISTINCT ON (order_id)
        order_id,
        store_id,
        date,
        creative_id,
        utm_content
    FROM shopify_orders
    WHERE (store_id = p_store_id OR store_id = 'default_store')
      AND date >= p_start_date AND date <= p_end_date
    ORDER BY order_id, synced_at DESC, created_at DESC
),
shopify_daily_mapped AS (
    SELECT 
        o.date AS order_date,
        TRIM(COALESCE(
            l1.resolved_creative_name,
            l2.resolved_creative_name,
            NULLIF(o.utm_content, ''),
            NULLIF(o.creative_id, ''),
            'Organic / Direct'
        )) AS resolved_creative_name
    FROM deduplicated_shopify_orders o
    LEFT JOIN meta_creative_lookup l1 ON o.creative_id = l1.creative_id OR o.creative_id = l1.ad_id
    LEFT JOIN meta_creative_lookup l2 ON o.utm_content = l2.creative_id OR o.utm_content = l2.ad_id
),
shopify_daily_aggregated AS (
    SELECT 
        order_date,
        resolved_creative_name,
        REGEXP_REPLACE(LOWER(resolved_creative_name), '[^a-z0-9]', '', 'g') AS clean_key,
        COUNT(*) AS shopify_actual_orders
    FROM shopify_daily_mapped
    GROUP BY order_date, resolved_creative_name
)
SELECT 
    m.ad_date,
    m.ad_name,
    m.creative_id,
    m.campaign_name,
    m.daily_creative_spend_inr,
    ROUND((m.daily_creative_spend_inr::numeric / NULLIF(SUM(m.daily_creative_spend_inr) OVER (PARTITION BY m.ad_date), 0) * 100), 2) || '%' AS pct_of_daily_meta_spend,
    m.meta_reported_purchases,
    COALESCE(s.shopify_actual_orders, 0) AS shopify_actual_orders,
    m.creative_thumbnail_url
FROM meta_daily m
LEFT JOIN shopify_daily_aggregated s 
  ON m.ad_date = s.order_date 
 AND (LOWER(m.resolved_creative_name) = LOWER(s.resolved_creative_name) 
      OR m.clean_key = s.clean_key
      OR m.creative_id = s.resolved_creative_name
      OR m.ad_name = s.resolved_creative_name)
ORDER BY m.ad_date DESC, m.daily_creative_spend_inr DESC;
$$;
