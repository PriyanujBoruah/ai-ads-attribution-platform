// TrueSignal - 1st-Party Client Tracking Script
// Preserves click_id, utm tags, fbc/fbp in first-party cookies for cart checkout matching


(function (window, document) {
  'use strict';

  const COOKIE_EXPIRY_DAYS = 90;
  const SCRIPT_TAG = document.currentScript;
  const INGEST_ENDPOINT = (SCRIPT_TAG && SCRIPT_TAG.getAttribute('data-endpoint')) 
    || window.TRUESIGNAL_INGEST_ENDPOINT 
    || '/api/proxy/ingest';

  // 1. Cookie Utility Helpers
  function setCookie(name, value, days) {
    const d = new Date();
    d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
    const expires = 'expires=' + d.toUTCString();
    const domain = window.location.hostname.replace(/^www\./, '');
    document.cookie = `${name}=${encodeURIComponent(value)};${expires};path=/;domain=.${domain};SameSite=Lax;Secure`;
  }

  function getCookie(name) {
    const cname = name + '=';
    const decodedCookie = decodeURIComponent(document.cookie);
    const ca = decodedCookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i].trim();
      if (c.indexOf(cname) === 0) {
        return c.substring(cname.length, c.length);
      }
    }
    return '';
  }

  // 2. Generate Unique First-Party Click ID
  function generateClickId() {
    return 'clk_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  }

  // 3. Extract Tracking Parameters from Query String
  function extractTrackingParams() {
    const params = new URLSearchParams(window.location.search);
    const tracking = {
      fbclid: params.get('fbclid') || '',
      ttclid: params.get('ttclid') || '',
      gclid: params.get('gclid') || '',
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      utm_content: params.get('utm_content') || '',
      utm_term: params.get('utm_term') || '',
      creative_id: params.get('creative_id') || params.get('utm_content') || '',
      ad_id: params.get('ad_id') || '',
      adset_id: params.get('adset_id') || '',
      campaign_id: params.get('campaign_id') || '',
      landing_page_url: window.location.href,
      referrer: document.referrer || 'direct',
      timestamp: new Date().toISOString()
    };

    return tracking;
  }

  // 4. Initialize & Persist 1st-Party Identity Cookies
  function initFirstPartySession() {
    const params = extractTrackingParams();
    const existingClickId = getCookie('_ts_click_id');
    const existingFbc = getCookie('_fbc');
    const existingFbp = getCookie('_fbp');

    // Create or renew click ID if fresh ad landing
    let clickId = existingClickId;
    if (params.fbclid || params.gclid || params.ttclid || params.utm_campaign || !existingClickId) {
      clickId = generateClickId();
      setCookie('_ts_click_id', clickId, COOKIE_EXPIRY_DAYS);
      localStorage.setItem('_ts_click_id', clickId);
    }

    // Meta _fbc generation (fb.1.timestamp.fbclid)
    let fbc = existingFbc;
    if (params.fbclid) {
      fbc = `fb.1.${Date.now()}.${params.fbclid}`;
      setCookie('_fbc', fbc, COOKIE_EXPIRY_DAYS);
    }

    // Meta _fbp generation (fb.1.timestamp.randomId)
    let fbp = existingFbp;
    if (!fbp) {
      const randNum = Math.floor(Math.random() * 8999999999 + 1000000000);
      fbp = `fb.1.${Date.now()}.${randNum}`;
      setCookie('_fbp', fbp, COOKIE_EXPIRY_DAYS);
    }

    // Persist full tracking state to LocalStorage
    if (params.utm_source || params.fbclid || params.utm_campaign) {
      localStorage.setItem('_ts_attribution_payload', JSON.stringify({
        ...params,
        click_id: clickId,
        fbc: fbc,
        fbp: fbp
      }));
    }

    // Attach tracking data to Shopify Cart Attributes for 100% Deterministic Checkout Matching
    syncWithShopifyCart(clickId, params, fbc, fbp);
  }

  // 5. Inject into Shopify Cart Attributes (Enables Zero-Loss Server Webhook Attribution)
  function syncWithShopifyCart(clickId, params, fbc, fbp) {
    if (typeof fetch !== 'function') return;

    const cartAttributes = {
      attributes: {
        '_ts_click_id': clickId,
        '_ts_utm_campaign': params.utm_campaign || '',
        '_ts_utm_source': params.utm_source || '',
        '_ts_utm_content': params.utm_content || '',
        '_ts_creative_id': params.creative_id || '',
        '_ts_fbclid': params.fbclid || '',
        '_ts_fbc': fbc || '',
        '_ts_fbp': fbp || '',
        '_ts_landing_url': params.landing_page_url || ''
      }
    };

    try {
      fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cartAttributes)
      }).catch(() => {
        // Silently handle non-Shopify environments
      });
    } catch (e) {
      // Ignored if not on a Shopify storefront
    }
  }

  // Auto-run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFirstPartySession);
  } else {
    initFirstPartySession();
  }

  // Expose global tracker
  window.TrueSignalTracker = {
    getClickId: () => getCookie('_ts_click_id') || localStorage.getItem('_ts_click_id'),
    getAttributionPayload: () => {
      try {
        return JSON.parse(localStorage.getItem('_ts_attribution_payload') || '{}');
      } catch (e) {
        return {};
      }
    }
  };

})(window, document);
