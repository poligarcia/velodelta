import { createRoot } from 'react-dom/client';

import './app/globals.css';
import Home from './app/page';

const root = document.getElementById('root');

if (!root) {
  throw new Error('No se encontró el contenedor principal de la aplicación.');
}

createRoot(root).render(<Home />);

const splash = document.getElementById('app-splash');

if (splash) {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      root.removeAttribute('aria-hidden');
      document.body.classList.remove('splash-active');
      splash.classList.add('is-hidden');

      if (prefersReducedMotion) {
        splash.remove();
        return;
      }

      const removeSplash = () => splash.remove();
      splash.addEventListener('transitionend', removeSplash, { once: true });
      window.setTimeout(removeSplash, 500);
    }, prefersReducedMotion ? 0 : 420);
  });
} else {
  root.removeAttribute('aria-hidden');
  document.body.classList.remove('splash-active');
}
