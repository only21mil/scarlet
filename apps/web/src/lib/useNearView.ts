import { useEffect, useState, type RefObject } from "react";

/**
 * Whether an element is in view in the pane that scrolls it (`pane`, a selector for its closest such ancestor), or
 * within a pane's height of it. It counts as in view until the pane first says otherwise, and always where there is
 * nothing to measure it with.
 */
export function useNearView(ref: RefObject<Element | null>, pane: string) {
  const [near, setNear] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      const last = entries.at(-1);
      if (last) setNear(last.isIntersecting);
    }, { root: element.closest(pane), rootMargin: "100% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, pane]);
  return near;
}
