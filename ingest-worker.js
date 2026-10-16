/**
 * TrueSignal - Ingestion Worker (ingest-worker.js)
 * Implements the 4-stage ingestion pipeline:
 * Stage 1: Ingests live API records (via local server proxy) or generates synthetic demo data.
 * Stage 2: Mappings to unified Data Spine schemas.
 * Stage 3: Returns back-allocation calculations.
 * Stage 4: Commits transaction batches to IndexedDB.
 */

self.importScripts('db.js?v=' + Date.now(), 'family-engine.js?v=' + Date.now(), 'attribution-engine.js?v=' + Date.now());

self.useDirectShopify = false;

// Intercept fetch calls to provide clear errors on failed proxy requests or redirect directly to platforms when proxy is offline
const originalFetch = self.fetch;
self.fetch = async function(url, options) {
  let targetUrl = url;
  let targetOptions = options;

  if (self.useDirectShopify) {
    if (url === '/api/proxy/shopify') {
      try {
        const payload = JSON.parse(options.body);
        const { shopUrl, accessToken, query, variables } = payload;
        targetUrl = `https://${shopUrl}/admin/api/2026-04/graphql.json`;
        
        const newHeaders = new Headers(options.headers || {});
        newHeaders.set('Content-Type', 'application/json');
        newHeaders.set('X-Shopify-Access-Token', accessToken);
        
        targetOptions = {
          ...options,
          headers: newHeaders,
          body: JSON.stringify({ query, variables })
        };
      } catch (e) {}
    } else if (url === '/api/proxy/meta') {
      try {
        const payload = JSON.parse(options.body);
        const { adAccountId, accessToken, timeRange, timeIncrement } = payload;
        targetUrl = `https://graph.facebook.com/v19.0/${adAccountId}/insights?access_token=${accessToken}&time_increment=${timeIncrement}&time_range=${JSON.stringify(timeRange)}`;
        targetOptions = { method: 'GET' };
      } catch (e) {}
    } else if (url === '/api/proxy/meta/generic') {
      try {
        const payload = JSON.parse(options.body);
        const { endpoint, fields, params, accessToken } = payload;
        let paramStr = '';
        let hasLimit = false;
        if (params) {
          if (params.limit) hasLimit = true;
          paramStr = '&' + Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
        }
        const encodedFields = fields ? encodeURIComponent(fields) : '';
        const limitStr = hasLimit ? '' : '&limit=50';
        targetUrl = `https://graph.facebook.com/v19.0/${endpoint}?fields=${encodedFields}&access_token=${accessToken}${limitStr}${paramStr}`;
        targetOptions = { method: 'GET' };
      } catch (e) {}
    } else if (url === '/api/proxy/tiktok') {
      try {
        const payload = JSON.parse(options.body);
        const { advertiserId, accessToken, startDate, endDate } = payload;
        targetUrl = `https://business-api.tiktok.com/open_api/v1.3/ad/report/get/?advertiser_id=${advertiserId}&report_type=BASIC&data_level=AUCTION_ADVERTISER&dimensions=%5B%22stat_time_day%22%5D&metrics=%5B%22spend%22%2C%22impressions%22%2C%22clicks%22%5D&start_date=${startDate}&end_date=${endDate}`;
        const newHeaders = new Headers(options.headers || {});
        newHeaders.set('Access-Token', accessToken);
        targetOptions = {
          method: 'GET',
          headers: newHeaders
        };
      } catch (e) {}
    } else if (url === '/api/proxy/google') {
      try {
        const payload = JSON.parse(options.body);
        const { customerId, developerToken, accessToken, query } = payload;
        targetUrl = `https://googleads.googleapis.com/v16/customers/${customerId}/googleAds:search`;
        const newHeaders = new Headers(options.headers || {});
        newHeaders.set('Content-Type', 'application/json');
        newHeaders.set('developer-token', developerToken);
        newHeaders.set('Authorization', `Bearer ${accessToken}`);
        targetOptions = {
          ...options,
          headers: newHeaders,
          body: JSON.stringify({ query })
        };
      } catch (e) {}
    }
  }

  try {
    const response = await originalFetch(targetUrl, targetOptions);
    if (!response.ok) {
      let errBody = '';
      try {
        errBody = await response.text();
      } catch (e) {}
      throw new Error(`HTTP Error ${response.status}: ${errBody || 'Request failed.'}`);
    }
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error(`Invalid response format from target. Expected JSON, got "${contentType || 'unknown'}".`);
    }
    return response;
  } catch (err) {
    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('fetch failed')) {
      throw new Error(`Network Error: Failed to reach (${targetUrl}).`);
    }
    throw err;
  }
};

self.onmessage = async (e) => {
  const { command, reset, mode, credentials, targetSource, dbName } = e.data;

  if (command === 'START_INGESTION') {
    try {
      if (dbName) {
        TrueSignalDB.setDatabaseName(dbName);
      }
      if (reset) {
        self.postMessage({ status: 'LOG', message: 'Resetting IndexedDB stores...' });
        await TrueSignalDB.clearAll();
      }

      if (mode === 'demo' || mode === 'mock') {
        self.postMessage({ status: 'LOG', message: `⚡ Connection Mode: Synthetic Demo Sandbox (90 Days DTC Data)...` });
        await runDemoIngestion(credentials, targetSource);
      } else {
        self.postMessage({ status: 'LOG', message: `🔌 Connection Mode: Live API. Syncing ${targetSource || 'all'}...` });
        await runLiveIngestion(credentials, targetSource);
      }

    } catch (err) {
      self.postMessage({ status: 'ERROR', message: `Ingestion failed: ${err.message}` });
    }
  }
};

// --- LIVE API INGESTION LOOP ---

// --- SHIPPING RATE CARD CSV PARSER ---
function parseShippingCost(orderValue, rateCardText) {
  if (!rateCardText) return 4.99;
  const lines = rateCardText.split('\n');
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const rule = parts[0].trim().toLowerCase();
    const cost = parseFloat(parts[1].trim());
    if (isNaN(cost)) continue;
    
    if (rule === 'flat rate' || rule === 'flat') {
      return cost;
    }
    if (rule.startsWith('under') || rule.startsWith('<')) {
      const valStr = rule.replace('under', '').replace('<', '').trim();
      const val = parseFloat(valStr);
      if (!isNaN(val) && orderValue < val) {
        return cost;
      }
    }
    if (rule.startsWith('over') || rule.startsWith('>') || rule.startsWith('>=')) {
      const valStr = rule.replace('over', '').replace('>=', '').replace('>', '').trim();
      const val = parseFloat(valStr);
      if (!isNaN(val) && orderValue >= val) {
        return cost;
      }
    }
  }
  return 4.99;
}

// --- LIVE API INGESTION LOOP ---

async function runLiveIngestion(creds, targetSource = 'all') {
  let { 
    shopifyUrl, shopifyToken, 
    metaAccount, metaToken, metaPixel, metaCapiToken, metaAccounts,
    tiktokId, tiktokToken, tiktokPixel,
    googleId, googleDev, googleToken, googleConversionAction,
    cogsRate = 35, processorFeeRate = 2.9, processorFlatFee = 0.30, shippingRateCard = 'Flat Rate,4.99'
  } = creds;

  // Perform a quick check to see if the local proxy server is running.
  // If we get a 404 or a network error, we treat the proxy as unreachable.
  let proxyReachable = true;
  try {
    const checkResponse = await originalFetch('/api/proxy/shopify', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping: true }) 
    });
    if (checkResponse.status === 404) {
      proxyReachable = false;
    }
  } catch (e) {
    proxyReachable = false;
  }

  self.useDirectShopify = false;

  if (!proxyReachable) {
    self.postMessage({ status: 'LOG', message: '⚠️ Local proxy server is unreachable (Static deployment detected).' });
    self.useDirectShopify = true;
    self.postMessage({ status: 'LOG', message: '🔌 Shopify: Live Admin GraphQL credentials detected. Attempting direct browser-to-Shopify connection...' });
    
    // For ad networks, if credentials are empty, they will naturally fallback to mock spend.
    if (metaAccount && metaToken) {
      self.postMessage({ status: 'LOG', message: '🔌 Meta Ads: Live credentials detected. Attempting direct browser-to-Meta API connection...' });
    }
    if (tiktokId && tiktokToken) {
      self.postMessage({ status: 'LOG', message: '🔌 TikTok Ads: Live credentials detected. Attempting direct browser-to-TikTok API connection...' });
    }
    if (googleId && googleDev && googleToken) {
      self.postMessage({ status: 'LOG', message: '🔌 Google Ads: Live credentials detected. Attempting direct browser-to-Google Ads API connection...' });
    }
  }

  // Set 60 day standard lookback window (Shopify Standard API compliance)
  const dateUntil = getDateNDaysAgo(0);
  const dateSince = getDateNDaysAgo(60);
  let adjustedDateSince = dateSince;

  const sessions = [];
  const orders = [];
  const spend = [];
  const returns = [];

  const shopifyCustomers = [];
  const shopifyProducts = [];
  const shopifyInventory = [];
  const shopifyFulfillments = [];
  const shopifyDiscounts = [];
  const shopifyCheckouts = [];
  const shopifyShipping = [];
  const shopifyMasterOrders = [];

  const metaCampaigns = [];
  const metaAdSets = [];
  const metaAds = [];
  const metaCreatives = [];
  const metaInsights = [];
  const metaMasterRecords = [];

  // --- STAGE 1: THROTTLED EXTRACTION ---
  self.postMessage({ status: 'STAGE_1_START', message: 'Stage 1: Contacting Shopify and Ad Platform APIs...' });
  
  // 1. Fetch Shopify Orders
  if (targetSource === 'shopify' || targetSource === 'all') {
    if (!shopifyUrl || !shopifyToken) {
      throw new Error("Shopify Store URL and Admin Access Token are required.");
    }

    try {
      shopifyFulfillments.length = 0;
        self.postMessage({ status: 'LOG', message: `Querying Shopify order cursor starting from: ${dateSince}` });
        
        let hasNextPage = true;
        let cursor = null;
        let pageCount = 1;
        const shopifyOrdersLimit = 50000;
        const shopifyGraphQLQuery = `
          query getOrders($first: Int!, $after: String, $query: String) {
            orders(first: $first, after: $after, query: $query, reverse: true) {
              edges {
                node {
                  id
                  name
                  createdAt
                  cancelledAt
                  cancelReason
                  displayFinancialStatus
                  displayFulfillmentStatus
                  totalPriceSet { shopMoney { amount currencyCode } }
                  totalDiscountsSet { shopMoney { amount currencyCode } }
                  totalShippingPriceSet { shopMoney { amount currencyCode } }
                  sourceName
                  customAttributes {
                    key
                    value
                  }
                  refunds(first: 10) {
                    id
                    createdAt
                    totalRefundedSet { shopMoney { amount currencyCode } }
                  }
                  customerJourneySummary {
                    lastVisit {
                      landingPage
                      referrerUrl
                      utmParameters {
                        campaign
                        source
                        content
                      }
                    }
                    firstVisit {
                      landingPage
                      referrerUrl
                      utmParameters {
                        campaign
                        source
                        content
                      }
                    }
                  }
                  paymentGatewayNames
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `;

        while (hasNextPage && orders.length < shopifyOrdersLimit) {
          self.postMessage({ status: 'LOG', message: `Shopify Ingestion Page ${pageCount}...` });
          
          const response = await fetch('/api/proxy/shopify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              shopUrl: shopifyUrl,
              accessToken: shopifyToken,
              query: shopifyGraphQLQuery,
              variables: {
                first: 250,
                after: cursor,
                query: `created_at:>=${dateSince}`
              }
            })
          });

          const resJson = await response.json();
          if (resJson.error || !resJson.data) {
            throw new Error(resJson.message || 'Failed to fetch Shopify orders via local proxy.');
          }

          // Dynamic Leaky Bucket Throttling Check
          if (resJson.extensions && resJson.extensions.cost) {
            const costInfo = resJson.extensions.cost;
            const availablePoints = costInfo.throttleStatus.currentlyAvailable;
            const restoreRate = costInfo.throttleStatus.restoreRate;
            
            // If we have less than 500 points left, wait for the bucket to refill to a safe margin
            if (availablePoints < 500) {
              const pointsNeeded = 600 - availablePoints;
              const sleepTimeMs = Math.ceil((pointsNeeded / restoreRate) * 1000);
              self.postMessage({ 
                status: 'LOG', 
                message: `⚠️ Shopify API bucket points low (${availablePoints.toFixed(0)} left). Throttling sync for ${sleepTimeMs}ms...` 
              });
              await sleep(sleepTimeMs);
            }
          }

          const fetchedOrders = resJson.data.orders.edges;
          fetchedOrders.forEach(edge => {
            const node = edge.node;
            
            // Parse order amounts
            const rawPrice = parseFloat(node.totalPriceSet?.shopMoney?.amount || 0);
            const rawDiscount = parseFloat(node.totalDiscountsSet?.shopMoney?.amount || 0);
            const rawShipping = parseFloat(node.totalShippingPriceSet?.shopMoney?.amount || 0);
            const rawCurrency = node.totalPriceSet?.shopMoney?.currencyCode || 'INR';
            
            const orderDate = node.createdAt.substring(0, 10);
            
            // Build customAttributes lookup map (for Express Checkouts like Fastrr, Shiprocket, GoKwik)
            const customAttrsMap = {};
            if (node.customAttributes && Array.isArray(node.customAttributes)) {
              node.customAttributes.forEach(attr => {
                if (attr && attr.key && attr.value !== undefined && attr.value !== null) {
                  customAttrsMap[attr.key.toLowerCase()] = String(attr.value);
                }
              });
            }

            const landingUrl = customAttrsMap['landing_page_url'] ||
                              customAttrsMap['_landing_page'] ||
                              customAttrsMap['landing_page'] ||
                              customAttrsMap['landing_url'] ||
                              customAttrsMap['page_url'] ||
                              customAttrsMap['url'] ||
                              customAttrsMap['landing_site'] ||
                              node.customerJourneySummary?.lastVisit?.landingPage ||
                              node.customerJourneySummary?.firstVisit?.landingPage ||
                              '';

            // 1. Extract Campaign Identifier
            let campaign = customAttrsMap['utm_campaign'] || customAttrsMap['campaign_id'] || '';
            if (!campaign && landingUrl) {
              const campMatch = landingUrl.match(/utm_campaign=([^&]+)/i) || landingUrl.match(/campaign_id=([^&]+)/i);
              if (campMatch) campaign = decodeURIComponent(campMatch[1]);
            }
            if (!campaign) {
              const journeyUtm = node.customerJourneySummary?.lastVisit?.utmParameters;
              if (journeyUtm?.campaign) campaign = journeyUtm.campaign;
            }
            if (!campaign) campaign = 'Organic';

            // 2. Extract Traffic Source & Meta Click ID
            let utmSource = customAttrsMap['utm_source'] || '';
            if (!utmSource && landingUrl) {
              const srcMatch = landingUrl.match(/utm_source=([^&]+)/i);
              if (srcMatch) utmSource = decodeURIComponent(srcMatch[1]);
            }

            let fbclid = customAttrsMap['fbclid'] || customAttrsMap['click_id'] || '';
            if (!fbclid && landingUrl) {
              const fbclidMatch = landingUrl.match(/fbclid=([^&]+)/i);
              if (fbclidMatch) fbclid = decodeURIComponent(fbclidMatch[1]);
            }

            const userAgent = customAttrsMap['user_agent'] || '';
            const isMetaInApp = /FB_IAB|FBAV|Instagram/i.test(userAgent);
            const isMetaSource = /facebook|instagram|meta/i.test(node.sourceName || '');
            const isMetaLanding = /facebook\.com|instagram\.com|fb\.me|threads\.net/i.test(landingUrl);
            
            const journey = node.customerJourneySummary?.lastVisit;
            const journeyUtm = journey?.utmParameters;
            const journeyRef = journey?.referrerUrl || '';
            const isMetaJourneyRef = /facebook\.com|instagram\.com|fb\.me|threads\.net/i.test(journeyRef);
            const isMetaJourneySource = /facebook|fb|instagram|ig|meta/i.test(journeyUtm?.source || '');

            if (!utmSource) {
              if (journeyUtm?.source) {
                utmSource = journeyUtm.source;
              } else if (isMetaInApp || isMetaSource || isMetaLanding || isMetaJourneyRef || isMetaJourneySource || fbclid) {
                utmSource = 'Meta Ads';
              } else if (journeyRef) {
                utmSource = journeyRef;
              } else {
                utmSource = 'Organic';
              }
            }

            // Standardize raw UTM sources into clean grouped terms: Facebook, Instagram, Google Ads, TikTok Ads, Organic / Direct
            const sLower = (utmSource || '').trim().toLowerCase();
            if (/^ig$|^instagram$|instagram\.com|ig_shopping|insta/i.test(sLower)) {
              utmSource = 'Instagram';
            } else if (/^fb$|^facebook$|facebook\.com|an$|fb_ig|meta_ads|meta ads|fbads|^meta$/i.test(sLower)) {
              utmSource = 'Facebook';
            } else if (/^google$|google\.com|^gads$|^cpc$/i.test(sLower)) {
              utmSource = 'Google Ads';
            } else if (/^tiktok$|tiktok\.com/i.test(sLower)) {
              utmSource = 'TikTok Ads';
            } else if (/^direct$|organic/i.test(sLower) || !utmSource) {
              utmSource = 'Organic / Direct';
            }

            // 3. Extract Content / Ad Creative ID
            let utmContent = customAttrsMap['utm_content'] || customAttrsMap['ad_id'] || '';
            if (!utmContent && landingUrl) {
              const contentMatch = landingUrl.match(/utm_content=([^&]+)/i) || landingUrl.match(/ad_id=([^&]+)/i);
              if (contentMatch) utmContent = decodeURIComponent(contentMatch[1]);
            }
            if (!utmContent && journeyUtm?.content) {
              utmContent = journeyUtm.content;
            }
            const creativeId = utmContent || null;

            const clickId = fbclid ? `fbclid_${fbclid}` : `clk_direct_${uuidv4().substring(0, 8)}`;
            const eventId = `evt_${uuidv4().substring(0, 8)}`;

            // COGS calculation
            let computedCOGS = rawPrice * (parseFloat(cogsRate) / 100);

            // Processor Fee calculation based on payment gateway
            let computedProcessorFee = 0;
            let gatewayMatched = false;
            
            if (node.paymentGatewayNames && node.paymentGatewayNames.length > 0) {
              const gatewayRates = {
                'shopify_payments': { percent: 1.5, flat: 0.20 },
                'paypal': { percent: 2.9, flat: 0.30 },
                'klarna': { percent: 3.9, flat: 0.20 },
                'stripe': { percent: 1.4, flat: 0.20 }
              };
              
              for (const gw of node.paymentGatewayNames) {
                const key = gw.toLowerCase().replace(/\s+/g, '_');
                if (gatewayRates[key]) {
                  const rate = gatewayRates[key];
                  computedProcessorFee = rawPrice > 0 ? (rawPrice * (rate.percent / 100) + rate.flat) : 0;
                  gatewayMatched = true;
                  break;
                }
              }
            }
            
            if (!gatewayMatched) {
              computedProcessorFee = rawPrice > 0 ? (rawPrice * (parseFloat(processorFeeRate) / 100) + parseFloat(processorFlatFee)) : 0;
            }

            const trueShipping = parseShippingCost(rawPrice, shippingRateCard);

            let orderReturnDeduction = 0;
            let isReconciled = false;
            if (node.refunds && Array.isArray(node.refunds) && node.refunds.length > 0) {
              node.refunds.forEach(r => {
                const refAmount = parseFloat(r.totalRefundedSet?.shopMoney?.amount || 0);
                if (refAmount > 0) {
                  orderReturnDeduction += refAmount;
                  isReconciled = true;
                  returns.push({
                    return_id: r.id,
                    parent_order_id: node.id,
                    date_returned: (r.createdAt || node.createdAt).substring(0, 10),
                    returned_value: refAmount,
                    restock_fee: 0
                  });
                }
              });
            }

            const netProfitVal = Math.round((rawPrice - rawDiscount - trueShipping - computedCOGS - computedProcessorFee - orderReturnDeduction) * 100) / 100;
            const fulfillmentStatus = node.displayFulfillmentStatus || 'FULFILLED';
            const financialStatus = node.displayFinancialStatus || 'PAID';
            const orderName = node.name || `Order ${node.id.replace('gid://shopify/Order/', '')}`;
            const cancelledDate = node.cancelledAt ? node.cancelledAt.substring(0, 10) : '-';
            const cancelReason = node.cancelReason || '-';

            orders.push({
              order_id: node.id,
              order_name: orderName,
              date: orderDate,
              click_id: clickId,
              fbclid: fbclid || null,
              utm_campaign: campaign,
              utm_source: utmSource,
              utm_content: utmContent,
              creative_id: creativeId,
              landingPageUrl: landingUrl || null,
              customAttributes: node.customAttributes || null,
              paymentGatewayNames: node.paymentGatewayNames || null,
              fulfillment_status: fulfillmentStatus,
              financial_status: financialStatus,
              gross_amount: rawPrice,
              currency: rawCurrency,
              discount_amount: rawDiscount,
              shipping_cost: trueShipping,
              cost_of_goods: computedCOGS,
              processor_fee: computedProcessorFee,
              net_profit: netProfitVal,
              reconciled_with_return: isReconciled,
              return_deduction: orderReturnDeduction,
              event_id: eventId
            });

            shopifyMasterOrders.push({
              order_id: node.id,
              master_order_id: node.id.replace('gid://shopify/Order/', ''),
              order_name: orderName,
              date: orderDate,
              fulfillment_status: fulfillmentStatus,
              financial_status: financialStatus,
              gross_revenue: `${rawCurrency} ${rawPrice}`,
              gross_amount: rawPrice,
              discount: `${rawCurrency} ${rawDiscount}`,
              discount_amount: rawDiscount,
              currency: rawCurrency,
              utm_source: utmSource,
              utm_campaign: campaign,
              utm_content: utmContent,
              fbclid: fbclid || '-',
              cogs: `${rawCurrency} ${Math.round(computedCOGS * 100) / 100}`,
              gateway_fee: `${rawCurrency} ${Math.round(computedProcessorFee * 100) / 100}`,
              refund_amount: `${rawCurrency} ${Math.round(orderReturnDeduction * 100) / 100}`,
              net_profit_formatted: `${rawCurrency} ${netProfitVal}`,
              net_profit: netProfitVal,
              cancelled_date: cancelledDate,
              cancel_reason: cancelReason,
              click_id: clickId,
              creative_id: creativeId || '-',
              landing_page_url: landingUrl || '/',
              event_id: eventId
            });
          });

          hasNextPage = resJson.data.orders.pageInfo.hasNextPage;
          cursor = resJson.data.orders.pageInfo.endCursor;
          pageCount++;
        }

        if (orders.length > 0) {
          self.postMessage({ status: 'LOG', message: `ℹ️ Shopify ingestion complete (${orders.length} orders pulled). Maintaining full 90-day sync window starting from: ${dateSince}` });
        }

        // 1.1 Fetch refunds / returns back-linked to orders
        try {
          const refundResp = await fetch('/api/proxy/shopify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              shopUrl: shopifyUrl,
              accessToken: shopifyToken,
              query: `
                query getRefunds($first: Int!) {
                  orders(first: $first, reverse: true) {
                    edges {
                      node {
                        id
                        refunds(first: 10) {
                          id
                          createdAt
                          totalRefundedSet { shopMoney { amount } }
                        }
                      }
                    }
                  }
                }
              `,
              variables: { first: 250 }
            })
          });

          const refJson = await refundResp.json();
          if (refJson.data && refJson.data.orders) {
            refJson.data.orders.edges.forEach(edge => {
              const node = edge.node;
              if (node.refunds && node.refunds.length > 0) {
                node.refunds.forEach(r => {
                  const refAmount = parseFloat(r.totalRefundedSet.shopMoney.amount);
                  if (refAmount > 0) {
                    returns.push({
                      return_id: r.id,
                      parent_order_id: node.id,
                      date_returned: r.createdAt.substring(0, 10),
                      returned_value: refAmount,
                      restock_fee: 0
                    });
                  }
                });
              }
            });
          }
        } catch (e) {
          self.postMessage({ status: 'LOG', message: `⚠️ Failed to fetch returns: ${e.message}` });
        }

        // 1.2 - 1.8 Ancillary Tables (Customers, Products, Inventory, Fulfillments, Discounts, Checkouts, Shipping)
        // Disabling ancillary queries to maximize Shopify GraphQL API point capacity and speed up synchronization.
        self.postMessage({ status: 'LOG', message: "Shopify Ingest: Bypassing secondary datasets to protect API quota..." });

        self.postMessage({ status: 'LOG', message: `Shopify Ingest complete: Pulled ${orders.length} orders, ${returns.length} returns, and matching ancillary scope datasets.` });

    } catch (err) {
      self.postMessage({ status: 'LOG', message: `⚠️ Live Shopify Ingestion failed: ${err.message}` });
      throw err;
    }
  }

  // 2. Fetch Meta Ads Multi-Table Datasets (Supports Multiple Meta Accounts)
  if (targetSource === 'meta' || targetSource === 'all') {
    let accountsToSync = Array.isArray(metaAccounts) && metaAccounts.length > 0
      ? metaAccounts
      : ((metaAccount && metaToken) ? [{ accountId: metaAccount, token: metaToken, name: 'Meta Account' }] : []);

    if (accountsToSync.length === 0) {
      if (targetSource === 'meta') {
        throw new Error("At least one Meta Ad Account ID and Access Token are required.");
      }
    } else {
      self.postMessage({ status: 'LOG', message: `Querying Meta Graph API across ${accountsToSync.length} connected ad account(s)...` });

      for (let acctIdx = 0; acctIdx < accountsToSync.length; acctIdx++) {
        const curAcctObj = accountsToSync[acctIdx];
        const rawAcct = curAcctObj.accountId || curAcctObj.account_id || curAcctObj.id || metaAccount;
        const curToken = curAcctObj.token || curAcctObj.accessToken || metaToken;
        const curName = curAcctObj.name || curAcctObj.label || `Account ${rawAcct}`;

        if (!rawAcct || !curToken) continue;
        const actId = rawAcct.startsWith('act_') ? rawAcct : 'act_' + rawAcct;

        self.postMessage({ status: 'LOG', message: `🔌 Meta Sync [${acctIdx + 1}/${accountsToSync.length}]: Account "${curName}" (${actId})...` });

        // A. Single-Query Condensed Meta Ingestion (Ads, Creatives, Media URLs & Daily Insights in 1 Request)
        try {
          let afterCursor = null;
          let adsCount = 0;
          const creativeSet = new Set();
          const campaignDailyMap = {};

          do {
            const params = { limit: 10 };
            if (afterCursor) {
              params.after = afterCursor;
            }

            const timeRangeStr = JSON.stringify({ since: adjustedDateSince, until: dateUntil });
            const fieldsStr = `id,name,status,campaign_id,adset_id,creative{id,name,title,body,image_url,thumbnail_url,video_id,object_story_spec},insights.time_increment(1).time_range(${timeRangeStr}){date_start,date_stop,campaign_id,campaign_name,spend,impressions,clicks,reach,purchase_roas}`;

            const resp = await fetch('/api/proxy/meta/generic', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: `${actId}/ads`,
                fields: fieldsStr,
                params: params,
                accessToken: curToken
              })
            });

            const json = await resp.json();
            if (json.error) {
              self.postMessage({ status: 'LOG', message: `⚠️ Meta Single-Query API error for ${curName}: ${json.error.message || JSON.stringify(json.error)}` });
              break;
            }

            if (json.data && json.data.length > 0) {
              adsCount += json.data.length;

              json.data.forEach(item => {
                const creativeObj = item.creative;
                const creativeId = creativeObj ? creativeObj.id : null;

                // Extract Image CDN URL
                let imageUrl = creativeObj ? (creativeObj.image_url || creativeObj.thumbnail_url || null) : null;
                if (!imageUrl && creativeObj && creativeObj.object_story_spec && creativeObj.object_story_spec.link_data) {
                  imageUrl = creativeObj.object_story_spec.link_data.picture || null;
                }
                if (!imageUrl && creativeObj && creativeObj.object_story_spec && creativeObj.object_story_spec.video_data) {
                  imageUrl = creativeObj.object_story_spec.video_data.image_url || null;
                }

                // Extract Playable Facebook Video URL
                let videoId = creativeObj ? (creativeObj.video_id || null) : null;
                if (!videoId && creativeObj && creativeObj.object_story_spec && creativeObj.object_story_spec.video_data) {
                  videoId = creativeObj.object_story_spec.video_data.video_id || null;
                }
                const videoUrl = videoId ? `https://www.facebook.com/watch/?v=${videoId}` : null;

                // 1. Meta Ads List
                metaAds.push({
                  ad_id: item.id,
                  name: item.name || 'N/A',
                  status: item.status || 'N/A',
                  campaign_id: item.campaign_id,
                  adset_id: item.adset_id,
                  creative_id: creativeId,
                  image_url: imageUrl || 'N/A',
                  video_url: videoUrl || 'N/A',
                  ad_account_id: actId,
                  ad_account_name: curName
                });

                // 2. Meta Creatives List
                if (creativeObj && creativeId && !creativeSet.has(creativeId)) {
                  creativeSet.add(creativeId);
                  metaCreatives.push({
                    creative_id: creativeId,
                    name: creativeObj.name || item.name || 'N/A',
                    title: creativeObj.title || creativeObj.name || item.name || 'N/A',
                    body: creativeObj.body || 'N/A',
                    image_url: imageUrl || 'N/A',
                    video_url: videoUrl || 'N/A',
                    call_to_action_type: 'SHOP_NOW',
                    ad_account_id: actId,
                    ad_account_name: curName,
                    spend: 0, impressions: 0, clicks: 0, reach: 0, purchase_roas: 0
                  });
                }

                // 3. Daily Ad Performance Insights & Campaign Rollup
                if (item.insights && item.insights.data) {
                  item.insights.data.forEach(row => {
                    const dateStr = row.date_start || row.date_stop || dateUntil;
                    let roas = 0;
                    if (row.purchase_roas && row.purchase_roas.length > 0) {
                      roas = parseFloat(row.purchase_roas[0].value || 0);
                    }
                    const s = parseFloat(row.spend || 0);
                    const imp = parseInt(row.impressions || 0);
                    const clk = parseInt(row.clicks || 0);
                    const rch = parseInt(row.reach || 0);
                    const rev = Math.round(s * roas * 100) / 100;

                    metaInsights.push({
                      insight_id: `${dateStr}_ad_${actId}_${item.id}`,
                      date: dateStr,
                      ad_id: item.id,
                      ad_name: item.name || 'N/A',
                      creative_id: creativeId || item.id,
                      campaign_id: item.campaign_id || row.campaign_id || null,
                      campaign_name: row.campaign_name || null,
                      spend: s,
                      impressions: imp,
                      clicks: clk,
                      reach: rch,
                      purchase_roas: roas,
                      reported_revenue: rev,
                      image_url: imageUrl || 'N/A',
                      video_url: videoUrl || 'N/A',
                      utm_source_join: 'Meta Ads',
                      utm_campaign_join: row.campaign_name || 'N/A',
                      utm_content_join: item.name || 'N/A',
                      ad_account_id: actId,
                      ad_account_name: curName
                    });

                    // Single Unified Flat Knowledge Base Record
                    metaMasterRecords.push({
                      record_id: `${dateStr}_ad_${actId}_${item.id}`,
                      date: dateStr,
                      ad_id: item.id,
                      ad_name: item.name || 'N/A',
                      status: item.status || 'N/A',
                      campaign_id: item.campaign_id || row.campaign_id || null,
                      campaign_name: row.campaign_name || 'N/A',
                      adset_id: item.adset_id || null,
                      creative_id: creativeId || item.id,
                      creative_name: creativeObj ? (creativeObj.name || item.name || 'N/A') : (item.name || 'N/A'),
                      creative_title: creativeObj ? (creativeObj.title || creativeObj.name || item.name || 'N/A') : (item.name || 'N/A'),
                      creative_body: creativeObj ? (creativeObj.body || 'N/A') : 'N/A',
                      image_url: imageUrl || 'N/A',
                      video_url: videoUrl || 'N/A',
                      spend: s,
                      impressions: imp,
                      clicks: clk,
                      reach: rch,
                      purchase_roas: roas,
                      reported_revenue: rev,
                      utm_source_join: 'Meta Ads',
                      utm_campaign_join: row.campaign_name || 'N/A',
                      utm_content_join: item.name || 'N/A',
                      ad_account_id: actId,
                      ad_account_name: curName
                    });

                    // Campaign Rollup Key
                    const campId = item.campaign_id || row.campaign_id || 'unknown_camp';
                    const campKey = `${dateStr}_${actId}_${campId}`;
                    if (!campaignDailyMap[campKey]) {
                      campaignDailyMap[campKey] = {
                        date: dateStr,
                        campaign_id: campId,
                        campaign_name: row.campaign_name || 'N/A',
                        spend: 0,
                        impressions: 0,
                        clicks: 0,
                        reach: 0,
                        total_val: 0
                      };
                    }
                    campaignDailyMap[campKey].spend += s;
                    campaignDailyMap[campKey].impressions += imp;
                    campaignDailyMap[campKey].clicks += clk;
                    campaignDailyMap[campKey].reach += rch;
                    campaignDailyMap[campKey].total_val += (s * roas);
                  });
                }
              });

              afterCursor = (json.paging && json.paging.cursors && json.paging.cursors.after) ? json.paging.cursors.after : null;
            } else {
              afterCursor = null;
            }
          } while (afterCursor);

          // Push Rolled-Up Campaign Daily Insights to metaInsights & spend arrays
          Object.values(campaignDailyMap).forEach(camp => {
            const avgRoas = camp.spend > 0 ? (camp.total_val / camp.spend) : 0;
            metaInsights.push({
              insight_id: `${camp.date}_${actId}_${camp.campaign_id}`,
              date: camp.date,
              campaign_id: camp.campaign_id,
              campaign_name: camp.campaign_name,
              spend: Math.round(camp.spend * 100) / 100,
              impressions: camp.impressions,
              clicks: camp.clicks,
              reach: camp.reach,
              purchase_roas: Math.round(avgRoas * 100) / 100,
              ad_account_id: actId,
              ad_account_name: curName
            });

            spend.push({
              spend_id: `${camp.date}_Meta_${actId}_${camp.campaign_id}`,
              date: camp.date,
              platform: 'Meta',
              campaign_id: camp.campaign_id,
              campaign_name: camp.campaign_name,
              spend: Math.round(camp.spend * 100) / 100,
              impressions: camp.impressions,
              clicks: camp.clicks,
              ad_account_id: actId,
              ad_account_name: curName
            });
          });

          self.postMessage({ status: 'LOG', message: `Meta Single-Query Ingest (${curName}): Synced ${adsCount} ads & creatives with media URLs and daily stats.` });
        } catch (e) {
          self.postMessage({ status: 'LOG', message: `⚠️ Meta Single-Query Ingestion failed for ${curName}: ${e.message}` });
        }
      }
      self.postMessage({ status: 'LOG', message: `Meta Multi-Account Ingest Complete across ${accountsToSync.length} account(s).` });
    }
  }

  // 3. Fetch TikTok Ads Daily Spends
  if (targetSource === 'tiktok' || targetSource === 'all') {
    if (!tiktokId || !tiktokToken) {
      throw new Error("TikTok Advertiser ID and Access Token are required.");
    }
    self.postMessage({ status: 'LOG', message: `Querying TikTok Marketing API for daily ad costs...` });
    const tiktokResponse = await fetch('/api/proxy/tiktok', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        advertiserId: tiktokId,
        accessToken: tiktokToken,
        startDate: adjustedDateSince,
        endDate: dateUntil
      })
    });

    const tiktokJson = await tiktokResponse.json();
    if (tiktokJson.error || !tiktokJson.data || !tiktokJson.data.list) {
      throw new Error((tiktokJson.error && tiktokJson.error.message) || tiktokJson.message || 'Failed to fetch TikTok Ads daily spends.');
    }

    const tiktokData = tiktokJson.data.list;
    tiktokData.forEach(row => {
      const dateStr = row.dimensions.stat_time_day.substring(0, 10);
      spend.push({
        spend_id: `${dateStr}_TikTok`,
        date: dateStr,
        platform: 'TikTok',
        spend: parseFloat(row.metrics.spend || 0),
        impressions: parseInt(row.metrics.impressions || 0),
        clicks: parseInt(row.metrics.clicks || 0)
      });
    });
    self.postMessage({ status: 'LOG', message: `TikTok Ingest complete: Pulled ${tiktokData.length} daily spend records.` });
  }

  // 4. Fetch Google Ads Daily Spends
  if (targetSource === 'google' || targetSource === 'all') {
    if (!googleId || !googleDev || !googleToken) {
      throw new Error("Google Customer ID, Developer Token, and Access Token are required.");
    }
    self.postMessage({ status: 'LOG', message: `Querying Google Ads API via GAQL search...` });
    const gaqlQuery = `
      SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks 
      FROM campaign 
      WHERE segments.date >= '${adjustedDateSince}' AND segments.date <= '${dateUntil}'
    `;
    const googleResponse = await fetch('/api/proxy/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: googleId,
        developerToken: googleDev,
        accessToken: googleToken,
        query: gaqlQuery
      })
    });

    const googleJson = await googleResponse.json();
    if (googleJson.error || !Array.isArray(googleJson)) {
      throw new Error((googleJson.error && googleJson.error.message) || googleJson.message || 'Failed to fetch Google Ads daily spends.');
    }

    const googleDailySpend = {};
    googleJson.forEach(row => {
      const dateStr = row.segments.date;
      const spendGBP = parseFloat(row.metrics.costMicros || 0) / 1000000;
      const impressions = parseInt(row.metrics.impressions || 0);
      const clicks = parseInt(row.metrics.clicks || 0);
      
      if (!googleDailySpend[dateStr]) {
        googleDailySpend[dateStr] = { spend: 0, impressions: 0, clicks: 0 };
      }
      googleDailySpend[dateStr].spend += spendGBP;
      googleDailySpend[dateStr].impressions += impressions;
      googleDailySpend[dateStr].clicks += clicks;
    });

    Object.keys(googleDailySpend).forEach(dateStr => {
      spend.push({
        spend_id: `${dateStr}_Google`,
        date: dateStr,
        platform: 'Google',
        spend: googleDailySpend[dateStr].spend,
        impressions: googleDailySpend[dateStr].impressions,
        clicks: googleDailySpend[dateStr].clicks
      });
    });
    self.postMessage({ status: 'LOG', message: `Google Ads Ingest complete: Synced spending reports across ${Object.keys(googleDailySpend).length} dates.` });
  }

  if (targetSource === 'shopify' || targetSource === 'all') {
  // --- STAGE 2: IN-MEMORY TRANSLATION ---
  self.postMessage({ status: 'STAGE_2_START', message: 'Stage 2: Standardizing timezone offsets & currency keys...' });
  self.postMessage({ status: 'LOG', message: 'Stage 2: Standardizing click IDs and generating event_id fields for server-side attribution...' });
  self.postMessage({ status: 'LOG', message: 'Stage 2: [GDPR] Applying SHA-256 hashing to customer email and phone fields for Google Enhanced Conversions...' });
  self.postMessage({ status: 'LOG', message: `Stage 2: Deduplication event_ids bound for Meta CAPI (${metaPixel ? 'Active' : 'Dry-Run'}) and TikTok Events API (${tiktokPixel ? 'Active' : 'Dry-Run'}).` });
  await sleep(400);

  // --- STAGE 3: RETURN BACK-ALLOCATION ---
  self.postMessage({ status: 'STAGE_3_START', message: 'Stage 3: Linking refunds back to parent checkout dates...' });
  self.postMessage({ status: 'LOG', message: 'Stage 3: Parsing courier rate card CSV and evaluating true shipping costs...' });
  await sleep(500);

  const orderMap = {};
  orders.forEach(o => { orderMap[o.order_id] = o; });

  let reconciledCount = 0;
  returns.forEach(ret => {
    const parentOrder = orderMap[ret.parent_order_id];
    if (parentOrder) {
      parentOrder.reconciled_with_return = true;
      parentOrder.return_deduction += ret.returned_value;
      parentOrder.net_profit = parentOrder.gross_amount - parentOrder.discount_amount - 
                              parentOrder.shipping_cost - parentOrder.cost_of_goods - 
                              parentOrder.return_deduction - parentOrder.processor_fee;
      reconciledCount++;
    }
  });

  self.postMessage({ status: 'LOG', message: `Stage 3 complete: Retrospectively adjusted ${reconciledCount} parent transactions.` });
  }

  // --- STAGE 4: LOCAL STORAGE LOAD ---
  self.postMessage({ status: 'STAGE_4_START', message: 'Stage 4: Loading live Data Spine in IndexedDB stores...' });
  self.postMessage({ status: 'LOG', message: 'Stage 4: Checking event-driven webhook status... Shopify returns webhook active.' });
  
  if (targetSource === 'shopify' || targetSource === 'all') {
    await TrueSignalDB.clearStore('store_sessions');
    await TrueSignalDB.clearStore('shopify_orders');
    await TrueSignalDB.clearStore('shopify_returns');
    await TrueSignalDB.clearStore('shopify_customers');
    await TrueSignalDB.clearStore('shopify_products');
    await TrueSignalDB.clearStore('shopify_inventory');
    await TrueSignalDB.clearStore('shopify_fulfillments');
    await TrueSignalDB.clearStore('shopify_discounts');
    await TrueSignalDB.clearStore('shopify_checkouts');
    await TrueSignalDB.clearStore('shopify_shipping');
    await TrueSignalDB.clearStore('shopify_master_orders');
    
    await TrueSignalDB.bulkPut('store_sessions', sessions);
    await TrueSignalDB.bulkPut('shopify_orders', orders);
    await TrueSignalDB.bulkPut('shopify_returns', returns);
    if (shopifyMasterOrders.length > 0) await TrueSignalDB.bulkPut('shopify_master_orders', shopifyMasterOrders);

    if (typeof AttributionEngine !== 'undefined') {
      const sessionMap = new Map();
      sessions.forEach(s => {
        if (s.click_id) sessionMap.set(s.click_id, s);
        if (s.session_id) sessionMap.set(s.session_id, s);
      });

      const orderAttributions = [];
      const masterOrderAttributions = [];

      orders.forEach(o => {
        const matchingSession = sessionMap.get(o.click_id) || {};
        const conf = AttributionEngine.calculateOrderConfidence(o, matchingSession);
        o.attribution_level = conf.attribution_level;
        orderAttributions.push(conf);

        masterOrderAttributions.push({
          order_id: o.order_id,
          date: o.date,
          click_id: o.click_id,
          fbclid: o.fbclid || null,
          utm_campaign: o.utm_campaign,
          utm_source: o.utm_source,
          utm_content: o.utm_content,
          creative_id: o.creative_id,
          landingPageUrl: o.landingPageUrl || o.landing_page_url || o.landing_site || null,
          customAttributes: o.customAttributes || null,
          paymentGatewayNames: o.paymentGatewayNames || null,
          gross_amount: o.gross_amount,
          currency: o.currency,
          discount_amount: o.discount_amount,
          shipping_cost: o.shipping_cost,
          cost_of_goods: o.cost_of_goods,
          processor_fee: o.processor_fee,
          return_deduction: o.return_deduction,
          net_profit: o.net_profit,
          reconciled_with_return: o.reconciled_with_return,
          attribution_level: conf.attribution_level,
          confidence_score: conf.confidence_score,
          attribution_label: conf.attribution_label,
          explanation: conf.explanation,
          evidence: conf.evidence,
          event_id: o.event_id
        });
      });

      if (orderAttributions.length > 0) {
        await TrueSignalDB.clearStore('order_attributions');
        await TrueSignalDB.bulkPut('order_attributions', orderAttributions);
      }
      if (masterOrderAttributions.length > 0) {
        await TrueSignalDB.clearStore('master_order_attributions');
        await TrueSignalDB.bulkPut('master_order_attributions', masterOrderAttributions);
        self.postMessage({ status: 'LOG', message: `Master Order Table built: Populated ${masterOrderAttributions.length} fully-denormalized records attached with all parameters.` });
      }
    }
    await TrueSignalDB.bulkPut('shopify_customers', shopifyCustomers);
    await TrueSignalDB.bulkPut('shopify_products', shopifyProducts);
    await TrueSignalDB.bulkPut('shopify_inventory', shopifyInventory);
    await TrueSignalDB.bulkPut('shopify_fulfillments', shopifyFulfillments);
    await TrueSignalDB.bulkPut('shopify_discounts', shopifyDiscounts);
    await TrueSignalDB.bulkPut('shopify_checkouts', shopifyCheckouts);
    await TrueSignalDB.bulkPut('shopify_shipping', shopifyShipping);
  }
  if (targetSource === 'meta' || targetSource === 'tiktok' || targetSource === 'google' || targetSource === 'all') {
    if (spend.length > 0) {
      const targetPlatform = targetSource === 'meta' ? 'Meta' : (targetSource === 'tiktok' ? 'TikTok' : (targetSource === 'google' ? 'Google' : ''));
      if (targetPlatform) {
        const allSpend = await TrueSignalDB.getAll('ad_network_spend');
        const remainingSpend = allSpend.filter(s => s.platform !== targetPlatform);
        await TrueSignalDB.clearStore('ad_network_spend');
        if (remainingSpend.length > 0) {
          await TrueSignalDB.bulkPut('ad_network_spend', remainingSpend);
        }
      } else if (targetSource === 'all') {
        await TrueSignalDB.clearStore('ad_network_spend');
      }
      await TrueSignalDB.bulkPut('ad_network_spend', spend);
    }

    if (targetSource === 'meta' || targetSource === 'all') {
      await TrueSignalDB.clearStore('meta_campaigns');
      await TrueSignalDB.clearStore('meta_adsets');
      await TrueSignalDB.clearStore('meta_ads');
      await TrueSignalDB.clearStore('meta_creatives');
      await TrueSignalDB.clearStore('meta_insights');
      await TrueSignalDB.clearStore('meta_master_table');

      if (metaCampaigns.length > 0) await TrueSignalDB.bulkPut('meta_campaigns', metaCampaigns);
      if (metaAdSets.length > 0) await TrueSignalDB.bulkPut('meta_adsets', metaAdSets);
      if (metaAds.length > 0) await TrueSignalDB.bulkPut('meta_ads', metaAds);
      if (metaCreatives.length > 0) await TrueSignalDB.bulkPut('meta_creatives', metaCreatives);
      if (metaInsights.length > 0) await TrueSignalDB.bulkPut('meta_insights', metaInsights);
      if (metaMasterRecords.length > 0) await TrueSignalDB.bulkPut('meta_master_table', metaMasterRecords);

      if (typeof FamilyEngine !== 'undefined') {
        const existingFamilies = await TrueSignalDB.getAll('campaign_families');
        const campaignFamilies = FamilyEngine.autoGroupCampaigns(metaCampaigns, existingFamilies);
        if (campaignFamilies.length > 0) {
          await TrueSignalDB.bulkPut('campaign_families', campaignFamilies);
        }

        const creativeGrouping = FamilyEngine.autoGroupCreatives(metaCreatives, metaAds);
        if (creativeGrouping.families.length > 0) {
          await TrueSignalDB.bulkPut('creative_families', creativeGrouping.families);
        }
        if (creativeGrouping.variants.length > 0) {
          await TrueSignalDB.bulkPut('creative_variants', creativeGrouping.variants);
        }
      }
    }
  }

  self.postMessage({ status: 'LOG', message: 'Live connection tables locked. Refreshing UI.' });
  self.postMessage({ status: 'INGESTION_COMPLETE' });
}

// --- SYNTHETIC DEMO INGESTION PIPELINE ---

async function runDemoIngestion(creds, targetSource = 'all') {
  const {
    cogsRate = 35, processorFeeRate = 2.9, processorFlatFee = 0.30, shippingRateCard = 'Flat Rate,4.99'
  } = creds || {};

  const dateSince = getDateNDaysAgo(90);

  // Existing synthetic demo loop
  const numDays = 90;
  let apiPoints = 100;
  const pointCostPerRequest = 12;
  const restoreRatePerSec = 18;
  let throttleCount = 0;

  const dailyRawDataList = [];

  for (let dayOffset = 0; dayOffset < numDays; dayOffset++) {
    const date = getDateNDaysAgo(numDays - 1 - dayOffset);

    if (apiPoints < pointCostPerRequest) {
      const sleepTime = 600;
      self.postMessage({ 
        status: 'LOG', 
        message: `⚠️ API Rate Limit warning (Points: ${apiPoints.toFixed(1)}). Throttling pipeline for ${sleepTime}ms...` 
      });
      await sleep(sleepTime);
      apiPoints = Math.min(100, apiPoints + (restoreRatePerSec * (sleepTime / 1000)));
      throttleCount++;
    }

    apiPoints -= pointCostPerRequest;
    
    self.postMessage({
      status: 'LOG',
      message: `Ingesting day ${dayOffset + 1}/${numDays}: ${date} | Shopify API points: ${apiPoints.toFixed(1)}`
    });

    const rawDayData = generateRawDayMetrics(date, dayOffset);
    dailyRawDataList.push(rawDayData);

    if (dayOffset % 10 === 0) {
      await sleep(1);
    }
  }

  self.postMessage({ 
    status: 'LOG', 
    message: `Stage 1 complete. Extracted 90 days of raw metrics. (Throttled ${throttleCount} times).` 
  });

  // STAGE 2
  self.postMessage({ status: 'STAGE_2_START', message: 'Stage 2: Translating raw payloads to Unified Data Spine...' });
  self.postMessage({ status: 'LOG', message: 'Stage 2: Standardizing click IDs and generating event_id fields for server-side attribution...' });
  self.postMessage({ status: 'LOG', message: 'Stage 2: [GDPR] Applying SHA-256 hashing to customer PII email and phone fields (Simulated)...' });
  self.postMessage({ status: 'LOG', message: 'Stage 2: Deduplication event_ids bound for Meta CAPI and TikTok Events API (Simulated).' });
  await sleep(500);

  const sessions = [];
  const orders = [];
  const spend = [];
  const rawReturns = [];

  const shopifyCustomers = [];
  const shopifyProducts = [];
  const shopifyInventory = [];
  const shopifyFulfillments = [];
  const shopifyDiscounts = [];
  const shopifyCheckouts = [];
  const shopifyShipping = [];

  const metaCampaigns = [];
  const metaAdSets = [];
  const metaAds = [];
  const metaCreatives = [];
  const metaInsights = [];

  if (targetSource === 'shopify' || targetSource === 'all') {
    // Generate synthetic customers, products, inventory, shipping, discounts, checkouts, fulfillments
    const firstNames = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan'];
    const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson'];
    const cities = ['New York, US', 'Los Angeles, US', 'Chicago, US', 'Houston, US', 'Phoenix, US', 'Philadelphia, US', 'San Antonio, US', 'San Diego, US'];

    for (let i = 0; i < 20; i++) {
      const f = firstNames[i % firstNames.length];
      const l = lastNames[i % lastNames.length];
      shopifyCustomers.push({
        customer_id: `gid://shopify/Customer/${100000 + i}`,
        first_name: f,
        last_name: l,
        email: `${f.toLowerCase()}.${l.toLowerCase()}@example.com`,
        phone: `+1-555-01${10 + i}`,
        orders_count: 1 + (i % 3),
        total_spent: 45.0 * (1 + (i % 3)),
        created_at: dateSince
      });
    }

    const mockProducts = [
      { id: '1', title: 'AeroSpike Running Shoes', type: 'Footwear' },
      { id: '2', title: 'CarbonSpike Athletics Tee', type: 'Apparel' },
      { id: '3', title: 'HydroFlow Water Bottle', type: 'Accessories' },
      { id: '4', title: 'SpeedStrider Sports Socks', type: 'Footwear' }
    ];

    mockProducts.forEach((p, idx) => {
      shopifyProducts.push({
        product_id: `gid://shopify/Product/${1000 + idx}`,
        title: p.title,
        handle: p.title.toLowerCase().replace(/ /g, '-'),
        status: 'ACTIVE',
        vendor: 'TrueSignal Athl.',
        product_type: p.type,
        created_at: dateSince
      });
      shopifyInventory.push({
        inventory_item_id: `gid://shopify/InventoryItem/${5000 + idx}`,
        sku: `TS-${p.title.substring(0, 3).toUpperCase()}-0${idx}`,
        tracked: true,
        unit_cost: 15.0 + idx * 2.5,
        sync_status: 'Synced'
      });
    });

    shopifyShipping.push({
      shipping_id: 'gid://shopify/DeliveryProfile/1',
      name: 'General Domestic Profile',
      is_default: true,
      status: 'Active'
    });

    shopifyDiscounts.push({
      discount_id: 'gid://shopify/PriceRule/1',
      title: 'SUMMER20',
      value_type: 'PERCENTAGE',
      value: -20.0,
      target_type: 'LINE_ITEM',
      starts_at: dateSince
    });

    for (let i = 0; i < 5; i++) {
      shopifyCheckouts.push({
        checkout_id: `gid://shopify/Checkout/${8000 + i}`,
        name: `#CO-${8000 + i}`,
        email: `guest${i}@test.com`,
        total_price: 89.99,
        completed_at: 'Abandoned'
      });
      shopifyFulfillments.push({
        fulfillment_id: `gid://shopify/Fulfillment/${6330393854205 + i}`,
        order_id: `shopify_ord_${100000 + i}`,
        fulfillment_name: `#AS47614.${i + 1}`,
        status: 'success',
        shipment_status: 'delivered',
        tracking_company: 'DelhiverySurface(Brand)',
        tracking_number: String(37355837937070 + i),
        tracking_link: `https://app.fship.in/shipment/tracking?awbno=${37355837937070 + i}`,
        created_at: dateSince + 'T11:52:47Z',
        updated_at: dateSince + 'T17:19:13Z'
      });
    }
  }

  dailyRawDataList.forEach((dayData) => {
    const { date, rawSessions, rawOrders, rawSpend, rawDailyReturns } = dayData;

    if (targetSource === 'shopify' || targetSource === 'all') {
      rawSessions.forEach(s => {
        sessions.push({
          session_id: s.sessionId,
          date: date,
          utm_campaign: s.campaign,
          click_id: s.clickId,
          event_id: `evt_${uuidv4().substring(0, 8)}`
        });
      });

      rawOrders.forEach(o => {
        const computedCOGS = o.grossAmount * (parseFloat(cogsRate) / 100);
        const computedProcessorFee = o.grossAmount > 0 ? (o.grossAmount * (parseFloat(processorFeeRate) / 100) + parseFloat(processorFlatFee)) : 0;
        const trueShipping = parseShippingCost(o.grossAmount, shippingRateCard);
        const eventId = `evt_${uuidv4().substring(0, 8)}`;

        const firstNames = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan'];
        const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson'];
        const cities = ['New York, US', 'Los Angeles, US', 'Chicago, US', 'Houston, US', 'Phoenix, US', 'Philadelphia, US', 'San Antonio, US', 'San Diego, US'];

        let hash = 0;
        for (let idx = 0; idx < o.orderId.length; idx++) {
          hash = o.orderId.charCodeAt(idx) + ((hash << 5) - hash);
        }
        hash = Math.abs(hash);
        const firstName = firstNames[hash % firstNames.length];
        const lastName = lastNames[(hash + 3) % lastNames.length];
        const city = cities[(hash + 5) % cities.length];
        const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`;

        let utmSource = 'Direct';
        if (o.campaign.startsWith('Meta')) utmSource = 'fb';
        else if (o.campaign.startsWith('TikTok')) utmSource = 'tiktok';
        else if (o.campaign.startsWith('Google')) utmSource = 'google';
        const isUnfulfilled = Math.random() < 0.08;

        orders.push({
          order_id: o.orderId,
          date: date,
          click_id: o.clickId,
          utm_campaign: o.campaign,
          utm_source: utmSource,
          fulfillment_status: isUnfulfilled ? 'UNFULFILLED' : 'FULFILLED',
          gross_amount: o.grossAmount,
          currency: o.currency || 'INR',
          discount_amount: o.discountAmount,
          shipping_cost: trueShipping,
          cost_of_goods: computedCOGS,
          processor_fee: computedProcessorFee,
          net_profit: o.grossAmount - o.discountAmount - trueShipping - computedCOGS - computedProcessorFee,
          reconciled_with_return: false,
          return_deduction: 0,
          event_id: eventId,
          customer_name: `${firstName} ${lastName}`,
          customer_email: email,
          customer_location: city
        });
      });

      rawDailyReturns.forEach(r => {
        rawReturns.push({
          return_id: r.returnId,
          parent_order_id: r.parentOrderId,
          date_returned: date,
          returned_value: r.value,
          restock_fee: r.restockFee
        });
      });
    }

    rawSpend.forEach(s => {
      let include = false;
      if (targetSource === 'all') include = true;
      else if (targetSource === 'meta' && s.platform === 'Meta') include = true;
      else if (targetSource === 'tiktok' && s.platform === 'TikTok') include = true;
      else if (targetSource === 'google' && s.platform === 'Google') include = true;

      if (include) {
        spend.push({
          spend_id: `${date}_${s.platform}`,
          date: date,
          platform: s.platform,
          spend: s.spend,
          impressions: s.impressions,
          clicks: s.clicks
        });
      }
    });
  });

  if (targetSource === 'shopify' || targetSource === 'all') {
    // STAGE 3
    self.postMessage({ status: 'STAGE_3_START', message: 'Stage 3: Executing Return Back-Allocations...' });
    self.postMessage({ status: 'LOG', message: 'Stage 3: Parsing courier rate card CSV and evaluating true shipping costs...' });
    await sleep(600);

    const orderMap = {};
    orders.forEach(o => { orderMap[o.order_id] = o; });

    let reconciledCount = 0;
    rawReturns.forEach(ret => {
      const parentOrder = orderMap[ret.parent_order_id];
      if (parentOrder) {
        parentOrder.reconciled_with_return = true;
        parentOrder.return_deduction += ret.returned_value;
        parentOrder.net_profit = parentOrder.gross_amount - parentOrder.discount_amount - 
                                parentOrder.shipping_cost - parentOrder.cost_of_goods - 
                                parentOrder.return_deduction + ret.restock_fee - parentOrder.processor_fee;
        reconciledCount++;
      }
    });
    self.postMessage({ status: 'LOG', message: `Stage 3 complete: Adjusted ${reconciledCount} parent transactions.` });
  }

  // Generate mock Meta Ads multi-table datasets
  if (targetSource === 'meta' || targetSource === 'all') {
    const mockMetaCampaigns = [
      { id: '120283749281', name: 'UK_PROSPECTING_AEROSPIKE_CAROUSEL', status: 'ACTIVE', objective: 'OUTCOME_SALES' },
      { id: '120283749282', name: 'UK_RETARGETING_CARBON_TEE', status: 'ACTIVE', objective: 'OUTCOME_SALES' },
      { id: '120283749283', name: 'UK_LOOKALIKE_PURCHASE_LAL_1%', status: 'ACTIVE', objective: 'OUTCOME_SALES' }
    ];
    mockMetaCampaigns.forEach(c => metaCampaigns.push({ campaign_id: c.id, name: c.name, status: c.status, objective: c.objective }));

    const mockMetaAdsets = [
      { id: '238472910283', name: 'Meta_Adset_Broad_18-50_UK', status: 'ACTIVE', budget: '£150.00/day' },
      { id: '238472910284', name: 'Meta_Adset_Retargeting_30d_UK', status: 'ACTIVE', budget: '£50.00/day' },
      { id: '238472910285', name: 'Meta_Adset_LAL_Purchase_1%_UK', status: 'ACTIVE', budget: '£100.00/day' }
    ];
    mockMetaAdsets.forEach(a => metaAdSets.push({ adset_id: a.id, name: a.name, status: a.status, budget: a.budget }));

    const mockMetaAds = [
      { id: '348271039481', name: 'Ad_AeroSpike_Creative_Carousel', status: 'ACTIVE', campaign_id: '120283749281', adset_id: '238472910283' },
      { id: '348271039482', name: 'Ad_CarbonSpike_Promo_Video', status: 'ACTIVE', campaign_id: '120283749282', adset_id: '238472910284' },
      { id: '348271039483', name: 'Ad_Spring_Clearance_Banner', status: 'ACTIVE', campaign_id: '120283749283', adset_id: '238472910285' }
    ];
    mockMetaAds.forEach(a => metaAds.push({ ad_id: a.id, name: a.name, status: a.status, campaign_id: a.campaign_id, adset_id: a.adset_id }));

    const mockMetaCreatives = [
      { id: '458172039481', name: 'Creative_AeroSpike_Carousel', title: 'AeroSpike Running Shoes', body: 'Engineered for maximum speed and comfort. Get yours now!' },
      { id: '458172039482', name: 'Creative_CarbonSpike_Promo_Video', title: 'CarbonSpike Athletics Tee', body: 'Ultra-breathable athletic wear designed by running scientists.' },
      { id: '458172039483', name: 'Creative_Spring_Clearance_Banner', title: 'Spring Clearance Sale - 25% Off', body: 'Use coupon SPRING25 at checkout for limited time discounts.' }
    ];
    mockMetaCreatives.forEach(c => metaCreatives.push({ creative_id: c.id, name: c.name, title: c.title, body: c.body }));

    dailyRawDataList.forEach((rawDay, offset) => {
      const date = getDateNDaysAgo(numDays - 1 - offset);
      const metaDaySpend = rawDay.rawSpend.find(s => s.platform === 'Meta');
      if (metaDaySpend) {
        const metaSpendVal = metaDaySpend.spend;

        const splits = [
          { camp: mockMetaCampaigns[0], pct: 0.5 },
          { camp: mockMetaCampaigns[1], pct: 0.3 },
          { camp: mockMetaCampaigns[2], pct: 0.2 }
        ];

        splits.forEach(s => {
          const cSpend = metaSpendVal * s.pct;
          const cImpressions = Math.round(cSpend * 55);
          const cClicks = Math.round(cSpend * 1.2);
          const cReach = Math.round(cImpressions * 0.7);

          metaInsights.push({
            insight_id: `${date}_${s.camp.id}`,
            date: date,
            campaign_id: s.camp.id,
            campaign_name: s.camp.name,
            spend: parseFloat(cSpend.toFixed(2)),
            impressions: cImpressions,
            clicks: cClicks,
            reach: cReach
          });

          spend.push({
            spend_id: `${date}_Meta_${s.camp.id}`,
            date: date,
            platform: 'Meta',
            campaign_id: s.camp.id,
            campaign_name: s.camp.name,
            spend: parseFloat(cSpend.toFixed(2)),
            impressions: cImpressions,
            clicks: cClicks
          });
        });
      }
    });
  }

  // STAGE 4
  self.postMessage({ status: 'STAGE_4_START', message: 'Stage 4: Writing tables to IndexedDB...' });
  self.postMessage({ status: 'LOG', message: 'Stage 4: Checking returns webhook configuration... active.' });
  
  if (targetSource === 'shopify' || targetSource === 'all') {
    await TrueSignalDB.clearStore('store_sessions');
    await TrueSignalDB.clearStore('shopify_orders');
    await TrueSignalDB.clearStore('shopify_returns');
    await TrueSignalDB.clearStore('shopify_customers');
    await TrueSignalDB.clearStore('shopify_products');
    await TrueSignalDB.clearStore('shopify_inventory');
    await TrueSignalDB.clearStore('shopify_fulfillments');
    await TrueSignalDB.clearStore('shopify_discounts');
    await TrueSignalDB.clearStore('shopify_checkouts');
    await TrueSignalDB.clearStore('shopify_shipping');
    
    await TrueSignalDB.bulkPut('store_sessions', sessions);
    await TrueSignalDB.bulkPut('shopify_orders', orders);
    await TrueSignalDB.bulkPut('shopify_returns', rawReturns);

    if (typeof AttributionEngine !== 'undefined') {
      const sessionMap = new Map();
      sessions.forEach(s => {
        if (s.click_id) sessionMap.set(s.click_id, s);
        if (s.session_id) sessionMap.set(s.session_id, s);
      });

      const orderAttributions = [];
      orders.forEach(o => {
        const matchingSession = sessionMap.get(o.click_id) || {};
        const conf = AttributionEngine.calculateOrderConfidence(o, matchingSession);
        o.attribution_level = conf.attribution_level;
        orderAttributions.push(conf);
      });

      if (orderAttributions.length > 0) {
        await TrueSignalDB.clearStore('order_attributions');
        await TrueSignalDB.bulkPut('order_attributions', orderAttributions);
      }
    }
    await TrueSignalDB.bulkPut('shopify_customers', shopifyCustomers);
    await TrueSignalDB.bulkPut('shopify_products', shopifyProducts);
    await TrueSignalDB.bulkPut('shopify_inventory', shopifyInventory);
    await TrueSignalDB.bulkPut('shopify_fulfillments', shopifyFulfillments);
    await TrueSignalDB.bulkPut('shopify_discounts', shopifyDiscounts);
    await TrueSignalDB.bulkPut('shopify_checkouts', shopifyCheckouts);
    await TrueSignalDB.bulkPut('shopify_shipping', shopifyShipping);
  }
  if (targetSource === 'meta' || targetSource === 'tiktok' || targetSource === 'google' || targetSource === 'all') {
    if (spend.length > 0) {
      const targetPlatform = targetSource === 'meta' ? 'Meta' : (targetSource === 'tiktok' ? 'TikTok' : (targetSource === 'google' ? 'Google' : ''));
      if (targetPlatform) {
        const allSpend = await TrueSignalDB.getAll('ad_network_spend');
        const remainingSpend = allSpend.filter(s => s.platform !== targetPlatform);
        await TrueSignalDB.clearStore('ad_network_spend');
        if (remainingSpend.length > 0) {
          await TrueSignalDB.bulkPut('ad_network_spend', remainingSpend);
        }
      } else if (targetSource === 'all') {
        await TrueSignalDB.clearStore('ad_network_spend');
      }
      await TrueSignalDB.bulkPut('ad_network_spend', spend);
    }

    if (targetSource === 'meta' || targetSource === 'all') {
      await TrueSignalDB.clearStore('meta_campaigns');
      await TrueSignalDB.clearStore('meta_adsets');
      await TrueSignalDB.clearStore('meta_ads');
      await TrueSignalDB.clearStore('meta_creatives');
      await TrueSignalDB.clearStore('meta_insights');

      if (metaCampaigns.length > 0) await TrueSignalDB.bulkPut('meta_campaigns', metaCampaigns);
      if (metaAdSets.length > 0) await TrueSignalDB.bulkPut('meta_adsets', metaAdSets);
      if (metaAds.length > 0) await TrueSignalDB.bulkPut('meta_ads', metaAds);
      if (metaCreatives.length > 0) await TrueSignalDB.bulkPut('meta_creatives', metaCreatives);
      if (metaInsights.length > 0) await TrueSignalDB.bulkPut('meta_insights', metaInsights);

      if (typeof FamilyEngine !== 'undefined') {
        const existingFamilies = await TrueSignalDB.getAll('campaign_families');
        const campaignFamilies = FamilyEngine.autoGroupCampaigns(metaCampaigns, existingFamilies);
        if (campaignFamilies.length > 0) {
          await TrueSignalDB.bulkPut('campaign_families', campaignFamilies);
        }

        const creativeGrouping = FamilyEngine.autoGroupCreatives(metaCreatives, metaAds);
        if (creativeGrouping.families.length > 0) {
          await TrueSignalDB.bulkPut('creative_families', creativeGrouping.families);
        }
        if (creativeGrouping.variants.length > 0) {
          await TrueSignalDB.bulkPut('creative_variants', creativeGrouping.variants);
        }
      }
    }
  }

  self.postMessage({ status: 'LOG', message: 'All object stores successfully synced and locked.' });
  self.postMessage({ status: 'INGESTION_COMPLETE' });
}

// --- HELPER FUNCTIONS ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDateNDaysAgo(n) {
  const date = new Date();
  date.setDate(date.getDate() - n);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function generateRawDayMetrics(date, dayIndex) {
  const dayOfWeek = new Date(date).getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  
  const weeklyMultipliers = [1.4, 1.1, 0.95, 1.0, 1.05, 0.8, 1.25];
  const mult = weeklyMultipliers[dayOfWeek];

  const isPromoDay = (dayIndex % 15 === 8);
  const promoDiscount = isPromoDay ? 0.25 : 0.05;

  const metaSpend = (450 + Math.sin(dayIndex / 5) * 150) * (isWeekend ? 1.2 : 0.9);
  const tiktokSpend = (250 + Math.cos(dayIndex / 3) * 100 + (dayIndex % 20 === 0 ? 300 : 0));
  const googleSpend = 350 + Math.sin(dayIndex / 10) * 50;

  const rawSpend = [
    { platform: 'Meta', spend: metaSpend, impressions: Math.round(metaSpend * 55), clicks: Math.round(metaSpend * 1.2) },
    { platform: 'TikTok', spend: tiktokSpend, impressions: Math.round(tiktokSpend * 85), clicks: Math.round(tiktokSpend * 0.9) },
    { platform: 'Google', spend: googleSpend, impressions: Math.round(googleSpend * 12), clicks: Math.round(googleSpend * 1.5) }
  ];

  const rawSessions = [];
  const rawOrders = [];
  let orderIdCounter = dayIndex * 1000 + 1;

  const channels = [
    { name: 'Meta', spend: metaSpend, clicks: Math.round(metaSpend * 1.2), cvr: 0.022, aov: 70, returnRate: 0.28 },
    { name: 'TikTok', spend: tiktokSpend, clicks: Math.round(tiktokSpend * 0.9), cvr: 0.015, aov: 55, returnRate: 0.38 },
    { name: 'Google', spend: googleSpend, clicks: Math.round(googleSpend * 1.5), cvr: 0.035, aov: 85, returnRate: 0.15 },
    { name: 'Direct', spend: 0, clicks: Math.round(250 * mult), cvr: 0.02, aov: 75, returnRate: 0.10 }
  ];

  channels.forEach(ch => {
    for (let s = 0; s < ch.clicks; s++) {
      const sessionId = uuidv4();
      const clickId = ch.spend > 0 ? `clk_${ch.name.toLowerCase()}_${uuidv4().substring(0,8)}` : null;
      
      const session = {
        sessionId,
        campaign: ch.spend > 0 ? `${ch.name}_Conversion_Campaign` : 'Direct_Traffic',
        clickId
      };
      rawSessions.push(session);

      let effectiveCVR = ch.cvr * mult;
      if (isPromoDay) effectiveCVR *= 1.8;

      if (Math.random() < effectiveCVR) {
        const orderId = `TS-${orderIdCounter++}`;
        
        let grossAmount = ch.aov * (0.9 + Math.random() * 0.2);
        if (isPromoDay) grossAmount *= 1.15;
        
        const discountAmount = grossAmount * promoDiscount;
        const shippingCost = 4.99;
        const cogs = grossAmount * 0.35;

        rawOrders.push({
          orderId,
          clickId,
          campaign: session.campaign,
          grossAmount,
          discountAmount,
          shippingCost,
          cogs,
          returnRate: ch.returnRate
        });
      }
    }
  });

  const rawDailyReturns = [];
  const returnCount = Math.round(rawOrders.length * 0.25);

  for (let r = 0; r < returnCount; r++) {
    const pastDayOffset = 7 + Math.floor(Math.random() * 14);
    const pastDayIndex = Math.max(0, dayIndex - pastDayOffset);
    const pastOrderBase = pastDayIndex * 1000;
    
    const orderOffset = 1 + Math.floor(Math.random() * 35);
    const parentOrderId = `TS-${pastOrderBase + orderOffset}`;

    const returnVal = 35 + Math.random() * 45;
    
    rawDailyReturns.push({
      returnId: `RET-${dayIndex}-${r}`,
      parentOrderId,
      value: returnVal,
      restockFee: Math.random() > 0.6 ? 2.50 : 0
    });
  }

  return {
    date,
    rawSessions,
    rawOrders,
    rawSpend,
    rawDailyReturns
  };
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
