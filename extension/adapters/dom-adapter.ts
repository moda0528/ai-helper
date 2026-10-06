import { queryFirst, waitForElement } from "../core/dom";
import { createLogger } from "../core/log";
import type { SelectionStrategy, SiteAdapter } from "../core/types";

/** Everything site-specific about finding assistant replies in a chat page. */
export interface DomAdapterConfig {
  siteId: string;
  /** How the Ask button should capture highlights on this site. */
  selectionStrategy?: SelectionStrategy;
  /** Stable markers for an assistant turn, most stable first. */
  assistantSelectors: string[];
  /** Prefer the outer conversation-turn wrapper when selectors match nested nodes too. */
  preferOutermostAssistant?: boolean;
  /** Use the whole assistant turn as the anchor/highlight root instead of its first markdown descendant. */
  useAssistantTurnAsContentRoot?: boolean;
  /** Used only when none of `assistantSelectors` match (UI variants / A/B tests). */
  assistantFallbackSelectors: string[];
  userSelectors: string[];
  /** Rendered body inside a turn; highlight offsets are relative to it. */
  contentSelector: string;
  /** A turn (or its body) matching any of these is still generating. */
  streamingSelectors: string[];
  /** Page-level stop button; only consulted for the newest assistant message. */
  stopButtonSelectors: string[];
  /** Element to observe for new messages. */
  chatRootSelectors: string[];
  conversationIdFromPath(pathname: string): string | null;
  messageIdFor(turn: HTMLElement): string | null;
  /** User and assistant turns in page order, for the conversation excerpt. */
  excerptTurns(): { role: "user" | "assistant"; el: HTMLElement }[];
}

const CHAT_ROOT_TIMEOUT_MS = 10_000;
const MUTATION_QUIET_MS = 500;

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** Matches in document order, dropping any element that contains another match. */
function queryInnermost(selectors: readonly string[]): HTMLElement[] {
  if (selectors.length === 0) return [];
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(selectors.join(", "))
  );
  return all.filter(
    (el) => !all.some((other) => other !== el && el.contains(other))
  );
}

function queryOutermost(selectors: readonly string[]): HTMLElement[] {
  if (selectors.length === 0) return [];
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(selectors.join(", "))
  );
  return all.filter(
    (el) => !all.some((other) => other !== el && other.contains(el))
  );
}

function describeElement(el: Element | null): string {
  if (!el) return "none";
  return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}>`;
}

export function createDomAdapter(config: DomAdapterConfig): SiteAdapter {
  const log = createLogger(`${config.siteId}-adapter`);
  const allAssistantSelector = [
    ...config.assistantSelectors,
    ...config.assistantFallbackSelectors,
  ].join(", ");

  let warnedEmpty = false;
  let warnedEmptyExcerpt = false;
  let lastMatchSummary = "";
  let observedRoot: HTMLElement | null = null;
  let reconcileImpl: () => void = () => {};

  const contentRootOf = (turn: HTMLElement): HTMLElement =>
    config.useAssistantTurnAsContentRoot
      ? turn
      : turn.querySelector<HTMLElement>(config.contentSelector) ?? turn;

  const findAssistantTurns = (): HTMLElement[] => {
    const queryAssistant = config.preferOutermostAssistant ? queryOutermost : queryInnermost;
    const stable = queryAssistant(config.assistantSelectors);
    const turns =
      stable.length > 0
        ? stable
        : queryAssistant(config.assistantFallbackSelectors);

    const summary =
      stable.length > 0
        ? `attribute selectors matched ${stable.length}`
        : `fallback selectors matched ${turns.length}`;
    if (summary !== lastMatchSummary) {
      lastMatchSummary = summary;
      log.debug(`Assistant turns: ${summary}`);
    }
    return turns;
  };

  const adapter: SiteAdapter = {
    siteId: config.siteId,
    selectionStrategy: config.selectionStrategy,

    getConversationId(): string {
      return (
        config.conversationIdFromPath(location.pathname) ??
        `anon-${location.pathname || "root"}`
      );
    },

    getConversationExcerpt(maxChars: number): string {
      const turns = config.excerptTurns();
      if (turns.length === 0) {
        // Empty new chat — expected, stay quiet.
        return "";
      }
      warnedEmptyExcerpt = false;

      const chunks: string[] = [];
      for (const { role, el } of turns) {
        const text = (contentRootOf(el).innerText || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) continue;
        chunks.push(`${role.toUpperCase()}: ${text}`);
      }

      if (chunks.length === 0) {
        if (!warnedEmptyExcerpt) {
          log.warn("Conversation excerpt: turns present but no usable text.");
          warnedEmptyExcerpt = true;
        }
        return "";
      }

      let excerpt = "";
      for (let i = chunks.length - 1; i >= 0; i--) {
        const next = excerpt ? `${chunks[i]}\n\n${excerpt}` : chunks[i];
        if (next.length > maxChars) {
          if (!excerpt) {
            excerpt = chunks[i].slice(-maxChars);
          }
          break;
        }
        excerpt = next;
      }
      return excerpt;
    },

    getMessageContainers(): HTMLElement[] {
      const turns = findAssistantTurns();

      // Only warn when the page clearly has chat content but assistants are missing.
      if (turns.length === 0) {
        if (!warnedEmpty && queryFirst(config.userSelectors)) {
          log.warn(
            `Found user turns but no assistant messages (tried: ${allAssistantSelector}). The site DOM may have changed.`
          );
          warnedEmpty = true;
        }
        return [];
      }
      warnedEmpty = false;

      return Array.from(new Set(turns.map(contentRootOf)));
    },

    getMessageRootForNode(node: Node): HTMLElement | null {
      const el =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node.parentElement;
      const turn = el?.closest<HTMLElement>(allAssistantSelector);
      return turn ? contentRootOf(turn) : null;
    },

    getMessageId(el: HTMLElement): string {
      const turn = el.closest<HTMLElement>(allAssistantSelector) ?? el;
      const fromSite = config.messageIdFor(turn);
      if (fromSite) return fromSite;

      const containers = adapter.getMessageContainers();
      const index = containers.indexOf(el);
      const prefix = (el.innerText || "").slice(0, 80).replace(/\s+/g, " ");
      return `hash-${simpleHash(`${index}:${prefix}`)}`;
    },

    isMessageComplete(el: HTMLElement): boolean {
      for (const sel of config.streamingSelectors) {
        if (el.closest(sel) || el.querySelector(sel)) return false;
      }
      // Only the newest assistant message can still be generating, so a stop
      // button elsewhere on the page must not hold back older messages.
      const containers = adapter.getMessageContainers();
      if (containers[containers.length - 1] !== el) return true;
      return !queryFirst(config.stopButtonSelectors);
    },

    onNewMessage(cb: (el: HTMLElement) => void): () => void {
      const seen = new WeakSet<HTMLElement>();
      let observer: MutationObserver | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let lastHref = location.href;
      let disposed = false;

      const reportExisting = () => {
        for (const el of adapter.getMessageContainers()) {
          if (seen.has(el)) continue;
          seen.add(el);
          cb(el);
        }
      };

      const attach = (root: HTMLElement) => {
        observer?.disconnect();
        observedRoot = root;
        observer = new MutationObserver(() => {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(reportExisting, MUTATION_QUIET_MS);
        });
        observer.observe(root, { childList: true, subtree: true });
        log.debug(`Observing chat root ${describeElement(root)}`);
      };

      reportExisting();

      void waitForElement(config.chatRootSelectors, CHAT_ROOT_TIMEOUT_MS).then(
        (root) => {
          if (disposed) return;
          if (!root) {
            log.warn(
              `Chat container (${config.chatRootSelectors.join(", ")}) not found after ${
                CHAT_ROOT_TIMEOUT_MS / 1000
              }s; observing <body> instead.`
            );
          }
          attach(root ?? document.body);
          reportExisting();
        }
      );

      reconcileImpl = () => {
        if (disposed) return;
        let changed = false;
        if (observedRoot && !observedRoot.isConnected) {
          log.debug("Chat root was replaced by the page; re-attaching observer");
          attach(queryFirst(config.chatRootSelectors) ?? document.body);
          changed = true;
        }
        if (location.href !== lastHref) {
          lastHref = location.href;
          warnedEmpty = false;
          changed = true;
        }
        if (changed) reportExisting();
      };

      return () => {
        disposed = true;
        observer?.disconnect();
        observer = null;
        observedRoot = null;
        if (quietTimer) clearTimeout(quietTimer);
        reconcileImpl = () => {};
      };
    },

    reconcile(): void {
      reconcileImpl();
    },

    describeDom(): Record<string, unknown> {
      const selectorHits: Record<string, number> = {};
      for (const sel of [
        ...config.assistantSelectors,
        ...config.assistantFallbackSelectors,
        ...config.userSelectors,
        ...config.streamingSelectors,
        ...config.stopButtonSelectors,
      ]) {
        selectorHits[sel] = document.querySelectorAll(sel).length;
      }
      const turns = findAssistantTurns();
      return {
        chatRoot: describeElement(queryFirst(config.chatRootSelectors)),
        observedRoot: observedRoot
          ? `${describeElement(observedRoot)} connected=${observedRoot.isConnected}`
          : "none",
        assistantTurns: turns.length,
        turnsWithMarkdownBody: turns.filter(
          (t) => t.querySelector(config.contentSelector) !== null
        ).length,
        selectorHits,
      };
    },
  };

  return adapter;
}
