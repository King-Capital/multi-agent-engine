import { useCallback, useEffect, useRef, useState } from "react";

/**
 * usePolling — periodically calls a loader function with proper AbortSignal
 * support and cleanup on unmount.
 *
 * @param loader - Async function that accepts an AbortSignal
 * @param intervalMs - Polling interval in milliseconds
 * @param deps - Dependency array that triggers a refresh when changed
 */
export function usePolling<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: readonly unknown[] = [],
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Store loader in a ref so the effect doesn't re-run when the function
  // identity changes (which happens every render for inline arrow fns).
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await loaderRef.current(signal ?? new AbortController().signal);
      if (signal?.aborted) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), intervalMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  // Public refresh (creates its own non-abortable signal for manual calls)
  const manualRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return { data, loading, error, refresh: manualRefresh };
}
