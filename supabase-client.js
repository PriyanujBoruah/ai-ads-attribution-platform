/**
 * TrueSignal - Supabase Cloud Database Client & Query Module (supabase-client.js)
 * Handles cloud database initialization, multi-tier order retention, and 
 * server-side analytical query execution.
 */

const DEFAULT_SUPABASE_URL = '';
const DEFAULT_SUPABASE_KEY = '';

const TrueSignalSupabase = (() => {
  let client = null;
  let config = {
    url: '',
    key: '',
    tierName: 'Growth',
    maxMonthlyOrders: 5000
  };

  /**
   * Loads credentials from localStorage and instantiates Supabase client.
   */
  function init() {
    const globalConfig = (typeof window !== 'undefined' && window.SUPABASE_CONFIG) ? window.SUPABASE_CONFIG : {};
    let savedUrl = localStorage.getItem('TRUESIGNAL_SUPABASE_URL') || globalConfig.url || DEFAULT_SUPABASE_URL;
    let savedKey = localStorage.getItem('TRUESIGNAL_SUPABASE_KEY') || globalConfig.key || DEFAULT_SUPABASE_KEY;

    // Purge deprecated or dead demo URLs
    if (savedUrl && savedUrl.includes('vhpglpeefuznhnkkvgwf.supabase.co')) {
      savedUrl = '';
      savedKey = '';
      try {
        localStorage.removeItem('TRUESIGNAL_SUPABASE_URL');
        localStorage.removeItem('TRUESIGNAL_SUPABASE_KEY');
      } catch (e) {}
    }

    const savedTier = localStorage.getItem('TRUESIGNAL_TIER') || globalConfig.tierName || 'Growth';
    const savedLimit = parseInt(localStorage.getItem('TRUESIGNAL_MAX_ORDERS') || String(globalConfig.maxMonthlyOrders || 5000), 10);

    config.url = savedUrl;
    config.key = savedKey;
    config.tierName = savedTier;
    config.maxMonthlyOrders = savedLimit;

    if (savedUrl && savedKey && typeof supabase !== 'undefined') {
      try {
        client = supabase.createClient(savedUrl, savedKey);
        console.log('⚡ [TrueSignal Supabase] Client initialized successfully.');
      } catch (err) {
        console.error('[TrueSignal Supabase] Failed to initialize Supabase client:', err);
        client = null;
      }
    } else {
      client = null;
    }
    return client;
  }

  /**
   * Checks if Supabase is properly configured with valid credentials.
   */
  function isConfigured() {
    if (typeof connectionMode !== 'undefined' && connectionMode === 'demo') {
      return false;
    }
    if (!client) init();
    return Boolean(client && config.url && config.key && !config.url.includes('vhpglpeefuznhnkkvgwf.supabase.co'));
  }

  /**
   * Saves Supabase URL, Anon Key, and Store Tier settings.
   */
  async function saveConfig({ url, key, tierName, maxMonthlyOrders, storeId, storeName, shopifyUrl }) {
    if (!url || !key) {
      throw new Error('Supabase URL and Anon Key are required.');
    }

    const cleanUrl = url.trim().replace(/\/$/, '');
    const cleanKey = key.trim();
    const validLimit = [3000, 5000, 12000, 30000].includes(Number(maxMonthlyOrders)) 
      ? Number(maxMonthlyOrders) 
      : 5000;
    const validTier = tierName || (validLimit === 3000 ? 'Starter' : validLimit === 12000 ? 'Pro' : validLimit === 30000 ? 'Enterprise' : 'Growth');

    const targetStoreId = storeId || 'default_store';
    const targetStoreName = storeName || 'Default Store';
    const targetShopifyUrl = shopifyUrl || 'default-store.myshopify.com';

    localStorage.setItem('TRUESIGNAL_SUPABASE_URL', cleanUrl);
    localStorage.setItem('TRUESIGNAL_SUPABASE_KEY', cleanKey);
    localStorage.setItem('TRUESIGNAL_TIER', validTier);
    localStorage.setItem('TRUESIGNAL_MAX_ORDERS', validLimit.toString());

    config.url = cleanUrl;
    config.key = cleanKey;
    config.tierName = validTier;
    config.maxMonthlyOrders = validLimit;

    if (typeof supabase !== 'undefined') {
      client = supabase.createClient(cleanUrl, cleanKey);
    }

    // Sync settings to store_settings table in Supabase
    if (client) {
      try {
        await client.from('store_settings').upsert({
          store_id: targetStoreId,
          store_name: targetStoreName,
          shopify_url: targetShopifyUrl,
          tier_name: validTier,
          max_monthly_orders: validLimit,
          updated_at: new Date().toISOString()
        });

        // Trigger prune function to match new tier limit immediately
        await client.rpc('prune_store_orders', {
          p_store_id: targetStoreId,
          p_max_orders: validLimit
        });
      } catch (e) {
        console.warn('[TrueSignal Supabase] Could not sync store settings to DB:', e.message);
      }
    }

    return true;
  }

  /**
   * Gets current configuration & active tier.
   */
  function getConfig() {
    return { ...config };
  }

  /**
   * Tests connection to Supabase database.
   */
  async function testConnection() {
    if (!isConfigured()) return { ok: false, error: 'Supabase client is not configured.' };
    try {
      const { data, error } = await client.from('store_settings').select('*').limit(1);
      if (error) throw error;
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Batch upserts orders into shopify_orders and master_order_attributions tables.
   */
  async function upsertOrders(orders, storeId = 'default_store') {
    if (!isConfigured() || !orders || orders.length === 0) return { count: 0 };
    const targetStoreId = storeId || 'default_store';

    function cleanNumber(val) {
      if (val === null || val === undefined || val === '') return 0;
      if (typeof val === 'number') return isNaN(val) ? 0 : val;
      const str = String(val).replace(/[^0-9.-]/g, '');
      const parsed = parseFloat(str);
      return isNaN(parsed) ? 0 : parsed;
    }

    // Format orders for Postgres schema (mapping all 24+ Master Order columns with safe currency parsing)
    const formattedOrders = orders.map(o => {
      const orderId = String(o.order_id || o.id || o.name || '');
      const masterOrderId = String(o.master_order_id || o.master_order_name || orderId.replace('gid://shopify/Order/', ''));
      const orderName = o.order_name || o.name || `Order ${masterOrderId}`;

      const grossAmt = cleanNumber(o.gross_amount || o.gross_revenue || o.total_price || 0);
      const discountAmt = cleanNumber(o.discount_amount || o.discount || 0);
      const shipping = cleanNumber(o.shipping_cost || 0);
      const cogs = cleanNumber(o.cost_of_goods || o.cogs || 0);
      const fee = cleanNumber(o.processor_fee || o.gateway_fee || 0);
      const retDeduction = cleanNumber(o.return_deduction || o.refund_amount || 0);

      const netProf = (o.net_profit !== undefined && o.net_profit !== null && o.net_profit !== '')
        ? cleanNumber(o.net_profit)
        : (grossAmt - discountAmt - shipping - cogs - fee - retDeduction);

      const currency = o.currency || (String(o.cogs || o.gross_revenue || o.gross_amount || '').includes('INR') ? 'INR' : 'USD');

      return {
        order_id: orderId,
        master_order_id: masterOrderId,
        order_name: orderName,
        store_id: targetStoreId,
        date: String(o.date || (o.created_at ? o.created_at.substring(0, 10) : new Date().toISOString().substring(0, 10))),
        created_at: o.created_at ? new Date(o.created_at).toISOString() : new Date().toISOString(),
        customer_id: o.customer_id ? String(o.customer_id) : null,
        payment_gateway_name: Array.isArray(o.paymentGatewayNames) ? o.paymentGatewayNames.join(', ') : (o.payment_gateway_name || o.payment_gateway || o.paymentGatewayName || 'Shopify Payments'),
        fulfillment_status: o.fulfillment_status || 'FULFILLED',
        financial_status: o.financial_status || 'PAID',
        gross_revenue: o.gross_revenue ? String(o.gross_revenue) : `${currency} ${grossAmt.toFixed(2)}`,
        gross_amount: grossAmt,
        discount: o.discount ? String(o.discount) : `${currency} ${discountAmt.toFixed(2)}`,
        discount_amount: discountAmt,
        currency: currency,
        shipping_cost: shipping,
        cost_of_goods: cogs,
        processor_fee: fee,
        return_deduction: retDeduction,
        reconciled_with_return: Boolean(o.reconciled_with_return || o.reconciled || (retDeduction > 0)),
        net_profit_formatted: o.net_profit_formatted ? String(o.net_profit_formatted) : `${currency} ${netProf.toFixed(2)}`,
        net_profit: netProf,
        cancelled_date: o.cancelled_date || o.cancelled_at || '-',
        cancel_reason: o.cancel_reason || '-',
        click_id: o.click_id || o.fbclid || null,
        fbclid: o.fbclid || o.click_id || null,
        utm_campaign: o.utm_campaign || o.campaign_name || o.campaign || null,
        utm_source: o.utm_source || o.sourceName || null,
        utm_medium: o.utm_medium || null,
        utm_content: o.utm_content || o.creative_id || null,
        creative_id: o.creative_id || o.utm_content || null,
        attributed_channel: o.attributed_channel || o.utm_source || (o.fbclid ? 'meta' : 'direct'),
        attribution_model: o.attribution_model || 'last_click',
        attribution_level: o.attribution_level || (o.utm_campaign ? 'DETERMINISTIC' : 'UNATTRIBUTED'),
        confidence_score: cleanNumber(o.confidence_score !== undefined ? o.confidence_score : (o.utm_campaign ? 100 : 0)),
        landing_page_url: o.landing_page_url || o.landingPageUrl || o.landing_site || o.landing_page || o.landingPage || '/',
        event_id: o.event_id || o.eventId || (`evt_${masterOrderId.replace(/[^a-zA-Z0-9]/g, '')}`),
        raw_data: o
      };
    });

    // Deduplicate array by order_id before chunking to prevent Postgres ON CONFLICT batch errors
    const uniqueOrdersMap = new Map();
    formattedOrders.forEach(item => {
      uniqueOrdersMap.set(item.order_id, item);
    });
    const uniqueOrders = Array.from(uniqueOrdersMap.values());

    // Batch insert in chunks of 500
    const CHUNK_SIZE = 500;
    let inserted = 0;
    for (let i = 0; i < uniqueOrders.length; i += CHUNK_SIZE) {
      const chunk = uniqueOrders.slice(i, i + CHUNK_SIZE);
      const { error } = await client.from('shopify_orders').upsert(chunk, { onConflict: 'order_id' });
      if (error) {
        console.error('[TrueSignal Supabase] Order upsert chunk error:', error);
        throw error;
      }
      inserted += chunk.length;
    }

    // Trigger pruning procedure according to stored max limit
    try {
      await client.rpc('prune_store_orders', {
        p_store_id: targetStoreId,
        p_max_orders: config.maxMonthlyOrders
      });
    } catch (e) {
      console.warn('[TrueSignal Supabase] Pruning trigger invocation:', e.message);
    }

    return { count: inserted };
  }

  /**
   * Batch upserts daily Meta Ads insights into meta_ads_daily table.
   */
  async function upsertMetaAds(adMetrics, storeId = 'default_store') {
    if (!isConfigured() || !adMetrics || adMetrics.length === 0) return { count: 0 };
    const targetStoreId = storeId || 'default_store';

    function cleanNumber(val) {
      if (val === null || val === undefined || val === '') return 0;
      if (typeof val === 'number') return isNaN(val) ? 0 : val;
      const str = String(val).replace(/[^0-9.-]/g, '');
      const parsed = parseFloat(str);
      return isNaN(parsed) ? 0 : parsed;
    }

    const formattedAds = adMetrics.map(ad => {
      const dateStr = ad.date || ad.stat_time_day || new Date().toISOString().substring(0, 10);
      const adId = String(ad.ad_id || ad.id || ad.creative_id || 'overall');
      const sp = cleanNumber(ad.spend || ad.cost || 0);
      const imp = parseInt(ad.impressions || 0, 10);
      const clk = parseInt(ad.clicks || 0, 10);
      const rch = parseInt(ad.reach || 0, 10);

      const roas = cleanNumber(ad.purchase_roas !== undefined ? ad.purchase_roas : ad.roas);
      const purVal = cleanNumber(ad.reported_revenue !== undefined ? ad.reported_revenue : (ad.purchase_value || ad.sales || (sp * roas)));
      const pur = parseInt(ad.purchases || ad.conversions || (sp > 0 && roas > 0 ? Math.max(1, Math.round(purVal / 45)) : 0), 10);

      const ctr = imp > 0 ? ((clk / imp) * 100) : cleanNumber(ad.ctr);
      const cpc = clk > 0 ? (sp / clk) : cleanNumber(ad.cpc);
      const imgUrl = (ad.image_url && ad.image_url !== 'N/A') ? String(ad.image_url) : (ad.thumbnail_url || ad.thumbnail || ad.preview_url || null);
      const videoUrl = (ad.video_url && ad.video_url !== 'N/A') ? String(ad.video_url) : null;

      return {
        id: `${targetStoreId}_${dateStr}_${adId}`,
        store_id: targetStoreId,
        date: dateStr,
        ad_id: adId,
        ad_name: ad.ad_name || ad.name || ad.creative_name || ad.creative_title || null,
        adset_id: ad.adset_id ? String(ad.adset_id) : null,
        adset_name: ad.adset_name || null,
        campaign_id: ad.campaign_id ? String(ad.campaign_id) : null,
        campaign_name: ad.campaign_name || ad.utm_campaign_join || ad.utm_campaign || null,
        creative_id: ad.creative_id ? String(ad.creative_id) : null,
        creative_name: ad.creative_name || ad.ad_name || ad.creative_title || null,
        spend: sp,
        impressions: imp,
        clicks: clk,
        reach: rch,
        ctr: ctr,
        cpc: cpc,
        purchases: pur,
        purchase_value: purVal,
        roas: roas,
        image_url: imgUrl,
        video_url: videoUrl,
        raw_data: ad
      };
    });

    // Deduplicate by primary key ID (store_id + date + ad_id) to ensure clean 1-row-per-ad-per-day PostgreSQL state
    const uniqueAdsMap = new Map();
    formattedAds.forEach(item => {
      if (uniqueAdsMap.has(item.id)) {
        const existing = uniqueAdsMap.get(item.id);
        // Prefer record with non-null ad_name or higher spend
        if ((item.spend || 0) >= (existing.spend || 0) || (item.ad_name && !existing.ad_name)) {
          uniqueAdsMap.set(item.id, item);
        }
      } else {
        uniqueAdsMap.set(item.id, item);
      }
    });
    const uniqueAds = Array.from(uniqueAdsMap.values());

    const CHUNK_SIZE = 500;
    let inserted = 0;
    for (let i = 0; i < uniqueAds.length; i += CHUNK_SIZE) {
      const chunk = uniqueAds.slice(i, i + CHUNK_SIZE);
      const { error } = await client.from('meta_ads_daily').upsert(chunk, { onConflict: 'id' });
      if (error) {
        console.error('[TrueSignal Supabase] Meta ads upsert chunk error:', error);
        throw error;
      }
      inserted += chunk.length;
    }

    return { count: inserted };
  }



  /**
   * Fetches Executive Overview Cloud Payload using get_daily_overview_ledger RPC function
   */
  async function fetchExecutiveOverviewPayload(storeId = null, startDate = '2026-01-01', endDate = '2026-12-31') {
    if (!isConfigured()) return null;
    const targetStoreId = storeId || (typeof window !== 'undefined' && typeof window.getActiveStoreId === 'function' ? window.getActiveStoreId() : (getConfig().storeId || 'default_store'));
    try {
      // 1. Call Cloud RPC Function in 1 Single Fetch
      const { data, error } = await client.rpc('get_daily_overview_ledger', {
        p_store_id: targetStoreId,
        p_start_date: startDate,
        p_end_date: endDate
      });

      if (error) {
        console.warn('[TrueSignal Supabase] RPC get_daily_overview_ledger error, falling back to direct table query:', error.message);
      } else if (data && data.length > 0) {
        // Compute Summary & Aggregations from 1 Single RPC Fetch
        const totalSpend = data.reduce((acc, r) => acc + (parseFloat(r.daily_creative_spend_inr) || 0), 0);
        const totalMetaPurchases = data.reduce((acc, r) => acc + (parseInt(r.meta_reported_purchases) || 0), 0);
        const totalShopifyOrders = data.reduce((acc, r) => acc + (parseInt(r.shopify_actual_orders) || 0), 0);

        // Daily Time-Series Map for Chart.js
        const dailyMap = {};
        data.forEach(r => {
          const d = r.ad_date;
          if (!dailyMap[d]) dailyMap[d] = { date: d, spend: 0, metaPurchases: 0, shopifyOrders: 0 };
          dailyMap[d].spend += (parseFloat(r.daily_creative_spend_inr) || 0);
          dailyMap[d].metaPurchases += (parseInt(r.meta_reported_purchases) || 0);
          dailyMap[d].shopifyOrders += (parseInt(r.shopify_actual_orders) || 0);
        });
        const dailyBreakdown = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date));

        // Creative Concept Aggregation
        const creativeMap = {};
        data.forEach(r => {
          const key = r.ad_name || r.creative_id || 'Unassigned Creative';
          if (!creativeMap[key]) {
            creativeMap[key] = {
              creative_concept: key,
              campaign_name: r.campaign_name,
              total_spend: 0,
              meta_purchases: 0,
              shopify_orders: 0,
              image_url: r.creative_thumbnail_url
            };
          }
          creativeMap[key].total_spend += (parseFloat(r.daily_creative_spend_inr) || 0);
          creativeMap[key].meta_purchases += (parseInt(r.meta_reported_purchases) || 0);
          creativeMap[key].shopify_orders += (parseInt(r.shopify_actual_orders) || 0);
          if (r.creative_thumbnail_url) creativeMap[key].image_url = r.creative_thumbnail_url;
        });

        const topCreatives = Object.values(creativeMap).sort((a, b) => b.shopify_orders - a.shopify_orders);

        // Fetch orders to get gross revenue & profit totals
        let ordersQuery = client.from('shopify_orders').select('*');
        if (targetStoreId) {
          ordersQuery = ordersQuery.eq('store_id', targetStoreId);
        }
        const { data: ordersData } = await ordersQuery;

        const totalSales = (ordersData || []).reduce((acc, o) => acc + (parseFloat(o.gross_amount) || 0), 0);
        const totalProfit = (ordersData || []).reduce((acc, o) => acc + (parseFloat(o.net_profit) || 0), 0);
        const trueROAS = totalSpend > 0 ? (totalSales / totalSpend) : 0;
        const netMargin = totalSales > 0 ? (totalProfit / totalSales * 100) : 0;

        return {
          ok: true,
          rpc: true,
          summary: {
            totalSales: Math.round(totalSales * 100) / 100,
            totalProfit: Math.round(totalProfit * 100) / 100,
            totalSpend: Math.round(totalSpend * 100) / 100,
            totalOrders: totalShopifyOrders || (ordersData || []).length,
            totalMetaPurchases,
            totalShopifyOrders,
            trueROAS: Math.round(trueROAS * 100) / 100,
            netMargin: Math.round(netMargin * 10) / 10,
            overAttributionPct: totalShopifyOrders > 0 ? (((totalMetaPurchases - totalShopifyOrders) / totalShopifyOrders) * 100).toFixed(1) + '%' : 'N/A'
          },
          dailyBreakdown,
          topCreatives,
          rawRpcData: data
        };
      }

      // Fallback if RPC returns empty or error
      let ordersQuery = client.from('shopify_orders').select('*');
      if (targetStoreId) {
        ordersQuery = ordersQuery.eq('store_id', targetStoreId);
      }
      const { data: ordersData } = await ordersQuery;

      let metaQuery = client.from('meta_ads_daily').select('*');
      if (targetStoreId) {
        metaQuery = metaQuery.eq('store_id', targetStoreId);
      }
      const { data: metaData } = await metaQuery;
      const filteredMeta = (metaData || []).filter(r => (r.ad_id || '').toLowerCase() !== 'overall' && (r.creative_id || '').toLowerCase() !== 'overall');

      const totalSales = (ordersData || []).reduce((acc, o) => acc + (parseFloat(o.gross_amount) || 0), 0);
      const totalProfit = (ordersData || []).reduce((acc, o) => acc + (parseFloat(o.net_profit) || 0), 0);
      const totalOrders = (ordersData || []).length;
      const totalSpend = filteredMeta.reduce((acc, m) => acc + (parseFloat(m.spend) || 0), 0);
      const trueROAS = totalSpend > 0 ? (totalSales / totalSpend) : 0;
      const netMargin = totalSales > 0 ? (totalProfit / totalSales * 100) : 0;

      return {
        ok: true,
        rpc: false,
        summary: {
          totalSales: Math.round(totalSales * 100) / 100,
          totalProfit: Math.round(totalProfit * 100) / 100,
          totalSpend: Math.round(totalSpend * 100) / 100,
          totalOrders,
          trueROAS: Math.round(trueROAS * 100) / 100,
          netMargin: Math.round(netMargin * 10) / 10
        },
        orders: ordersData || [],
        meta: filteredMeta
      };
    } catch (err) {
      console.error('[TrueSignal Supabase] Executive Overview RPC error:', err);
      return null;
    }
  }

  /**
   * Calls get_creatives_stats_ledger RPC function on Supabase PostgreSQL database.
   * Falls back to dynamic demo ledger when unconfigured or in demo mode.
   */
  async function fetchCreativesStatsLedger(storeId = null, startDate = '2026-01-01', endDate = '2026-12-31') {
    if (isConfigured()) {
      const targetStoreId = storeId || (typeof window !== 'undefined' && typeof window.getActiveStoreId === 'function' ? window.getActiveStoreId() : (getConfig().storeId || 'default_store'));
      try {
        const { data, error } = await client.rpc('get_creatives_stats_ledger', {
          p_store_id: targetStoreId,
          p_start_date: startDate,
          p_end_date: endDate
        });
        if (!error && data && data.length > 0) return data;
      } catch (err) {
        console.warn('[TrueSignal Supabase] fetchCreativesStatsLedger RPC notice:', err.message);
      }
    }
    if (typeof window !== 'undefined' && typeof window.generateDemoCreativesLedger === 'function') {
      return window.generateDemoCreativesLedger(startDate, endDate);
    }
    return [];
  }

  /**
   * Calls get_campaign_stats_ledger RPC function on Supabase PostgreSQL database.
   * Falls back to dynamic demo ledger when unconfigured or in demo mode.
   */
  async function fetchCampaignStatsLedger(storeId = null, startDate = '2026-01-01', endDate = '2026-12-31') {
    if (isConfigured()) {
      const targetStoreId = storeId || (typeof window !== 'undefined' && typeof window.getActiveStoreId === 'function' ? window.getActiveStoreId() : (getConfig().storeId || 'default_store'));
      try {
        const { data, error } = await client.rpc('get_campaign_stats_ledger', {
          p_store_id: targetStoreId,
          p_start_date: startDate,
          p_end_date: endDate
        });
        if (!error && data && data.length > 0) return data;
      } catch (err) {
        console.warn('[TrueSignal Supabase] fetchCampaignStatsLedger RPC notice:', err.message);
      }
    }
    if (typeof window !== 'undefined' && typeof window.generateDemoCampaignsLedger === 'function') {
      return window.generateDemoCampaignsLedger(startDate, endDate);
    }
    return [];
  }

  return {
    init,
    isConfigured,
    saveConfig,
    getConfig,
    testConnection,
    upsertOrders,
    upsertMetaAds,
    fetchExecutiveOverviewPayload,
    fetchCreativesStatsLedger,
    fetchCampaignStatsLedger,
    fetchCampaignsStatsLedger: fetchCampaignStatsLedger
  };
})();

// Auto-initialize on load if script included in browser
if (typeof window !== 'undefined') {
  window.TrueSignalSupabase = TrueSignalSupabase;
  document.addEventListener('DOMContentLoaded', () => {
    TrueSignalSupabase.init();
  });
}
