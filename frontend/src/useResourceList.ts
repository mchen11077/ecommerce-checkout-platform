import { useEffect, useState } from 'react';

type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type LoadStatus = 'loading' | 'ready' | 'error';

export function useResourceList<T>(request: Request, path: string | null, cache?: RequestCache) {
  const [items, setItems] = useState<T[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setStatus('loading');
    request<T[]>(path, { signal: controller.signal, cache }).then(result => {
      if (controller.signal.aborted) return;
      setItems(result);
      setStatus('ready');
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('error');
    });
    return () => controller.abort();
  }, [request, path, cache, revision]);

  function reload() {
    setStatus('loading');
    setRevision(value => value + 1);
  }

  return { items, setItems, status, revision, reload };
}
