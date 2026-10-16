// TrueSignal - Order Attribution & Traceability
// Confidence scoring and customer touchpoint timeline reconstruction

(function (exports) {

  // Computes confidence score (0-100) based on captured tracking parameters
  function calculateOrderConfidence(order = {}, session = {}) {
    const clickId = order.click_id || session.click_id || '';
    const utmCampaign = order.utm_campaign || session.utm_campaign || '';
    const utmSource = (order.utm_source || session.utm_source || '').toLowerCase();
    const utmContent = order.utm_content || session.utm_content || '';
    const creativeId = order.creative_id || session.creative_id || '';
    const fbclid = order.fbclid || session.fbclid || '';
    const fbc = order.fbc || session.fbc || '';
    const fbp = order.fbp || session.fbp || '';

    let score = 0;
    let level = 'UNATTRIBUTED';
    let label = '0% Unattributed';
    let explanation = 'No defensible marketing source or tracking evidence found.';

    const hasRealClickId = clickId && !clickId.startsWith('clk_direct_');

    // 100% Deterministic: Exact ad click ID or fbclid + campaign/creative
    if ((hasRealClickId || fbclid) && (utmContent || creativeId || utmCampaign)) {
      score = 100;
      level = 'DETERMINISTIC';
      label = '100% Deterministic';
      explanation = 'Exact first-party click_id and ad/campaign identifiers captured at checkout.';
    }
    // High Confidence: Direct fbclid or session click with source
    else if (fbclid || (hasRealClickId && utmSource)) {
      score = 90;
      level = 'HIGH_CONFIDENCE';
      label = '90% High Confidence';
      explanation = 'Direct Meta fbclid or authenticated customer session matched.';
    }
    // Probabilistic: UTM campaign matched without unique click token
    else if (utmCampaign) {
      score = 70;
      level = 'PROBABILISTIC';
      label = '70% Probabilistic';
      explanation = 'Campaign UTM parameter matched without unique ad click ID (e.g. direct/saved link or old campaign).';
    }
    // Source Only: General source known but campaign/creative missing
    else if (utmSource && utmSource !== 'direct') {
      score = 30;
      level = 'SOURCE_ONLY';
      label = '30% Source Only';
      explanation = 'Traffic source known (e.g. paid social), but specific campaign or ad is unlinked.';
    }

    return {
      order_id: order.order_id || 'UNKNOWN',
      confidence_score: score,
      attribution_level: level,
      attribution_label: label,
      explanation: explanation,
      evidence: {
        click_id: clickId,
        utm_campaign: utmCampaign,
        utm_source: utmSource || 'Direct',
        utm_content: utmContent,
        creative_id: creativeId,
        fbclid: fbclid,
        fbc: fbc,
        fbp: fbp
      }
    };
  }

  // Assembles touchpoint sequence for timeline inspection
  function buildCustomerJourneyTimeline(order = {}, session = {}, returnsList = []) {
    const timeline = [];
    const orderDate = order.date || new Date().toISOString().split('T')[0];

    // First touch (landing session)
    if (session && (session.date || session.click_id)) {
      timeline.push({
        type: 'FIRST_TOUCH',
        title: 'First Paid Click Landing',
        timestamp: session.date || orderDate,
        badge: 'First Touch',
        badgeColor: 'var(--primary)',
        details: `Captured UTM Campaign: ${session.utm_campaign || 'N/A'} (Click ID: ${session.click_id || 'N/A'})`
      });
    }

    // Last paid touch
    if (order.utm_campaign || order.click_id) {
      timeline.push({
        type: 'LAST_TOUCH',
        title: 'Last Attributable Click',
        timestamp: orderDate,
        badge: 'Last Touch',
        badgeColor: 'var(--success)',
        details: `Source: ${order.utm_source || 'Meta Ads'} | Campaign: ${order.utm_campaign || 'N/A'}`
      });
    }

    // Order placed event
    timeline.push({
      type: 'ORDER_PLACED',
      title: `Shopify Order Placed (${order.order_id || 'Order'})`,
      timestamp: orderDate,
      badge: 'Purchased',
      badgeColor: 'var(--text-main)',
      details: `Gross Amount: £${(order.gross_amount || 0).toFixed(2)} | Net Profit: £${(order.net_profit || 0).toFixed(2)}`
    });

    // Processed returns linked to this order
    const matchingReturns = returnsList.filter(r => r.parent_order_id === order.order_id);
    matchingReturns.forEach(ret => {
      timeline.push({
        type: 'REFUND_PROCESSED',
        title: `Refund Mapped to Original Order`,
        timestamp: ret.date_returned || orderDate,
        badge: 'Refunded',
        badgeColor: 'var(--danger)',
        details: `Return Deduction: £${(ret.return_amount || ret.deduction || 0).toFixed(2)} (Assigned back to original acquisition)`
      });
    });

    return timeline;
  }

  exports.AttributionEngine = {
    calculateOrderConfidence,
    buildCustomerJourneyTimeline
  };

})(typeof window !== 'undefined' ? window : self);
