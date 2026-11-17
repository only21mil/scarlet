// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useNearView } from "./useNearView";

afterEach(() => vi.unstubAllGlobals());

it("counts an element in view until its pane says otherwise, measured against that pane with a screen to spare", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers: { report(near: boolean): void; options?: IntersectionObserverInit; observed: Element[]; gone: boolean }[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    observed: Element[] = [];
    gone = false;
    constructor(callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) {
      observers.push(Object.assign(this, { report: (near: boolean) => callback([{ isIntersecting: near } as IntersectionObserverEntry], this as never) }));
    }
    observe(element: Element) { this.observed.push(element); }
    disconnect() { this.gone = true; }
  });
  const seen: boolean[] = [];
  function Probe() {
    const ref = useRef<HTMLDivElement>(null);
    seen.push(useNearView(ref, ".pane"));
    return <div ref={ref} />;
  }
  const container = document.createElement("div");
  container.className = "pane";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  expect(seen.at(-1)).toBe(true);
  const [observer] = observers;
  expect(observer!.options).toMatchObject({ root: container, rootMargin: "100% 0px" });
  expect(observer!.observed).toEqual([container.firstElementChild]);
  await act(async () => observer!.report(false));
  expect(seen.at(-1)).toBe(false);
  await act(async () => observer!.report(true));
  expect(seen.at(-1)).toBe(true);
  await act(async () => root.unmount());
  expect(observer!.gone).toBe(true);
  container.remove();
});
