// Envato Author Earnings Calculator - Content Script
(function () {
  const STORAGE_KEY_CURRENCY = "eec_selected_currency";
  const RATES_CACHE_KEY = "eec_currency_rates_cache";
  const DEFAULT_RATES = {
    USD: 1.0,
    EUR: 0.92,
    GBP: 0.79,
    INR: 83.5,
    AUD: 1.52,
    CAD: 1.37,
    JPY: 155.0,
    SGD: 1.35,
    BRL: 5.15,
    AED: 3.67
  };

  const CURRENCY_SYMBOLS = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    INR: "₹",
    AUD: "A$",
    CAD: "C$",
    JPY: "¥",
    SGD: "S$",
    BRL: "R$",
    AED: "AED "
  };

  let exchangeRates = { ...DEFAULT_RATES };
  let currentCurrency = "USD";
  let calculationData = null;

  async function loadExchangeRates() {
    try {
      if (chrome?.storage?.local) {
        const cached = await chrome.storage.local.get([RATES_CACHE_KEY, STORAGE_KEY_CURRENCY]);
        if (cached[STORAGE_KEY_CURRENCY]) {
          currentCurrency = cached[STORAGE_KEY_CURRENCY];
        }
        if (cached[RATES_CACHE_KEY] && cached[RATES_CACHE_KEY].timestamp > Date.now() - 3600000 * 12) {
          exchangeRates = cached[RATES_CACHE_KEY].rates;
          return;
        }
      }
      
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      if (res.ok) {
        const json = await res.json();
        if (json && json.rates) {
          exchangeRates = { ...DEFAULT_RATES, ...json.rates };
          if (chrome?.storage?.local) {
            await chrome.storage.local.set({
              [RATES_CACHE_KEY]: {
                timestamp: Date.now(),
                rates: exchangeRates
              }
            });
          }
        }
      }
    } catch (e) {
      console.warn("[Envato Earnings Calculator] Could not fetch live FX rates, using fallback.", e);
    }
  }

  function formatMoney(amountUSD, currencyCode) {
    const rate = exchangeRates[currencyCode] || 1.0;
    const converted = amountUSD * rate;
    const symbol = CURRENCY_SYMBOLS[currencyCode] || `${currencyCode} `;
    
    return `${symbol}${converted.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  function getAuthorSalesFromHeader() {
    // 1. itemprop interactionCount content="AuthorSales:1,312"
    const metaTag = document.querySelector('meta[itemprop="interactionCount"][content*="AuthorSales:"]');
    if (metaTag) {
      const match = metaTag.getAttribute("content").match(/AuthorSales:([\d,]+)/i);
      if (match) return parseInt(match[1].replace(/,/g, ""), 10);
    }

    // 2. Search user-info-header stat articles
    const statArticles = document.querySelectorAll(".user-info-header__stats-article, .user-info-header__stats");
    for (const art of statArticles) {
      const text = art.textContent || "";
      if (/sales/i.test(text)) {
        const numMatch = text.match(/([\d,]+)\s*(?:Sales)?/i);
        if (numMatch) {
          const val = parseInt(numMatch[1].replace(/,/g, ""), 10);
          if (!isNaN(val) && val > 0) return val;
        }
      }
    }

    return null;
  }

  // Exact product count from "Currently Viewing" tag (e.g. 149 CodeCanyon Items / Currently Viewing)
  function getExactProductCountFromCurrentlyViewing(doc = document) {
    // 1. Check DOM selector for site-portfolios Currently Viewing link
    if (doc.querySelectorAll) {
      const viewingLinks = doc.querySelectorAll(".site-portfolios__site-link, small");
      for (const link of viewingLinks) {
        if (/currently\s+viewing/i.test(link.textContent || "")) {
          const parent = link.closest("div") || link.parentElement;
          if (parent) {
            const text = parent.textContent || "";
            const m = text.match(/([\d,]+)\s*(?:[A-Za-z]+)?\s*Items?/i);
            if (m) {
              const val = parseInt(m[1].replace(/,/g, ""), 10);
              if (!isNaN(val) && val > 0) return val;
            }
          }
        }
      }
    }

    // 2. Regex fallback on raw HTML for the Currently Viewing container
    const html = doc.body ? doc.body.innerHTML : (typeof doc === "string" ? doc : "");
    const regex1 = /<div[^>]*>[\s\S]*?<small[^>]*>([\d,]+)\s+[^<]*Items?<\/small>[\s\S]*?Currently\s+Viewing[\s\S]*?<\/div>/i;
    const m1 = html.match(regex1);
    if (m1) return parseInt(m1[1].replace(/,/g, ""), 10);

    const regex2 = /([\d,]+)\s*(?:CodeCanyon|ThemeForest|[A-Za-z]+)?\s*Items?[\s\S]{0,120}Currently\s*Viewing/i;
    const m2 = html.match(regex2);
    if (m2) return parseInt(m2[1].replace(/,/g, ""), 10);

    return null;
  }

  function parseItemsFromDocument(doc) {
    const items = [];
    const seenTitlesOrIds = new Set();

    // --- DOM Strategy 1: Grid View (.product-grid__footer) ---
    if (doc.querySelectorAll) {
      const footers = doc.querySelectorAll(".product-grid__footer");
      if (footers && footers.length > 0) {
        footers.forEach(footer => {
          let price = null;
          let sales = 0;
          let title = "Product";

          const card = footer.closest(".product-grid__inside, li") || footer.parentElement;
          if (card) {
            const titleEl = card.querySelector(".product-grid__heading a, [class*='heading'] a, h3 a");
            if (titleEl && titleEl.textContent) title = titleEl.textContent.trim();
          }

          const priceEl = footer.querySelector(".product-grid__price, [class*='price']");
          if (priceEl) {
            const pMatch = priceEl.textContent.match(/\$([\d,]+(?:\.\d{2})?)/);
            if (pMatch) price = parseFloat(pMatch[1].replace(/,/g, ""));
          }

          const salesMatch = footer.textContent.match(/([\d,]+)\s*Sales/i);
          if (salesMatch) {
            sales = parseInt(salesMatch[1].replace(/,/g, ""), 10);
          }

          if (price !== null && !isNaN(price)) {
            const key = `${title}_${price}_${sales}`;
            if (!seenTitlesOrIds.has(key)) {
              seenTitlesOrIds.add(key);
              items.push({ title, price, sales, revenue: price * sales });
            }
          }
        });
      }
    }

    // --- DOM Strategy 2: List View (ONLY .product-list__column-detail) ---
    if (items.length === 0 && doc.querySelectorAll) {
      const rows = doc.querySelectorAll(".product-list__column-detail");
      if (rows && rows.length > 0) {
        rows.forEach((row) => {
          let price = null;
          let sales = 0;
          let title = "Product";

          const titleEl = row.querySelector(".product-list__heading a, [class*='heading'] a, h3 a");
          if (titleEl && titleEl.textContent) title = titleEl.textContent.trim();

          const priceEl = row.querySelector(".product-list__price p, .product-list__price");
          if (priceEl) {
            const pMatch = priceEl.textContent.match(/\$([\d,]+(?:\.\d{2})?)/);
            if (pMatch) price = parseFloat(pMatch[1].replace(/,/g, ""));
          }

          const salesEl = row.querySelector(".product-list__info-sale, .item-thumbnail-actions__action-sales");
          if (salesEl) {
            const sMatch = salesEl.textContent.match(/([\d,]+)\s*Sales/i);
            if (sMatch) sales = parseInt(sMatch[1].replace(/,/g, ""), 10);
          } else {
            const sMatch2 = row.textContent.match(/([\d,]+)\s*Sales/i);
            if (sMatch2) sales = parseInt(sMatch2[1].replace(/,/g, ""), 10);
          }

          if (price !== null && !isNaN(price)) {
            const key = `${title}_${price}_${sales}`;
            if (!seenTitlesOrIds.has(key)) {
              seenTitlesOrIds.add(key);
              items.push({ title, price, sales, revenue: price * sales });
            }
          }
        });
      }
    }

    // --- Fallback Strategy 3: Regex parsing on HTML string ---
    if (items.length === 0) {
      const html = doc.body ? doc.body.innerHTML : (typeof doc === "string" ? doc : "");
      
      // 3a. Grid View regex: <footer class="product-grid__footer">
      const gridFooterRegex = /<footer[^>]*class="[^"]*product-grid__footer[^"]*"[^>]*>([\s\S]*?)<\/footer>/gi;
      let gm;
      while ((gm = gridFooterRegex.exec(html)) !== null) {
        const content = gm[1];
        const priceM = content.match(/class="product-grid__price"[^>]*>\$([\d,.]+)/i) || content.match(/\$([\d,.]+)/);
        const salesM = content.match(/([\d,]+)\s*Sales/i);
        if (priceM) {
          const price = parseFloat(priceM[1].replace(/,/g, ""));
          const sales = salesM ? parseInt(salesM[1].replace(/,/g, ""), 10) : 0;
          items.push({ title: "Product " + (items.length + 1), price, sales, revenue: price * sales });
        }
      }

      // 3b. List View regex by .product-list__column-detail
      if (items.length === 0) {
        const rowRegex = /<div class="product-list__column-detail">([\s\S]*?)(?:<div class="product-list__column-category"|<div class="product-list__columns-container"|<\/li>)/gi;
        let rm;
        while ((rm = rowRegex.exec(html)) !== null) {
          const block = rm[1];
          let title = "Product " + (items.length + 1);
          const tM = block.match(/class="product-list__heading"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
          if (tM) title = tM[1].trim();

          const priceM = block.match(/class="product-list__price"[^>]*>[\s\S]*?\$([\d,.]+)/i) || block.match(/\$([\d,.]+)/);
          const salesM = block.match(/([\d,]+)\s*Sales/i);
          if (priceM) {
            const price = parseFloat(priceM[1].replace(/,/g, ""));
            const sales = salesM ? parseInt(salesM[1].replace(/,/g, ""), 10) : 0;
            items.push({ title, price, sales, revenue: price * sales });
          }
        }
      }
    }

    return items;
  }

  async function fetchAllPortfolioPages(authorUrl) {
    const p1Items = parseItemsFromDocument(document);
    
    // Check total pages in pagination
    let maxPages = 1;
    const pageLinks = document.querySelectorAll(".pagination__page, .pagination__summary");
    document.querySelectorAll(".pagination__summary").forEach(el => {
      const m = el.textContent.match(/Page\s+\d+\s+of\s+(\d+)/i);
      if (m) maxPages = Math.max(maxPages, parseInt(m[1], 10));
    });

    document.querySelectorAll("a.pagination__page").forEach(el => {
      const num = parseInt(el.textContent.trim(), 10);
      if (!isNaN(num)) maxPages = Math.max(maxPages, num);
    });

    let allItems = [...p1Items];

    // If more pages, fetch in background keeping existing query parameters (like view=grid)
    if (maxPages > 1) {
      const pagePromises = [];

      for (let p = 2; p <= maxPages; p++) {
        let pageUrl;
        try {
          const parsed = new URL(authorUrl);
          parsed.searchParams.set("page", p);
          pageUrl = parsed.toString();
        } catch (_) {
          const baseCleanUrl = authorUrl.split("?")[0].replace(/\/$/, "");
          pageUrl = `${baseCleanUrl}?page=${p}`;
        }

        pagePromises.push(
          fetch(pageUrl)
            .then(res => res.text())
            .then(html => {
              const parser = new DOMParser();
              const pageDoc = parser.parseFromString(html, "text/html");
              return parseItemsFromDocument(pageDoc);
            })
            .catch(err => {
              console.error(`[Envato Earnings Calculator] Failed to load page ${p}`, err);
              return [];
            })
        );
      }

      const results = await Promise.all(pagePromises);
      results.forEach(items => {
        allItems = allItems.concat(items);
      });
    }

    return { allItems, totalPages: maxPages };
  }

  function renderEarningsBanner(data) {
    const existing = document.getElementById("envato-earnings-calculator-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "envato-earnings-calculator-banner";
    banner.className = "eec-container";

    const currencyOptions = Object.keys(exchangeRates)
      .filter(c => ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "JPY", "SGD", "BRL", "AED"].includes(c))
      .map(c => `<option value="${c}" ${c === currentCurrency ? "selected" : ""}>${c} (${CURRENCY_SYMBOLS[c] || c})</option>`)
      .join("");

    banner.innerHTML = `
      <div class="eec-card">
        <div class="eec-header">
          <div class="eec-title-wrap">
            <span class="eec-badge">Revenue Estimator</span>
            <h3 class="eec-title">Author Earnings Summary</h3>
          </div>
          <div class="eec-controls">
            <label class="eec-label" for="eec-curr-select">Currency:</label>
            <select id="eec-curr-select" class="eec-select">
              ${currencyOptions}
            </select>
          </div>
        </div>

        <div class="eec-stats-grid">
          <div class="eec-stat-box highlight">
            <div class="eec-stat-title-wrap">
              <span class="eec-stat-title">Actual Lifetime Earnings</span>
              <span class="eec-tooltip-wrap">
                <span class="eec-info-icon">?</span>
                <span class="eec-tooltip-text">Real total revenue calculated accurately by summing (Item Price × Item Sales) for each product across all portfolio pages.</span>
              </span>
            </div>
            <span class="eec-stat-value" id="eec-earnings">${formatMoney(data.exactEarnings, currentCurrency)}</span>
            <span class="eec-stat-sub">Sum of all products (Price × Sales)</span>
          </div>

          <div class="eec-stat-box">
            <div class="eec-stat-title-wrap">
              <span class="eec-stat-title">Active Products</span>
              <span class="eec-tooltip-wrap">
                <span class="eec-info-icon">?</span>
                <span class="eec-tooltip-text">Total number of published items in this author's marketplace portfolio (from the official Currently Viewing count).</span>
              </span>
            </div>
            <span class="eec-stat-value" id="eec-products-count">${data.totalProducts}</span>
            <span class="eec-stat-sub">Across ${data.totalPages} portfolio page${data.totalPages > 1 ? "s" : ""}</span>
          </div>

          <div class="eec-stat-box">
            <div class="eec-stat-title-wrap">
              <span class="eec-stat-title">Average Product Price</span>
              <span class="eec-tooltip-wrap">
                <span class="eec-info-icon">?</span>
                <span class="eec-tooltip-text">Total sum of all individual item prices divided by total products listed: ($${data.sumPrice.toFixed(2)} ÷ ${data.parsedProductsCount}).</span>
              </span>
            </div>
            <span class="eec-stat-value" id="eec-avg-price">${formatMoney(data.avgPrice, currentCurrency)}</span>
            <span class="eec-stat-sub">USD $${data.avgPrice.toFixed(2)}</span>
          </div>

          <div class="eec-stat-box">
            <div class="eec-stat-title-wrap">
              <span class="eec-stat-title">Total Completed Sales</span>
              <span class="eec-tooltip-wrap">
                <span class="eec-info-icon">?</span>
                <span class="eec-tooltip-text">All-time lifetime completed sales count from the author's official profile header badge.</span>
              </span>
            </div>
            <span class="eec-stat-value" id="eec-total-sales">${data.totalSales.toLocaleString()}</span>
            <span class="eec-stat-sub">Author overall sales count</span>
          </div>
        </div>

        <div class="eec-footer">
          <span class="eec-formula-note">
            <span>Actual Revenue: Sum of (Price × Sales) across ${data.parsedProductsCount} products = $${data.exactEarnings.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD</span>
            <button id="eec-btn-view-breakdown" class="eec-btn-breakdown" type="button">📊 View Product Breakdown</button>
          </span>
          <span class="eec-exact-note">
            Approx (Sales × Avg Price): <strong>${formatMoney(data.estimatedEarnings, currentCurrency)}</strong>
            <span class="eec-tooltip-wrap" style="margin-left: 4px;">
              <span class="eec-info-icon">?</span>
              <span class="eec-tooltip-text">Approximate estimate using average price: ${data.totalSales.toLocaleString()} sales × $${data.avgPrice.toFixed(2)}. Actual calculation accounts for high-selling vs low-selling prices individually.</span>
            </span>
          </span>
        </div>
      </div>

      <!-- Breakdown Modal Popup -->
      <div id="eec-modal-overlay" class="eec-modal-overlay">
        <div class="eec-modal">
          <div class="eec-modal-header">
            <h4 class="eec-modal-title">Product-by-Product Revenue Breakdown (${data.parsedProductsCount} Items)</h4>
            <button id="eec-modal-close" class="eec-modal-close" type="button">&times;</button>
          </div>
          <div class="eec-modal-body">
            <table class="eec-table">
              <thead>
                <tr>
                  <th>Product Name</th>
                  <th class="align-right">Price</th>
                  <th class="align-right">Sales</th>
                  <th class="align-right">Product Revenue</th>
                </tr>
              </thead>
              <tbody id="eec-table-rows">
                ${data.items.map(it => `
                  <tr>
                    <td><strong>${it.title || 'Product'}</strong></td>
                    <td class="align-right">${formatMoney(it.price, currentCurrency)}</td>
                    <td class="align-right">${it.sales.toLocaleString()}</td>
                    <td class="align-right"><strong>${formatMoney(it.revenue, currentCurrency)}</strong></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <div class="eec-modal-footer">
            <span>Actual Total Revenue:</span>
            <span class="grand-total" id="eec-modal-grand-total">${formatMoney(data.exactEarnings, currentCurrency)}</span>
          </div>
        </div>
      </div>
    `;

    // Locate target place to inject banner
    const targetAnchor = document.querySelector(".page-tabs") || 
                         document.querySelector(".user-info-header") || 
                         document.querySelector("#content .content-s") ||
                         document.querySelector("main") ||
                         document.body;

    if (targetAnchor && targetAnchor.parentNode) {
      if (targetAnchor.classList.contains("page-tabs")) {
        targetAnchor.parentNode.insertBefore(banner, targetAnchor.nextSibling);
      } else {
        targetAnchor.insertBefore(banner, targetAnchor.firstChild);
      }
    } else {
      document.body.prepend(banner);
    }

    // Attach modal open/close listeners
    const modalOverlay = banner.querySelector("#eec-modal-overlay");
    const openBtn = banner.querySelector("#eec-btn-view-breakdown");
    const closeBtn = banner.querySelector("#eec-modal-close");

    if (openBtn && modalOverlay) {
      openBtn.addEventListener("click", () => {
        modalOverlay.classList.add("open");
      });
    }

    if (closeBtn && modalOverlay) {
      closeBtn.addEventListener("click", () => {
        modalOverlay.classList.remove("open");
      });
    }

    if (modalOverlay) {
      modalOverlay.addEventListener("click", (e) => {
        if (e.target === modalOverlay) {
          modalOverlay.classList.remove("open");
        }
      });
    }

    // Attach currency change listener
    const select = banner.querySelector("#eec-curr-select");
    if (select) {
      select.addEventListener("change", async (e) => {
        currentCurrency = e.target.value;
        if (chrome?.storage?.local) {
          await chrome.storage.local.set({ [STORAGE_KEY_CURRENCY]: currentCurrency });
        }
        // Update money values in DOM
        document.getElementById("eec-avg-price").textContent = formatMoney(data.avgPrice, currentCurrency);
        document.getElementById("eec-earnings").textContent = formatMoney(data.exactEarnings, currentCurrency);
        const approxSpan = banner.querySelector(".eec-exact-note strong");
        if (approxSpan) {
          approxSpan.textContent = formatMoney(data.estimatedEarnings, currentCurrency);
        }
        const modalTotal = banner.querySelector("#eec-modal-grand-total");
        if (modalTotal) {
          modalTotal.textContent = formatMoney(data.exactEarnings, currentCurrency);
        }
        // Update table rows in modal
        const tbody = banner.querySelector("#eec-table-rows");
        if (tbody) {
          tbody.innerHTML = data.items.map(it => `
            <tr>
              <td><strong>${it.title || 'Product'}</strong></td>
              <td class="align-right">${formatMoney(it.price, currentCurrency)}</td>
              <td class="align-right">${it.sales.toLocaleString()}</td>
              <td class="align-right"><strong>${formatMoney(it.revenue, currentCurrency)}</strong></td>
            </tr>
          `).join('');
        }
      });
    }
  }

  let isCalculating = false;

  async function init() {
    if (isCalculating) return;
    // Check if on user portfolio or profile page
    const isUserPage = window.location.pathname.startsWith("/user/");
    if (!isUserPage) return;

    isCalculating = true;
    try {
      await loadExchangeRates();

      let authorSales = getAuthorSalesFromHeader() || 0;
      const { allItems, totalPages } = await fetchAllPortfolioPages(window.location.href);

      if (allItems.length === 0 && authorSales === 0) {
        return;
      }

      // Check exact product count from "Currently Viewing" tag requested by user
      const exactTagCount = getExactProductCountFromCurrentlyViewing(document);
      const parsedProductsCount = allItems.length;
      // Use the official "Currently Viewing" count if present, otherwise fallback to parsed count
      const totalProducts = exactTagCount !== null ? exactTagCount : parsedProductsCount;

      const sumPrice = allItems.reduce((acc, x) => acc + x.price, 0);
      const avgPrice = parsedProductsCount > 0 ? (sumPrice / parsedProductsCount) : 0;
      
      // If header didn't have sales, sum item-level sales
      if (authorSales === 0) {
        authorSales = allItems.reduce((acc, x) => acc + x.sales, 0);
      }

      // Approximate estimation using overall sales * avg price
      const estimatedEarnings = authorSales * avgPrice;
      
      // Actual lifetime earnings: Sum of (each product price * each product sales)
      const exactEarnings = allItems.reduce((acc, x) => acc + (x.price * x.sales), 0);

      calculationData = {
        totalProducts,
        parsedProductsCount,
        sumPrice,
        totalPages,
        avgPrice,
        totalSales: authorSales,
        estimatedEarnings,
        exactEarnings,
        items: allItems
      };

      // Save to storage for quick popup view
      if (chrome?.storage?.local) {
        chrome.storage.local.set({
          eec_last_calc: {
            url: window.location.href,
            author: window.location.pathname.split("/")[2] || "Author",
            ...calculationData,
            timestamp: Date.now()
          }
        });
      }

      renderEarningsBanner(calculationData);
    } finally {
      isCalculating = false;
    }
  }

  // Listen for messages from popup
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === "getCalculationData") {
        sendResponse({ success: true, data: calculationData, currency: currentCurrency, rates: exchangeRates });
      } else if (msg.action === "recalculate") {
        init().then(() => sendResponse({ success: true, data: calculationData }));
        return true;
      }
    });
  }

  // Watch for dynamic view/layout switches (e.g. toggling list/grid without full reload)
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      init();
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
