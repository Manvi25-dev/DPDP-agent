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
let modeRecheckObserverActive = false;
let modeRecheckTimer = null;
let overlayDragCleanup = null;

}
          <div class="decision-note">Data may be shared with vendors, partners, or service providers outside the site.</div>
        </div>
      </li>
      <li class="decision-item">
        <span class="decision-icon ${retentionGap ? "bad" : "good"}" aria-hidden="true">${retentionGap ? "✗" : "✓"}</span>
        <div class="decision-copy">
          <div class="decision-label">Unclear retention</div>
          <div class="decision-note">If retention is vague, your data may stay longer than you expect or can easily justify.</div>
        </div>
      </li>
      <li class="decision-item">
        <span class="decision-icon ${rightsGap ? "bad" : "good"}" aria-hidden="true">${rightsGap ? "✗" : "✓"}</span>
        <div class="decision-copy">
          <div class="decision-label">Limited control</div>
          <div class="decision-note">Missing rights language can make withdrawal, erasure, or correction harder to exercise.</div>
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

function closeOverlay() {
  cleanupOverlayDrag();
          ${riskItems}
        </ul>
        <div class="decision-note" style="margin-top:10px;">${mode === MODE.BANNER ? "Banner pages prioritize the decision layer first, while still keeping the analysis visible above." : "Policy pages always show both the analysis and the decision layer."}</div>
      `;
    }

    function buildDecisionInsightBlock({ mode, analysis, risks, bannerContext }) {
      const context = bannerContext || { cookieSettingsDetected: false, acceptAllDetected: false };
      const sharingRisk = risks.some((risk) => risk.principle === "Purpose Limitation") || Boolean((analysis?.third_party_sharing || "").trim());
      const retentionGap = risks.some((risk) => risk.principle === "Storage Limitation");
      const rightsGap = risks.some((risk) => risk.principle === "User Rights");

      if (mode === MODE.BANNER) {
        return `
          <div class="decision-lead">${context.cookieSettingsDetected ? "Cookie controls are visible, so you can narrow consent before proceeding." : "Cookie controls were detected, so this page still has an actionable consent path."}</div>
          <ul class="decision-list" aria-label="Banner decision consequences">
            <li class="decision-item">
              <span class="decision-icon warn" aria-hidden="true">⚠</span>
              <div class="decision-copy">
                <div class="decision-label">Accept All</div>
                <div class="decision-note">Usually enables broader tracking, more third-party sharing, and weaker control over optional cookies.</div>
              </div>
            </li>
            <li class="decision-item">
              <span class="decision-icon good" aria-hidden="true">✓</span>
              <div class="decision-copy">
                <div class="decision-label">Reject All</div>
                <div class="decision-note">Limits optional tracking, but some essential cookies may still be used for the site to function.</div>
              </div>
            </li>
          </ul>
          <div class="decision-callout">${buildRecommendedActionText({ mode, analysis, risks, bannerContext: context, sharingRisk, retentionGap, rightsGap })}</div>
        `;
      }

      return `
        <div class="decision-lead">By using this site, you may be consenting to:</div>
        <ul class="decision-list" aria-label="Policy decision consequences">
          <li class="decision-item">
            <span class="decision-icon ${sharingRisk ? "warn" : "good"}" aria-hidden="true">${sharingRisk ? "⚠" : "✓"}</span>
            <div class="decision-copy">
              <div class="decision-label">Third-party sharing</div>
              <div class="decision-note">Data may be shared with vendors, partners, or service providers outside the site.</div>
            </div>
          </li>
          <li class="decision-item">
            <span class="decision-icon ${retentionGap ? "bad" : "good"}" aria-hidden="true">${retentionGap ? "✗" : "✓"}</span>
            <div class="decision-copy">
              <div class="decision-label">Unclear retention</div>
              <div class="decision-note">If retention is vague, your data may stay longer than you expect or can easily justify.</div>
            </div>
          </li>
          <li class="decision-item">
            <span class="decision-icon ${rightsGap ? "bad" : "good"}" aria-hidden="true">${rightsGap ? "✗" : "✓"}</span>
            <div class="decision-copy">
              <div class="decision-label">Limited control</div>
              <div class="decision-note">Missing rights language can make withdrawal, erasure, or correction harder to exercise.</div>
            </div>
          </li>
        </ul>
        <div class="decision-callout">${buildRecommendedActionText({ mode, analysis, risks, bannerContext: context, sharingRisk, retentionGap, rightsGap })}</div>
      `;
    }

    function buildRecommendedActionText({ mode, analysis, bannerContext, sharingRisk, retentionGap, rightsGap }) {
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

    function closeOverlay() {
      cleanupOverlayDrag();
      document.getElementById(OVERLAY_ID)?.remove();
      overlayInjected = false;
    }

    function setupOverlayDrag(shadow, handleEl) {
      cleanupOverlayDrag();

      if (!handleEl) return;

      const host = document.getElementById(OVERLAY_ID);
      if (!host) return;

      const dragState = {
        isDragging: false,
        offsetX: 0,
        offsetY: 0,
      };

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
        dragState.offsetY = event.clientY - rect.top;
        document.body.style.userSelect = "none";
      };

      const onMouseMove = (event) => {
        if (!dragState.isDragging) return;

        host.style.left = `${event.clientX - dragState.offsetX}px`;
        host.style.top = `${event.clientY - dragState.offsetY}px`;
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
