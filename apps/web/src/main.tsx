import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './i18n';
import './index.css';
import { resolveRouterBasename } from './router-basename';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={resolveRouterBasename()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
