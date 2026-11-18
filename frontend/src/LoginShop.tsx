import { useEffect, useState } from 'react';
import Shop, { type BrowserSession } from './Shop';

export default function LoginShop() {
  const [session, setSession] = useState<BrowserSession>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setFailed(false);
    const controller = new AbortController();
    fetch('/api/session', { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Session unavailable');
      const current: BrowserSession = await response.json();
      if (!controller.signal.aborted) setSession(current);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [revision]);

  if (failed) return <main className="page"><p role="alert">Could not load your session.</p><button type="button" onClick={() => setRevision(value => value + 1)}>Retry connection</button></main>;
  if (!session) return <main className="page"><p role="status">Loading shop…</p></main>;
  return <Shop session={session} />;
}
