import {
  applyHighlightsToElement,
  attachSelectionHandler,
  getPlainText,
  type SelectionAnchor,
} from "./anchor";
import { registerDiagnostics } from "./diagnostics";
import { createLogger } from "./log";
import { Sidebar, sendAskFollowUp } from "./sidebar";
import {
  EXTENSION_RELOAD_MSG,
  isExtensionAlive,
  loadThreads,
  migrateThreads,
  removeLegacyKeys,
  saveThreads,
} from "./storage";
import type { SiteAdapter, Thread } from "./types";

const log = createLogger("engine");

const EXCERPT_MAX_CHARS = 4000;
const TICK_MS = 1000;
/** Give up waiting for a streaming message after this long (e.g. a stuck stop button). */
const READY_TIMEOUT_MS = 10 * 60_000;

function createId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Boots the highlight-to-thread engine for a given site adapter:
 * loads persisted threads, attaches selection UI, renders marks, and
 * keeps the Shadow DOM sidebar in sync.
 */
export async function bootEngine(adapter: SiteAdapter): Promise<() => void> {
  let conversationId = adapter.getConversationId();
  let threads: Thread[] = await loadThreads(adapter.siteId, conversationId);
  const messageEls = new Map<string, HTMLElement>();
  /** Messages still streaming; highlights are applied once they complete. */
  const pendingReady = new Map<HTMLElement, { messageId: string; since: number }>();
  let loadToken = 0;
  let dead = false;

  const markDead = (err?: unknown) => {
    if (dead) return;
    dead = true;
    const msg =
      err instanceof Error && /reload this/i.test(err.message)
        ? err.message
        : EXTENSION_RELOAD_MSG;
    log.warn(msg, err instanceof Error ? err.message : err ?? "");
  };

  const persist = async () => {
    if (!isExtensionAlive()) {
      markDead();
      throw new Error(EXTENSION_RELOAD_MSG);
    }
    try {
      await saveThreads(adapter.siteId, conversationId, threads);
    } catch (err) {
      markDead(err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const surroundingContext = (thread: Thread): string => {
    const el = messageEls.get(thread.messageId);
    if (!el) return thread.quotedText;
    const raw = el.dataset.aiHelperRaw || getPlainText(el);
    const pad = 200;
    const start = Math.max(0, thread.anchorStart - pad);
    const end = Math.min(raw.length, thread.anchorEnd + pad);
    return raw.slice(start, end);
  };

  const conversationExcerpt = (): string => {
    if (typeof adapter.getConversationExcerpt === "function") {
      return adapter.getConversationExcerpt(EXCERPT_MAX_CHARS);
    }
    return "";
  };

  const bindMarkClicks = (el: HTMLElement) => {
    el.querySelectorAll<HTMLElement>("mark[data-thread-id]").forEach((mark) => {
      if (mark.dataset.aiHelperBound) return;
      mark.dataset.aiHelperBound = "1";
      mark.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = mark.dataset.threadId;
        if (id) sidebar.focusThread(id);
      });
    });
  };

  const applyToMessage = (el: HTMLElement, messageId: string) => {
    if (!el.dataset.aiHelperRaw) {
      el.dataset.aiHelperRaw = getPlainText(el);
    }
    const forMessage = threads.filter((t) => t.messageId === messageId);
    applyHighlightsToElement(el, forMessage);
    bindMarkClicks(el);
  };

  const refreshHighlights = () => {
    for (const [messageId, el] of messageEls) {
      if (!adapter.isMessageComplete(el)) continue;
      applyToMessage(el, messageId);
    }
  };

  const sidebar = new Sidebar({
    onFocusThread: (threadId) => {
      const mark = document.querySelector(
        `mark[data-thread-id="${CSS.escape(threadId)}"]`
      ) as HTMLElement | null;
      if (mark) {
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
        mark.style.outline = "2px solid #c9a227";
        setTimeout(() => {
          mark.style.outline = "";
        }, 1200);
      }
    },
    onDeleteThread: async (threadId) => {
      if (!isExtensionAlive()) {
        markDead();
        return;
      }
      const next = threads.filter((t) => t.id !== threadId);
      if (next.length === threads.length) return;
      const previous = threads;
      threads = next;
      try {
        await persist();
      } catch (err) {
        threads = previous;
        sidebar.setThreads(threads);
        log.warn(
          "could not delete thread:",
          err instanceof Error ? err.message : err
        );
        return;
      }
      sidebar.setThreads(threads);
      refreshHighlights();
    },
    onSend: async (thread, question, onPartial) => {
      if (!isExtensionAlive()) {
        markDead();
        return { ok: false, error: EXTENSION_RELOAD_MSG };
      }
      const idx = threads.findIndex((t) => t.id === thread.id);
      if (idx < 0) return { ok: false, error: "Thread not found" };

      const current = threads[idx];
      threads[idx] = {
        ...current,
        replies: [
          ...current.replies,
          { role: "user", text: question, ts: Date.now() },
        ],
      };
      try {
        await persist();
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      sidebar.setThreads(threads);
      sidebar.focusThread(thread.id);

      const result = await sendAskFollowUp(
        {
          siteId: adapter.siteId,
          quotedText: current.quotedText,
          surroundingContext: surroundingContext(current),
          conversationExcerpt: conversationExcerpt(),
          question,
          messageId: current.messageId,
          threadId: current.id,
          sideConversationId: current.sideConversationId,
          sideParentMessageId: current.sideParentMessageId,
          sideMeta: current.sideMeta,
          priorTurns: current.replies.map(({ role, text }) => ({ role, text })),
        },
        onPartial
      );

      if (result.ok && result.reply) {
        const i = threads.findIndex((t) => t.id === thread.id);
        if (i >= 0) {
          threads[i] = {
            ...threads[i],
            sideConversationId:
              result.sideConversationId ?? threads[i].sideConversationId,
            sideParentMessageId:
              result.sideParentMessageId ?? threads[i].sideParentMessageId,
            sideMeta: result.sideMeta ?? threads[i].sideMeta,
            replies: [
              ...threads[i].replies,
              { role: "assistant", text: result.reply, ts: Date.now() },
            ],
          };
          try {
            await persist();
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
          sidebar.setThreads(threads);
        }
      }
      return result;
    },
  }, adapter.siteId);

  sidebar.setThreads(threads);

  const registerMessage = (el: HTMLElement) => {
    const messageId = adapter.getMessageId(el);
    messageEls.set(messageId, el);
    if (adapter.isMessageComplete(el)) {
      pendingReady.delete(el);
      applyToMessage(el, messageId);
    } else if (!pendingReady.has(el)) {
      pendingReady.set(el, { messageId, since: Date.now() });
    }
  };

  const processPendingReady = () => {
    const now = Date.now();
    for (const [el, { messageId, since }] of pendingReady) {
      if (!el.isConnected) {
        pendingReady.delete(el);
      } else if (adapter.isMessageComplete(el)) {
        pendingReady.delete(el);
        applyToMessage(el, messageId);
      } else if (now - since > READY_TIMEOUT_MS) {
        pendingReady.delete(el);
        log.warn(
          `Message ${messageId} still looks like it is streaming after ${
            READY_TIMEOUT_MS / 60_000
          } min; skipping highlight restore for it.`
        );
      }
    }
  };

  const onAsk = async (anchor: SelectionAnchor) => {
    if (!isExtensionAlive()) {
      markDead();
      log.warn(EXTENSION_RELOAD_MSG);
      return;
    }
    const messageId = adapter.getMessageId(anchor.messageRoot);
    messageEls.set(messageId, anchor.messageRoot);

    if (!anchor.messageRoot.dataset.aiHelperRaw) {
      anchor.messageRoot.dataset.aiHelperRaw = getPlainText(
        anchor.messageRoot
      );
    }

    const overlapping = threads.some(
      (t) =>
        t.messageId === messageId &&
        !(anchor.end <= t.anchorStart || anchor.start >= t.anchorEnd)
    );
    if (overlapping) {
      log.warn("Selection overlaps an existing highlight; create skipped.");
      return;
    }

    const thread: Thread = {
      id: createId(),
      messageId,
      anchorStart: anchor.start,
      anchorEnd: anchor.end,
      quotedText: anchor.quotedText,
      replies: [],
    };
    threads = [...threads, thread];
    try {
      await persist();
    } catch (err) {
      threads = threads.filter((t) => t.id !== thread.id);
      log.warn(
        "could not save new thread:",
        err instanceof Error ? err.message : err
      );
      return;
    }
    sidebar.setThreads(threads);
    sidebar.focusThread(thread.id);
    refreshHighlights();
  };

  const detachSelection = attachSelectionHandler(
    () => adapter.getMessageContainers(),
    (anchor) => {
      void onAsk(anchor);
    },
    adapter.getMessageRootForNode?.bind(adapter),
    adapter.selectionStrategy ?? "native"
  );

  const stopObserving = adapter.onNewMessage((el) => registerMessage(el));
  void removeLegacyKeys(adapter.siteId);

  const onConversationChange = async (next: string) => {
    log.debug(`Conversation changed: "${conversationId}" -> "${next}"`);
    const previous = conversationId;
    conversationId = next;
    const token = ++loadToken;
    // A brand-new chat starts on "/" and gets its /c/<id> URL mid-reply; carry
    // over highlights made before that, but only for messages still on screen.
    const loaded =
      previous.startsWith("anon-") && !next.startsWith("anon-")
        ? await migrateThreads(
            adapter.siteId,
            previous,
            next,
            new Set(
              adapter.getMessageContainers().map((el) => adapter.getMessageId(el))
            )
          ).catch((err) => {
            log.warn(
              "Could not move new-chat highlights:",
              err instanceof Error ? err.message : err
            );
            return loadThreads(adapter.siteId, next);
          })
        : await loadThreads(adapter.siteId, next);
    if (token !== loadToken || dead) return;
    threads = loaded;
    messageEls.clear();
    pendingReady.clear();
    sidebar.setThreads(threads);
    for (const el of adapter.getMessageContainers()) {
      registerMessage(el);
    }
  };

  // Single watcher for SPA navigation and host re-renders (no History API hooks
  // are available from the isolated world, so a cheap tick is the reliable option).
  const tick = setInterval(() => {
    if (dead || !isExtensionAlive()) {
      markDead();
      clearInterval(tick);
      return;
    }
    adapter.reconcile?.();
    sidebar.ensureMounted();
    const next = adapter.getConversationId();
    if (next !== conversationId) {
      void onConversationChange(next);
    }
    if (pendingReady.size) processPendingReady();
  }, TICK_MS);

  const unregisterDiagnostics = registerDiagnostics({
    adapter,
    getConversationId: () => conversationId,
    getThreadCount: () => threads.length,
    getRegisteredMessageCount: () => messageEls.size,
    getPendingCount: () => pendingReady.size,
    isSidebarMounted: () => sidebar.isMounted(),
    isDead: () => dead,
  });

  log.info(
    `Engine started for site="${adapter.siteId}" conversation="${conversationId}" (${threads.length} threads loaded)`
  );

  return () => {
    detachSelection();
    stopObserving();
    clearInterval(tick);
    unregisterDiagnostics();
    sidebar.dispose();
  };
}
