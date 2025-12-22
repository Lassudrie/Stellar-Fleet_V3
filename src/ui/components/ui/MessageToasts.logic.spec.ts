import assert from 'node:assert';
import { computeHiddenToastState, selectActiveToastMessages } from './MessageToasts';
import { GameMessage } from '../../../shared/types';

{
  const initial = new Set<string>();
  const { next, changed } = computeHiddenToastState(initial, 'm1');
  assert.strictEqual(changed, true, 'First hide should be reported as changed');
  assert.ok(next.has('m1'), 'Toast id should be added to hidden set');
}

{
  const initial = new Set<string>(['m1']);
  const { next, changed } = computeHiddenToastState(initial, 'm1');
  assert.strictEqual(changed, false, 'Hiding the same toast twice should be ignored');
  assert.strictEqual(next, initial, 'Hidden set should be reused when nothing changes');
}

{
  const messages: GameMessage[] = [
    {
      id: 'toast-1',
      day: 1,
      createdAtTurn: 10,
      priority: 1,
      read: false,
      dismissed: false,
      title: 'Status report',
      subtitle: 'Automated update',
      type: 'status',
      lines: ['All systems nominal.'],
      payload: {}
    }
  ];

  const hidden = computeHiddenToastState(new Set<string>(), 'toast-1').next;
  const activeToasts = selectActiveToastMessages(messages, hidden);
  assert.strictEqual(activeToasts.length, 0, 'Auto-hidden toast should not render again');

  const visibleMessages = messages.filter(msg => !msg.dismissed);
  assert.strictEqual(visibleMessages.length, 1, 'Auto-hidden toast should remain in the message list');
}

console.log('MessageToasts logic tests passed');
