/**
 * content.js - Content Script
 * Detects consent banners and policy pages, then renders a unified DPDP overlay.
 */

let overlayInjected = false;
let detectionDebounceTimer = null;
let observerActive = false;
let pageFlowInitialized = false;
let activeMode = "DEFAULT_MODE";
let modeRecheckObserverActive = false;
let modeRecheckTimer = null;
let overlayDragCleanup = null;

const MODE = {
  POLICY: "POLICY_MODE",
  BANNER: "BANNER_MODE",
  DEFAULT: "DEFAULT_MODE",
};

const OVERLAY_ID = "dpdp-agent";
const POLICY_MODE_MAX_CHARS = 10000;
const CONSENT_KEYWORDS = ["cookie", "privacy", "consent", "accept", "agree", "gdpr", "data protection", "terms"];
const POLICY_LINK_KEYWORDS = ["privacy policy", "privacy notice", "data protection", "privacy statement"];

console.log("[DPDP] content.js loaded on:", window.location.href);

function runAgent() {
  if (pageFlowInitialized && activeMode !== MODE.DEFAULT) return;
  pageFlowInitialized = true;

  if (isPolicyPage()) {
    activeMode = MODE.POLICY;
    renderPolicyMode();
    return;
  }

  if (isCookieBannerPresent()) {
    activeMode = MODE.BANNER;
    runBannerMode();
    return;
  }

  activeMode = MODE.DEFAULT;
  runDefaultMode();
}

function isPolicyPage() {
  const url = window.location.href.toLowerCase();
  const urlMatch = url.includes("privacy") || url.includes("policy");
  const headings = Array.from(document.querySelectorAll("h1, h2, h3")).map((el) => (el.innerText || "").toLowerCase());
  const headingMatch = headings.some((heading) => heading.includes("privacy policy"));
  const bodyText = (document.body?.innerText || "").toLowerCase();

  return urlMatch || headingMatch || bodyText.includes("privacy policy");
}

function isCookieBannerPresent() {
  return Boolean(findConsentElement());
}

function runBannerMode() {
  detectConsentBanner();

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
  startModeRecheckObserver();
}

function startModeRecheckObserver() {
  if (modeRecheckObserverActive || !document.body) return;
  modeRecheckObserverActive = true;

  const observer = new MutationObserver(() => {
    if (activeMode !== MODE.DEFAULT) return;
    clearTimeout(modeRecheckTimer);
    modeRecheckTimer = setTimeout(() => {
      pageFlowInitialized = false;
      runAgent();
    }, 500);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function renderPolicyMode() {
  const analysis = createPolicyPageFallbackAnalysis(extractVisiblePolicyText() || (document.body?.innerText || ""), window.location.href);
  renderUnifiedOverlay({
    mode: MODE.POLICY,
    analysis,
    sourceUrl: window.location.href,
    risks: padWithFallbacks(mapRisks(analysis)),
    bannerContext: { cookieSettingsDetected: false, acceptAllDetected: false },
    isFallback: false,
  });
}

function detectConsentBanner() {
  if (activeMode === MODE.POLICY || overlayInjected) return;

  const banner = findConsentElement();
  if (!banner) return;

  const policyUrl = extractPolicyUrl(banner) || window.location.href;
  const bannerText = banner.innerText || banner.textContent || "";
  const analysis = analyzeText(`${bannerText}\n${document.body?.innerText || ""}`);

  renderUnifiedOverlay({
    mode: MODE.BANNER,
    analysis,
    sourceUrl: policyUrl,
    risks: padWithFallbacks(mapRisks(analysis)),
    bannerContext: extractBannerContext(banner),
    isFallback: false,
  });
}

function findConsentElement() {
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

  for (const selector of knownSelectors) {
    try {
      const element = document.querySelector(selector);
      if (element && isVisible(element)) return element;
    } catch {
      // ignore invalid selectors
    }
  }

  const candidates = document.querySelectorAll("div, section, aside, dialog, [role='dialog'], [role='alertdialog']");
  for (const element of candidates) {
    if (!isVisible(element)) continue;
    const text = (element.innerText || element.textContent || "").toLowerCase();
    const matchCount = CONSENT_KEYWORDS.filter((keyword) => text.includes(keyword)).length;
    if (matchCount >= 2 && text.length < 3000) return element;
  }

  return null;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function extractPolicyUrl(bannerEl) {
  const roots = [bannerEl, document.body];

  for (const root of roots) {
    const links = root.querySelectorAll("a[href]");

    for (const link of links) {
      const text = (link.innerText || link.textContent || link.title || link.getAttribute("aria-label") || "").toLowerCase();
      const href = link.href;
      if (!href || href.startsWith("javascript:") || href === "#") continue;

      if (POLICY_LINK_KEYWORDS.some((keyword) => text.includes(keyword))) {
        return resolveUrl(href);
      }
    }

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

function analyzeText(text) {
  const normalized = String(text || "").toLowerCase();

  return {
    data_types_collected: collectHeuristicMatches(normalized, [
      ["email", /\bemail\b/],
      ["name", /\bname\b/],
      ["phone", /\b(phone|mobile|telephone)\b/],
      ["address", /\b(address|location)\b/],
      ["payment", /\b(card|payment|billing)\b/],
      ["device info", /\b(device|browser|ip address|cookie id)\b/],
    ]),
    collection_purposes: collectHeuristicMatches(normalized, [
      ["service delivery", /\b(provide|deliver|operate)\b/],
      ["account management", /\b(account|registration|login)\b/],
      ["analytics", /\b(analytics|measure|improve)\b/],
      ["marketing", /\b(marketing|promotion|advertising)\b/],
      ["support", /\b(support|assist|customer service)\b/],
      ["security", /\b(security|fraud|abuse|protect)\b/],
    ]),
    retention_periods: extractHeuristicSentence(normalized, [/retain/, /retention/, /store for/, /kept for/, /keep your data/]),
    third_party_sharing: extractHeuristicSentence(normalized, [/third\s*party/, /share/, /partners/, /service providers/, /vendors/]),
    consent_mechanism: extractHeuristicSentence(normalized, [/consent/, /agree/, /accept/, /opt\s*out/, /opt\s*in/]),
    user_rights: collectHeuristicMatches(normalized, [
      ["access", /\b(access|obtain a copy)\b/],
      ["deletion", /\b(delete|erasure|erase|remove)\b/],
      ["correction", /\b(correct|rectif)\b/],
      ["withdraw consent", /\b(withdraw|revoke)\b/],
      ["complaint", /\b(grievance|complaint|authority)\b/],
    ]),
  };
}

function createPolicyPageFallbackAnalysis(policyText, pageUrl) {
  const text = String(policyText || "").toLowerCase();
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((el) => (el.innerText || "").toLowerCase())
    .join(" ");
  const combined = `${text} ${headings} ${String(pageUrl || window.location.href).toLowerCase()}`;
  return analyzeText(combined);
}

function extractVisiblePolicyText() {
  return (document.body?.innerText || "").slice(0, POLICY_MODE_MAX_CHARS).trim();
}

function extractBannerContext(bannerEl) {
  const fallbackContext = { cookieSettingsDetected: false, acceptAllDetected: false };
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

function mapRisks(analysis) {
  const risks = [];
  if (!analysis) return risks;

  if (!analysis.retention_periods || analysis.retention_periods.trim() === "") {
    risks.push({ level: "High", principle: "Storage Limitation", message: "Data retention period not specified. Under DPDP, data must not be kept longer than necessary." });
  }

  if (analysis.third_party_sharing && analysis.third_party_sharing.trim() !== "") {
    risks.push({ level: "Medium", principle: "Purpose Limitation", message: "Third-party data sharing detected. Verify if sharing aligns with the stated collection purpose." });
  }

  const consent = (analysis.consent_mechanism || "").toLowerCase();
  if (!consent || consent.length < 10 || ["vague", "unclear", "not specified", "none"].some((word) => consent.includes(word))) {
    risks.push({ level: "Medium", principle: "Lawful Consent", message: "Consent mechanism is unclear or vague. DPDP requires free, specific, informed, and unambiguous consent." });
  }

  if (!analysis.user_rights || analysis.user_rights.length === 0) {
    risks.push({ level: "High", principle: "User Rights", message: "No user rights mentioned (e.g., right to withdraw consent, erasure). DPDP mandates these rights." });
  }

  if (!analysis.collection_purposes || analysis.collection_purposes.length === 0) {
    risks.push({ level: "High", principle: "Transparency", message: "Data collection purposes not stated. DPDP requires clear disclosure of why data is collected." });
  }

  if (!analysis.data_types_collected || analysis.data_types_collected.length === 0) {
    risks.push({ level: "Medium", principle: "Data Minimization", message: "Types of data collected are not specified. Transparency about collected data is required under DPDP." });
  }

  return risks;
}

function getFallbackRisks() {
  return [
    { level: "High", principle: "Storage Limitation", message: "Retention period not clearly specified. Data may be kept longer than necessary." },
    { level: "Medium", principle: "Purpose Limitation", message: "Third-party data sharing detected. Verify if sharing aligns with stated purposes." },
    { level: "Medium", principle: "User Rights", message: "User rights (erasure, withdrawal) not clearly outlined in this policy." },
  ];
}

function padWithFallbacks(risks) {
  if (risks.length >= 2) return risks;
  const fallbacks = getFallbackRisks();
  const combined = [...risks];

  for (const fallback of fallbacks) {
    if (combined.length >= 3) break;
    if (!combined.some((risk) => risk.principle === fallback.principle)) {
      combined.push(fallback);
    }
  }

  return combined;
}

function renderUnifiedOverlay({ mode, analysis, sourceUrl, risks = [], bannerContext, isFallback }) {
  overlayInjected = true;
  const { shadow } = createShadowHost();

  const checkRows = buildPolicyCheckRows(analysis);
  const riskSummary = buildPolicyRiskSummary(checkRows, risks, mode);
  const decisionBlock = buildDecisionInsightBlock({ mode, analysis, risks, bannerContext });
  const detailsMarkup = buildDetailedAnalysisMarkup(analysis, risks, mode);
  const recommendedAction = buildRecommendedActionTextFromRisks(risks);
  const sourceLink = sourceUrl || window.location.href;
  const highlightClass = mode === MODE.BANNER ? "section-highlight" : "";
  const titlePrefix = mode === MODE.BANNER ? "Consent request detected" : "Policy Analysis";
  const showCookieSettingsButton = Boolean(bannerContext?.cookieSettingsDetected);

  const checkMarkup = checkRows.map((row) => `
    <li class="policy-check-item">
      <span class="check-icon ${row.tone}" aria-hidden="true">${row.icon}</span>
      <div class="check-copy">
        <div class="check-label">${escapeHtml(row.label)}</div>
        <div class="check-note">${escapeHtml(row.note)}</div>
      </div>
    </li>
  `).join("");

  const fallbackNotice = isFallback
    ? `<div class="fallback-notice">⚠ Unable to fully analyze this policy. Showing indicative risks based on common patterns.</div>`
    : "";

  shadow.innerHTML = `
    <style>${getBaseStyles()}</style>
    <div class="consent-label">${escapeHtml(titlePrefix)}</div>
    <div class="card" id="dpdp-panel" role="dialog" aria-label="DPDP Privacy Analysis">
      <div class="drag-handle" id="dpdp-drag-handle" aria-hidden="true"><span class="drag-grip">⋮⋮</span><span>Drag left/right</span></div>
      <div class="header"><span class="logo">🛡️</span><span class="title">DPDP Privacy Agent</span></div>

      ${fallbackNotice}

      <div class="panel-section recommended-action-section" aria-label="Recommended action">
        <div class="section-kicker">Section 1</div>
        <div class="section-title">⚠ Recommended Action</div>
        <div class="recommended-action-box">${escapeHtml(recommendedAction)}</div>
      </div>

      <div class="panel-section ${highlightClass} decision-section" aria-label="Decision insight">
        <div class="section-kicker">Section 2</div>
        <div class="section-title">Decision Insight</div>
        ${decisionBlock}
      </div>

      <div class="panel-section" aria-label="Policy analysis summary">
        <div class="section-kicker">Section 3</div>
        <div class="section-title">Policy Analysis</div>
        <ul class="policy-check-list" aria-label="Policy findings">${checkMarkup}</ul>
        <div class="risk-summary-title">Risk Summary</div>
        <div class="risk-summary-body">${escapeHtml(riskSummary)}</div>
      </div>

      <div class="panel-section" aria-label="Action controls">
        <div class="section-kicker">Section 4</div>
        <div class="section-title">CTA</div>
        <div class="btn-row">
          ${showCookieSettingsButton ? '<button class="btn-primary" id="dpdp-open-cookie-settings">Open Cookie Settings</button>' : ""}
          <button class="btn-details" id="dpdp-toggle" aria-expanded="false">View Full Analysis</button>
        </div>
      </div>

      <div class="details-section" id="dpdp-details">
        ${detailsMarkup}
        <div class="policy-link">Source: <a href="${escapeHtml(sourceLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(sourceLink, 60))}</a></div>
      </div>
    </div>
  `;

  setupOverlayDrag(shadow.getElementById("dpdp-drag-handle"));

  const detailsEl = shadow.getElementById("dpdp-details");
  const toggleBtn = shadow.getElementById("dpdp-toggle");
  const cookieBtn = shadow.getElementById("dpdp-open-cookie-settings");

  toggleBtn.addEventListener("click", () => {
    const isOpen = detailsEl.classList.toggle("open");
    toggleBtn.textContent = isOpen ? "Hide Full Analysis" : "View Full Analysis";
    toggleBtn.setAttribute("aria-expanded", String(isOpen));
  });

  if (cookieBtn) {
    cookieBtn.addEventListener("click", () => {
      const opened = openCookieSettingsOnPage();
      if (!opened) {
        cookieBtn.textContent = "Cookie Settings Not Found";
        cookieBtn.disabled = true;
      }
    });
  }
}

function buildPolicyCheckRows(analysis) {
  const hasDataCollection = Array.isArray(analysis?.data_types_collected) && analysis.data_types_collected.length > 0;
  const hasPurposeLimitation = Array.isArray(analysis?.collection_purposes) && analysis.collection_purposes.length > 0;
  const sharingText = String(analysis?.third_party_sharing || "").toLowerCase().trim();
  const sharingDetected = Boolean(sharingText) && !/(none|not shared|no third party|not applicable|does not share|no sharing)/.test(sharingText);
  const retentionText = String(analysis?.retention_periods || "").toLowerCase().trim();
  const retentionGap = !retentionText || /(not specified|unknown|n\/?a|none|not mentioned|unclear|vague)/.test(retentionText);
  const rightsCount = Array.isArray(analysis?.user_rights) ? analysis.user_rights.length : 0;
  const rightsGap = rightsCount === 0;

  return [
    {
      icon: hasDataCollection ? "✓" : "✗",
      tone: hasDataCollection ? "good" : "bad",
      label: "Data Collection",
      note: hasDataCollection ? `${formatArray(analysis?.data_types_collected)} collected.` : "Collected data not clearly stated.",
    },
    {
      icon: hasPurposeLimitation ? "✓" : "✗",
      tone: hasPurposeLimitation ? "good" : "bad",
      label: "Purpose Limitation",
      note: hasPurposeLimitation ? `${formatArray(analysis?.collection_purposes)} listed.` : "Purpose for collection is unclear.",
    },
    {
      icon: sharingDetected ? "⚠" : "✓",
      tone: sharingDetected ? "warn" : "good",
      label: "Third-party sharing",
      note: sharingDetected ? "Third-party sharing is mentioned." : "No clear third-party sharing signal.",
    },
    {
      icon: retentionGap ? "✗" : "✓",
      tone: retentionGap ? "bad" : "good",
      label: "Retention gaps",
      note: retentionGap ? "Retention period is unclear." : "Retention period is specified.",
    },
    {
      icon: rightsGap ? "✗" : "✓",
      tone: rightsGap ? "bad" : "good",
      label: "User rights gaps",
      note: rightsGap ? "Deletion or withdrawal rights are unclear." : `${formatArray(analysis?.user_rights)} described.`,
    },
  ];
}

function buildPolicyRiskSummary(checkRows, risks, mode) {
  const sharingRisk = checkRows.some((row) => row.label === "Third-party sharing" && row.tone === "warn");
  const gapCount = checkRows.filter((row) => row.tone === "bad").length;
  const highRiskCount = risks.filter((risk) => risk.level === "High").length;

  const lineOne = gapCount > 0 ? "Retention and user-rights disclosure gaps still need attention." : "Core disclosures are visible in the text shown here.";
  const lineTwo = sharingRisk || risks.some((risk) => risk.principle === "Purpose Limitation")
    ? "Third-party sharing remains the main exposure point."
    : "No strong third-party sharing signal was found in the visible analysis.";
  const lineThree = mode === MODE.BANNER
    ? "On banner pages, use the decision layer below to choose the narrowest consent path."
    : highRiskCount > 0
      ? "Review the clauses before proceeding, especially where retention or rights are unclear."
      : "Review the detailed view if you want the underlying clauses.";

  return `${lineOne} ${lineTwo} ${lineThree}`;
}

function buildDetailedAnalysisMarkup(analysis, risks, mode) {
  const dataRows = [
    { label: "Data Types", value: formatArray(analysis?.data_types_collected) },
    { label: "Purposes", value: formatArray(analysis?.collection_purposes) },
    { label: "Third-party Sharing", value: analysis?.third_party_sharing || "Not mentioned" },
    { label: "Retention", value: analysis?.retention_periods || "Not mentioned" },
    { label: "User Rights", value: formatArray(analysis?.user_rights) },
  ];

  const riskItems = risks.length > 0
    ? risks.map((risk) => `
      <li class="detail-row">
        <span class="detail-icon ${risk.level === "High" ? "bad" : risk.level === "Medium" ? "warn" : "good"}" aria-hidden="true">${risk.level === "High" ? "✗" : risk.level === "Medium" ? "⚠" : "✓"}</span>
        <div class="detail-copy">
          <div class="detail-label">DPDP: ${escapeHtml(risk.principle)}</div>
          <div class="detail-note">${escapeHtml(risk.message)}</div>
        </div>
      </li>`).join("")
    : `<li class="detail-row"><div class="detail-copy"><div class="detail-note">No additional risks were generated.</div></div></li>`;

  return `
    <div class="section-kicker">Additional Details</div>
    <div class="section-title additional-title">Additional Details</div>
    <div class="detail-stack" aria-label="Additional details list">
      ${dataRows.map((row) => `
        <div class="detail-inline-row">
          <div class="detail-inline-label">${escapeHtml(row.label)}</div>
          <div class="detail-inline-value">${escapeHtml(row.value)}</div>
        </div>`).join("")}
    </div>
    <ul class="detail-data-list" aria-label="Detailed risk findings">${riskItems}</ul>
    <div class="decision-note" style="margin-top:10px;">${mode === MODE.BANNER ? "Banner mode keeps action and decision layers in focus." : "Policy mode keeps full context while prioritizing action first."}</div>
  `;
}

function buildDecisionInsightBlock({ mode, analysis, risks, bannerContext }) {
  const context = bannerContext || { cookieSettingsDetected: false, acceptAllDetected: false };
  const sharingRisk = risks.some((risk) => risk.principle === "Purpose Limitation") || Boolean((analysis?.third_party_sharing || "").trim());
  const retentionGap = risks.some((risk) => risk.principle === "Storage Limitation");
  const rightsGap = risks.some((risk) => risk.principle === "User Rights");

  if (mode === MODE.BANNER) {
    return `
      <div class="decision-lead">⚠ If you continue on this site:</div>
      <ul class="decision-list" aria-label="Banner decision consequences">
        <li class="decision-item">
          <span class="decision-icon warn" aria-hidden="true">✗</span>
          <div class="decision-copy">
            <div class="decision-label">Third-party sharing</div>
            <div class="decision-note">Your data may be shared with third parties.</div>
          </div>
        </li>
        <li class="decision-item">
          <span class="decision-icon bad" aria-hidden="true">✗</span>
          <div class="decision-copy">
            <div class="decision-label">Longer retention risk</div>
            <div class="decision-note">Your data may be retained longer than expected.</div>
          </div>
        </li>
        <li class="decision-item">
          <span class="decision-icon ${context.cookieSettingsDetected ? "warn" : "bad"}" aria-hidden="true">${context.cookieSettingsDetected ? "⚠" : "✗"}</span>
          <div class="decision-copy">
            <div class="decision-label">Control may be limited</div>
            <div class="decision-note">You may have limited control over deletion or withdrawal.</div>
          </div>
        </li>
      </ul>
      <div class="decision-callout">${buildRecommendedActionText({ mode, bannerContext: context, sharingRisk, retentionGap, rightsGap })}</div>
    `;
  }

  return `
    <div class="decision-lead">⚠ If you continue on this site:</div>
    <ul class="decision-list" aria-label="Policy decision consequences">
      <li class="decision-item">
        <span class="decision-icon ${sharingRisk ? "bad" : "good"}" aria-hidden="true">${sharingRisk ? "✗" : "✓"}</span>
        <div class="decision-copy">
          <div class="decision-label">Third-party sharing</div>
          <div class="decision-note">Your data may be shared with third parties.</div>
        </div>
      </li>
      <li class="decision-item">
        <span class="decision-icon ${retentionGap ? "bad" : "good"}" aria-hidden="true">${retentionGap ? "✗" : "✓"}</span>
        <div class="decision-copy">
          <div class="decision-label">Longer retention risk</div>
          <div class="decision-note">Your data may be retained longer than expected.</div>
        </div>
      </li>
      <li class="decision-item">
        <span class="decision-icon ${rightsGap ? "bad" : "good"}" aria-hidden="true">${rightsGap ? "✗" : "✓"}</span>
        <div class="decision-copy">
          <div class="decision-label">Control may be limited</div>
          <div class="decision-note">You may have limited control over deletion or withdrawal.</div>
        </div>
      </li>
    </ul>
    <div class="decision-callout">${buildRecommendedActionText({ mode, bannerContext: context, sharingRisk, retentionGap, rightsGap })}</div>
  `;
}

function buildRecommendedActionText({ mode, bannerContext, sharingRisk, retentionGap, rightsGap }) {
  const context = bannerContext || { cookieSettingsDetected: false, acceptAllDetected: false };

  if (mode === MODE.BANNER) {
    if (context.cookieSettingsDetected) {
      return "Open Cookie Settings, disable optional categories, and save the narrowest consent profile available before continuing.";
    }
    return "Pause before accepting, look for any preference controls, and avoid blanket consent unless the site offers a narrower choice.";
  }

  if (sharingRisk || retentionGap || rightsGap) {
    return "Review the sharing, retention, and rights clauses before using the site, and avoid unnecessary consent until the defaults are clearer.";
  }

  return "Review the detailed analysis for the exact clauses, then decide whether the site's default controls are acceptable for your use case.";
}

function buildRecommendedActionTextFromRisks(risks) {
  const hasSharingRisk = risks.some((risk) => risk.principle === "Purpose Limitation");
  const hasRetentionGap = risks.some((risk) => risk.principle === "Storage Limitation");
  const hasRightsGap = risks.some((risk) => risk.principle === "User Rights");

  if (hasSharingRisk || hasRetentionGap || hasRightsGap) {
    return "Avoid 'Accept All Cookies'. Use 'Cookie Settings' to disable advertising and analytics cookies.";
  }

  return "Minimal risk detected. You may proceed, but review cookie settings if needed.";
}

function openCookieSettingsOnPage() {
  const elements = document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']");
  const keywords = /(cookie settings|cookie preferences|manage cookies|manage preferences|privacy settings|customi[sz]e|preferences)/i;

  for (const el of elements) {
    const text = [el.innerText, el.textContent, el.getAttribute("aria-label"), el.getAttribute("title"), el.value].filter(Boolean).join(" ");
    if (!keywords.test(text)) continue;
    if (!isVisible(el)) continue;
    el.click();
    return true;
  }

  return false;
}

function closeOverlay() {
  cleanupOverlayDrag();
  document.getElementById(OVERLAY_ID)?.remove();
  overlayInjected = false;
}

function createShadowHost() {
  cleanupOverlayDrag();

  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; left: 20px; top: 20px; right: auto; bottom: auto; max-width: 380px; font-family: sans-serif; cursor: move;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });
  return { host, shadow };
}

function setupOverlayDrag(handleEl) {
  cleanupOverlayDrag();
  if (!handleEl) return;

  const host = document.getElementById(OVERLAY_ID);
  if (!host) return;

  const dragState = { isDragging: false, offsetX: 0, startTop: 0 };

  const onMouseDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const rect = host.getBoundingClientRect();
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";

    dragState.isDragging = true;
    dragState.offsetX = event.clientX - rect.left;
    dragState.startTop = rect.top;
    document.body.style.userSelect = "none";
  };

  const onMouseMove = (event) => {
    if (!dragState.isDragging) return;

    let left = event.clientX - dragState.offsetX;
    let top = dragState.startTop;

    const hostRect = host.getBoundingClientRect();

    const panelHeight = hostRect.height;
    const viewportHeight = window.innerHeight;

    let maxTop = viewportHeight - panelHeight;

    // If panel is taller than viewport, keep it anchored at the top.
    if (panelHeight > viewportHeight) {
      maxTop = 0;
    }

    top = Math.min(Math.max(0, top), maxTop);

    const panelWidth = hostRect.width;
    const viewportWidth = window.innerWidth;
    const maxLeft = Math.max(0, viewportWidth - panelWidth);
    left = Math.min(Math.max(0, left), maxLeft);

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  };

  const onMouseUp = () => {
    dragState.isDragging = false;
    document.body.style.userSelect = "";
  };

  handleEl.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  overlayDragCleanup = () => {
    handleEl.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.userSelect = "";
    dragState.isDragging = false;
  };
}

function cleanupOverlayDrag() {
  if (overlayDragCleanup) {
    overlayDragCleanup();
    overlayDragCleanup = null;
  }
}

function getBaseStyles() {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    .drag-handle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 0 8px;
      margin-bottom: 8px;
      border-bottom: 1px solid #2d2d4e;
      cursor: move;
      user-select: none;
      color: #888;
      font-size: 10px;
      letter-spacing: 0.3px;
    }
    .drag-grip { color: #7c83fd; font-size: 12px; line-height: 1; }
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
    #dpdp-panel {
      max-height: 90vh;
      overflow-y: auto;
    }
    .header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .title { font-size: 14px; font-weight: bold; color: #fff; }
    .btn-row { display: flex; gap: 8px; }
    button { flex: 1; padding: 7px 10px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .btn-details { background: #2d2d4e; color: #e0e0e0; }
    .btn-details:hover { background: #3d3d6e; }
    .btn-primary { background: #f0a531; color: #1a1a2e; }
    .btn-primary:hover { background: #ffc266; }
    .btn-dismiss { background: transparent; color: #8f95b8; border: 1px solid #2d2d4e; opacity: 0.82; }
    .btn-dismiss:hover { background: rgba(255,255,255,0.03); color: #cfd3ea; }
    .consent-label { font-size: 10px; color: #7c83fd; margin-bottom: 6px; letter-spacing: 0.3px; opacity: 0.85; }
    .fallback-notice {
      font-size: 10px;
      color: #ffb347;
      background: rgba(255,179,71,0.08);
      border-radius: 4px;
      padding: 5px 8px;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .panel-section {
      border: 1px solid #262b46;
      border-radius: 12px;
      padding: 12px;
      margin-top: 10px;
      background: rgba(14, 16, 31, 0.68);
    }
    .panel-section.section-highlight {
      border-color: rgba(124, 131, 253, 0.45);
      box-shadow: 0 0 0 1px rgba(124, 131, 253, 0.1), 0 0 18px rgba(124, 131, 253, 0.12);
      background: linear-gradient(180deg, rgba(24, 28, 54, 0.9), rgba(14, 16, 31, 0.9));
    }
    .recommended-action-section {
      border-color: rgba(255, 196, 76, 0.28);
      background: linear-gradient(180deg, rgba(52, 44, 20, 0.32), rgba(20, 18, 12, 0.2));
      box-shadow: inset 0 0 0 1px rgba(255, 196, 76, 0.06);
    }
    .decision-section {
      border-color: rgba(255, 122, 89, 0.28);
      background: linear-gradient(180deg, rgba(46, 26, 24, 0.34), rgba(16, 14, 20, 0.22));
    }
    .recommended-action-box {
      color: #f4e8c2;
      font-size: 12px;
      line-height: 1.45;
      padding: 10px 11px;
      border-radius: 10px;
      border: 1px solid rgba(255, 196, 76, 0.24);
      background: rgba(255, 196, 76, 0.08);
    }
    .section-kicker { font-size: 10px; color: #8f95b8; letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 4px; }
    .section-title { font-size: 14px; color: #fff; font-weight: 700; margin-bottom: 8px; }
    .risk-summary-title { font-size: 11px; color: #9fa8ff; margin-top: 6px; margin-bottom: 4px; font-weight: 700; }
    .risk-summary-body { font-size: 12px; color: #c7c7dd; line-height: 1.45; margin-bottom: 8px; }
    .policy-check-list, .decision-list, .detail-data-list { list-style: none; margin: 0; padding: 0; }
    .policy-check-item, .decision-item, .detail-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 8px 0;
      border-bottom: 1px solid #242844;
    }
    .policy-check-item:last-child, .decision-item:last-child, .detail-row:last-child { border-bottom: none; }
    .check-icon, .decision-icon, .detail-icon {
      width: 18px;
      flex: 0 0 18px;
      text-align: center;
      font-size: 14px;
      line-height: 1.2;
      margin-top: 1px;
    }
    .check-icon.good, .decision-icon.good, .detail-icon.good { color: #4caf50; }
    .check-icon.warn, .decision-icon.warn, .detail-icon.warn { color: #ffb347; }
    .check-icon.bad, .decision-icon.bad, .detail-icon.bad { color: #ff6b6b; }
    .check-copy, .decision-copy, .detail-copy { flex: 1; min-width: 0; }
    .check-label, .decision-label, .detail-label { font-size: 12px; font-weight: 700; color: #f2f3ff; margin-bottom: 2px; }
    .check-note, .decision-note, .detail-note { font-size: 11px; color: #aeb3d4; line-height: 1.45; }
    .decision-lead { font-size: 12px; color: #d8dbf6; line-height: 1.5; margin-bottom: 8px; }
    .decision-callout {
      font-size: 11px;
      color: #d8dbf6;
      line-height: 1.45;
      padding: 8px 10px;
      border-radius: 10px;
      background: rgba(255, 179, 71, 0.08);
      border: 1px solid rgba(255, 179, 71, 0.18);
      margin-top: 8px;
    }
    .detail-grid { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 10px; }
    .detail-card { padding: 10px; border-radius: 10px; background: rgba(13, 15, 28, 0.86); border: 1px solid #242844; }
    .detail-card .detail-label { margin-bottom: 4px; }
    .details-section { display: none; margin-top: 10px; }
    .details-section.open { display: block; }
    .details-section {
      border: 1px solid #242844;
      border-radius: 10px;
      padding: 10px;
      background: rgba(10, 12, 24, 0.62);
      opacity: 0.9;
    }
    .additional-title { font-size: 13px; color: #b8bfeb; margin-bottom: 6px; }
    .detail-stack { display: grid; gap: 6px; margin-bottom: 8px; }
    .detail-inline-row {
      border: 1px solid #242844;
      border-radius: 8px;
      background: rgba(13, 15, 28, 0.8);
      padding: 8px;
    }
    .detail-inline-label { font-size: 11px; color: #8f95b8; margin-bottom: 2px; }
    .detail-inline-value { font-size: 11px; color: #d2d6f3; line-height: 1.35; }
    .policy-link { font-size: 10px; color: #7c83fd; word-break: break-all; margin-top: 4px; }
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
    a { color: #7c83fd; }
  `;
}

function formatArray(value) {
  if (!Array.isArray(value) || value.length === 0) return "Not mentioned";
  return value.join(", ");
}

function extractHeuristicSentence(text, patterns) {
  const sentences = String(text || "").match(/[^.!?]+[.!?]?/g) || [String(text || "")];
  for (const sentence of sentences) {
    if (patterns.some((pattern) => pattern.test(sentence))) return sentence.trim();
  }
  return "";
}

function collectHeuristicMatches(text, items) {
  const matched = [];
  for (const [label, pattern] of items) {
    if (pattern.test(text)) matched.push(label);
  }
  return matched;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function initAgent() {
  setTimeout(runAgent, 1000);
}

window.addEventListener("load", initAgent);

if (document.readyState === "complete") {
  initAgent();
}
