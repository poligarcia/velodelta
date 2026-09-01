import { createRoot } from 'react-dom/client';

import './app/globals.css';
import Home from './app/page';

const root = document.getElementById('root');

if (!root) {
  throw new Error('No se encontró el contenedor principal de la aplicación.');
}

createRoot(root).render(<Home />);
