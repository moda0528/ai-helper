import type { AskFollowUpRequest, AskFollowUpResponse, Thread } from "./types";
import { formatReplyHtml } from "./text-clean";
import { fetchAccessTokenFromPage } from "./chatgpt-auth";
import { completeViaChatGptSession } from "../background/chatgpt-session";
import { completeViaClaudeSession } from "../background/claude-session";
import { completeViaGeminiSession } from "../background/gemini-session";
import { setHtml } from "./html";
import {
  SIDEBAR_HOST_ID,
  SIDEBAR_KEY_EVENT,
} from "./input-guard";
import { rafThrottle } from "./dom";
import { createLogger } from "./log";

const log = createLogger("sidebar");

export const HOST_ID = SIDEBAR_HOST_ID;
const COMPOSER_MAX_HEIGHT = 160;
const SIDEBAR_DEFAULT_WIDTH = 360;
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 760;
const SIDEBAR_WIDTH_STORAGE_KEY = "ai-helper:sidebar-width";
const PAGE_LAYOUT_STYLE_ID = "ai-helper-page-layout-style";
const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;

export interface SidebarCallbacks {
  onFocusThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void | Promise<void>;
  onSend: (
    thread: Thread,
    question: string,
    onPartial?: (text: string) => void
  ) => Promise<{ ok: boolean; reply?: string; error?: string }>;
}

const STYLES = `
:host {
  all: initial;
  --ai-helper-sidebar-width: ${SIDEBAR_DEFAULT_WIDTH}px;
}
* {
  box-sizing: border-box;
}
.fab {
  position: fixed;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2147483647;
  width: 28px;
  height: 72px;
  padding: 0;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 999px;
  background: #0d0d0d;
  color: #fff;
  font: 600 11px/1 ${FONT_STACK};
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,0.25);
  writing-mode: vertical-rl;
  text-orientation: mixed;
  letter-spacing: 0.04em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: right 0.2s ease;
}
.fab.panel-open {
  right: calc(var(--ai-helper-sidebar-width) + 10px);
}
.panel {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: var(--ai-helper-sidebar-width);
  max-width: calc(100vw - 48px);
  background: #f7f7f5;
  color: #1a1a1a;
  font-family: ${FONT_STACK};
  font-size: 13px;
  line-height: 1.45;
  border-left: 1px solid #d8d8d4;
  box-shadow: -4px 0 24px rgba(0,0,0,0.08);
  display: flex;
  flex-direction: column;
  z-index: 2147483646;
  transform: translateX(0);
  transition: transform 0.2s ease;
  pointer-events: auto;
}
.panel.resizing,
.fab.resizing {
  transition: none;
}
.resize-handle {
  position: absolute;
  top: 0;
  left: -5px;
  width: 10px;
  height: 100%;
  cursor: ew-resize;
  touch-action: none;
  z-index: 3;
}
.resize-handle::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 2px;
  background: transparent;
  transition: background 120ms ease;
}
.resize-handle:hover::after,
.resize-handle.dragging::after {
  background: rgba(26,26,26,0.24);
}
.panel.collapsed {
  transform: translateX(100%);
  box-shadow: none;
  pointer-events: none;
}
.header {
  padding: 14px 16px;
  border-bottom: 1px solid #e4e4e0;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.header span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
.empty {
  color: #777;
  padding: 20px 12px;
  text-align: center;
}
.card {
  background: #fff;
  border: 1px solid #e4e4e0;
  border-radius: 8px;
  margin-bottom: 10px;
}
.card.active {
  border-color: #c9a227;
  box-shadow: 0 0 0 1px #c9a22733;
}
.card-header {
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.card-header-main {
  flex: 1;
  min-width: 0;
}
.menu {
  position: relative;
  flex-shrink: 0;
}
.menu-btn {
  border: none;
  background: transparent;
  color: #888;
  font-size: 18px;
  line-height: 1;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 4px;
  letter-spacing: 0.02em;
}
.menu-btn:hover,
.menu.open .menu-btn {
  background: #eee;
  color: #333;
}
.menu-dropdown {
  display: none;
  position: absolute;
  top: 100%;
  right: 0;
  min-width: 120px;
  padding: 4px;
  background: #fff;
  border: 1px solid #e4e4e0;
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.12);
  z-index: 2;
}
.menu.open .menu-dropdown {
  display: block;
}
.menu-item {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 8px 10px;
  border-radius: 6px;
  font: inherit;
  color: #a33;
  cursor: pointer;
}
.menu-item:hover {
  background: #f5eaea;
}
.reply.streaming .body::after {
  content: "|";
  display: inline-block;
  margin-left: 1px;
  animation: blink 1s step-end infinite;
  color: #888;
}
@keyframes blink {
  50% { opacity: 0; }
}
.quote {
  font-style: italic;
  color: #444;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-body {
  display: none;
  border-top: 1px solid #eee;
  padding: 10px 12px 12px;
}
.card.expanded .card-body {
  display: block;
}
.replies {
  max-height: 220px;
  overflow-y: auto;
  margin-bottom: 10px;
}
.reply {
  padding: 6px 8px;
  border-radius: 6px;
  margin-bottom: 6px;
}
.reply.user {
  background: #eef3ff;
}
.reply.assistant {
  background: #f3f3f0;
}
.reply .role {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #888;
  margin-bottom: 2px;
}
.reply .body {
  white-space: normal;
  word-break: break-word;
}
.reply .body strong {
  font-weight: 600;
}
.reply .body em {
  font-style: italic;
}
.fab:hover {
  background: #2f2f2f;
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.composer textarea {
  flex: 1;
  min-width: 0;
  border: 1px solid #d0d0cc;
  border-radius: 6px;
  padding: 8px 10px;
  font: inherit;
  line-height: 1.4;
  background: #fff;
  color: #111;
  resize: none;
  overflow-y: hidden;
  max-height: ${COMPOSER_MAX_HEIGHT}px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.composer button {
  border: none;
  border-radius: 6px;
  padding: 8px 12px;
  background: #1a1a1a;
  color: #fff;
  font: inherit;
  cursor: pointer;
}
.composer button:disabled {
  opacity: 0.5;
  cursor: default;
}
.status {
  margin-top: 6px;
  font-size: 11px;
  color: #a33;
}
`;

export class Sidebar {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private panel!: HTMLElement;
  private fab!: HTMLButtonElement;
  private listEl!: HTMLElement;
  private threads: Thread[] = [];
  private expanded = new Set<string>();
  /** Unsent composer text per thread, so re-renders don't wipe it. */
  private drafts = new Map<string, string>();
  /** Thread ids currently waiting on a reply. */
  private sending = new Set<string>();
  /** Last send error per thread, cleared on the next successful attempt. */
  private errors = new Map<string, string>();
  /** In-flight streaming text that should survive a full list rebuild. */
  private partials = new Map<string, string>();
  private activeId: string | null = null;
  /** Start collapsed so we don't cover ChatGPT chrome until needed. */
  private collapsed = true;
  private panelWidth = SIDEBAR_DEFAULT_WIDTH;
  private resizeHandle!: HTMLElement;
  private callbacks: SidebarCallbacks;
  /** Tell host apps to recompute responsive layout after panel width changes. */
  private notifyHostResize = rafThrottle(() => {
    window.dispatchEvent(new Event("resize"));
  });

  /** Close the sidebar with Escape when focus is anywhere on the host page. */
  private onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.collapsed) return;
    this.closeAllMenus();
    this.setCollapsed(true);
  };

  constructor(callbacks: SidebarCallbacks, siteId: string) {
    this.callbacks = callbacks;
    document.documentElement.dataset.aiHelperSite = siteId;

    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.body.appendChild(host);
    }
    this.host = host;
    this.shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "beforeinput",
      "input",
      "paste",
      "cut",
      "copy",
      "compositionstart",
      "compositionend",
    ] as const) {
      this.shadow.addEventListener(type, (event) => event.stopPropagation());
    }
    this.installPageLayoutStyle();
    this.renderShell();
    this.loadSavedWidth();
    window.addEventListener("resize", this.onWindowResize);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
  }

  dispose(): void {
    window.removeEventListener("resize", this.onWindowResize);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    document.documentElement.classList.remove(
      "ai-helper-sidebar-open",
      "ai-helper-sidebar-resizing"
    );
    document.documentElement.style.removeProperty(
      "--ai-helper-page-sidebar-width"
    );
    this.notifyHostResize.cancel();
  }

  /** Re-append the host if the page's own rendering removed it from <body>. */
  ensureMounted(): void {
    this.installPageLayoutStyle();
    if (this.host.isConnected) return;
    log.debug("Sidebar host was removed by the page; re-attaching");
    document.body.appendChild(this.host);
  }

  isMounted(): boolean {
    return this.host.isConnected;
  }

  setThreads(threads: Thread[]): void {
    this.threads = threads;
    this.renderList();
  }

  focusThread(threadId: string): void {
    this.expanded.clear();
    this.expanded.add(threadId);
    this.activeId = threadId;
    this.setCollapsed(false);
    this.renderList();
    const card = this.shadow.querySelector(
      `[data-thread-id="${CSS.escape(threadId)}"]`
    ) as HTMLElement | null;
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card?.querySelector("textarea")?.focus({ preventScroll: true });
    this.scrollThreadToBottom(threadId);
  }

  /** Accordion: opening a thread closes the others; clicking the open one closes it. */
  private toggleThread(threadId: string): void {
    const wasOpen = this.expanded.has(threadId);
    this.expanded.clear();
    if (!wasOpen) {
      this.expanded.add(threadId);
      this.activeId = threadId;
      this.callbacks.onFocusThread(threadId);
    }
    this.renderList();
    if (!wasOpen) this.scrollThreadToBottom(threadId);
  }

  /** Update the in-flight assistant bubble without rebuilding the whole list. */
  patchAssistantReply(threadId: string, text: string): void {
    this.partials.set(threadId, text);
    const card = this.shadow.querySelector(
      `[data-thread-id="${CSS.escape(threadId)}"]`
    );
    if (!card) return;
    const replies = card.querySelector(".replies");
    if (!replies) return;

    let live = replies.querySelector(
      ".reply.assistant.streaming"
    ) as HTMLElement | null;
    if (!live) {
      live = document.createElement("div");
      live.className = "reply assistant streaming";
      setHtml(live, `<div class="role">assistant</div><div class="body"></div>`);
      replies.appendChild(live);
    }
    const body = live.querySelector(".body");
    if (body) setHtml(body, formatReplyHtml(text) || "&nbsp;");
    replies.scrollTop = replies.scrollHeight;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.panel.classList.toggle("collapsed", collapsed);
    this.fab.classList.toggle("panel-open", !collapsed);
    this.fab.setAttribute("aria-expanded", collapsed ? "false" : "true");
    this.fab.title = collapsed
      ? "Open highlight threads"
      : "Close highlight threads";
    this.fab.setAttribute(
      "aria-label",
      collapsed ? "Open highlight threads" : "Close highlight threads"
    );
    document.documentElement.classList.toggle(
      "ai-helper-sidebar-open",
      !collapsed
    );
    document.documentElement.style.setProperty(
      "--ai-helper-page-sidebar-width",
      `${this.panelWidth}px`
    );
    this.notifyHostResize();
  }

  private installPageLayoutStyle(): void {
    if (document.getElementById(PAGE_LAYOUT_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PAGE_LAYOUT_STYLE_ID;
    style.textContent = `
      html.ai-helper-sidebar-open body {
        margin-right: var(--ai-helper-page-sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px) !important;
        transition: margin-right 180ms ease;
      }

      /*
       * ChatGPT currently keeps its app shell viewport-sized, so shrinking
       * <body> does not reliably affect the conversation.  Reserve the
       * sidebar width *inside main* instead.  This changes the actual layout
       * width seen by ChatGPT's responsive thread/composer containers and
       * updates continuously while the resize handle is dragged.
       */
      html[data-ai-helper-site="chatgpt"].ai-helper-sidebar-open body {
        margin-right: 0 !important;
        width: 100% !important;
        max-width: none !important;
        overflow-x: clip !important;
      }
      html[data-ai-helper-site="chatgpt"].ai-helper-sidebar-open main {
        box-sizing: border-box !important;
        min-width: 0 !important;
        width: calc(100% - var(--ai-helper-page-sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px)) !important;
        max-width: calc(100% - var(--ai-helper-page-sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px)) !important;
        flex: 0 1 calc(100% - var(--ai-helper-page-sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px)) !important;
        padding-right: 0 !important;
        margin-right: var(--ai-helper-page-sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px) !important;
        transition: width 180ms ease, max-width 180ms ease, margin-right 180ms ease !important;
      }
      /* The composer can be positioned independently of the scrolling thread
         on some ChatGPT builds; keep its usable right edge with main. */
      html[data-ai-helper-site="chatgpt"].ai-helper-sidebar-open #thread-bottom-container {
        box-sizing: border-box !important;
        width: auto !important;
        max-width: calc(100vw - var(--ai-helper-page-sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px)) !important;
        right: var(--ai-helper-page-sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px) !important;
      }

      html.ai-helper-sidebar-resizing body,
      html[data-ai-helper-site="chatgpt"].ai-helper-sidebar-resizing main {
        transition: none !important;
      }
    `;
    (document.head ?? document.documentElement).appendChild(style);
  }

  private clampPanelWidth(width: number): number {
    const viewportMax = Math.max(180, window.innerWidth - 48);
    const viewportMin = Math.min(SIDEBAR_MIN_WIDTH, viewportMax);
    return Math.round(
      Math.min(
        Math.min(SIDEBAR_MAX_WIDTH, viewportMax),
        Math.max(viewportMin, width)
      )
    );
  }

  private setPanelWidth(width: number): void {
    this.panelWidth = this.clampPanelWidth(width);
    this.host.style.setProperty(
      "--ai-helper-sidebar-width",
      `${this.panelWidth}px`
    );
    document.documentElement.style.setProperty(
      "--ai-helper-page-sidebar-width",
      `${this.panelWidth}px`
    );
    if (!this.collapsed) this.notifyHostResize();
  }

  private loadSavedWidth(): void {
    try {
      chrome.storage.local.get(SIDEBAR_WIDTH_STORAGE_KEY, (result) => {
        if (chrome.runtime.lastError) return;
        const saved = result?.[SIDEBAR_WIDTH_STORAGE_KEY];
        if (typeof saved === "number" && Number.isFinite(saved)) {
          this.setPanelWidth(saved);
        }
      });
    } catch {
      // If the extension context was reloaded, keep the default width.
    }
  }

  private saveWidth(): void {
    try {
      chrome.storage.local.set({
        [SIDEBAR_WIDTH_STORAGE_KEY]: this.panelWidth,
      });
    } catch {
      // Width persistence is non-critical.
    }
  }

  private onWindowResize = (): void => {
    this.setPanelWidth(this.panelWidth);
  };

  private scrollThreadToBottom(threadId: string): void {
    requestAnimationFrame(() => {
      const replies = this.shadow.querySelector(
        `[data-thread-id="${CSS.escape(threadId)}"] .replies`
      ) as HTMLElement | null;
      if (replies) replies.scrollTop = replies.scrollHeight;
    });
  }

  private closeAllMenus(): void {
    this.shadow
      .querySelectorAll(".menu.open")
      .forEach((el) => el.classList.remove("open"));
  }

  private renderShell(): void {
    this.shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadow.appendChild(style);

    this.fab = document.createElement("button");
    this.fab.type = "button";
    this.fab.className = "fab";
    this.fab.title = "Open highlight threads";
    this.fab.setAttribute("aria-label", "Open highlight threads");
    this.fab.setAttribute("aria-expanded", "false");
    this.fab.textContent = "Threads";
    this.fab.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    this.shadow.appendChild(this.fab);

    this.panel = document.createElement("div");
    this.panel.className = "panel collapsed";
    setHtml(
      this.panel,
      `
      <div class="header">
        <span>Highlight threads</span>
      </div>
      <div class="list"></div>
    `
    );
    this.shadow.appendChild(this.panel);
    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "resize-handle";
    this.resizeHandle.title = "Drag to resize sidebar";
    this.resizeHandle.setAttribute("aria-hidden", "true");
    this.panel.prepend(this.resizeHandle);
    this.installResizeHandling();
    this.listEl = this.panel.querySelector(".list") as HTMLElement;

    this.shadow.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (!target?.closest(".menu")) this.closeAllMenus();
    });
  }

  private installResizeHandling(): void {
    let pointerId: number | null = null;

    const finish = () => {
      if (pointerId == null) return;
      const id = pointerId;
      pointerId = null;
      try {
        if (this.resizeHandle.hasPointerCapture(id)) {
          this.resizeHandle.releasePointerCapture(id);
        }
      } catch {
        // Capture may already have been released by the browser.
      }
      this.resizeHandle.classList.remove("dragging");
      this.panel.classList.remove("resizing");
      this.fab.classList.remove("resizing");
      document.documentElement.classList.remove("ai-helper-sidebar-resizing");
      this.saveWidth();
    };

    this.resizeHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.collapsed) return;
      event.preventDefault();
      event.stopPropagation();
      pointerId = event.pointerId;
      this.resizeHandle.setPointerCapture(pointerId);
      this.resizeHandle.classList.add("dragging");
      this.panel.classList.add("resizing");
      this.fab.classList.add("resizing");
      document.documentElement.classList.add("ai-helper-sidebar-resizing");
    });

    this.resizeHandle.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) return;
      event.preventDefault();
      this.setPanelWidth(window.innerWidth - event.clientX);
    });

    this.resizeHandle.addEventListener("pointerup", finish);
    this.resizeHandle.addEventListener("pointercancel", finish);
    this.resizeHandle.addEventListener("lostpointercapture", () => {
      if (pointerId != null) finish();
    });
  }

  private renderList(): void {
    const focused = this.shadow.activeElement;
    const focusState =
      focused instanceof HTMLTextAreaElement
        ? {
            id: focused.closest("[data-thread-id]")?.getAttribute("data-thread-id") ?? undefined,
            start: focused.selectionStart,
            end: focused.selectionEnd,
          }
        : null;
    if (this.threads.length === 0) {
      setHtml(
        this.listEl,
        `<div class="empty">Highlight text in a reply and click “Ask about this” to start a thread.</div>`
      );
      return;
    }

    this.listEl.replaceChildren();
    for (const thread of this.threads) {
      this.listEl.appendChild(this.buildCard(thread));
    }
    for (const [id, text] of this.partials) this.patchAssistantReply(id, text);
    if (focusState?.id) {
      const input = this.listEl.querySelector(
        `[data-thread-id="${CSS.escape(focusState.id)}"] textarea`
      ) as HTMLTextAreaElement | null;
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(focusState.start, focusState.end);
    }
    if (this.activeId && this.expanded.has(this.activeId)) {
      this.scrollThreadToBottom(this.activeId);
    }
  }

  private buildCard(thread: Thread): HTMLElement {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.threadId = thread.id;
    if (this.expanded.has(thread.id)) card.classList.add("expanded");
    if (this.activeId === thread.id) card.classList.add("active");

    const header = document.createElement("div");
    header.className = "card-header";

    const main = document.createElement("div");
    main.className = "card-header-main";
    setHtml(
      main,
      `
      <div class="quote">${escapeHtml(thread.quotedText)}</div>
    `
    );
    main.addEventListener("click", () => this.toggleThread(thread.id));

    const menu = document.createElement("div");
    menu.className = "menu";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "menu-btn";
    menuBtn.title = "Thread options";
    menuBtn.setAttribute("aria-label", "Thread options");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.textContent = "⋯";
    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = menu.classList.contains("open");
      this.closeAllMenus();
      if (!wasOpen) {
        menu.classList.add("open");
        menuBtn.setAttribute("aria-expanded", "true");
      }
    });

    const dropdown = document.createElement("div");
    dropdown.className = "menu-dropdown";
    dropdown.setAttribute("role", "menu");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "menu-item";
    deleteBtn.setAttribute("role", "menuitem");
    deleteBtn.textContent = "Remove thread & highlight";
    deleteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closeAllMenus();
      this.expanded.delete(thread.id);
      this.drafts.delete(thread.id);
      this.errors.delete(thread.id);
      this.partials.delete(thread.id);
      this.sending.delete(thread.id);
      if (this.activeId === thread.id) this.activeId = null;
      void this.callbacks.onDeleteThread(thread.id);
    });
    dropdown.appendChild(deleteBtn);
    menu.appendChild(menuBtn);
    menu.appendChild(dropdown);

    header.appendChild(main);
    header.appendChild(menu);
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "card-body";

    const replies = document.createElement("div");
    replies.className = "replies";
    for (const r of thread.replies) {
      const div = document.createElement("div");
      div.className = `reply ${r.role}`;
      setHtml(
        div,
        `<div class="role">${r.role}</div><div class="body">${
          r.role === "assistant" ? formatReplyHtml(r.text) : escapeHtml(r.text)
        }</div>`
      );
      replies.appendChild(div);
    }
    body.appendChild(replies);

    const composer = document.createElement("div");
    composer.className = "composer";
    const input = document.createElement("textarea");
    input.rows = 1;
    input.placeholder = "Ask about this snippet…";
    input.setAttribute("aria-label", "Ask about this snippet");
    input.readOnly = this.sending.has(thread.id);
    input.value = this.drafts.get(thread.id) ?? "";
    const autoGrow = () => {
      input.style.overflowY = "hidden";
      input.style.height = "auto";
      const borders = input.offsetHeight - input.clientHeight;
      const wanted = input.scrollHeight + borders;
      input.style.height = `${Math.min(wanted, COMPOSER_MAX_HEIGHT)}px`;
      if (wanted > COMPOSER_MAX_HEIGHT) input.style.overflowY = "auto";
    };
    input.addEventListener("input", () => {
      this.drafts.set(thread.id, input.value);
      autoGrow();
    });
    if (input.value) requestAnimationFrame(autoGrow);
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "Send";
    send.disabled = this.sending.has(thread.id);
    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = this.sending.has(thread.id)
      ? "Waiting for a reply…"
      : this.errors.get(thread.id) ?? "";

    const doSend = async () => {
      const question = input.value.trim();
      if (!question || this.sending.has(thread.id)) return;

      // Clear immediately on Enter/click so the composer never looks frozen.
      input.value = "";
      this.drafts.delete(thread.id);
      autoGrow();
      this.sending.add(thread.id);
      this.errors.delete(thread.id);
      this.renderList();
      this.scrollThreadToBottom(thread.id);
      const patch = rafThrottle((partial: string) =>
        this.patchAssistantReply(thread.id, partial)
      );
      try {
        const result = await this.callbacks.onSend(thread, question, patch);
        if (!result.ok) {
          this.errors.set(thread.id, result.error || "Request failed");
          // Restore the draft so a failed send isn't lost.
          this.drafts.set(thread.id, question);
        }
      } catch (err) {
        this.errors.set(
          thread.id,
          err instanceof Error ? err.message : String(err)
        );
        this.drafts.set(thread.id, question);
      } finally {
        patch.cancel();
        this.sending.delete(thread.id);
        this.partials.delete(thread.id);
        this.renderList();
      }
    };

    send.addEventListener("click", () => void doSend());
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeAllMenus();
        this.setCollapsed(true);
        return;
      }
      // Shift+Enter inserts a newline; Enter during IME composition confirms text.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void doSend();
      }
    };
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener(SIDEBAR_KEY_EVENT, (event) => {
      onKeyDown((event as CustomEvent<KeyboardEvent>).detail);
    });

    composer.appendChild(input);
    composer.appendChild(send);
    body.appendChild(composer);
    body.appendChild(status);
    card.appendChild(body);
    return card;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type SessionCompleter = (
  req: AskFollowUpRequest,
  onPartial?: (text: string) => void
) => Promise<AskFollowUpResponse>;

/** Sites whose follow-ups run in-page through the user's logged-in session. */
const SESSION_COMPLETERS: Record<string, SessionCompleter> = {
  chatgpt: async (req, onPartial) =>
    completeViaChatGptSession(await fetchAccessTokenFromPage(), req, onPartial),
  claude: completeViaClaudeSession,
  gemini: completeViaGeminiSession,
};

/**
 * Ask a follow-up about a highlight.
 *
 * Session-backed sites run entirely in the content script (no CS↔SW↔CS nested
 * messaging): that pattern closes the message channel before long streams
 * finish, and page cookies are only same-origin from here.
 */
export async function sendAskFollowUp(
  payload: Omit<AskFollowUpRequest, "type">,
  onPartial?: (text: string) => void
): Promise<AskFollowUpResponse> {
  const message: AskFollowUpRequest = { type: "ask-follow-up", ...payload };

  const complete = SESSION_COMPLETERS[payload.siteId];
  if (complete) {
    try {
      log.debug(`Completing ${payload.siteId} follow-up in page`);
      return await complete(message, onPartial);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error("Follow-up failed:", error);
      return { ok: false, error };
    }
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: AskFollowUpResponse) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message,
        });
        return;
      }
      resolve(response ?? { ok: false, error: "Empty response" });
    });
  });
}
