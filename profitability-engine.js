// TrueSignal - Unit Economics & POAS Calculations
// Handles UK VAT, COGS, shipping, payment processor cuts, and contribution margins

(function (exports) {

  let currentVatMode = 'INCLUSIVE'; // 'INCLUSIVE' (20% UK VAT) or 'EXCLUSIVE'

  function setVatMode(mode) {
    if (mode === 'INCLUSIVE' || mode === 'EXCLUSIVE') {
      currentVatMode = mode;
    }
  }

  // Calculate net margin & contribution for an individual order
  function calculateOrderCommercials(order = {}, vatMode = currentVatMode) {
    const grossAmount = parseFloat(order.gross_amount || order.total_price || order.subtotal_price || (order.total_price_set && order.total_price_set.shop_money ? order.total_price_set.shop_money.amount : 0) || 0);
    const returnDeduction = parseFloat(order.return_deduction || order.refunded_amount || (Array.isArray(order.refunds) ? order.refunds.reduce((sum, r) => sum + parseFloat(r.total_refund || r.amount || 0), 0) : 0) || 0);
    const discountAmount = parseFloat(order.discount_amount || order.total_discounts || 0);
    const cogs = parseFloat(order.cost_of_goods || order.cogs || 0);
    const shippingCost = parseFloat(order.shipping_cost || order.total_shipping || (Array.isArray(order.shipping_lines) ? order.shipping_lines.reduce((sum, s) => sum + parseFloat(s.price || 0), 0) : 0) || 0);
    const processorFee = parseFloat(order.processor_fee || order.fee || 0);

    let realisedRevenue = Math.max(0, grossAmount - returnDeduction);
    let vatTaxAmount = 0;
    let exVatRevenue = realisedRevenue;

    // Standard UK 20% VAT back-out (1/6th of gross inclusive)
    if (vatMode === 'INCLUSIVE' && realisedRevenue > 0) {
      vatTaxAmount = realisedRevenue * (1 / 6);
      exVatRevenue = realisedRevenue - vatTaxAmount;
    }

    const contributionBeforeAds = exVatRevenue - cogs - shippingCost - processorFee;

    return {
      grossAmount,
      returnDeduction,
      realisedRevenue,
      vatTaxAmount,
      exVatRevenue,
      cogs,
      shippingCost,
      processorFee,
      contributionBeforeAds
    };
  }

  // Profit on ad spend: Contribution Margin / Ad Spend
  function calculatePOAS(contributionBeforeAds = 0, spend = 0) {
    if (!spend || spend <= 0) return 0;
    return contributionBeforeAds / spend;
  }

  // Aggregates commercial ledger across orders + ad spend
  function calculateEntityCommercials(ordersList = [], spend = 0, vatMode = currentVatMode) {
    let totalGross = 0;
    let totalRefunds = 0;
    let totalRealised = 0;
    let totalVatTax = 0;
    let totalExVatRealised = 0;
    let totalCogs = 0;
    let totalShipping = 0;
    let totalFees = 0;

    ordersList.forEach(o => {
      const comm = calculateOrderCommercials(o, vatMode);
      totalGross += comm.grossAmount;
      totalRefunds += comm.returnDeduction;
      totalRealised += comm.realisedRevenue;
      totalVatTax += comm.vatTaxAmount;
      totalExVatRealised += comm.exVatRevenue;
      totalCogs += comm.cogs;
      totalShipping += comm.shippingCost;
      totalFees += comm.processorFee;
    });

    const contributionBeforeAds = totalExVatRealised - totalCogs - totalShipping - totalFees;
    const poas = calculatePOAS(contributionBeforeAds, spend);
    const profitAfterAds = contributionBeforeAds - spend;

    return {
      grossRevenue: totalGross,
      refundsValue: totalRefunds,
      realisedRevenue: totalRealised,
      vatTaxAmount: totalVatTax,
      exVatRealisedRevenue: totalExVatRealised,
      cogs: totalCogs,
      shippingCost: totalShipping,
      processorFee: totalFees,
      contributionBeforeAds,
      spend,
      poas,
      profitAfterAds
    };
  }

  exports.ProfitabilityEngine = {
    setVatMode,
    calculateOrderCommercials,
    calculatePOAS,
    calculateEntityCommercials
  };

})(typeof window !== 'undefined' ? window : self);
