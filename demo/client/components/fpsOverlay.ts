/**
 * Tiny FPS overlay for local performance testing of the WebGL renderer.
 * Not part of the upstream demo surface — kept on this branch only.
 *
 * Counts two things:
 *   rAF  = requestAnimationFrame callbacks per second (display cadence)
 *   draw = WebglRenderer.renderRows calls per second, via the
 *          (globalThis as any).__webglOnFrame hook installed in WebglRenderer
 */

export interface IFpsOverlayHandle {
  destroy(): void;
}

export function attachFpsOverlay(): IFpsOverlayHandle {
  const root = document.createElement('div');
  root.id = 'fps-overlay';
  Object.assign(root.style, {
    position: 'fixed',
    top: '8px',
    right: '8px',
    zIndex: '99999',
    padding: '6px 8px',
    background: 'rgba(0, 0, 0, 0.7)',
    color: '#0f0',
    font: '12px/1.3 ui-monospace, Menlo, monospace',
    borderRadius: '4px',
    pointerEvents: 'none',
    whiteSpace: 'pre',
    minWidth: '120px'
  } as Partial<CSSStyleDeclaration>);
  root.textContent = 'rAF  --\ndraw --';
  document.body.appendChild(root);

  let rafCount = 0;
  let drawCount = 0;
  let lastSec = performance.now();
  let lastRafFps = 0;
  let lastDrawFps = 0;

  const prevHook = (globalThis as any).__webglOnFrame;
  (globalThis as any).__webglOnFrame = () => {
    drawCount++;
    prevHook?.();
  };

  let rafHandle = 0;
  const tick = (now: number): void => {
    rafCount++;
    if (now - lastSec >= 1000) {
      const elapsed = (now - lastSec) / 1000;
      lastRafFps = Math.round(rafCount / elapsed);
      lastDrawFps = Math.round(drawCount / elapsed);
      rafCount = 0;
      drawCount = 0;
      lastSec = now;
      root.textContent =
        `rAF  ${String(lastRafFps).padStart(3, ' ')}\n` +
        `draw ${String(lastDrawFps).padStart(3, ' ')}`;
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);

  return {
    destroy(): void {
      cancelAnimationFrame(rafHandle);
      (globalThis as any).__webglOnFrame = prevHook;
      root.remove();
    }
  };
}
