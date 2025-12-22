import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { I18nProvider } from './i18n';
import ErrorBoundary from './components/ErrorBoundary';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    console.error('[GlobalError] Uncaught error', event.error || event.message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[GlobalError] Unhandled promise rejection', event.reason);
  });
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
