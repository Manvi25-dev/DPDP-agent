/**
 * content.js — Content Script
 * Detects consent banners, extracts policy URL, triggers analysis, renders overlay.
 */

// ─── State ────────────────────────────────────────────────────────────────────

let overlayInjected = false;
let detectionDebounceTimer = null;
let observerActive = false;
let pageFlowInitialized = false;
let activeMode = "DEFAULT_MODE";

const MODE = {
  POLICY: "POLICY_MODE",
  BANNER: "BANNER_MODE",
  DEFAULT: "DEFAULT_MODE",
};

const pageRunCache = new Set();

const POLICY_MODE_MAX_CHARS = 10000;

// Keywords that indicate a consent/cookie banner
const CONSENT_KEYWORDS = ["cookie", "privacy", "consent", "accept", "agree", "gdpr", "data protection", "terms"];
const POLICY_LINK_KEYWORDS = ["privacy policy", "privacy notice", "data protection", "privacy statement"];

// ─── Entry Point ──────────────────────────────────────────────────────────────

function init() {
  if (pageFlowInitialized) return;
  pageFlowInitialized = true;

  activeMode = detectMode();

  if (activeMode === MODE.POLICY) {
    runPolicyMode();
    return;
  }

  if (activeMode === MODE.BANNER) {
    runBannerMode();
    return;
  }

  runDefaultMode();
}

// ─── Strict Mode Router ───────────────────────────────────────────────────────

function detectMode() {
  if (isPolicyPage()) return MODE.POLICY;

  // Keep existing banner detection logic for non-policy pages.
  const banner = findConsentElement();
  if (banner) return MODE.BANNER;

  return MODE.DEFAULT;
}

function runPolicyMode() {
  const pageUrl = window.location.href;
  if (pageRunCache.has(pageUrl)) return;
  pageRunCache.add(pageUrl);

  const policyText = extractVisiblePolicyText();
  if (!policyText) return;

  showPolicyModeLoadingOverlay(pageUrl);

  chrome.runtime.sendMessage(
    {
      type: "ANALYZE_POLICY_TEXT",
      pageUrl,
      policyText,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("[DPDP] Policy mode message error:", chrome.runtime.lastError.message);
        showPolicyModeErrorOverlay("Policy analysis could not be completed on this page.");
        return;
      }

      if (!response || !response.success || !response.analysis) {
        showPolicyModeErrorOverlay("Policy analysis could not be completed on this page.");
        return;
      }

      showPolicyModeOverlay(response.analysis, pageUrl);
    }
  );
}

function runBannerMode() {
  // Run once on load
  detectConsentBanner();

  // Watch for dynamically injected banners
  if (!observerActive) {
    observerActive = true;
    const observer = new MutationObserver(() => {
      clearTimeout(detectionDebounceTimer);
      detectionDebounceTimer = setTimeout(detectConsentBanner, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

function runDefaultMode() {
  // Intentional no-op: in default mode we keep the page untouched.
}

// ─── Policy Page Detection (Highest Priority) ────────────────────────────────

function isPolicyPage() {
  const url = window.location.href.toLowerCase();
  const urlHit = ["privacy", "policy", "cookie-policy", "terms"].some((token) => url.includes(token));

  const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
  const headingHit = headings.some((el) => {
    const text = (el.innerText || el.textContent || "").toLowerCase();
    return text.includes("privacy policy") || text.includes("cookie policy");
  });

  return urlHit || headingHit;
}

function extractVisiblePolicyText() {
  const text = (document.body?.innerText || "").slice(0, POLICY_MODE_MAX_CHARS).trim();
  if (!text) return "";
  return text;
}

// ─── Consent Detection ────────────────────────────────────────────────────────

function detectConsentBanner() {
  if (activeMode === MODE.POLICY) return;
  if (overlayInjected) return;

  const banner = findConsentElement();
  if (!banner) return;

  const policyUrl = extractPolicyUrl(banner);
  if (!policyUrl) {
    console.log("[DPDP] Consent banner found but no policy link detected.");
    return;
  }

  console.log("[DPDP] Consent banner detected. Policy URL:", policyUrl);
  triggerAnalysis(policyUrl, banner);
}

function findConsentElement() {
  // Strategy 1: known framework selectors
  const knownSelectors = [
    "#onetrust-banner-sdk",
    "#cookieConsent",
    "#cookie-banner",
    "#cookie-notice",
    ".cookie-banner",
    ".cookie-consent",
    ".consent-banner",
    "[id*='cookie'][id*='banner']",
    "[class*='cookie'][class*='banner']",
    "[class*='consent']",
    "[aria-label*='cookie']",
    "[aria-label*='consent']",
  ];

  for (const sel of knownSelectors) {
    try {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    } catch {
      // invalid selector — skip
    }
  }

  // Strategy 2: heuristic — scan visible elements for keyword density
  const candidates = document.querySelectorAll("div, section, aside, dialog, [role='dialog'], [role='alertdialog']");
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const text = (el.innerText || el.textContent || "").toLowerCase();
    const matchCount = CONSENT_KEYWORDS.filter((kw) => text.includes(kw)).length;
    if (matchCount >= 2 && text.length < 3000) {
      return el;
    }
  }

  return null;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

// ─── Policy URL Extraction ────────────────────────────────────────────────────

function extractPolicyUrl(bannerEl) {
  // Search within banner first, then fall back to full page
  const searchRoots = [bannerEl, document.body];

  for (const root of searchRoots) {
    const links = root.querySelectorAll("a[href]");
    for (const link of links) {
      const text = (link.innerText || link.textContent || link.title || link.getAttribute("aria-label") || "").toLowerCase();
      const href = link.href;
      if (!href || href.startsWith("javascript:") || href === "#") continue;

      if (POLICY_LINK_KEYWORDS.some((kw) => text.includes(kw))) {
        return resolveUrl(href);
      }
    }

    // Also check href patterns
    for (const link of links) {
      const href = (link.href || "").toLowerCase();
      if (href.includes("privacy") || href.includes("data-protection")) {
        return resolveUrl(link.href);
      }
    }
  }

  return null;
}

function resolveUrl(href) {
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return null;
  }
}

// ─── Analysis Trigger ─────────────────────────────────────────────────────────

function triggerAnalysis(policyUrl, bannerEl) {
  const bannerContext = extractBannerContext(bannerEl);

  // [ADDED] Show loading state immediately with "agent feel"
  showLoadingOverlay(bannerEl);

  chrome.runtime.sendMessage({ type: "ANALYZE_POLICY", policyUrl }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("[DPDP] Message error:", chrome.runtime.lastError.message);
      // [ADDED] Minimum delay so loading state is always visible
      setTimeout(() => showErrorOverlay(bannerEl, "Extension error. Please reload the page."), 1500);
      return;
    }

    if (!response || !response.success) {
      // [ADDED] On failure, show fallback risks instead of hard error
      const fallbackRisks = getFallbackRisks();
      setTimeout(() => showRiskOverlay(bannerEl, fallbackRisks, policyUrl, true, null, bannerContext), 1800);
      return;
    }

    const risks = mapRisks(response.analysis);

    // [ADDED] Ensure at least 2–3 risks are shown; pad with fallbacks if needed
    const paddedRisks = padWithFallbacks(risks);

    // [ADDED] Delay render by 1.8s to simulate AI processing
    setTimeout(() => showRiskOverlay(bannerEl, paddedRisks, policyUrl, false, response.analysis, bannerContext), 1800);
  });
}

function extractBannerContext(bannerEl) {
  const fallbackContext = {
    cookieSettingsDetected: false,
    acceptAllDetected: false,
  };

  if (!bannerEl) return fallbackContext;

  const combinedText = [
    bannerEl.innerText || bannerEl.textContent || "",
    ...Array.from(bannerEl.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")).map((el) => {
      if (el.tagName === "INPUT") return el.value || "";
      return el.innerText || el.textContent || el.getAttribute("aria-label") || "";
    }),
  ].join(" ").toLowerCase();

  return {
    cookieSettingsDetected: /(cookie settings|cookie preferences|manage cookies|manage preferences|privacy settings|customi[sz]e)/.test(combinedText),
    acceptAllDetected: /(accept all|allow all|agree all|accept cookies|allow cookies)/.test(combinedText),
  };
}

// [ADDED] Fallback risks shown when analysis fails or returns too few results
function getFallbackRisks() {
  return [
    { level: "High", principle: "Storage Limitation", message: "Retention period not clearly specified. Data may be kept longer than necessary." },
    { level: "Medium", principle: "Purpose Limitation", message: "Third-party data sharing detected. Verify if sharing aligns with stated purposes." },
    { level: "Medium", principle: "User Rights", message: "User rights (erasure, withdrawal) not clearly outlined in this policy." },
  ];
}

// [ADDED] Pad real risks with fallbacks if fewer than 2 risks were detected
function padWithFallbacks(risks) {
  if (risks.length >= 2) return risks;
  const fallbacks = getFallbackRisks();
  const combined = [...risks];
  for (const fb of fallbacks) {
    if (combined.length >= 3) break;
    // Avoid duplicating same principle
    if (!combined.some((r) => r.principle === fb.principle)) {
      combined.push(fb);
    }
  }
  return combined;
}

// ─── DPDP Rule Mapping Engine ─────────────────────────────────────────────────

function mapRisks(analysis) {
  const risks = [];

  if (!analysis) return risks;

  // Rule: retention_periods empty
  if (!analysis.retention_periods || analysis.retention_periods.trim() === "") {
    risks.push({ level: "High", principle: "Storage Limitation", message: "Data retention period not specified. Under DPDP, data must not be kept longer than necessary." });
  }

  // Rule: third_party_sharing present
  if (analysis.third_party_sharing && analysis.third_party_sharing.trim() !== "") {
    risks.push({ level: "Medium", principle: "Purpose Limitation", message: "Third-party data sharing detected. Verify if sharing aligns with the stated collection purpose." });
  }

  // Rule: consent_mechanism vague or empty
  const consent = (analysis.consent_mechanism || "").toLowerCase();
  if (!consent || consent.length < 10 || ["vague", "unclear", "not specified", "none"].some((w) => consent.includes(w))) {
    risks.push({ level: "Medium", principle: "Lawful Consent", message: "Consent mechanism is unclear or vague. DPDP requires free, specific, informed, and unambiguous consent." });
  }

  // Rule: user_rights empty
  if (!analysis.user_rights || analysis.user_rights.length === 0) {
    risks.push({ level: "High", principle: "User Rights", message: "No user rights mentioned (e.g., right to withdraw consent, erasure). DPDP mandates these rights." });
  }

  // Rule: collection_purposes empty
  if (!analysis.collection_purposes || analysis.collection_purposes.length === 0) {
    risks.push({ level: "High", principle: "Transparency", message: "Data collection purposes not stated. DPDP requires clear disclosure of why data is collected." });
  }

  // Rule: data_types_collected empty
  if (!analysis.data_types_collected || analysis.data_types_collected.length === 0) {
    risks.push({ level: "Medium", principle: "Data Minimization", message: "Types of data collected are not specified. Transparency about collected data is required under DPDP." });
  }

  return risks;
}

// ─── UI Overlay (Shadow DOM) ──────────────────────────────────────────────────

const OVERLAY_ID = "dpdp-warning-host";

function createShadowHost() {
  // Remove any existing overlay
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; bottom: 20px; right: 20px; max-width: 380px; font-family: sans-serif;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });
  return { host, shadow };
}

function getBaseStyles() {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    .card {
      background: #1a1a2e;
      color: #e0e0e0;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      border: 1px solid #2d2d4e;
      font-size: 13px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: bold;
    }
    .badge-high { background: #ff4444; color: #fff; }
    .badge-medium { background: #ff9800; color: #fff; }
    .badge-low { background: #4caf50; color: #fff; }
    .title { font-size: 14px; font-weight: bold; color: #fff; }
    .subtitle { font-size: 11px; color: #aaa; margin-bottom: 10px; }
    .risk-list { list-style: none; margin-bottom: 12px; }
    .risk-item {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 6px 0;
      border-bottom: 1px solid #2d2d4e;
    }
    .risk-item:last-child { border-bottom: none; }
    .risk-msg { flex: 1; font-size: 12px; color: #ccc; }
    .risk-principle { font-size: 10px; color: #888; margin-top: 2px; }
    .details-section { display: none; margin-bottom: 10px; }
    .details-section.open { display: block; }
    .btn-row { display: flex; gap: 8px; }
    button {
      flex: 1;
      padding: 7px 10px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .btn-details { background: #2d2d4e; color: #e0e0e0; }
    .btn-details:hover { background: #3d3d6e; }
    .btn-dismiss { background: #333; color: #aaa; }
    .btn-dismiss:hover { background: #444; }
    .loading { text-align: center; padding: 12px 0; color: #aaa; font-size: 12px; }
    .spinner {
      display: inline-block;
      width: 16px; height: 16px;
      border: 2px solid #444;
      border-top-color: #7c83fd;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { color: #ff6b6b; font-size: 12px; padding: 8px 0; }
    .logo { font-size: 16px; }
    .policy-link { font-size: 10px; color: #7c83fd; word-break: break-all; margin-top: 4px; }
    a { color: #7c83fd; }
    /* [ADDED] Consent detected label above the card */
    .consent-label {
      font-size: 10px;
      color: #7c83fd;
      margin-bottom: 6px;
      letter-spacing: 0.3px;
      opacity: 0.85;
    }
    /* [ADDED] Context line at top of card */
    .context-line {
      font-size: 10px;
      color: #888;
      font-style: italic;
      margin-bottom: 10px;
      line-height: 1.4;
      border-left: 2px solid #3d3d6e;
      padding-left: 8px;
    }
    /* [ADDED] Risk level label inline with message */
    .risk-level-label {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-right: 5px;
    }
    .risk-level-high { color: #ff6b6b; }
    .risk-level-medium { color: #ffb347; }
    .risk-level-low { color: #4caf50; }
    /* [ADDED] Icon column in risk row */
    .risk-icon { font-size: 12px; margin-top: 2px; flex-shrink: 0; }
    /* [ADDED] Fallback notice */
    .fallback-notice {
      font-size: 10px;
      color: #ffb347;
      background: rgba(255,179,71,0.08);
      border-radius: 4px;
      padding: 5px 8px;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .policy-status-list {
      list-style: none;
      margin-bottom: 10px;
    }
    .policy-status-item {
      font-size: 12px;
      color: #ddd;
      padding: 4px 0;
      border-bottom: 1px solid #2d2d4e;
    }
    .policy-status-item:last-child {
      border-bottom: none;
    }
    .risk-summary-title {
      font-size: 11px;
      color: #9fa8ff;
      margin-top: 6px;
      margin-bottom: 4px;
      font-weight: 700;
    }
    .risk-summary-body {
      font-size: 12px;
      color: #c7c7dd;
      line-height: 1.45;
      margin-bottom: 8px;
    }
  `;
}

function showLoadingOverlay(bannerEl) {
  overlayInjected = true;
  const { shadow } = createShadowHost();

  // [ADDED] "Consent detected" label + multi-step loading message for agent feel
  shadow.innerHTML = `
    <style>${getBaseStyles()}</style>
    <div class="consent-label" aria-label="Consent request detected">🔍 Consent request detected</div>
    <div class="card" role="status" aria-live="polite">
      <div class="header">
        <span class="logo">🛡️</span>
        <span class="title">DPDP Privacy Agent</span>
      </div>
      <div class="loading">
        <span class="spinner" aria-hidden="true"></span>
        Analyzing privacy policy...
      </div>
    </div>
  `;
}

function showErrorOverlay(bannerEl, errorMsg) {
  overlayInjected = true;
  const { shadow } = createShadowHost();

  shadow.innerHTML = `
    <style>${getBaseStyles()}</style>
    <div class="consent-label">🔍 Consent request detected</div>
    <div class="card" role="alert">
      <div class="header">
        <span class="logo">🛡️</span>
        <span class="title">DPDP Privacy Agent</span>
      </div>
      <div class="error">⚠️ ${escapeHtml(errorMsg)}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn-dismiss" id="dpdp-dismiss">Dismiss</button>
      </div>
    </div>
  `;

  shadow.getElementById("dpdp-dismiss").addEventListener("click", () => {
    document.getElementById(OVERLAY_ID)?.remove();
    overlayInjected = false;
  });
}

function showPolicyModeLoadingOverlay(pageUrl) {
  overlayInjected = true;
  const { shadow } = createShadowHost();

  shadow.innerHTML = `
    <style>${getBaseStyles()}</style>
    <div class="consent-label">Policy Analysis</div>
    <div class="card" role="status" aria-live="polite">
      <div class="header">
        <span class="logo">📄</span>
        <span class="title">Policy Analysis</span>
      </div>
      <div class="loading">
        <span class="spinner" aria-hidden="true"></span>
        Reviewing visible policy text...
      </div>
      <div class="policy-link">Source: ${escapeHtml(truncate(pageUrl, 72))}</div>
    </div>
  `;
}

function showPolicyModeErrorOverlay(errorMsg) {
  overlayInjected = true;
  const { shadow } = createShadowHost();

  shadow.innerHTML = `
    <style>${getBaseStyles()}</style>
    <div class="consent-label">Policy Analysis</div>
    <div class="card" role="alert">
      <div class="header">
        <span class="logo">📄</span>
        <span class="title">Policy Analysis</span>
      </div>
      <div class="error">⚠️ ${escapeHtml(errorMsg)}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn-dismiss" id="dpdp-dismiss">Dismiss</button>
      </div>
    </div>
  `;

  shadow.getElementById("dpdp-dismiss").addEventListener("click", () => {
    document.getElementById(OVERLAY_ID)?.remove();
    overlayInjected = false;
  });
}

function showPolicyModeOverlay(analysis, pageUrl) {
  overlayInjected = true;
  const { shadow } = createShadowHost();

  const statusRows = buildPolicyStatusRows(analysis);
  const riskSummary = buildPolicyRiskSummary(statusRows);

  const statusMarkup = statusRows
    .map((row) => `<li class="policy-status-item">${row.icon} ${escapeHtml(row.label)}: ${escapeHtml(row.value)}</li>`)
    .join("");

  const detailsMarkup = `
    <ul class="risk-list" aria-label="Detailed policy analysis">
      <li class="risk-item"><div class="risk-msg"><span class="risk-level-label risk-level-low">Data Types</span> ${escapeHtml(formatArray(analysis.data_types_collected))}</div></li>
      <li class="risk-item"><div class="risk-msg"><span class="risk-level-label risk-level-low">Purposes</span> ${escapeHtml(formatArray(analysis.collection_purposes))}</div></li>
      <li class="risk-item"><div class="risk-msg"><span class="risk-level-label risk-level-low">Third-Party Sharing</span> ${escapeHtml(analysis.third_party_sharing || "Not mentioned")}</div></li>
      <li class="risk-item"><div class="risk-msg"><span class="risk-level-label risk-level-low">Retention</span> ${escapeHtml(analysis.retention_periods || "Not mentioned")}</div></li>
      <li class="risk-item"><div class="risk-msg"><span class="risk-level-label risk-level-low">User Rights</span> ${escapeHtml(formatArray(analysis.user_rights))}</div></li>
    </ul>
  `;

  shadow.innerHTML = `
    <style>${getBaseStyles()}</style>
    <div class="consent-label">Policy Analysis</div>
    <div class="card" role="dialog" aria-label="Policy Analysis Results">
      <div class="header">
        <span class="logo">📄</span>
        <span class="title">Policy Analysis</span>
      </div>

      <ul class="policy-status-list" aria-label="Policy findings">
        ${statusMarkup}
      </ul>

      <div class="risk-summary-title">Risk Summary</div>
      <div class="risk-summary-body">${escapeHtml(riskSummary)}</div>

      <div class="details-section" id="dpdp-policy-details">
        ${detailsMarkup}
      </div>

      <div class="policy-link">Source: <a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(pageUrl, 60))}</a></div>

      <div class="btn-row" style="margin-top:10px">
        <button class="btn-details" id="dpdp-policy-toggle" aria-expanded="false">View Detailed Analysis</button>
        <button class="btn-dismiss" id="dpdp-dismiss">Dismiss</button>
      </div>
    </div>
  `;

  const detailsEl = shadow.getElementById("dpdp-policy-details");
  const toggleBtn = shadow.getElementById("dpdp-policy-toggle");

  toggleBtn.addEventListener("click", () => {
    const isOpen = detailsEl.classList.toggle("open");
    toggleBtn.textContent = isOpen ? "Hide Detailed Analysis" : "View Detailed Analysis";
    toggleBtn.setAttribute("aria-expanded", String(isOpen));
  });

  shadow.getElementById("dpdp-dismiss").addEventListener("click", () => {
    document.getElementById(OVERLAY_ID)?.remove();
    overlayInjected = false;
  });
}

function buildPolicyStatusRows(analysis) {
  const collected = Array.isArray(analysis?.data_types_collected) && analysis.data_types_collected.length > 0;
  const purposes = Array.isArray(analysis?.collection_purposes) && analysis.collection_purposes.length > 0;
  const rights = Array.isArray(analysis?.user_rights) && analysis.user_rights.length > 0;

  const sharingText = (analysis?.third_party_sharing || "").toLowerCase();
  const retentionText = (analysis?.retention_periods || "").toLowerCase();

  const sharingDetected = Boolean(sharingText.trim())
    && !/(none|not shared|no third party|not applicable)/.test(sharingText);

  const retentionSpecified = Boolean(retentionText.trim())
    && !/(not specified|unknown|n\/?a|none|not mentioned)/.test(retentionText);

  return [
    { icon: collected ? "✔" : "⚠", label: "Data Collection", value: collected ? "Present" : "Unclear" },
    { icon: purposes ? "✔" : "⚠", label: "Purpose Limitation", value: purposes ? "Clearly defined" : "Unclear" },
    { icon: sharingDetected ? "⚠" : "✔", label: "Third-party sharing", value: sharingDetected ? "Detected" : "Not detected" },
    { icon: retentionSpecified ? "✔" : "❌", label: "Retention", value: retentionSpecified ? "Specified" : "Not specified" },
    { icon: rights ? "✔" : "❌", label: "User rights", value: rights ? "Mentioned" : "Not mentioned" },
  ];
}

function buildPolicyRiskSummary(statusRows) {
  const criticalCount = statusRows.filter((row) => row.icon === "❌").length;
  const warningCount = statusRows.filter((row) => row.icon === "⚠").length;

  const firstLine = criticalCount > 0
    ? "Key safeguards are missing, especially around retention or user rights."
    : "No critical gaps were detected in the visible policy text.";

  const secondLine = warningCount > 0
    ? "Some clauses are unclear or indicate potential third-party sharing risks."
    : "Most major disclosures appear to be stated clearly.";

  const thirdLine = "Review detailed clauses before accepting terms on this page.";

  return `${firstLine} ${secondLine} ${thirdLine}`;
}

function formatArray(value) {
  if (!Array.isArray(value) || value.length === 0) return "Not mentioned";
  return value.join(", ");
}

function showRiskOverlay(bannerEl, risks, policyUrl, isFallback, analysis, bannerContext) {
  overlayInjected = true;
  const { shadow } = createShadowHost();

  const highCount = risks.filter((r) => r.level === "High").length;
  const medCount = risks.filter((r) => r.level === "Medium").length;

  const summaryBadge = highCount > 0
    ? `<span class="badge badge-high">⚠ ${highCount} High Risk</span>`
    : medCount > 0
    ? `<span class="badge badge-medium">● ${medCount} Medium Risk</span>`
    : `<span class="badge badge-low">✓ Low Risk</span>`;

  // [ADDED] Icon per risk level for visual hierarchy
  const riskIcon = (level) => level === "High" ? "🔴" : level === "Medium" ? "🟠" : "🟢";

  const riskItems = risks.length > 0
    ? risks.map((r) => `
        <li class="risk-item">
          <span class="risk-icon" aria-hidden="true">${riskIcon(r.level)}</span>
          <div class="risk-msg">
            <span class="risk-level-label risk-level-${r.level.toLowerCase()}">${escapeHtml(r.level)}</span>
            ${escapeHtml(r.message)}
            <div class="risk-principle">DPDP: ${escapeHtml(r.principle)}</div>
          </div>
        </li>`).join("")
    : `<li class="risk-item"><div class="risk-msg">No significant risks detected.</div></li>`;

  // [ADDED] Fallback notice shown when analysis failed and we're using indicative risks
  const fallbackNotice = isFallback
    ? `<div class="fallback-notice">⚠ Unable to fully analyze this policy. Showing indicative risks based on common patterns.</div>`
    : "";

  const recommendationBlock = buildRecommendationBlock({ risks, analysis, bannerContext });

  shadow.innerHTML = `
    <style>${getBaseStyles()}</style>
    <div class="consent-label">🔍 Consent request detected</div>
    <div class="card" role="dialog" aria-label="DPDP Privacy Risk Warning">
      <div class="header">
        <span class="logo">🛡️</span>
        <span class="title">DPDP Privacy Agent</span>
        ${summaryBadge}
      </div>

      <!-- [ADDED] Context line reinforcing product positioning -->
      <div class="context-line">This insight is generated before you give consent using AI + DPDP principles.</div>

      ${fallbackNotice}

      <div class="details-section open" id="dpdp-details">
        <ul class="risk-list" aria-label="Risk findings">${riskItems}</ul>
        ${recommendationBlock}
        <div class="policy-link">Policy: <a href="${escapeHtml(policyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(policyUrl, 60))}</a></div>
      </div>

      <div class="btn-row">
        <button class="btn-details" id="dpdp-toggle" aria-expanded="true">Hide Details</button>
        <button class="btn-dismiss" id="dpdp-dismiss">Dismiss</button>
      </div>
    </div>
  `;

  const detailsEl = shadow.getElementById("dpdp-details");
  const toggleBtn = shadow.getElementById("dpdp-toggle");

  toggleBtn.addEventListener("click", () => {
    const isOpen = detailsEl.classList.toggle("open");
    toggleBtn.textContent = isOpen ? "Hide Details" : "View Details";
    toggleBtn.setAttribute("aria-expanded", String(isOpen));
  });

  shadow.getElementById("dpdp-dismiss").addEventListener("click", () => {
    document.getElementById(OVERLAY_ID)?.remove();
    overlayInjected = false;
  });
}

function buildRecommendationBlock({ risks, analysis, bannerContext }) {
  const safeContext = bannerContext || { cookieSettingsDetected: false, acceptAllDetected: false };
  const thirdPartySharingDetected = Boolean((analysis?.third_party_sharing || "").trim())
    || risks.some((r) => r.principle === "Purpose Limitation");

  const recommendationRows = [];

  if (safeContext.cookieSettingsDetected) {
    recommendationRows.push(`
      <li class="risk-item">
        <div class="risk-msg">
          <span class="risk-level-label risk-level-low">STEP 1</span>
          Click "Cookie Settings".
          <div class="risk-principle">Consequence: opens granular controls so you can avoid blanket consent.</div>
        </div>
      </li>
    `);

    recommendationRows.push(`
      <li class="risk-item">
        <div class="risk-msg">
          <span class="risk-level-label risk-level-low">STEP 2</span>
          Inside settings, disable:<br>
          • Performance cookies<br>
          • Functional cookies<br>
          • Targeting/advertising cookies<br>
          Keep enabled:<br>
          • Strictly necessary cookies
          <div class="risk-principle">Consequence: reduces optional tracking while preserving essential site functionality.</div>
          ${thirdPartySharingDetected ? '<div class="risk-principle">Third-party sharing detected: prioritize disabling targeting/advertising cookies to reduce external data transfer.</div>' : ""}
        </div>
      </li>
    `);

    recommendationRows.push(`
      <li class="risk-item">
        <div class="risk-msg">
          <span class="risk-level-label risk-level-low">STEP 3</span>
          Click "Confirm Choices" or "Save Preferences".
          <div class="risk-principle">Consequence: stores a narrower consent profile instead of full access.</div>
        </div>
      </li>
    `);
  } else {
    recommendationRows.push(`
      <li class="risk-item">
        <div class="risk-msg">
          <span class="risk-level-label risk-level-low">STEP 1</span>
          Open the consent panel and look for "Cookie Settings", "Manage Preferences", or "Customize".
          <div class="risk-principle">Consequence: unlocks category-level controls instead of one-click blanket consent.</div>
        </div>
      </li>
    `);

    recommendationRows.push(`
      <li class="risk-item">
        <div class="risk-msg">
          <span class="risk-level-label risk-level-low">STEP 2</span>
          Inside settings, disable optional categories (Performance, Functional, Targeting/Advertising) and keep only strictly necessary cookies enabled.
          <div class="risk-principle">Consequence: minimizes tracking surface while preserving core website operation.</div>
          ${thirdPartySharingDetected ? '<div class="risk-principle">Third-party sharing detected: prioritizing "Targeting/Advertising" off reduces external sharing risk.</div>' : ""}
        </div>
      </li>
    `);

    recommendationRows.push(`
      <li class="risk-item">
        <div class="risk-msg">
          <span class="risk-level-label risk-level-low">STEP 3</span>
          Save your choices using "Confirm", "Save Preferences", or equivalent action.
          <div class="risk-principle">Consequence: records explicit, narrower consent choices for this site.</div>
        </div>
      </li>
    `);
  }

  recommendationRows.push(`
    <li class="risk-item">
      <div class="risk-msg">
        <span class="risk-level-label risk-level-medium">Decision Insight</span>
        If you click "Accept All":<br>
        • Enables third-party data sharing<br>
        • Enables behavioral tracking<br>
        • Reduces consent granularity
        ${safeContext.acceptAllDetected ? '<div class="risk-principle">Accept All option is visible on this banner, so this risk path is immediately actionable.</div>' : ""}
      </div>
    </li>
  `);

  recommendationRows.push(`
    <li class="risk-item">
      <div class="risk-msg">
        <span class="risk-level-label risk-level-low">Decision Insight</span>
        If you follow this recommendation:<br>
        • Limits data sharing<br>
        • Improves privacy control<br>
        • Aligns closer with DPDP principles
      </div>
    </li>
  `);

  if (recommendationRows.length === 0) return "";

  return `
    <ul class="risk-list" aria-label="Actionable recommendations">
      ${recommendationRows.join("")}
    </ul>
  `;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────
init();
