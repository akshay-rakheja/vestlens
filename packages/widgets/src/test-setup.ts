import "@testing-library/jest-dom/vitest";

// jsdom has no PointerEvent; a MouseEvent subclass carries clientX and pointerType for chart tests.
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class TestPointerEvent extends MouseEvent {
    pointerType: string;
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
      this.pointerId = init.pointerId ?? 1;
    }
  }
  // Browsers expose onpointer* handlers; Preact and Testing Library both check for them to pick lower-case event names.
  for (const name of ["onpointerdown", "onpointermove", "onpointerup", "onpointerleave", "onpointercancel"]) {
    if (!(name in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, name, { value: null, writable: true, configurable: true });
  }
  // Testing Library builds events from the node's own window (document.defaultView), which may differ from globalThis.
  for (const target of [globalThis, document.defaultView]) if (target) (target as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
}
