import { useRef, useState } from "react";
import { useProjectStore } from "../../stores/project";

export function useMediaProcessing() {
  const projectId = useProjectStore(s => s.current?.id);
  const paused = useProjectStore(s => !!s.current?.project.mediaPaused);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = paused ? "Resume" : "Pause";

  async function toggle(): Promise<boolean> {
    if (!projectId || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await useProjectStore.getState().updateProject({ mediaPaused: !paused }, projectId);
      return true;
    } catch {
      setError(`Couldn’t ${label.toLowerCase()} media processing. Try again.`);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return { label, description: `${label} media processing`, icon: paused ? "play" as const : "pause" as const, busy, error, toggle };
}
