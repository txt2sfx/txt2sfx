import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerServiceWorker } from './lib/updates.js';
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

/* Before the render rather than inside an effect: registering is not React's business, it
   must happen exactly once whatever StrictMode does to the tree, and the whole point is
   that it is already under way while the first paint is being drawn. It never throws —
   `lib/updates.ts` says why a browser that refuses is not an error to handle here. */
registerServiceWorker();

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
