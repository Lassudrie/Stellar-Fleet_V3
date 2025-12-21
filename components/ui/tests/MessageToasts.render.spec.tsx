import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MessageToasts from '../MessageToasts';
import { GameMessage } from '../../../types';
import { I18nProvider } from '../../../i18n';

const buildMessage = (id: string, overrides: Partial<GameMessage> = {}): GameMessage => ({
  id,
  day: 1,
  type: 'info',
  priority: 1,
  title: `Message ${id}`,
  subtitle: 'Details',
  lines: ['First line'],
  payload: {},
  read: false,
  dismissed: false,
  createdAtTurn: 0,
  ...overrides,
});

const renderWithI18n = (children: React.ReactNode) => (
  <I18nProvider>{children}</I18nProvider>
);

const run = () => {
  const messages = Array.from({ length: 8 }).map((_, idx) => buildMessage(`msg-${idx}`));

  const html = renderToStaticMarkup(
    renderWithI18n(
      <MessageToasts
        messages={messages}
        onDismissMessage={() => {}}
        onOpenMessage={() => {}}
        onMarkRead={() => {}}
      />
    )
  );

  // Should render only the first six messages by priority/turn sorting
  const renderedCount = (html.match(/Message msg-/g) || []).length;
  assert.strictEqual(renderedCount, 6);
  assert.ok(html.includes('aria-label="Dismiss"'));
};

run();
