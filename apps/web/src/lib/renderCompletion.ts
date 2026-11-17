import type { Render } from "@scarlet/shared";
import { useProjectStore } from "../stores/project";

/** Use the matching socket completion immediately. A timeout lets the caller
 * poll when the engine reconnects or an export continues in another project.
 * `onProgress` hears each socket update of the render before it finishes. */
export function renderCompletion(projectId: string, renderId: string, timeout: number, signal: AbortSignal,
  onProgress?: (render: Render) => void) {
  return new Promise<Render | undefined>(resolve => {
    if (signal.aborted) { resolve(undefined); return; }
    const read = () => {
      const current = useProjectStore.getState().current;
      if (current?.id !== projectId) return;
      const render = current.renders.find(r => r.id === renderId);
      if (render && (render.state === "done" || render.state === "cancelled" || render.state === "failed")) finish(render);
      else if (render && onProgress) onProgress(render);
    };
    const off = useProjectStore.subscribe((state, previous) => {
      if (state.current?.renders !== previous.current?.renders) read();
    });
    const stop = () => finish(undefined);
    const timer = window.setTimeout(stop, timeout);
    function finish(render: Render | undefined) {
      window.clearTimeout(timer);
      off();
      signal.removeEventListener("abort", stop);
      resolve(render);
    }
    signal.addEventListener("abort", stop, {once: true});
    read();
  });
}
