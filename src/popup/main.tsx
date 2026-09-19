import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installChromeShim } from './chrome-shim';
import './styles/tokens.css';
import './styles/components.css';

installChromeShim();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
