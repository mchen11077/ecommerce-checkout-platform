import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import Shop from './Shop';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root is missing from index.html');
}

const Page = import.meta.env.VITE_COUPON_LOGIN === 'true'
  ? lazy(() => import('./LoginShop'))
  : import.meta.env.DEV && new URLSearchParams(window.location.search).get('debug') === '1'
  ? lazy(() => import('./App'))
  : Shop;

createRoot(container).render(
  <StrictMode>
    <Suspense fallback={<p>Loading…</p>}>
      <Page />
    </Suspense>
  </StrictMode>,
);
