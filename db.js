// TrueSignal - IndexedDB Storage Helpers
// Promise-based IndexedDB wrappers for UI and Web Worker threads

const TrueSignalDB = (() => {
  let activeDbName = 'TrueSignalDB';
  const DB_VERSION = 14;

  function setDatabaseName(dbName) {
    if (dbName) {
      activeDbName = dbName;
    }
  }

  function open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not supported in this environment.'));
        return;
      }
      const request = indexedDB.open(activeDbName, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = request.result;

        // 1. store_sessions: Captures tracking info before checkout
        if (!db.objectStoreNames.contains('store_sessions')) {
          const sessionsStore = db.createObjectStore('store_sessions', { keyPath: 'session_id' });
          sessionsStore.createIndex('date', 'date', { unique: false });
          sessionsStore.createIndex('utm_campaign', 'utm_campaign', { unique: false });
          sessionsStore.createIndex('click_id', 'click_id', { unique: false });
        }

        // 2. shopify_orders: Checkout details linked to session click_id
        let ordersStore;
        if (!db.objectStoreNames.contains('shopify_orders')) {
          ordersStore = db.createObjectStore('shopify_orders', { keyPath: 'order_id' });
        } else {
          ordersStore = event.target.transaction.objectStore('shopify_orders');
        }
        if (!ordersStore.indexNames.contains('date')) ordersStore.createIndex('date', 'date', { unique: false });
        if (!ordersStore.indexNames.contains('click_id')) ordersStore.createIndex('click_id', 'click_id', { unique: false });
        if (!ordersStore.indexNames.contains('reconciled_with_return')) ordersStore.createIndex('reconciled_with_return', 'reconciled_with_return', { unique: false });
        if (!ordersStore.indexNames.contains('creative_id')) ordersStore.createIndex('creative_id', 'creative_id', { unique: false });
        if (!ordersStore.indexNames.contains('utm_content')) ordersStore.createIndex('utm_content', 'utm_content', { unique: false });
        if (!ordersStore.indexNames.contains('attribution_level')) ordersStore.createIndex('attribution_level', 'attribution_level', { unique: false });

        // 2b. shopify_master_orders: Unified master 90-day orders store
        let masterOrdersStore;
        if (!db.objectStoreNames.contains('shopify_master_orders')) {
          masterOrdersStore = db.createObjectStore('shopify_master_orders', { keyPath: 'order_id' });
        } else {
          masterOrdersStore = event.target.transaction.objectStore('shopify_master_orders');
        }
        if (!masterOrdersStore.indexNames.contains('date')) masterOrdersStore.createIndex('date', 'date', { unique: false });
        if (!masterOrdersStore.indexNames.contains('fulfillment_status')) masterOrdersStore.createIndex('fulfillment_status', 'fulfillment_status', { unique: false });
        if (!masterOrdersStore.indexNames.contains('financial_status')) masterOrdersStore.createIndex('financial_status', 'financial_status', { unique: false });
        if (!masterOrdersStore.indexNames.contains('utm_campaign')) masterOrdersStore.createIndex('utm_campaign', 'utm_campaign', { unique: false });
        if (!masterOrdersStore.indexNames.contains('utm_source')) masterOrdersStore.createIndex('utm_source', 'utm_source', { unique: false });

        // 3. shopify_returns: Audit trail linking refunds back to parent orders
        if (!db.objectStoreNames.contains('shopify_returns')) {
          const returnsStore = db.createObjectStore('shopify_returns', { keyPath: 'return_id' });
          returnsStore.createIndex('parent_order_id', 'parent_order_id', { unique: false });
          returnsStore.createIndex('date_returned', 'date_returned', { unique: false });
        }

        // 4. ad_network_spend: Daily marketing expense tables
        let spendStore;
        if (!db.objectStoreNames.contains('ad_network_spend')) {
          spendStore = db.createObjectStore('ad_network_spend', { keyPath: 'spend_id' });
        } else {
          spendStore = event.target.transaction.objectStore('ad_network_spend');
        }
        if (!spendStore.indexNames.contains('date')) spendStore.createIndex('date', 'date', { unique: false });
        if (!spendStore.indexNames.contains('platform')) spendStore.createIndex('platform', 'platform', { unique: false });
        if (!spendStore.indexNames.contains('ad_account_id')) spendStore.createIndex('ad_account_id', 'ad_account_id', { unique: false });

        // 5. shopify_customers
        if (!db.objectStoreNames.contains('shopify_customers')) {
          db.createObjectStore('shopify_customers', { keyPath: 'customer_id' });
        }

        // 6. shopify_products
        if (!db.objectStoreNames.contains('shopify_products')) {
          db.createObjectStore('shopify_products', { keyPath: 'product_id' });
        }

        // 7. shopify_inventory
        if (!db.objectStoreNames.contains('shopify_inventory')) {
          db.createObjectStore('shopify_inventory', { keyPath: 'inventory_item_id' });
        }

        // 8. shopify_fulfillments
        if (!db.objectStoreNames.contains('shopify_fulfillments')) {
          db.createObjectStore('shopify_fulfillments', { keyPath: 'fulfillment_id' });
        }

        // 9. shopify_discounts
        if (!db.objectStoreNames.contains('shopify_discounts')) {
          db.createObjectStore('shopify_discounts', { keyPath: 'discount_id' });
        }

        // 10. shopify_checkouts
        if (!db.objectStoreNames.contains('shopify_checkouts')) {
          db.createObjectStore('shopify_checkouts', { keyPath: 'checkout_id' });
        }

        // 11. shopify_shipping
        if (!db.objectStoreNames.contains('shopify_shipping')) {
          db.createObjectStore('shopify_shipping', { keyPath: 'shipping_id' });
        }

        // 12. meta_campaigns
        let metaCampStore;
        if (!db.objectStoreNames.contains('meta_campaigns')) {
          metaCampStore = db.createObjectStore('meta_campaigns', { keyPath: 'campaign_id' });
        } else {
          metaCampStore = event.target.transaction.objectStore('meta_campaigns');
        }
        if (!metaCampStore.indexNames.contains('ad_account_id')) metaCampStore.createIndex('ad_account_id', 'ad_account_id', { unique: false });

        // 13. meta_adsets
        if (!db.objectStoreNames.contains('meta_adsets')) {
          db.createObjectStore('meta_adsets', { keyPath: 'adset_id' });
        }

        // 14. meta_ads
        let adsStore;
        if (!db.objectStoreNames.contains('meta_ads')) {
          adsStore = db.createObjectStore('meta_ads', { keyPath: 'ad_id' });
        } else {
          adsStore = event.target.transaction.objectStore('meta_ads');
        }
        if (!adsStore.indexNames.contains('creative_id')) adsStore.createIndex('creative_id', 'creative_id', { unique: false });
        if (!adsStore.indexNames.contains('ad_account_id')) adsStore.createIndex('ad_account_id', 'ad_account_id', { unique: false });

        // 15. meta_creatives
        let metaCreativesStore;
        if (!db.objectStoreNames.contains('meta_creatives')) {
          metaCreativesStore = db.createObjectStore('meta_creatives', { keyPath: 'creative_id' });
        } else {
          metaCreativesStore = event.target.transaction.objectStore('meta_creatives');
        }
        if (!metaCreativesStore.indexNames.contains('ad_account_id')) metaCreativesStore.createIndex('ad_account_id', 'ad_account_id', { unique: false });

        // 16. meta_insights
        let metaInsightsStore;
        if (!db.objectStoreNames.contains('meta_insights')) {
          metaInsightsStore = db.createObjectStore('meta_insights', { keyPath: 'insight_id' });
        } else {
          metaInsightsStore = event.target.transaction.objectStore('meta_insights');
        }
        if (!metaInsightsStore.indexNames.contains('ad_account_id')) metaInsightsStore.createIndex('ad_account_id', 'ad_account_id', { unique: false });

        // 16b. Unified Flat Meta Master Knowledge Base Table
        let metaMasterStore;
        if (!db.objectStoreNames.contains('meta_master_table')) {
          metaMasterStore = db.createObjectStore('meta_master_table', { keyPath: 'record_id' });
        } else {
          metaMasterStore = event.target.transaction.objectStore('meta_master_table');
        }
        if (!metaMasterStore.indexNames.contains('date')) metaMasterStore.createIndex('date', 'date', { unique: false });
        if (!metaMasterStore.indexNames.contains('ad_id')) metaMasterStore.createIndex('ad_id', 'ad_id', { unique: false });
        if (!metaMasterStore.indexNames.contains('campaign_id')) metaMasterStore.createIndex('campaign_id', 'campaign_id', { unique: false });
        if (!metaMasterStore.indexNames.contains('creative_id')) metaMasterStore.createIndex('creative_id', 'creative_id', { unique: false });

        // 17. meta_regional_insights
        if (!db.objectStoreNames.contains('meta_regional_insights')) {
          db.createObjectStore('meta_regional_insights', { keyPath: 'regional_insight_id' });
        }

        // 18. campaign_families: Logical grouping of duplicate/restarted campaigns
        if (!db.objectStoreNames.contains('campaign_families')) {
          const familyStore = db.createObjectStore('campaign_families', { keyPath: 'family_id' });
          familyStore.createIndex('grouping_key', 'grouping_key', { unique: false });
          familyStore.createIndex('name', 'name', { unique: false });
        }

        // 19. creative_families: Concept-level grouping of shared creative assets
        if (!db.objectStoreNames.contains('creative_families')) {
          const cfStore = db.createObjectStore('creative_families', { keyPath: 'creative_family_id' });
          cfStore.createIndex('name', 'name', { unique: false });
          cfStore.createIndex('concept_tag', 'concept_tag', { unique: false });
        }

        // 20. creative_variants: Specific ad creative variations under a creative family
        if (!db.objectStoreNames.contains('creative_variants')) {
          const cvStore = db.createObjectStore('creative_variants', { keyPath: 'variant_id' });
          cvStore.createIndex('creative_family_id', 'creative_family_id', { unique: false });
          cvStore.createIndex('creative_fingerprint', 'creative_fingerprint', { unique: false });
          cvStore.createIndex('meta_creative_id', 'meta_creative_id', { unique: false });
        }

        // 21. grouping_audit_log: Audit trail of manual or automatic grouping decisions
        if (!db.objectStoreNames.contains('grouping_audit_log')) {
          const auditStore = db.createObjectStore('grouping_audit_log', { keyPath: 'log_id' });
          auditStore.createIndex('entity_type', 'entity_type', { unique: false });
          auditStore.createIndex('entity_id', 'entity_id', { unique: false });
          auditStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // 22. order_attributions: Deterministic evidence and confidence level per order
        if (!db.objectStoreNames.contains('order_attributions')) {
          const attrStore = db.createObjectStore('order_attributions', { keyPath: 'order_id' });
          attrStore.createIndex('confidence_score', 'confidence_score', { unique: false });
          attrStore.createIndex('attribution_level', 'attribution_level', { unique: false });
        }

        // 23. master_order_attributions: Master order table attaching every referencing parameter
        if (!db.objectStoreNames.contains('master_order_attributions')) {
          const masterStore = db.createObjectStore('master_order_attributions', { keyPath: 'order_id' });
          masterStore.createIndex('date', 'date', { unique: false });
          masterStore.createIndex('utm_campaign', 'utm_campaign', { unique: false });
          masterStore.createIndex('utm_source', 'utm_source', { unique: false });
          masterStore.createIndex('creative_id', 'creative_id', { unique: false });
          masterStore.createIndex('click_id', 'click_id', { unique: false });
          masterStore.createIndex('attribution_level', 'attribution_level', { unique: false });
          masterStore.createIndex('confidence_score', 'confidence_score', { unique: false });
        }
      };
    });
  }

  /**
   * Clears all data stores in the database.
   * @returns {Promise<void>}
   */
  function clearAll() {
    return open().then(db => {
      return new Promise((resolve, reject) => {
        const stores = Array.from(db.objectStoreNames);
        if (stores.length === 0) {
          resolve();
          return;
        }
        const tx = db.transaction(stores, 'readwrite');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve();

        stores.forEach(storeName => {
          tx.objectStore(storeName).clear();
        });
      });
    });
  }

  /**
   * Clears a single specified store in the database.
   * @param {string} storeName
   * @returns {Promise<void>}
   */
  function clearStore(storeName) {
    return open().then(db => {
      return new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(storeName)) {
          resolve();
          return;
        }
        const tx = db.transaction(storeName, 'readwrite');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve();
        tx.objectStore(storeName).clear();
      });
    });
  }

  /**
   * Bulk writes records into a specified store.
   * @param {string} storeName 
   * @param {Array<object>} records 
   * @returns {Promise<void>}
   */
  function bulkPut(storeName, records) {
    return open().then(db => {
      return new Promise((resolve, reject) => {
        if (records.length === 0 || !db.objectStoreNames.contains(storeName)) {
          resolve();
          return;
        }
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        records.forEach(record => {
          store.put(record);
        });
      });
    });
  }

  /**
   * Retrieves a single record by primary key.
   * @param {string} storeName 
   * @param {any} key 
   * @returns {Promise<any>}
   */
  function get(storeName, key) {
    return open().then(db => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  /**
   * Retrieves all records in a store.
   * @param {string} storeName 
   * @returns {Promise<Array<any>>}
   */
  function getAll(storeName) {
    return open().then(db => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    });
  }

  /**
   * Queries records in a store using an index and a query range.
   * @param {string} storeName 
   * @param {string} indexName 
   * @param {IDBKeyRange} range 
   * @returns {Promise<Array<any>>}
   */
  function getByIndex(storeName, indexName, range) {
    return open().then(db => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const request = index.getAll(range);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    });
  }

  return {
    open,
    clearAll,
    clearStore,
    bulkPut,
    get,
    getAll,
    getByIndex,
    setDatabaseName
  };
})();

// If running in a Node-like context or CommonJS module environment (for unit test compatibility)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrueSignalDB;
}
