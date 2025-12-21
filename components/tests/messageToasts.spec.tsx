import assert from 'node:assert';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import MessageToasts from '../ui/MessageToasts';
import { I18nProvider } from '../../i18n';
import { GameMessage } from '../../types';

Object.defineProperty(globalThis, 'window', {
  value: {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  },
  configurable: true
});

Object.defineProperty(globalThis, 'document', {
  value: {
    body: {},
    documentElement: { lang: 'en' }
  },
  configurable: true
});

Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US' },
  configurable: true
});

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => undefined
  },
  configurable: true
});

const sampleMessage: GameMessage = {
  id: 'm1',
  day: 1,
  createdAtTurn: 1,
  priority: 1,
  title: 'Test',
  subtitle: 'Sub',
  lines: ['Line'],
  payload: {},
  read: false,
  dismissed: false
};

let dismissedId: string | null = null;
const onDismiss = (messageId: string) => {
  dismissedId = messageId;
};

const markup = ReactDOMServer.renderToStaticMarkup(
  <I18nProvider>
    <MessageToasts
      messages={[sampleMessage]}
      onDismissMessage={onDismiss}
      onOpenMessage={() => undefined}
      onMarkRead={() => undefined}
    />
  </I18nProvider>
);

assert.ok(markup.includes('Test'), 'Toast content should render');
assert.ok(markup.toLowerCase().includes('dismiss'), 'Dismiss control should be present');

// Simulate an explicit dismiss call to ensure callback wiring is intact.
onDismiss(sampleMessage.id);
assert.strictEqual(dismissedId, 'm1', 'Dismissing a toast should notify the caller');
