// Envato Author Earnings Calculator - Popup Script
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
let activeAuthorData = null;

function formatMoney(amountUSD, currencyCode) {
  const rate = exchangeRates[currencyCode] || 1.0;
  const converted = amountUSD * rate;
  const symbol = CURRENCY_SYMBOLS[currencyCode] || `${currencyCode} `;
  
  return `${symbol}${converted.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

async function loadRatesAndCurrency() {
  const stored = await chrome.storage.local.get([STORAGE_KEY_CURRENCY, RATES_CACHE_KEY]);
  if (stored[STORAGE_KEY_CURRENCY]) {
    currentCurrency = stored[STORAGE_KEY_CURRENCY];
  }
  if (stored[RATES_CACHE_KEY] && stored[RATES_CACHE_KEY].rates) {
    exchangeRates = stored[RATES_CACHE_KEY].rates;
  } else {
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      if (res.ok) {
        const json = await res.json();
        if (json && json.rates) {
          exchangeRates = { ...DEFAULT_RATES, ...json.rates };
          await chrome.storage.local.set({
            [RATES_CACHE_KEY]: { timestamp: Date.now(), rates: exchangeRates }
          });
        }
      }
    } catch (e) {
      console.warn("Failed fetching live rates in popup", e);
    }
  }

  const select = document.getElementById("currency-select");
  if (select) {
    select.value = currentCurrency;
  }
}

function updateUI() {
  if (!activeAuthorData) {
    document.getElementById("author-state").style.display = "none";
    document.getElementById("empty-state").style.display = "block";
    updateManualCalculator();
    return;
  }

  document.getElementById("author-state").style.display = "block";
  document.getElementById("empty-state").style.display = "none";

  document.getElementById("author-name").textContent = activeAuthorData.author || "Envato Author";
  document.getElementById("stat-products").textContent = activeAuthorData.totalProducts || 0;
  document.getElementById("stat-sales").textContent = (activeAuthorData.totalSales || 0).toLocaleString();
  document.getElementById("stat-avg-price").textContent = formatMoney(activeAuthorData.avgPrice || 0, currentCurrency);
  // Hero is now Actual Lifetime Earnings (exact sum of all products)
  document.getElementById("stat-earnings").textContent = formatMoney(activeAuthorData.exactEarnings || 0, currentCurrency);
  // Secondary is the old approximation
  document.getElementById("stat-exact").textContent = formatMoney(activeAuthorData.estimatedEarnings || 0, currentCurrency);
  document.getElementById("stat-formula").textContent = `Exact sum across ${activeAuthorData.parsedProductsCount || activeAuthorData.totalProducts || 0} products (Price × Sales)`;

  updateManualCalculator();
}

function updateManualCalculator() {
  const salesInput = parseFloat(document.getElementById("manual-sales").value) || 0;
  const avgPriceInput = parseFloat(document.getElementById("manual-avg-price").value) || 0;
  const totalUSD = salesInput * avgPriceInput;
  document.getElementById("manual-output").textContent = formatMoney(totalUSD, currentCurrency);
}

async function requestActiveTabStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url) {
      fallbackToStorage();
      return;
    }

    if (tab.url.includes("codecanyon.net/user/") || tab.url.includes("themeforest.net/user/")) {
      const authorMatch = tab.url.match(/user\/([^/?#]+)/i);
      const authorName = authorMatch ? authorMatch[1] : "Author";

      chrome.tabs.sendMessage(tab.id, { action: "getCalculationData" }, (response) => {
        // Checking chrome.runtime.lastError explicitly clears and prevents the unhandled warning
        if (chrome.runtime.lastError) {
          // Content script not ready yet or page reloaded, fallback gracefully
          fallbackToStorage();
          return;
        }

        if (response && response.data) {
          activeAuthorData = {
            author: authorName,
            ...response.data
          };
          updateUI();
        } else {
          fallbackToStorage();
        }
      });
    } else {
      fallbackToStorage();
    }
  } catch (e) {
    fallbackToStorage();
  }
}

function fallbackToStorage() {
  if (chrome?.storage?.local) {
    chrome.storage.local.get("eec_last_calc", (res) => {
      // Clear any pending runtime error
      if (chrome.runtime.lastError) {}
      if (res && res.eec_last_calc) {
        activeAuthorData = res.eec_last_calc;
      }
      updateUI();
    });
  } else {
    updateUI();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadRatesAndCurrency();
  await requestActiveTabStats();

  // Currency select listener
  document.getElementById("currency-select").addEventListener("change", async (e) => {
    currentCurrency = e.target.value;
    await chrome.storage.local.set({ [STORAGE_KEY_CURRENCY]: currentCurrency });
    updateUI();

    // Notify active tab to sync
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: "recalculate" }, () => {
        // Void callback: access lastError to swallow connection warning if tab not listening
        if (chrome.runtime.lastError) {}
      });
    }
  });

  // Manual inputs
  document.getElementById("manual-sales").addEventListener("input", updateManualCalculator);
  document.getElementById("manual-avg-price").addEventListener("input", updateManualCalculator);

  // Refresh button
  document.getElementById("btn-refresh").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: "recalculate" }, (response) => {
        if (chrome.runtime.lastError) {
          fallbackToStorage();
          return;
        }
        if (response && response.data) {
          activeAuthorData = {
            author: activeAuthorData ? activeAuthorData.author : "Author",
            ...response.data
          };
          updateUI();
        }
      });
    }
  });

  // Open portfolio button
  document.getElementById("btn-open-portfolio").addEventListener("click", () => {
    const url = (activeAuthorData && activeAuthorData.url) || "https://codecanyon.net/user/go-web/portfolio";
    chrome.tabs.create({ url });
  });
});
