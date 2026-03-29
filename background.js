/**
 * background.js — Service Worker
 * Handles policy fetching, LLM analysis, and session caching.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_POLICY_CHARS = 24000; // ~6000 tokens at ~4 chars/token

// ─── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ANALYZE_POLICY") {
    handleAnalyzePolicy(message.policyUrl, sendResponse);
    return true; // keep channel open for async response
  }
  if (message.type === "GET_API_KEY") {
    chrome.storage.local.get("openrouter_api_key", (result) => {
      sendResponse({ apiKey: result.openrouter_api_key || null });
    });
    return true;
  }
  if (message.type === "SAVE_API_KEY") {
    chrome.storage.local.set({ openrouter_api_key: message.apiKey }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handleAnalyzePolicy(policyUrl, sendResponse) {
  try {
    // 1. Check session cache
    const cached = await getFromCache(policyUrl);
    if (cached) {
      console.log("[DPDP] Cache hit for:", policyUrl);
      sendResponse({ success: true, analysis: cached });
      return;
    }

    // 2. Fetch and parse policy text
    const policyText = await fetchPolicyText(policyUrl);
    if (!policyText) {
      sendResponse({ success: false, error: "Unable to retrieve privacy policy content." });
      return;
    }

    // 3. Get API key (falls back to bundled default)
    const DEFAULT_API_KEY = "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";
    const { openrouter_api_key: storedKey } = await chrome.storage.local.get("openrouter_api_key");
    const apiKey = storedKey || DEFAULT_API_KEY;

    // 4. Call LLM
    const analysis = await analyzePolicyWithLLM(policyText, apiKey);
    if (!analysis) {
      sendResponse({ success: false, error: "LLM analysis failed or returned invalid data." });
      return;
    }

    // 5. Cache result
    await saveToCache(policyUrl, analysis);

    sendResponse({ success: true, analysis });
  } catch (err) {
    console.error("[DPDP] handleAnalyzePolicy error:", err);
    sendResponse({ success: false, error: "An unexpected error occurred during analysis." });
  }
}

// ─── Policy Fetching ─────────────────────────────────────────────────────────

async function fetchPolicyText(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    return extractTextFromHtml(html);
  } catch (err) {
    console.error("[DPDP] fetchPolicyText failed:", err);
    return null;
  }
}

function extractTextFromHtml(html) {
  // NOTE: DOMParser is NOT available in MV3 service workers.
  // Use regex-based stripping instead.

  let text = html
    // Remove script/style/noscript blocks and their content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    // Remove nav/header/footer blocks
    .replace(/<(nav|header|footer|iframe|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Strip all remaining HTML tags
    .replace(/<[^>]+>/g, " ")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Truncate to token budget
  return text.length > MAX_POLICY_CHARS ? text.slice(0, MAX_POLICY_CHARS) + "\n...[truncated]" : text;
}

// ─── LLM Analysis ────────────────────────────────────────────────────────────

async function analyzePolicyWithLLM(policyText, apiKey) {
  const prompt = buildPrompt(policyText);

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "chrome-extension://dpdp-privacy-agent",
        "X-Title": "DPDP Privacy Warning Agent",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini", // cost-effective default; user can change
        messages: [
          {
            role: "system",
            content:
              "You are a legal text analyzer. Extract structured data from privacy policies. Do not give opinions. Do not classify compliance. Return only valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("[DPDP] OpenRouter error:", response.status, errBody);
      return null;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseJsonSafely(content);
  } catch (err) {
    console.error("[DPDP] analyzePolicyWithLLM error:", err);
    return null;
  }
}

function buildPrompt(policyText) {
  return `Analyze the following privacy policy and return ONLY a JSON object with these exact keys:

{
  "data_types_collected": [],
  "collection_purposes": [],
  "retention_periods": "",
  "third_party_sharing": "",
  "consent_mechanism": "",
  "user_rights": []
}

Rules:
- Arrays should contain short string items (max 10 items each).
- Strings should be concise (max 200 chars).
- If information is not found, use empty string "" or empty array [].
- Return ONLY the JSON object. No explanation, no markdown.

Privacy Policy:
<<<
${policyText}
>>>`;
}

function parseJsonSafely(text) {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from surrounding text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ─── Session Cache ────────────────────────────────────────────────────────────
// chrome.storage.session is available Chrome 102+. Fall back to in-memory Map.

const memoryCache = new Map();

async function getFromCache(key) {
  // Try chrome.storage.session first
  if (chrome.storage.session) {
    try {
      const result = await chrome.storage.session.get(key);
      if (result[key]) return result[key];
    } catch {
      // fall through to memory cache
    }
  }
  return memoryCache.get(key) || null;
}

async function saveToCache(key, value) {
  memoryCache.set(key, value);
  if (chrome.storage.session) {
    try {
      await chrome.storage.session.set({ [key]: value });
    } catch (err) {
      console.warn("[DPDP] session storage write failed, using memory cache only:", err);
    }
  }
}
