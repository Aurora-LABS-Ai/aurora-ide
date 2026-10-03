import { useCallback, useEffect, useRef, useState } from "react";
import {
  cachedGalleryList,
  listGallery,
  rememberGalleryList,
  type GalleryResult,
} from "@/apps/agent/services/gallery/gallery-service";

export function useGallery() {
  // Start from the last list this session read: switching Images ↔ Library
  // paints the wall at once, and the fetch below only revalidates it.
  const [data, setData] = useState<GalleryResult>(
    () => cachedGalleryList() ?? { images: [], warnings: [] },
  );
  const [loading, setLoading] = useState(true);
  /** A first answer (list or error) has arrived; later polls are not "loading the page". */
  const [loaded, setLoaded] = useState(() => cachedGalleryList() !== null);
  const [error, setError] = useState("");
  const requests = useRef({ generation: 0, pending: false });
  const refresh = useCallback(async () => {
    const state = requests.current;
    if (state.pending) return;
    const request = ++state.generation;
    state.pending = true;
    setLoading(true);
    try {
      const result = await listGallery();
      if (request !== state.generation) return;
      rememberGalleryList(result);
      setData(result);
      setError("");
    } catch (cause) {
      if (request === state.generation) setError(String(cause));
    } finally {
      if (request === state.generation) {
        state.pending = false;
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    const state = requests.current;
    void refresh();
    const reload = () => {
      if (!document.hidden) void refresh();
    };
    const timer = window.setInterval(reload, 10_000);
    window.addEventListener("focus", reload);
    return () => {
      ++state.generation;
      state.pending = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [refresh]);

  return { ...data, loading, loaded, error, refresh };
}
