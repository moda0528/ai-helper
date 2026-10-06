import { rafThrottle } from "./dom";
import { createLogger } from "./log";
import type { Thread } from "./types";

const log = createLogger("anchor");

// ─── Text-offset helpers ────────────────────────────────────────────────

/**
 * Convert a DOM position (node + offset) into a plain-text character offset
 * relative to `root`, by walking text nodes with a TreeWalker.
 */
export function getTextOffset(
  root: Node,
  node: Node,
  offset: number
): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current: Node | null = walker.nextNode();

  while (current) {
    if (current === node) {
      return total + offset;
    }
    total += (current.textContent ?? "").length;
    current = walker.nextNode();
  }

  if (root.contains(node)) {
    try {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.setEnd(node, offset);
      return range.toString().length;
    } catch {
      return total;
    }
  }

  return -1;
}

/** Extract the concatenated plain text of all text nodes under `root`. */
export function getPlainText(root: Node): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  let current: Node | null = walker.nextNode();
  while (current) {
    text += current.textContent ?? "";
    current = walker.nextNode();
  }
  return text;
}

/**
 * Overlaps are rejected (later starts that collide with a kept interval
 * are skipped). TODO: split/merge overlapping highlights cleanly.
 */
function filterNonOverlapping(
  threads: Pick<Thread, "id" | "anchorStart" | "anchorEnd">[],
  textLen: number
): Pick<Thread, "id" | "anchorStart" | "anchorEnd">[] {
  const sorted = [...threads].sort((a, b) => a.anchorStart - b.anchorStart);
  const kept: typeof sorted = [];
  let lastEnd = -1;

  for (const t of sorted) {
    if (
      t.anchorStart < 0 ||
      t.anchorEnd > textLen ||
      t.anchorStart >= t.anchorEnd
    ) {
      continue;
    }
    if (t.anchorStart < lastEnd) {
      log.warn(
        "Skipping overlapping highlight",
        t.id,
        `(${t.anchorStart}-${t.anchorEnd} overlaps prior end ${lastEnd})`
      );
      continue;
    }
    kept.push(t);
    lastEnd = t.anchorEnd;
  }
  return kept;
}

// ─── Rect helpers ───────────────────────────────────────────────────────

/** True when a DOMRect has positive dimensions and a finite top. */
function usableRect(rect: DOMRect): boolean {
  return (rect.width > 0 || rect.height > 0) && Number.isFinite(rect.top);
}

/** Get a usable bounding rect for a Range, falling back to client rects. */
function rangeRect(range: Range): DOMRect {
  let rect = range.getBoundingClientRect();
  if (!usableRect(rect)) {
    const rects = range.getClientRects();
    if (rects.length > 0) rect = rects[0]!;
  }
  return rect;
}

/** Walk client rects back-to-front and return the last usable one. */
function rangePlacementRect(range: Range): DOMRect {
  const rects = range.getClientRects();
  for (let i = rects.length - 1; i >= 0; i--) {
    const rect = rects[i]!;
    if (usableRect(rect)) return rect;
  }
  return rangeRect(range);
}

/** A caret-like rect at the visual end of the range's final line. */
function rangeEndPlacementRect(range: Range): DOMRect {
  const rects = range.getClientRects();
  for (let i = rects.length - 1; i >= 0; i--) {
    const rect = rects[i]!;
    if (!usableRect(rect)) continue;
    return new DOMRect(rect.right, rect.top, 1, Math.max(1, rect.height));
  }
  const rect = rangeRect(range);
  return new DOMRect(rect.right, rect.top, 1, Math.max(1, rect.height));
}

/** Placement rect for a selection, preferring the focus/caret end. */
function selectionPlacementRect(sel: Selection, range: Range): DOMRect {
  if (sel.focusNode) {
    try {
      const caret = document.createRange();
      caret.setStart(sel.focusNode, sel.focusOffset);
      caret.collapse(true);
      const caretRect = caret.getBoundingClientRect();
      if (usableRect(caretRect)) return caretRect;
    } catch {
      // Fall through to range-based logic.
    }
  }
  const rects = range.getClientRects();
  if (rects.length > 0) {
    const focusIsStart =
      sel.focusNode === range.startContainer &&
      sel.focusOffset === range.startOffset;
    const rect = focusIsStart ? rects[0]! : rects[rects.length - 1]!;
    if (usableRect(rect)) return rect;
  }
  return rangeRect(range);
}

// ─── Whitespace normalisation ───────────────────────────────────────────

interface WhitespaceMap {
  text: string;
  starts: number[];
  ends: number[];
}

/**
 * Collapse runs of whitespace to a single space, keeping parallel
 * arrays that map each normalised character back to the original range.
 */
function normalizeWhitespaceWithMap(text: string): WhitespaceMap {
  let out = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    if (/\s/.test(text[i]!)) {
      const start = i;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      out += " ";
      starts.push(start);
      ends.push(i);
    } else {
      out += text[i];
      starts.push(i);
      ends.push(i + 1);
      i++;
    }
  }
  return { text: out, starts, ends };
}

// ─── Selection anchor types & core logic ────────────────────────────────

export interface SelectionAnchor {
  messageRoot: HTMLElement;
  start: number;
  end: number;
  quotedText: string;
  rect: DOMRect;
  placementRect?: DOMRect;
}

/** Site hook: message root containing a node, when it isn't in the known roots. */
export type RootForNode = (node: Node) => HTMLElement | null;

/**
 * Try to recover a selection anchor by fuzzy-matching `quotedText` across
 * all message roots (whitespace-normalised).  Picks the candidate whose
 * bounding rect is closest to `selectionRect`.
 */
function recoverSelectionAnchor(
  messageRoots: HTMLElement[],
  quotedText: string,
  selectionRect: DOMRect
): SelectionAnchor | null {
  const wanted = normalizeWhitespaceWithMap(quotedText).text.trim();
  if (!wanted) return null;

  const sx = selectionRect.left + selectionRect.width / 2;
  const sy = selectionRect.top + selectionRect.height / 2;

  let best: { anchor: SelectionAnchor; score: number } | null = null;

  for (const root of messageRoots) {
    const raw = getPlainText(root);
    if (!raw) continue;

    const mapped = normalizeWhitespaceWithMap(raw);
    let from = 0;

    while (from <= mapped.text.length - wanted.length) {
      const at = mapped.text.indexOf(wanted, from);
      if (at < 0) break;

      const last = at + wanted.length - 1;
      const start = mapped.starts[at];
      const end = mapped.ends[last];

      if (start == null || end == null || start >= end) {
        from = at + 1;
        continue;
      }

      const candidateRange = rangeFromOffsets(root, start, end);
      const candidateRect = candidateRange?.getBoundingClientRect();
      const rect =
        candidateRect && usableRect(candidateRect)
          ? candidateRect
          : root.getBoundingClientRect();

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const rootRect = root.getBoundingClientRect();
      const overlapsRoot =
        usableRect(selectionRect) &&
        selectionRect.right >= rootRect.left &&
        selectionRect.left <= rootRect.right &&
        selectionRect.bottom >= rootRect.top &&
        selectionRect.top <= rootRect.bottom;

      const score = Math.hypot(cx - sx, cy - sy) + (overlapsRoot ? 0 : 1e4);
      const anchor: SelectionAnchor = {
        messageRoot: root,
        start,
        end,
        quotedText,
        rect,
        placementRect: candidateRange
          ? rangePlacementRect(candidateRange)
          : rect,
      };

      if (!best || score < best.score) best = { anchor, score };
      from = at + 1;
    }
  }

  return best?.anchor ?? null;
}

/**
 * If the current window selection lies entirely inside one of the given
 * message roots, return its character offsets and bounding rect.
 * Falls back to `findRootForNode` when the host wraps the selection in a node
 * outside the registered roots, and to `recoverSelectionAnchor` when offsets
 * can't be resolved.
 */
export function getSelectionAnchor(
  messageRoots: HTMLElement[],
  findRootForNode?: RootForNode
): SelectionAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }

  const range = sel.getRangeAt(0);
  const { startContainer, endContainer } = range;
  const startOffset = range.startOffset;
  const endOffset = range.endOffset;

  const quotedText = range.toString();
  if (!quotedText.trim()) return null;

  const rect = rangeRect(range);
  const placementRect = selectionPlacementRect(sel, range);

  let messageRoot =
    messageRoots.find(
      (root) =>
        root.contains(startContainer) && root.contains(endContainer)
    ) ?? null;

  if (!messageRoot) {
    messageRoot = findRootForNode?.(startContainer) ?? null;
    if (
      !messageRoot ||
      !messageRoot.contains(startContainer) ||
      !messageRoot.contains(endContainer)
    ) {
      return recoverSelectionAnchor(messageRoots, quotedText, rect);
    }
  }

  const start = getTextOffset(messageRoot, startContainer, startOffset);
  const end = getTextOffset(messageRoot, endContainer, endOffset);
  if (start < 0 || end < 0 || start >= end) {
    return recoverSelectionAnchor(messageRoots, quotedText, rect);
  }

  return { messageRoot, start, end, quotedText, rect, placementRect };
}

/** Recompute a viewport rect for a previously captured selection anchor. */
export function getAnchorRect(anchor: SelectionAnchor): DOMRect | null {
  if (!anchor.messageRoot.isConnected) return null;
  const range = rangeFromOffsets(anchor.messageRoot, anchor.start, anchor.end);
  return range ? rangeRect(range) : null;
}

/** Recompute a placement rect for a previously captured selection anchor. */
export function getAnchorPlacementRect(
  anchor: SelectionAnchor
): DOMRect | null {
  if (!anchor.messageRoot.isConnected) return null;
  const range = rangeFromOffsets(anchor.messageRoot, anchor.start, anchor.end);
  return range ? rangePlacementRect(range) : null;
}

function rangeFromOffsets(
  root: HTMLElement,
  start: number,
  end: number
): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;

  let current: Node | null = walker.nextNode();
  while (current) {
    const node = current as Text;
    const len = node.data.length;
    const nodeStart = offset;
    const nodeEnd = offset + len;

    if (!startNode && start >= nodeStart && start <= nodeEnd) {
      startNode = node;
      startOff = start - nodeStart;
    }
    if (!endNode && end >= nodeStart && end <= nodeEnd) {
      endNode = node;
      endOff = end - nodeStart;
      break;
    }
    offset = nodeEnd;
    current = walker.nextNode();
  }

  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    return range;
  } catch {
    return null;
  }
}

// ─── Pointer selection strategy ─────────────────────────────────────────

interface CaretPoint {
  node: Node;
  offset: number;
}

interface PointerSelectionStart extends CaretPoint {
  messageRoot: HTMLElement;
}

/** Number of characters spanned by an anchor. */
function selectionSpan(anchor: SelectionAnchor): number {
  return Math.max(0, anchor.end - anchor.start);
}

/**
 * ChatGPT occasionally replaces a just-finished selection with a tiny portal
 * fragment (observed as "et"). Keep a much better drag snapshot instead of
 * accepting that host-generated truncation.
 */
function chooseReleasedAnchor(
  current: SelectionAnchor | null,
  bestDrag: SelectionAnchor | null,
  preferLongest = false
): SelectionAnchor | null {
  if (!current) return bestDrag;
  if (!bestDrag || current.messageRoot !== bestDrag.messageRoot) return current;
  const currentSpan = selectionSpan(current);
  const bestSpan = selectionSpan(bestDrag);
  // ChatGPT can shorten the browser range by only a word or punctuation, not
  // necessarily by 50%+. For the sticky-native strategy the drag snapshot is
  // authoritative whenever it contains more of what the user selected.
  if (preferLongest && bestSpan > currentSpan) return bestDrag;
  const hostTruncatedSelection =
    bestSpan >= 8 && currentSpan < bestSpan && currentSpan <= bestSpan * 0.5;
  return hostTruncatedSelection ? bestDrag : current;
}

/**
 * Chrome exposes `caretRangeFromPoint`; `caretPositionFromPoint` is the
 * standards path.
 */
function caretPointFromClient(x: number, y: number): CaretPoint | null {
  const doc = document as Document & {
    caretPositionFromPoint?(
      x: number,
      y: number
    ): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };

  try {
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (pos?.offsetNode) {
      return { node: pos.offsetNode, offset: pos.offset };
    }
  } catch {
    // Fall through to Chrome's legacy API.
  }

  try {
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  } catch {
    // A host overlay may briefly make a point non-resolvable.
  }

  return null;
}

/** Find the message root that contains `node`. */
function messageRootForNode(
  messageRoots: HTMLElement[],
  node: Node,
  findRootForNode?: RootForNode
): HTMLElement | null {
  return (
    messageRoots.find((root) => root.contains(node)) ??
    findRootForNode?.(node) ??
    null
  );
}

/** Compare two caret points by document order. */
function compareCaretPoints(a: CaretPoint, b: CaretPoint): number {
  const ar = document.createRange();
  const br = document.createRange();
  try {
    ar.setStart(a.node, a.offset);
    ar.collapse(true);
    br.setStart(b.node, b.offset);
    br.collapse(true);
    return ar.compareBoundaryPoints(Range.START_TO_START, br);
  } catch {
    return 0;
  }
}

/** Build a Range spanning two arbitrary caret points (auto-ordered). */
function rangeBetweenCarets(a: CaretPoint, b: CaretPoint): Range | null {
  const range = document.createRange();
  try {
    if (compareCaretPoints(a, b) <= 0) {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } else {
      range.setStart(b.node, b.offset);
      range.setEnd(a.node, a.offset);
    }
    return range;
  } catch {
    return null;
  }
}

/**
 * Build an anchor from pointer coordinates without consulting
 * `window.getSelection()`.  This is intentionally used by ChatGPT only:
 * its selected-text overlay can replace the browser selection with a tiny
 * fragment even while the user's drag is intact.
 *
 * Placement still uses the selection range (like Claude/Gemini), not the
 * live cursor point — otherwise the Ask button follows the mouse.
 */
function getPointerSelectionAnchor(
  start: PointerSelectionStart,
  x: number,
  y: number,
  messageRoots: HTMLElement[],
  findRootForNode?: RootForNode
): SelectionAnchor | null {
  const endPoint = caretPointFromClient(x, y);
  if (!endPoint) return null;

  const endRoot = messageRootForNode(
    messageRoots,
    endPoint.node,
    findRootForNode
  );
  if (!endRoot || endRoot !== start.messageRoot) return null;

  const range = rangeBetweenCarets(start, endPoint);
  if (!range || range.collapsed) return null;

  const quotedText = range.toString();
  if (!quotedText.trim()) return null;

  const startOff = getTextOffset(
    start.messageRoot,
    range.startContainer,
    range.startOffset
  );
  const endOff = getTextOffset(
    start.messageRoot,
    range.endContainer,
    range.endOffset
  );
  if (startOff < 0 || endOff < 0 || startOff >= endOff) {
    return null;
  }

  return {
    messageRoot: start.messageRoot,
    start: startOff,
    end: endOff,
    quotedText,
    rect: rangeRect(range),
    placementRect: rangePlacementRect(range),
  };
}

// ─── Ask button ─────────────────────────────────────────────────────────

export const ASK_BUTTON_ID = "ai-helper-ask-btn";

export type AskButtonHandler = (anchor: SelectionAnchor) => void;

const ASK_BG = "#0d0d0d";
const ASK_BG_HOVER = "#2f2f2f";

function styleAskButton(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    position: "fixed",
    zIndex: "2147483646",
    margin: "0",
    padding: "7px 14px",
    fontSize: "13px",
    fontWeight: "500",
    fontFamily:
      'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Helvetica, Arial, sans-serif',
    lineHeight: "1.2",
    letterSpacing: "0.01em",
    // Light hairline keeps the black pill visible in ChatGPT's dark theme too.
    border: "1px solid rgba(255,255,255,0.16)",
    borderRadius: "9999px",
    background: ASK_BG,
    color: "#fff",
    boxShadow: "0 4px 16px rgba(0,0,0,0.22), 0 1px 3px rgba(0,0,0,0.18)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: "0",
    transition: "background-color 120ms ease, transform 120ms ease",
  } as CSSStyleDeclaration);
  button.addEventListener("mouseenter", () => {
    button.style.background = ASK_BG_HOVER;
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = ASK_BG;
    button.style.transform = "";
  });
  button.addEventListener("mousedown", () => {
    button.style.transform = "scale(0.97)";
  });
}

function createAskButton(
  getPending: () => SelectionAnchor | null,
  onAsk: AskButtonHandler,
  hide: () => void
): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = ASK_BUTTON_ID;
  button.type = "button";
  button.textContent = "Ask about this";
  button.dataset.aiHelperAsk = "1";
  styleAskButton(button);
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const anchor = getPending();
    if (anchor) onAsk(anchor);
    hide();
    window.getSelection()?.removeAllRanges();
  });
  return button;
}

// ─── Selection handler ──────────────────────────────────────────────────

/**
 * Show a single floating "Ask about this" near the selection.
 * (We intentionally do not inject into ChatGPT's toolbar — that caused
 * duplicates.)
 *
 * @param selectionStrategy  `"native"` reads `window.getSelection()`
 *   (default).  `"pointer"` builds a Range from raw pointer coordinates,
 *   useful when the host replaces the native selection mid-drag.
 */
export function attachSelectionHandler(
  getMessageRoots: () => HTMLElement[],
  onAsk: AskButtonHandler,
  findRootForNode?: RootForNode,
  selectionStrategy: "native" | "native-sticky" | "pointer" = "native"
): () => void {
  const stickyNative = selectionStrategy === "native-sticky";
  let pending: SelectionAnchor | null = null;
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerSelecting = false;
  /** Best pointer-derived range seen during the drag (ChatGPT fallback only). */
  let bestDragAnchor: SelectionAnchor | null = null;
  /**
   * Exact browser selection captured while the mouse is still down. ChatGPT
   * can replace this range on release when its own selection UI mounts, so
   * this snapshot is the source of truth whenever it exists.
   */
  let bestNativeDragAnchor: SelectionAnchor | null = null;
  let pointerReleaseLocked = false;
  /**
   * Chrome can finish extending a native text selection after pointerup has
   * already dispatched. ChatGPT may then mount its own selection UI and
   * mutate the range again. For native-sticky, keep a tiny post-release
   * capture window and retain the longest real range seen in that window.
   */
  let stickyReleaseSettling = false;
  let stickyReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerSelectionStart: PointerSelectionStart | null = null;

  const hide = () => {
    document
      .querySelectorAll<HTMLElement>("[data-ai-helper-ask='1']")
      .forEach((el) => el.remove());
    pending = null;
  };

  const positionFloating = (el: HTMLElement, rect: DOMRect) => {
    const top = Math.min(
      window.innerHeight - 40,
      Math.max(8, rect.bottom + 8)
    );
    const left = Math.min(
      window.innerWidth - 160,
      Math.max(8, rect.left)
    );
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  };

  const placeFloating = (anchor: SelectionAnchor) => {
    const placementTarget = anchor.placementRect ?? anchor.rect;
    const existing = document.getElementById(
      ASK_BUTTON_ID
    ) as HTMLButtonElement | null;
    if (existing) {
      positionFloating(existing, placementTarget);
      return;
    }
    const button = createAskButton(() => {
      if (!pending) return null;
      if (pending.messageRoot.isConnected) return pending;

      // ChatGPT occasionally replaces the rendered assistant turn between
      // mouseup and the click on our pill. Recover the same quote in the new
      // turn instead of silently doing nothing with a detached DOM node.
      const recovered = recoverSelectionAnchor(
        getMessageRoots(),
        pending.quotedText,
        pending.rect
      );
      if (recovered) pending = recovered;
      return pending?.messageRoot.isConnected ? pending : null;
    }, onAsk, hide);
    positionFloating(button, placementTarget);
    document.body.appendChild(button);
    log.debug("Ask button shown");
  };

  const show = (anchor: SelectionAnchor) => {
    // Keep the geometry captured from Chrome's *live* native selection.
    // Rebuilding the range from offsets here was a ChatGPT-only divergence
    // from Claude/Gemini and could move the pill when ChatGPT had already
    // mutated/re-rendered the underlying markdown nodes.
    pending = anchor;
    placeFloating(pending);
  };

  const rememberLongestNative = (anchor: SelectionAnchor | null): SelectionAnchor | null => {
    if (!anchor) return bestDragAnchor;
    if (
      !bestDragAnchor ||
      bestDragAnchor.messageRoot !== anchor.messageRoot ||
      selectionSpan(anchor) >= selectionSpan(bestDragAnchor)
    ) {
      bestDragAnchor = anchor;
    }
    return bestDragAnchor;
  };

  const captureStickyNative = (): SelectionAnchor | null => {
    const current = getSelectionAnchor(getMessageRoots(), findRootForNode);
    const best = rememberLongestNative(current);
    if (best) show(best);
    return best;
  };

  const refreshFromSelection = (allowHostMutation = true) => {
    const anchor = getSelectionAnchor(getMessageRoots(), findRootForNode);
    if (anchor) {
      if (pointerSelecting) {
        rememberLongestNative(anchor);
        show(stickyNative ? bestDragAnchor ?? anchor : anchor);
        return;
      }
      // Immediately after pointer release, ChatGPT may swap the real range
      // for a tiny overlay fragment.  Do not let that overwrite the captured
      // quote.
      if (!allowHostMutation || pointerReleaseLocked) {
        if (pending) placeFloating(pending);
        return;
      }
      show(anchor);
      return;
    }
    // ChatGPT often collapses the native selection when its own toolbar
    // mounts.  If we already captured an anchor, keep the button visible.
    if (pending && document.getElementById(ASK_BUTTON_ID)) {
      return;
    }
    if (pending) {
      placeFloating(pending);
      return;
    }
  };

  const scheduleRefresh = (delayMs: number) => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      refreshFromSelection();
    }, delayMs);
  };

  // Capture during the event, before the host's selection toolbar can clear
  // the native range.  A delayed-only read loses it on ChatGPT.
  const finishPointerSelection = (clientX?: number, clientY?: number) => {
    if (!pointerSelecting) return;

    // Read the native range first, while we're still inside the release event.
    // On ChatGPT this is often still the exact highlighted sentence here, but
    // can be replaced by the site's own selection UI immediately afterward.
    const nativeAtRelease = getSelectionAnchor(
      getMessageRoots(),
      findRootForNode
    );
    if (
      nativeAtRelease &&
      (!bestNativeDragAnchor ||
        bestNativeDragAnchor.messageRoot !== nativeAtRelease.messageRoot ||
        selectionSpan(nativeAtRelease) >= selectionSpan(bestNativeDragAnchor))
    ) {
      bestNativeDragAnchor = nativeAtRelease;
    }

    let pointerAnchor: SelectionAnchor | null = null;
    if (
      pointerSelectionStart &&
      typeof clientX === "number" &&
      typeof clientY === "number"
    ) {
      pointerAnchor = getPointerSelectionAnchor(
        pointerSelectionStart,
        clientX,
        clientY,
        getMessageRoots(),
        findRootForNode
      );
    }

    // IMPORTANT: prefer the browser's real selection captured during the drag.
    // The coordinate-derived range is only a fallback.  Making pointerAnchor
    // win unconditionally caused ChatGPT selections to lose words and made the
    // Ask button appear away from the actual highlight.
    const released =
      bestNativeDragAnchor ??
      chooseReleasedAnchor(nativeAtRelease, bestDragAnchor) ??
      pointerAnchor ??
      bestDragAnchor;

    pointerSelecting = false;
    pointerSelectionStart = null;
    bestDragAnchor = null;
    bestNativeDragAnchor = null;
    if (released) show(released);
    else hide();
    pointerReleaseLocked = true;
  };

  const onMouseUp = (e: MouseEvent) => {
    if (selectionStrategy === "pointer") {
      // Normal pointer events fire first; mouseup is a reliable fallback when
      // the host page swallows/cancels pointerup.
      finishPointerSelection(e.clientX, e.clientY);
      return;
    }
    if (stickyNative && stickyReleaseSettling) {
      captureStickyNative();
      return;
    }
    refreshFromSelection(!pointerReleaseLocked);
    if (!pointerReleaseLocked) scheduleRefresh(40);
  };

  const onTouchEnd = () => {
    if (selectionStrategy === "pointer") return;
    refreshFromSelection(!pointerReleaseLocked);
    if (!pointerReleaseLocked) scheduleRefresh(60);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (
      e.key === "Shift" ||
      e.key.startsWith("Arrow") ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      pointerReleaseLocked = false;
      refreshFromSelection();
      scheduleRefresh(40);
    }
  };

  const onSelectionChange = () => {
    if (selectionStrategy === "pointer") {
      // ChatGPT: snapshot Chrome's exact selection while the drag is active.
      // Do not display from this event; pointermove/release controls the pill.
      if (!pointerSelecting) return;
      const native = getSelectionAnchor(getMessageRoots(), findRootForNode);
      if (
        native &&
        (!bestNativeDragAnchor ||
          bestNativeDragAnchor.messageRoot !== native.messageRoot ||
          selectionSpan(native) >= selectionSpan(bestNativeDragAnchor))
      ) {
        bestNativeDragAnchor = native;
      }
      return;
    }
    if (stickyNative && (pointerSelecting || stickyReleaseSettling)) {
      captureStickyNative();
      return;
    }
    refreshFromSelection(!pointerReleaseLocked);
    if (!pointerReleaseLocked) scheduleRefresh(80);
  };

  const captureDragSelection = rafThrottle(() => refreshFromSelection());

  const onPointerDown = (e: PointerEvent) => {
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (t instanceof Element && t.closest("[data-ai-helper-ask='1']")) {
      return;
    }
    bestDragAnchor = null;
    bestNativeDragAnchor = null;
    pointerReleaseLocked = false;
    stickyReleaseSettling = false;
    if (stickyReleaseTimer) {
      clearTimeout(stickyReleaseTimer);
      stickyReleaseTimer = null;
    }
    pointerSelectionStart = null;
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = null;

    if (e.button !== 0) {
      pointerSelecting = false;
      return;
    }

    if (selectionStrategy === "pointer") {
      const roots = getMessageRoots();
      const caret = caretPointFromClient(e.clientX, e.clientY);
      const rootFromTarget = messageRootForNode(roots, t, findRootForNode);
      const rootFromCaret = caret
        ? messageRootForNode(roots, caret.node, findRootForNode)
        : null;
      const messageRoot =
        caret && rootFromTarget?.contains(caret.node)
          ? rootFromTarget
          : rootFromCaret;
      if (!rootFromTarget && !rootFromCaret) {
        pointerSelecting = false;
        hide();
        return;
      }
      pointerSelecting = true;
      if (caret && messageRoot && messageRoot.contains(caret.node)) {
        pointerSelectionStart = { ...caret, messageRoot };
      }
      hide();
      return;
    }

    pointerSelecting = true;
    // A new interaction invalidates the old quote, even if the host keeps
    // its old native selection.  Clicks on Ask itself were excluded above.
    hide();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointerSelecting || (e.buttons & 1) === 0) return;

    if (selectionStrategy === "pointer") {
      // Native first: this exactly matches what the user can see highlighted.
      // Pointer geometry is kept only for the cases where ChatGPT has already
      // cleared/replaced the native selection.
      const native = getSelectionAnchor(getMessageRoots(), findRootForNode);
      if (
        native &&
        (!bestNativeDragAnchor ||
          bestNativeDragAnchor.messageRoot !== native.messageRoot ||
          selectionSpan(native) >= selectionSpan(bestNativeDragAnchor))
      ) {
        bestNativeDragAnchor = native;
      }

      const pointer = pointerSelectionStart
        ? getPointerSelectionAnchor(
            pointerSelectionStart,
            e.clientX,
            e.clientY,
            getMessageRoots(),
            findRootForNode
          )
        : null;
      if (
        pointer &&
        (!bestDragAnchor ||
          bestDragAnchor.messageRoot !== pointer.messageRoot ||
          selectionSpan(pointer) >= selectionSpan(bestDragAnchor))
      ) {
        bestDragAnchor = pointer;
      }

      const displayAnchor = bestNativeDragAnchor ?? pointer ?? bestDragAnchor;
      if (displayAnchor) show(displayAnchor);
      return;
    }

    // Native strategy: snapshot continuously during the drag.  Some hosts
    // move the selection into a portal before mouseup/selectionchange.
    captureDragSelection();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!pointerSelecting) return;

    if (selectionStrategy === "pointer") {
      finishPointerSelection(e.clientX, e.clientY);
      return;
    }

    captureDragSelection.cancel();

    if (stickyNative) {
      // Do NOT lock immediately. Chrome's final native selection can land
      // after pointerup dispatch. Keep listening briefly, while always
      // retaining the longest range so ChatGPT's own toolbar cannot shrink it.
      captureStickyNative();
      pointerSelecting = false;
      stickyReleaseSettling = true;

      requestAnimationFrame(() => {
        if (!stickyReleaseSettling) return;
        captureStickyNative();
        requestAnimationFrame(() => {
          if (stickyReleaseSettling) captureStickyNative();
        });
      });

      stickyReleaseTimer = setTimeout(() => {
        stickyReleaseTimer = null;
        if (!stickyReleaseSettling) return;
        captureStickyNative();
        stickyReleaseSettling = false;
        pointerReleaseLocked = true;
        const released = bestDragAnchor;
        bestDragAnchor = null;
        if (released) show(released);
        else hide();
      }, 120);
      return;
    }

    const current = getSelectionAnchor(getMessageRoots(), findRootForNode);
    const released = chooseReleasedAnchor(current, bestDragAnchor, false);
    pointerSelecting = false;
    bestDragAnchor = null;
    if (released) show(released);
    pointerReleaseLocked = true;
  };

  const onPointerCancel = () => {
    if (selectionStrategy !== "pointer" || !pointerSelecting) return;
    // A cancel can be caused by host UI taking pointer capture. Preserve the
    // last valid/native selection if one exists instead of dropping the pill.
    finishPointerSelection();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && pending) hide();
  };

  /** Keep the Ask button while scrolling; only hide if the anchor is gone. */
  const onScroll = rafThrottle(() => {
    if (!pending) return;
    if (!pending.messageRoot.isConnected) {
      hide();
      return;
    }
    const rect = getAnchorRect(pending);
    const placementRect = getAnchorPlacementRect(pending);
    if (
      !rect ||
      !placementRect ||
      (rect.width === 0 && rect.height === 0)
    ) {
      document.getElementById(ASK_BUTTON_ID)?.remove();
      return;
    }
    pending = { ...pending, rect, placementRect };
    placeFloating(pending);
  });

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("touchend", onTouchEnd, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("scroll", onScroll, true);

  return () => {
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("touchend", onTouchEnd, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    window.removeEventListener("scroll", onScroll, true);
    captureDragSelection.cancel();
    onScroll.cancel();
    if (selectionTimer) clearTimeout(selectionTimer);
    if (stickyReleaseTimer) clearTimeout(stickyReleaseTimer);
    hide();
  };
}

// ─── Highlight wrapping ─────────────────────────────────────────────────

/** Remove previously injected highlight marks without deleting their text. */
export function unwrapHighlights(root: HTMLElement): void {
  const marks = Array.from(
    root.querySelectorAll<HTMLElement>("mark[data-thread-id]")
  );
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  }
  root.normalize();
}

/**
 * Wrap plain-text character ranges with <mark> inside the existing DOM,
 * preserving headers, lists, and other ChatGPT formatting.
 */
export function wrapHighlightsInPlace(
  root: HTMLElement,
  threads: Pick<Thread, "id" | "anchorStart" | "anchorEnd">[]
): void {
  unwrapHighlights(root);

  const textLen = getPlainText(root).length;
  const kept = filterNonOverlapping(threads, textLen);
  // Apply from the end so earlier offsets stay valid while splitting nodes.
  const ordered = [...kept].sort((a, b) => b.anchorStart - a.anchorStart);

  for (const t of ordered) {
    wrapTextRange(root, t.anchorStart, t.anchorEnd, t.id);
  }
}

function wrapTextRange(
  root: HTMLElement,
  start: number,
  end: number,
  threadId: string
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  const segments: { node: Text; from: number; to: number }[] = [];

  let current: Node | null = walker.nextNode();
  while (current) {
    const node = current as Text;
    // Skip text inside marks we just added (shouldn't happen end→start).
    if (node.parentElement?.closest("mark[data-thread-id]")) {
      offset += node.data.length;
      current = walker.nextNode();
      continue;
    }

    const len = node.data.length;
    const nodeStart = offset;
    const nodeEnd = offset + len;
    const from = Math.max(0, start - nodeStart);
    const to = Math.min(len, end - nodeStart);
    if (from < to) {
      segments.push({ node, from, to });
    }
    offset = nodeEnd;
    if (offset >= end) break;
    current = walker.nextNode();
  }

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    wrapTextNodePortion(seg.node, seg.from, seg.to, threadId);
  }
}

function wrapTextNodePortion(
  node: Text,
  from: number,
  to: number,
  threadId: string
): void {
  const parent = node.parentNode;
  if (!parent) return;

  const text = node.data;
  const before = text.slice(0, from);
  const mid = text.slice(from, to);
  const after = text.slice(to);
  if (!mid) return;

  const mark = document.createElement("mark");
  mark.dataset.threadId = threadId;
  mark.textContent = mid;
  mark.style.background = "rgba(201, 162, 39, 0.45)";
  mark.style.borderRadius = "2px";
  mark.style.cursor = "pointer";

  const frag = document.createDocumentFragment();
  if (before) frag.appendChild(document.createTextNode(before));
  frag.appendChild(mark);
  if (after) frag.appendChild(document.createTextNode(after));
  parent.replaceChild(frag, node);
}

/**
 * Apply highlight marks to a message element from stored thread offsets.
 * Preserves the host page's DOM structure (lists, headings, etc.).
 */
export function applyHighlightsToElement(
  el: HTMLElement,
  threads: Thread[]
): void {
  const relevant = threads.filter((t) => t.anchorEnd > t.anchorStart);

  const rawText = getPlainText(el);
  if (!rawText) {
    return;
  }

  if (!el.dataset.aiHelperRaw) {
    el.dataset.aiHelperRaw = rawText;
  }

  wrapHighlightsInPlace(el, relevant);
}
