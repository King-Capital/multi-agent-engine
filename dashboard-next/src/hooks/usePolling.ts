import { useCallback, useEffect, useRef, useState } from "react";

export function usePolling<T>(loader: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await loader();
      if (!mounted.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, deps);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void refresh();
    const timer = window.setInterval(refresh, intervalMs);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh, intervalMs]);

  return { data, loading, error, refresh };
}
