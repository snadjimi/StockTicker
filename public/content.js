// StockPulse Content Script
// Injected into every page. Detects what stock ticker the user is viewing.
// Communicates with the popup via Chrome message passing.

(() => {
  // ─── URL-based detection (fast, high confidence) ─────────────────────
  // Each finance site puts the ticker in the URL in a predictable spot.

  function detectFromURL() {
    const url = window.location.href;
    const hostname = window.location.hostname;

    const patterns = [
      {
        name: "Yahoo Finance",
        match: () => hostname.includes("finance.yahoo.com"),
        extract: () => {
          const m = url.match(/\/quote\/([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
      {
        name: "Google Finance",
        match: () => hostname.includes("google.com") && url.includes("/finance/quote/"),
        extract: () => {
          const m = url.match(/\/finance\/quote\/([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
      {
        name: "Robinhood",
        match: () => hostname.includes("robinhood.com"),
        extract: () => {
          const m = url.match(/\/stocks\/([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
      {
        name: "TradingView",
        match: () => hostname.includes("tradingview.com"),
        extract: () => {
          const m = url.match(/\/symbols\/(?:[A-Z]+[-:])?([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
      {
        name: "MarketWatch",
        match: () => hostname.includes("marketwatch.com"),
        extract: () => {
          const m = url.match(/\/investing\/stock\/([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
      {
        name: "Seeking Alpha",
        match: () => hostname.includes("seekingalpha.com"),
        extract: () => {
          const m = url.match(/\/symbol\/([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
      {
        name: "Finviz",
        match: () => hostname.includes("finviz.com"),
        extract: () => {
          const m = url.match(/[?&]t=([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
      {
        name: "Schwab",
        match: () => hostname.includes("schwab.com"),
        extract: () => {
          const m = url.match(/\/symbol\/([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
      {
        name: "Fidelity",
        match: () => hostname.includes("fidelity.com"),
        extract: () => {
          const m = url.match(/symbol=([A-Z]{1,5})/);
          return m ? m[1] : null;
        },
      },
    ];

    for (const pattern of patterns) {
      if (pattern.match()) {
        const ticker = pattern.extract();
        if (ticker) {
          return { ticker, source: pattern.name, confidence: "high" };
        }
      }
    }

    return null;
  }

  // ─── DOM-based detection (fallback, medium confidence) ───────────────
  // If the URL didn't work, scan the page for common ticker patterns.

  function detectFromDOM() {
    // Check data-symbol attributes (many finance sites use these)
    const symbolEl = document.querySelector("[data-symbol]");
    if (symbolEl) {
      const ticker = symbolEl.getAttribute("data-symbol");
      if (ticker && /^[A-Z]{1,5}$/.test(ticker)) {
        return { ticker, source: "data-attribute", confidence: "medium" };
      }
    }

    // Check page headings for patterns like "(AAPL)" or "NASDAQ: AAPL"
    const headings = document.querySelectorAll("h1, h2, h3");
    for (const heading of headings) {
      const text = heading.textContent;

      // Match "(AAPL)" pattern
      const parenMatch = text.match(/\(([A-Z]{1,5})\)/);
      if (parenMatch) {
        return { ticker: parenMatch[1], source: "heading-paren", confidence: "medium" };
      }

      // Match "NASDAQ: AAPL" or "NYSE: MSFT" pattern
      const exchangeMatch = text.match(/(?:NASDAQ|NYSE|AMEX|OTC):\s*([A-Z]{1,5})/);
      if (exchangeMatch) {
        return { ticker: exchangeMatch[1], source: "heading-exchange", confidence: "medium" };
      }
    }

    return null;
  }

  // ─── Main detection: try URL first, then DOM ─────────────────────────

  function detectTicker() {
    return detectFromURL() || detectFromDOM() || null;
  }

  // ─── Listen for messages from the popup ──────────────────────────────
  // When the popup opens, it sends GET_TICKER. We respond with whatever
  // ticker we found on this page.

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_TICKER") {
      const result = detectTicker();
      sendResponse(result);
    }
    return true; // keeps the message channel open for async response
  });
})();
