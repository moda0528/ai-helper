/** A single turn inside a highlight thread. */
export interface Reply {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/** A highlight-anchored follow-up thread, persisted by character offsets. */
export interface Thread {
  id: string;
  messageId: string;
  anchorStart: number;
  anchorEnd: number;
  quotedText: string;
  replies: Reply[];
  /** Hidden (temporary) side conversation used only by this highlight thread. */
  sideConversationId?: string;
  /** Leaf message id in the side conversation (for parent_message_id). */
  sideParentMessageId?: string;
  /** Extra per-site continuation state (e.g. Claude org id, Gemini candidate id). */
  sideMeta?: Record<string, string>;
}

/** How the Ask button captures a highlight on this site. */
export type SelectionStrategy = "native" | "native-sticky" | "pointer";

/** Site-specific hooks so the core engine stays agnostic of host DOM. */
export interface SiteAdapter {
  siteId: string;
  /**
   * `"native-sticky"` keeps the longest native selection captured during a
   * drag. ChatGPT uses it because its own selected-text UI can shorten the
   * browser range immediately after pointer release.
   */
  selectionStrategy?: SelectionStrategy;
  getConversationId(): string;
  getMessageContainers(): HTMLElement[];
  getMessageId(el: HTMLElement): string;
  isMessageComplete(el: HTMLElement): boolean;
  /** Report existing and future message roots. Returns a cleanup function. */
  onNewMessage(cb: (el: HTMLElement) => void): () => void;
  /** Optional: budgeted excerpt of the visible parent chat for follow-ups. */
  getConversationExcerpt?(maxChars: number): string;
  /** Optional: message root containing `node`, for selections outside known roots. */
  getMessageRootForNode?(node: Node): HTMLElement | null;
  /** Optional: re-attach observers after SPA navigation or host DOM replacement. */
  reconcile?(): void;
  /** Optional: selector hit counts etc. for the diagnostics report. */
  describeDom?(): Record<string, unknown>;
}

/** Message sent from the sidebar to the background service worker. */
export interface AskFollowUpRequest {
  type: "ask-follow-up";
  siteId: string;
  quotedText: string;
  surroundingContext: string;
  conversationExcerpt: string;
  question: string;
  messageId: string;
  threadId: string;
  sideConversationId?: string;
  sideParentMessageId?: string;
  sideMeta?: Record<string, string>;
  /** Earlier Q&A in this thread, resent only when the side chat can't be continued. */
  priorTurns?: Pick<Reply, "role" | "text">[];
}

/** Result of a follow-up, from an in-page session client or the service worker. */
export interface AskFollowUpResponse {
  ok: boolean;
  reply?: string;
  error?: string;
  sideConversationId?: string;
  sideParentMessageId?: string;
  sideMeta?: Record<string, string>;
}
