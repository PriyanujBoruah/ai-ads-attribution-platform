// TrueSignal - Refund Cohort Maturity Engine
// Classifies order age windows (0-13d, 14-29d, 30d+) to account for return lag

(function (exports) {

  let currentReportingMode = 'COHORT'; // 'COHORT' (order creation date) or 'TRANSACTION' (refund date)

  function setReportingMode(mode) {
    if (mode === 'COHORT' || mode === 'TRANSACTION') {
      currentReportingMode = mode;
    }
  }

  function calculateCohortMaturity(dateInput, targetWindowDays = 30) {
    if (!dateInput) {
      return {
        age_days: 0,
        maturity_status: 'IMMATURE',
        maturity_label: '0-13D Immature',
        maturity_color: 'var(--danger)'
      };
    }

    const rawVal = (typeof dateInput === 'object' && dateInput !== null)
      ? (dateInput.created_at || dateInput.date || dateInput.timestamp || dateInput.created_at_date)
      : dateInput;

    const orderTime = new Date(rawVal).getTime();
    const nowTime = new Date().getTime();
    const ageDays = isNaN(orderTime) ? 0 : Math.max(0, Math.floor((nowTime - orderTime) / (1000 * 60 * 60 * 24)));

    let status = 'IMMATURE';
    let label = `${ageDays}D Immature`;
    let color = 'var(--danger)';

    if (ageDays >= targetWindowDays) {
      status = 'MATURE';
      label = `${targetWindowDays}D+ Mature`;
      color = 'var(--success)';
    } else if (ageDays >= 14) {
      status = 'PARTIALLY_MATURE';
      label = '14-29D Partial';
      color = 'var(--warning)';
    } else {
      status = 'IMMATURE';
      label = '0-13D Immature';
      color = 'var(--danger)';
    }

    return {
      age_days: ageDays,
      maturity_status: status,
      maturity_label: label,
      maturity_color: color
    };
  }

  exports.MaturityEngine = {
    setReportingMode,
    calculateCohortMaturity
  };

})(typeof window !== 'undefined' ? window : self);
