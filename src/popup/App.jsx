import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

// ─── Styles ────────────────────────────────────────────────────────────
// All CSS as JS objects. Keeps everything in one file for the extension.

const colors = {
  bg: "#080C10",
  surface: "#0D1318",
  border: "#1A2530",
  green: "#00FF88",
  red: "#FF4560",
  neutral: "#7A8A9A",
  textPrimary: "#E0E0E0",
  textSecondary: "#7A8A9A",
};

const DASH = "—";

function show(v) {
  return v === null || v === undefined || v === "" || v === "n/a" ? DASH : v;
}

function money(v) {
  return v === null || v === undefined ? DASH : `$${Number(v).toFixed(2)}`;
}

// ─── Utility components ────────────────────────────────────────────────

function Skeleton({ width = "100%", height = "16px" }) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: "4px",
        background: `linear-gradient(90deg, ${colors.surface} 25%, ${colors.border} 50%, ${colors.surface} 75%)`,
        backgroundSize: "200% 100%",
        animation: "shimmer 1.5s infinite",
      }}
    />
  );
}

function Badge({ type, text }) {
  const badgeColors = {
    bullish: { bg: colors.green + "20", text: colors.green, border: colors.green + "40" },
    bearish: { bg: colors.red + "20", text: colors.red, border: colors.red + "40" },
    neutral: { bg: colors.neutral + "20", text: colors.neutral, border: colors.neutral + "40" },
  };
  const c = badgeColors[type] || badgeColors.neutral;

  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 10px",
        borderRadius: "12px",
        fontSize: "11px",
        fontWeight: 600,
        fontFamily: "'Syne', sans-serif",
        background: c.bg,
        color: c.text,
        border: `1px solid ${c.border}`,
      }}
    >
      {text}
    </span>
  );
}

// ─── Sentiment score bar ───────────────────────────────────────────────
// Horizontal bar from 0–100, gradient red→yellow→green.

function SentimentBar({ score }) {
  return (
    <div style={{ position: "relative", width: "100%", height: "8px", marginTop: "8px" }}>
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: "4px",
          background: "linear-gradient(to right, #FF4560, #FFB347, #00FF88)",
          opacity: 0.3,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "-3px",
          left: `${score}%`,
          width: "14px",
          height: "14px",
          borderRadius: "50%",
          background: score > 60 ? colors.green : score > 40 ? "#FFB347" : colors.red,
          border: `2px solid ${colors.bg}`,
          transform: "translateX(-50%)",
          transition: "left 0.6s ease",
        }}
      />
    </div>
  );
}

// ─── Data cards ────────────────────────────────────────────────────────

function Card({ title, children, delay = 0 }) {
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: "8px",
        padding: "14px",
        animation: `fadeSlideUp 0.4s ease ${delay}s both`,
      }}
    >
      <div
        style={{
          fontSize: "10px",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "1px",
          color: colors.textSecondary,
          marginBottom: "10px",
          fontFamily: "'Syne', sans-serif",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function DataRow({ label, value, mono = false }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "3px 0",
      }}
    >
      <span style={{ fontSize: "12px", color: colors.textSecondary }}>{label}</span>
      <span
        style={{
          fontSize: "12px",
          fontFamily: mono ? "'DM Mono', monospace" : "'Syne', sans-serif",
          fontWeight: 500,
          color: colors.textPrimary,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Collapsible section (for bull cases / risks) ──────────────────────

function CollapsibleList({ title, items, color }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: "8px",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: colors.textPrimary,
          fontFamily: "'Syne', sans-serif",
          fontSize: "12px",
          fontWeight: 600,
        }}
      >
        <span style={{ color }}>{title}</span>
        <span
          style={{
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
            fontSize: "10px",
            color: colors.textSecondary,
          }}
        >
          ▼
        </span>
      </button>
      {open && (
        <ul style={{ padding: "0 14px 12px 14px", listStyle: "none" }}>
          {items.map((item, i) => (
            <li
              key={i}
              style={{
                fontSize: "11px",
                color: colors.textSecondary,
                padding: "4px 0",
                paddingLeft: "12px",
                position: "relative",
                lineHeight: "1.4",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  color,
                  fontSize: "8px",
                  top: "6px",
                }}
              >
                ●
              </span>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Search bar ────────────────────────────────────────────────────────

function SearchBar({ value, onChange, onSubmit }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      style={{ position: "relative", marginBottom: "16px" }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder="Search ticker..."
        style={{
          width: "100%",
          padding: "10px 14px",
          paddingRight: "40px",
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: "8px",
          color: colors.textPrimary,
          fontFamily: "'DM Mono', monospace",
          fontSize: "13px",
          outline: "none",
        }}
        onFocus={(e) => (e.target.style.borderColor = colors.green)}
        onBlur={(e) => (e.target.style.borderColor = colors.border)}
      />
      <button
        type="submit"
        style={{
          position: "absolute",
          right: "8px",
          top: "50%",
          transform: "translateY(-50%)",
          background: "none",
          border: "none",
          color: colors.green,
          cursor: "pointer",
          fontSize: "16px",
          fontFamily: "'Syne', sans-serif",
        }}
      >
        →
      </button>
    </form>
  );
}

// ─── Loading skeleton ──────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div style={{ padding: "16px" }}>
      <Skeleton width="60%" height="24px" />
      <div style={{ height: "8px" }} />
      <Skeleton width="40%" height="14px" />
      <div style={{ height: "20px" }} />
      <Skeleton height="60px" />
      <div style={{ height: "16px" }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <Skeleton height="100px" />
        <Skeleton height="100px" />
        <Skeleton height="100px" />
        <Skeleton height="100px" />
      </div>
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────

function App() {
  const [ticker, setTicker] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // On mount: ask the content script what ticker is on the current page
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) {
        setLoading(false);
        return;
      }

      chrome.tabs.sendMessage(tabs[0].id, { type: "GET_TICKER" }, (response) => {
        if (chrome.runtime.lastError || !response) {
          // No ticker detected — user can search manually
          setLoading(false);
          return;
        }
        setTicker(response.ticker);
        setSearchInput(response.ticker);
        fetchData(response.ticker);
      });
    });
  }, []);

  function fetchData(t) {
    setLoading(true);
    setError(null);

    chrome.runtime.sendMessage({ type: "FETCH_BRIEF", ticker: t }, (response) => {
      if (chrome.runtime.lastError) {
        setError("Failed to fetch data");
        setLoading(false);
        return;
      }
      if (response?.success) {
        setBrief(response.data);
      } else {
        setError(response?.error || "Unknown error");
      }
      setLoading(false);
    });
  }

  function handleSearch() {
    const t = searchInput.trim();
    if (t && t.length <= 5) {
      setTicker(t);
      fetchData(t);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: "500px", fontFamily: "'Syne', sans-serif" }}>
      {/* Inject keyframe animations */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div style={{ padding: "16px" }}>
        {/* Search bar */}
        <SearchBar value={searchInput} onChange={setSearchInput} onSubmit={handleSearch} />

        {/* Loading state */}
        {loading && <LoadingSkeleton />}

        {/* Error state */}
        {error && (
          <div
            style={{
              textAlign: "center",
              padding: "40px 20px",
              color: colors.red,
              fontSize: "13px",
            }}
          >
            {error}
          </div>
        )}

        {/* Empty state — no ticker detected and not loading */}
        {!loading && !error && !brief && (
          <div
            style={{
              textAlign: "center",
              padding: "60px 20px",
              color: colors.textSecondary,
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>📡</div>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "6px" }}>
              No ticker detected
            </div>
            <div style={{ fontSize: "12px" }}>
              Navigate to a finance page or search above
            </div>
          </div>
        )}

        {/* Dashboard */}
        {!loading && !error && brief && (
          <div style={{ animation: "fadeSlideUp 0.3s ease both" }}>
            {/* ── Header ──────────────────────────────────── */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: "16px",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    marginBottom: "4px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "22px",
                      fontWeight: 700,
                      fontFamily: "'DM Mono', monospace",
                      color: colors.textPrimary,
                    }}
                  >
                    {brief.ticker}
                  </span>
                  <Badge type={brief.sentiment.label.toLowerCase()} text={brief.sentiment.label} />
                </div>
                <div style={{ fontSize: "12px", color: colors.textSecondary }}>{brief.name}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontSize: "20px",
                    fontWeight: 700,
                    fontFamily: "'DM Mono', monospace",
                    color: colors.textPrimary,
                  }}
                >
                  {money(brief.price)}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    fontFamily: "'DM Mono', monospace",
                    color: brief.changePct >= 0 ? colors.green : colors.red,
                  }}
                >
                  {brief.changePct >= 0 ? "+" : ""}
                  {brief.change.toFixed(2)} ({brief.changePct >= 0 ? "+" : ""}
                  {brief.changePct.toFixed(2)}%)
                </div>
              </div>
            </div>

            {/* ── AI Summary ──────────────────────────────── */}
            <div
              style={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: "8px",
                padding: "14px",
                marginBottom: "12px",
                fontSize: "12px",
                lineHeight: "1.6",
                color: colors.textSecondary,
                animation: "fadeSlideUp 0.4s ease 0.05s both",
              }}
            >
              {brief.summary}
            </div>

            {/* ── Signal badges ───────────────────────────── */}
            <div
              style={{
                display: "flex",
                gap: "6px",
                flexWrap: "wrap",
                marginBottom: "12px",
                animation: "fadeSlideUp 0.4s ease 0.1s both",
              }}
            >
              {brief.signals.map((s, i) => (
                <Badge key={i} type={s.type} text={s.text} />
              ))}
            </div>

            {/* ── 2x2 Data cards grid ─────────────────────── */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "10px",
                marginBottom: "12px",
              }}
            >
              {/* Sentiment card */}
              <Card title="Sentiment" delay={0.15}>
                <DataRow label="Label" value={brief.sentiment.label} />
                <DataRow label="Confidence" value={brief.sentiment.confidence} />
                <DataRow label="Score" value={brief.sentiment.score} mono />
                <SentimentBar score={brief.sentiment.score} />
              </Card>

              {/* Fundamentals card */}
              <Card title="Fundamentals" delay={0.2}>
                <DataRow label="P/E" value={show(brief.fundamentals.pe)} mono />
                <DataRow label="EPS" value={money(brief.fundamentals.eps)} mono />
                <DataRow label="Revenue" value={show(brief.fundamentals.revenueGrowth)} mono />
                <DataRow label="Margin" value={show(brief.fundamentals.margin)} mono />
              </Card>

              {/* Social buzz card */}
              <Card title="Social Buzz" delay={0.25}>
                <DataRow label="Reddit" value={brief.social.redditMentions.toLocaleString()} mono />
                <DataRow label="vs Avg" value={brief.social.mentionChange} mono />
                <DataRow
                  label="Trending"
                  value={brief.social.trending ? "🔥 Yes" : "No"}
                />
              </Card>

              {/* Options card */}
              <Card title="Options" delay={0.3}>
                <DataRow label="C/P Ratio" value={show(brief.options.callPutRatio)} mono />
                <DataRow
                  label="Unusual"
                  value={brief.options.unusualActivity ? "⚡ Yes" : "No"}
                />
                <DataRow label="IV" value={show(brief.options.impliedVolatility)} mono />
              </Card>
            </div>

            {/* ── Bull cases / Risks ──────────────────────── */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                marginBottom: "16px",
                animation: "fadeSlideUp 0.4s ease 0.35s both",
              }}
            >
              <CollapsibleList
                title="Bull Cases"
                items={brief.bullCases}
                color={colors.green}
              />
              <CollapsibleList title="Risks" items={brief.risks} color={colors.red} />
            </div>

            {/* ── Footer ──────────────────────────────────── */}
            <div
              style={{
                textAlign: "center",
                fontSize: "10px",
                color: colors.neutral,
                paddingBottom: "8px",
                animation: "fadeSlideUp 0.4s ease 0.4s both",
              }}
            >
              Signal logged — accuracy tracked
              <div style={{ marginTop: "2px", fontFamily: "'DM Mono', monospace" }}>
                {brief.cachedAt ? new Date(brief.cachedAt).toLocaleTimeString() : "—"}
                {brief.fromCache && " · cached"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Mount React ───────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root"));
root.render(<App />);
