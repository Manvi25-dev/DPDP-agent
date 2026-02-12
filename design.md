# Design Specification

## 1. System Architecture Overview

The DPDP Privacy Warning Agent is a client-side browser extension that operates entirely within the user's browser environment. The system detects consent interfaces on web pages, extracts privacy policy content, sends policy text to an external generative AI API for analysis, maps findings to core DPDP principles, and displays risk warnings to the user.

The architecture consists of five primary components:
- Consent Detection Module
- Policy Extraction Module
- GenAI Analysis Engine
- DPDP Principle Mapping Engine
- UI Rendering Module

All components execute within the browser extension context. No backend server infrastructure is required for the MVP implementation.

## 2. High-Level Data Flow

```
1. User navigates to webpage
2. Consent Detection Module scans DOM for consent interfaces
3. If consent interface detected:
   a. Policy Extraction Module identifies privacy policy links
   b. Policy Extraction Module fetches policy content
   c. GenAI Analysis Engine sends policy text to AI API
   d. GenAI Analysis Engine receives structured analysis response
   e. DPDP Principle Mapping Engine maps analysis to core DPDP principles
   f. DPDP Principle Mapping Engine assigns risk severity levels
   g. UI Rendering Module displays warning overlay
4. User reviews warning and proceeds with consent decision
```

Data flows unidirectionally from detection through analysis to display. No user data is transmitted to external services. Only privacy policy text is sent to the AI API.

## 3. Component Design

### 3.1 Browser Extension Layer

The extension consists of three standard browser extension components:

**Content Script**
- Injected into all web pages
- Executes Consent Detection Module
- Manipulates DOM to inject UI elements
- Communicates with background script via message passing

**Background Script**
- Manages extension lifecycle
- Handles Policy Extraction Module HTTP requests
- Interfaces with GenAI Analysis Engine
- Manages session storage for policy cache
- Operates within browser content security policy constraints

**Popup Interface**
- Provides extension settings UI
- Allows user to enable/disable extension
- Shows extension status and error messages

### 3.2 Consent Detection Module

**Purpose**: Identify consent collection interfaces on web pages

**Implementation**:
- MutationObserver monitors DOM changes for dynamically loaded consent interfaces
- Pattern matching against known consent interface selectors
- Heuristic detection based on element attributes, text content, and positioning
- Maintains detection rule set in JSON configuration file

**Detection Patterns**:
- Cookie banner frameworks (OneTrust, Cookiebot, Osano)
- Modal dialogs containing keywords: "consent", "privacy policy", "accept", "cookies"
- Form elements with privacy policy checkboxes
- Elements with ARIA labels indicating consent collection

**Output**: DOM element reference and consent type classification

**Limitations**:
- Cannot detect consent interfaces rendered in iframes from different origins
- May produce false positives on non-consent modal dialogs
- Detection accuracy depends on pattern rule completeness

### 3.3 Policy Extraction Module

**Purpose**: Retrieve privacy policy content from detected consent interfaces

**Implementation**:
- Link extraction: Searches detected consent interface for anchor tags containing keywords ("privacy policy", "privacy notice", "data protection")
- Content fetching: Background script performs HTTP GET request to policy URL
- Content parsing: Extracts text from HTML using DOM parser, removes navigation and footer elements
- Format handling: Supports HTML and plain text; PDF parsing deferred to future versions

**Caching Strategy**:
- In-session caching using policy URL as key
- Cache storage: Browser session storage API
- Cache cleared on browser restart

**Output**: Plain text privacy policy content and source URL

**Limitations**:
- Cannot access policies behind authentication walls
- May fail on JavaScript-rendered policy content
- Limited to policies accessible via direct HTTP GET
- No support for PDF or image-based policies in MVP
- Session cache only - no persistent storage

### 3.4 GenAI Analysis Engine

**Purpose**: Analyze privacy policy content using generative AI API

**API Integration**:
- Provider: OpenAI GPT-4 or compatible API endpoint
- Authentication: API key stored in browser secure storage
- Request format: JSON with policy text and structured prompt
- Response format: JSON with extracted data points

**Analysis Prompt Structure**:
```
System: You are a privacy policy analyzer. Extract the following information from the provided privacy policy text.

User: Analyze this privacy policy and return JSON with:
- data_types_collected: array of personal data types
- collection_purposes: array of purposes
- retention_periods: string or null
- third_party_sharing: boolean and details
- user_rights: array of rights mentioned
- data_transfer_locations: array of countries/regions
- consent_mechanism: description
```

**Response Processing**:
- JSON parsing with error handling
- Validation of required fields
- Fallback to partial analysis if response incomplete

**Error Handling**:
- API timeout: Display error message to user
- Rate limiting: Display error message, suggest retry
- Invalid response: Log error, display generic warning
- Network failure: Display error message

**Output**: Structured JSON object with extracted policy attributes

**Limitations**:
- Analysis quality depends on AI model capabilities
- API costs scale with policy length and analysis frequency
- No guarantee of legal accuracy
- Cannot verify if policy text matches actual data practices

### 3.5 DPDP Principle Mapping Engine

**Purpose**: Map analyzed policy attributes to core DPDP principles and assign risk levels

**Implementation**:
- Rule-based mapping system using predefined rules in JSON configuration
- Each rule maps policy attribute to DPDP principle
- Risk scoring algorithm assigns severity based on principle alignment

**Mapping Rules**:
```
{
  "rule_id": "consent_mechanism_check",
  "dpdp_principle": "Lawful consent",
  "condition": "consent_mechanism is vague or absent",
  "risk_level": "high",
  "message": "Policy does not clearly describe consent mechanism"
}
```

**Risk Classification Logic**:
- High: Practices that may conflict with DPDP principles
- Medium: Ambiguous language or unclear privacy implications
- Low: Minor clarity issues

**DPDP Principle Reference Data**:
- Stored in separate JSON file for maintainability
- Contains principle names and plain language explanations
- Updated independently from code logic

**Output**: Array of risk objects with severity, DPDP principle reference, and user-facing message

**Limitations**:
- Rule-based system cannot capture all legal nuances
- Does not constitute legal advice or compliance certification
- May produce false positives or miss subtle issues
- Requires manual rule updates as understanding evolves

### 3.6 UI Rendering Module

**Purpose**: Display risk warnings to users in accessible format

**Implementation**:
- Injects overlay div into page DOM adjacent to detected consent interface
- CSS styling ensures visibility without obstructing consent controls
- Renders risk summary with expandable details
- Provides dismiss control

**UI Components**:
- Risk summary card: Shows count of high/medium/low risks
- Risk detail list: Expandable items with DPDP principle references and explanations
- Action buttons: "View Details", "Dismiss"
- Status indicator: Shows analysis in progress or complete

**Accessibility**:
- Semantic HTML with ARIA labels
- Keyboard navigation support
- Sufficient color contrast ratios
- Screen reader compatible

**Styling**:
- Shadow DOM isolation to prevent page CSS conflicts
- Responsive design for various viewport sizes
- Minimal visual footprint to avoid user annoyance

**Output**: Rendered UI overlay visible to user

**Limitations**:
- May conflict with page layouts on complex sites
- Cannot guarantee visibility on all page designs
- Dismiss action does not persist across page reloads

## 4. Technology Stack

**Browser Extension Framework**:
- Manifest V3 specification
- JavaScript ES2020+
- WebExtension APIs (cross-browser compatible subset)

**Content Script**:
- Vanilla JavaScript (no framework dependencies)
- MutationObserver API for DOM monitoring
- Fetch API for HTTP requests (via background script)

**Background Script**:
- Service worker (Manifest V3 requirement)
- IndexedDB or LocalStorage for caching
- Chrome Storage API for settings persistence

**UI Rendering**:
- HTML5 and CSS3
- Shadow DOM for style isolation
- No UI framework (vanilla JS for minimal bundle size)

**External Dependencies**:
- OpenAI API client library (or fetch-based implementation)
- DOMPurify for HTML sanitization (security)

**Development Tools**:
- Node.js for build tooling
- Webpack or Rollup for bundling
- ESLint for code quality
- Jest for unit testing

**Browser Targets**:
- Chrome 88+
- Edge 88+
- Brave (Chromium-based)

## 5. Error Handling

**General Error Strategy**:
- Fail gracefully without blocking user's ability to interact with page
- Display clear error messages to user
- Log errors to console for debugging
- Continue page operation normally on any failure

**Specific Failure Handling**:
- Detection failures: Continue silently, log to console
- Policy extraction failures: Display "Unable to retrieve privacy policy"
- AI API failures: Display "Analysis unavailable, please try again"
- Mapping failures: Display AI analysis without risk classification
- UI rendering failures: Fall back to browser notification

## 6. Limitations

**Technical Limitations**:
- Analysis accuracy depends on AI model capabilities
- Cannot analyze policies not written in English
- Cannot access policies behind authentication or paywalls
- Detection limited to known consent interface patterns
- No support for PDF or image-based policies in MVP
- Session-only caching - no persistent storage

**Legal Limitations**:
- System provides informational analysis only, not legal advice or compliance certification
- Cannot verify if stated policies match actual data practices
- Risk classifications are algorithmic interpretations, not legal determinations
- Does not account for exemptions or special circumstances

**Performance Limitations**:
- AI API latency introduces delay for analysis
- Large privacy policies may exceed API token limits
- API usage incurs costs

**User Experience Limitations**:
- Warning overlay may conflict with page layouts
- Cannot prevent user from proceeding with consent
- Analysis cleared on browser restart

**Security Limitations**:
- API key stored in browser is accessible to user
- Privacy policy content sent to third-party AI service

## 7. Future Scalability

**Potential Enhancements**:
- Backend server for shared policy analysis cache across users
- Multi-language support for non-English policies
- PDF and image-based policy parsing
- Machine learning-based consent interface detection
- Persistent caching with policy change detection
- Firefox and Safari browser support
