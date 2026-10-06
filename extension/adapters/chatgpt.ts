import type { SiteAdapter } from "../core/types";
import { createDomAdapter } from "./dom-adapter";

const MODERN_USER_SELECTORS = [
  '[data-content-search-unit-key$=":user"]',
  '[data-chatgpt-search-unit-key$=":user"]',
];

// ChatGPT is currently rolling out a second turn DOM that does not always
// expose data-message-author-role.  In that UI, assistant turns are keyed
// with the matching :assistant search-unit attributes.  Missing these meant
// getMessageContainers() could be empty even while an answer was visibly on
// screen, so the selection handler had no valid root and never showed the
// Ask button.
const MODERN_ASSISTANT_SELECTORS = [
  '[data-content-search-unit-key$=":assistant"]',
  '[data-chatgpt-search-unit-key$=":assistant"]',
];
const ROLE_SELECTOR = [
  "[data-message-author-role]",
  "[data-turn]",
  "[data-turn-role]",
  '[data-content-search-unit-key$=":assistant"]',
  '[data-content-search-unit-key$=":user"]',
  '[data-chatgpt-search-unit-key$=":assistant"]',
  '[data-chatgpt-search-unit-key$=":user"]',
].join(", ");

function roleFor(el: HTMLElement): "user" | "assistant" | null {
  const legacyRole =
    el.getAttribute("data-message-author-role") ||
    el.getAttribute("data-turn") ||
    el.getAttribute("data-turn-role");
  if (legacyRole === "user" || legacyRole === "assistant") {
    return legacyRole;
  }
  const searchKey =
    el.getAttribute("data-content-search-unit-key") ||
    el.getAttribute("data-chatgpt-search-unit-key");
  if (searchKey?.endsWith(":assistant")) return "assistant";
  if (searchKey?.endsWith(":user")) return "user";
  return null;
}

export function createChatGptAdapter(): SiteAdapter {
  return createDomAdapter({
    siteId: "chatgpt",
    // ChatGPT mutates the browser selection when its own selected-text UI
    // appears. Keep the longest *native* range captured during the drag and
    // never reconstruct it from mouse coordinates.
    selectionStrategy: "native-sticky",
    // ChatGPT now nests several assistant markers inside one conversation
    // article.  Anchor against the OUTER turn, not whichever inner markdown
    // block happens to be first, so selections in any part of the answer are
    // recognized and multi-paragraph selections stay inside one root.
    preferOutermostAssistant: true,
    useAssistantTurnAsContentRoot: true,
    // Keep selection roots at the full assistant turn.  Do NOT use
    // [data-markdown-text-style="assistant-message"] here: ChatGPT may apply
    // that attribute to a nested markdown fragment, which makes a multi-line
    // browser selection leave the registered root after the first character.
    assistantSelectors: [
      ...MODERN_ASSISTANT_SELECTORS,
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '[data-message-author="assistant"]',
      'article[data-turn="assistant"]',
      '[data-turn="assistant"]',
      'article[data-turn-role="assistant"]',
      '[data-testid="assistant-message"]',
    ],
    assistantFallbackSelectors: [".agent-turn"],
    userSelectors: [
      ...MODERN_USER_SELECTORS,
      '[data-message-author-role="user"]',
      '[data-turn="user"]',
      'article[data-turn-role="user"]',
    ],
    // Prefer the container that owns the whole rendered markdown reply.
    // The data-markdown marker is only a fallback because on some ChatGPT
    // builds it can be attached to smaller descendants.
    contentSelector:
      '.markdown, .prose, [class*="markdown" i], [class*="prose" i], [data-markdown-text-style="assistant-message"], .whitespace-pre-wrap',
    streamingSelectors: ['[data-is-streaming="true"]', ".result-streaming"],
    // data-testid is language-independent; aria-labels are English-only fallbacks.
    stopButtonSelectors: [
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
    ],
    chatRootSelectors: [
      '[data-thread-find-target="conversation"]',
      "main",
      '[role="main"]',
    ],
    conversationIdFromPath: (pathname) =>
      pathname.match(/\/(c|share)\/([a-zA-Z0-9-]+)/)?.[2] ?? null,
    messageIdFor: (turn) =>
      turn
        .closest("[data-chatgpt-selection-message-id]")
        ?.getAttribute("data-chatgpt-selection-message-id") ||
      turn.getAttribute("data-message-id") ||
      turn.getAttribute("data-turn-id") ||
      turn.getAttribute("data-testid") ||
      turn.id ||
      null,
    excerptTurns: () =>
      Array.from(document.querySelectorAll<HTMLElement>(ROLE_SELECTOR)).flatMap(
        (el) => {
          const role = roleFor(el);
          return role ? [{ role, el }] : [];
        }
      ),
  });
}
