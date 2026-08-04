/**
 * Zoom/pan viewport for the showcase canvases.
 *
 * ## How it works, and why it needs no changes to the sections
 *
 * The canvas keeps its 1px-per-cell backing store and its `putImageData`
 * render path untouched. Zoom and pan are a CSS `transform` on the canvas
 * element, clipped by an `overflow: hidden` wrapper.
 *
 * That choice is what makes this cheap: `getBoundingClientRect()` reports the
 * *transformed* box, so a section's existing "screen pixel → grid cell" math —
 * `((clientX - rect.left) / rect.width) * GRID` — stays correct at any zoom and
 * pan with no edit at all. Painting lands where you see it, and the planet's
 * spin un-rotation composes with it for free. Scaling inside the canvas instead
 * would have meant an offscreen buffer, a `drawImage` per frame, and rewriting
 * both sections' pointer mapping.
 *
 * ## Layering
 *
 * The pure geometry is exported separately from the DOM wiring, so the parts
 * worth getting exactly right — clamping, and keeping a point fixed under the
 * cursor while zooming — are unit-testable under Node like `renderer.ts` and
 * `cloud.ts`. {@link attachViewport} is the thin DOM shell over them.
 */

/** Zoom factor and pan offset, in CSS pixels of the viewport. */
export interface View {
  /** 1 = fit. Never below 1: the canvas always fills its frame. */
  zoom: number;
  /** Offset of the canvas' top-left from the viewport's, in viewport pixels. */
  panX: number;
  panY: number;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 12;
/** Multiplier per button press. 1.5 is ~7 presses across the whole range. */
export const ZOOM_STEP = 1.5;

/** The identity view: fitted, centred, unzoomed. */
export const FIT_VIEW: View = { zoom: 1, panX: 0, panY: 0 };

/**
 * Clamp a view so the canvas always covers its frame.
 *
 * Zoom is held at or above 1 and pan is bounded to the overhang, so there is no
 * way to drag the world off screen and be left staring at the background
 * wondering where it went — the usual failure of a free-floating pan.
 */
export function clampView(view: View, viewW: number, viewH: number): View {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom));
  // Content is never smaller than the viewport, so the offset runs from
  // "bottom-right corner flush" up to "top-left corner flush".
  const minX = viewW - viewW * zoom;
  const minY = viewH - viewH * zoom;
  return {
    zoom,
    panX: Math.min(0, Math.max(minX, view.panX)),
    panY: Math.min(0, Math.max(minY, view.panY)),
  };
}

/**
 * Zoom to `targetZoom` while holding the content point currently under
 * `(anchorX, anchorY)` in place.
 *
 * Anchoring is what separates a zoom that feels like a magnifying glass from
 * one that feels like the world jumping: without it, zooming in on a detail
 * sends that detail off screen and you have to pan back to it every step.
 * Buttons pass the viewport centre; pinch-zoom passes the cursor.
 */
export function zoomAbout(
  view: View,
  targetZoom: number,
  anchorX: number,
  anchorY: number,
  viewW: number,
  viewH: number,
): View {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, targetZoom));
  const k = zoom / view.zoom;
  // Solving `(anchor - pan') / zoom' === (anchor - pan) / zoom` for pan'.
  return clampView(
    { zoom, panX: anchorX - k * (anchorX - view.panX), panY: anchorY - k * (anchorY - view.panY) },
    viewW,
    viewH,
  );
}

/** The CSS transform for a view. `transform-origin` must be `0 0`. */
export function viewTransform(view: View): string {
  return `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
}

/** Human-readable zoom, e.g. `"150%"`. */
export function formatZoom(view: View): string {
  return `${Math.round(view.zoom * 100)}%`;
}

/** Controls a {@link attachViewport} instance owns and updates. */
export interface ViewportControls {
  /** The `overflow: hidden` frame. Sized by CSS; the canvas fills it. */
  viewport: HTMLElement;
  canvas: HTMLCanvasElement;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  fit: HTMLButtonElement;
  pan: HTMLButtonElement;
  readout: HTMLElement;
}

/** Handle returned by {@link attachViewport}. */
export interface ViewportHandle {
  /** The current view. */
  get view(): View;
  /** Reset to fit. */
  reset(): void;
}

/**
 * Wire zoom/pan controls onto a canvas.
 *
 * Pan is deliberately reachable three ways, because a modal pan tool on its own
 * is a trap: you leave it selected, painting silently stops working, and the
 * cause is invisible. So the toggle is the discoverable path, and **middle-drag**
 * and **space-drag** are always live regardless of the toggle — the same escape
 * hatches every drawing tool has.
 *
 * Pan listeners sit on the wrapper in the **capture** phase and stop propagation
 * once a drag is claimed, so the section's own paint handlers on the canvas
 * never see a panning gesture and need no knowledge of this module.
 *
 * Wheel zoom is bound only to ctrl/⌘+wheel — which is what a trackpad pinch
 * sends. Plain wheel is left alone so the page still scrolls normally over the
 * canvas.
 */
export function attachViewport(c: ViewportControls): ViewportHandle {
  let view: View = { ...FIT_VIEW };
  let panMode = false;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let spaceHeld = false;
  let hovering = false;

  const size = (): { w: number; h: number } => {
    const r = c.viewport.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };

  const apply = (): void => {
    c.canvas.style.transform = viewTransform(view);
    c.readout.textContent = formatZoom(view);
    const canPan = view.zoom > 1;
    c.zoomOut.disabled = view.zoom <= ZOOM_MIN;
    c.zoomIn.disabled = view.zoom >= ZOOM_MAX;
    c.fit.disabled = view.zoom === 1 && view.panX === 0 && view.panY === 0;
    c.viewport.classList.toggle('is-pannable', canPan && (panMode || spaceHeld));
    c.viewport.classList.toggle('is-panning', dragging);
    // Drives the pan hint, which is only worth showing once panning does
    // something. `?.` because the stage wrapper is the section's markup, not
    // this module's to require.
    c.viewport.parentElement?.classList.toggle('is-zoomed', canPan);
  };

  const setView = (next: View): void => {
    const { w, h } = size();
    view = clampView(next, w, h);
    apply();
  };

  const zoomBy = (factor: number): void => {
    const { w, h } = size();
    // Anchored on the middle of the frame, so the thing you were looking at is
    // the thing you keep looking at.
    view = zoomAbout(view, view.zoom * factor, w / 2, h / 2, w, h);
    apply();
  };

  c.zoomIn.addEventListener('click', () => { zoomBy(ZOOM_STEP); c.zoomIn.blur(); });
  c.zoomOut.addEventListener('click', () => { zoomBy(1 / ZOOM_STEP); c.zoomOut.blur(); });
  c.fit.addEventListener('click', () => { setView({ ...FIT_VIEW }); c.fit.blur(); });

  c.pan.addEventListener('click', () => {
    panMode = !panMode;
    c.pan.setAttribute('aria-pressed', String(panMode));
    apply();
    c.pan.blur();
  });

  // --- Panning -------------------------------------------------------------

  /** True if this gesture is a pan rather than a paint. */
  const isPanGesture = (e: PointerEvent): boolean =>
    view.zoom > 1 && (panMode || spaceHeld || e.button === 1);

  c.viewport.addEventListener(
    'pointerdown',
    (e) => {
      if (!isPanGesture(e)) return;
      // Claim the gesture before it reaches the canvas' paint handler.
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      // Capture keeps the drag alive if the pointer leaves the frame. It throws
      // for a pointer id the browser has no record of — which real input never
      // produces, but a synthetic event does — and a throw here would skip the
      // cursor update and leave the drag looking dead while it is still live.
      try {
        c.viewport.setPointerCapture(e.pointerId);
      } catch {
        /* drag still works, it just won't survive leaving the frame */
      }
      apply();
    },
    true,
  );

  c.viewport.addEventListener(
    'pointermove',
    (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      setView({ zoom: view.zoom, panX: view.panX + (e.clientX - lastX), panY: view.panY + (e.clientY - lastY) });
      lastX = e.clientX;
      lastY = e.clientY;
    },
    true,
  );

  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (c.viewport.hasPointerCapture(e.pointerId)) c.viewport.releasePointerCapture(e.pointerId);
    apply();
  };
  c.viewport.addEventListener('pointerup', endDrag, true);
  c.viewport.addEventListener('pointercancel', endDrag, true);
  // Middle-click otherwise opens autoscroll on some platforms.
  c.viewport.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

  // --- Pinch / ctrl-wheel zoom ---------------------------------------------

  c.viewport.addEventListener(
    'wheel',
    (e) => {
      // Plain wheel is left to the page. A trackpad pinch arrives here as
      // ctrl+wheel, which is the one wheel gesture that unambiguously means
      // "zoom" and never competes with scrolling.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = c.viewport.getBoundingClientRect();
      view = zoomAbout(
        view,
        view.zoom * Math.pow(1.0015, -e.deltaY),
        e.clientX - r.left,
        e.clientY - r.top,
        r.width,
        r.height,
      );
      apply();
    },
    { passive: false },
  );

  // --- Space-to-pan ---------------------------------------------------------

  c.viewport.addEventListener('pointerenter', () => { hovering = true; });
  c.viewport.addEventListener('pointerleave', () => { hovering = false; });

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || spaceHeld) return;
    spaceHeld = true;
    // Only swallow the keypress while the pointer is over this canvas, so
    // space still scrolls the page everywhere else.
    if (hovering) e.preventDefault();
    apply();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    spaceHeld = false;
    apply();
  });

  // Re-clamp on resize: a narrower viewport changes how much overhang there is.
  window.addEventListener('resize', () => setView(view));

  apply();

  return {
    get view() {
      return view;
    },
    reset: () => setView({ ...FIT_VIEW }),
  };
}
