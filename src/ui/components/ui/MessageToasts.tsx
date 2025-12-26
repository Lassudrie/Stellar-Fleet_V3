import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameMessage } from '../../../shared/types';
import { useI18n } from '../../i18n';
import { sorted } from '../../../shared/sorting';

interface MessageToastsProps {
  messages: GameMessage[];
  onOpenMessage: (message: GameMessage) => void;
  onMarkRead: (messageId: string, read: boolean) => void;
}

const AUTO_DISMISS_MS = 8000;
const safeSetTimeout = typeof window !== 'undefined' && window.setTimeout ? window.setTimeout : setTimeout;
const safeClearTimeout = typeof window !== 'undefined' && window.clearTimeout ? window.clearTimeout : clearTimeout;
const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

export const computeHiddenToastState = (previous: Set<string>, messageId: string): { next: Set<string>; changed: boolean } => {
  if (previous.has(messageId)) return { next: previous, changed: false };
  const next = new Set(previous);
  next.add(messageId);
  return { next, changed: true };
};

export const selectActiveToastMessages = (messages: GameMessage[], hiddenToastIds: Set<string>): GameMessage[] => {
  return sorted(
    messages.filter(msg => !msg.dismissed && !hiddenToastIds.has(msg.id)),
    (a, b) => {
      const turnDiff = b.createdAtTurn - a.createdAtTurn;
      if (turnDiff !== 0) return turnDiff;
      const priorityDiff = b.priority - a.priority;
      if (priorityDiff !== 0) return priorityDiff;
      return compareIds(b.id, a.id);
    }
  ).slice(0, 6);
};

const MessageToasts: React.FC<MessageToastsProps> = ({
  messages,
  onOpenMessage,
  onMarkRead
}) => {
  const { t } = useI18n();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [hiddenToastIds, setHiddenToastIds] = useState<Set<string>>(new Set());

  const hideToast = useCallback((messageId: string, options?: { markRead?: boolean }) => {
    if (options?.markRead) {
      onMarkRead(messageId, true);
    }
    setHiddenToastIds(prev => computeHiddenToastState(prev, messageId).next);
  }, [onMarkRead]);

  useEffect(() => {
    const knownIds = new Set(messages.map(msg => msg.id));
    setHiddenToastIds(prev => {
        const next = new Set(Array.from(prev).filter(id => knownIds.has(id)));
        return next.size === prev.size ? prev : next;
    });
  }, [messages]);

  const activeMessages = useMemo(() => {
    return selectActiveToastMessages(messages, hiddenToastIds);
  }, [messages, hiddenToastIds]);

  useEffect(() => {
    activeMessages.forEach(message => {
      if (hoveredId === message.id) {
        if (timersRef.current[message.id]) {
          safeClearTimeout(timersRef.current[message.id]);
          delete timersRef.current[message.id];
        }
        return;
      }

      if (!timersRef.current[message.id]) {
        timersRef.current[message.id] = safeSetTimeout(() => {
          hideToast(message.id, { markRead: true });
          delete timersRef.current[message.id];
        }, AUTO_DISMISS_MS);
      }
    });

    Object.keys(timersRef.current).forEach(id => {
      if (!activeMessages.find(msg => msg.id === id)) {
        safeClearTimeout(timersRef.current[id]);
        delete timersRef.current[id];
      }
    });

    return () => {
      Object.values(timersRef.current).forEach(timer => safeClearTimeout(timer));
      timersRef.current = {};
    };
  }, [activeMessages, hideToast, hoveredId]);

  if (activeMessages.length === 0) return null;

  return (
    <div className="absolute top-4 right-4 z-40 pointer-events-none flex flex-col gap-2 w-80">
      {activeMessages.map(message => (
        <div
          key={message.id}
          className="pointer-events-auto bg-slate-900/90 border border-slate-700 rounded-lg shadow-lg p-3 text-sm text-slate-200 hover:border-blue-400/70 transition-colors group"
          onMouseEnter={() => setHoveredId(message.id)}
          onMouseLeave={() => setHoveredId(prev => (prev === message.id ? null : prev))}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 cursor-pointer" onClick={() => onOpenMessage(message)}>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${message.read ? 'bg-slate-600' : 'bg-amber-400 animate-pulse'}`} />
                <span className="text-[10px] uppercase text-slate-500 font-mono">
                  {t('ui.turn')} {message.day}
                </span>
                <span className={`text-[10px] uppercase px-2 py-0.5 rounded-full border ${message.priority >= 2 ? 'border-amber-500 text-amber-400' : 'border-slate-700 text-slate-400'}`}>
                  {message.priority >= 2 ? t('messages.priority.high') : t('messages.priority.normal')}
                </span>
              </div>
              <div className="mt-2">
                <div className="font-bold text-white leading-tight">{message.title}</div>
                <div className="text-xs text-slate-400">{message.subtitle}</div>
              </div>
              <ul className="mt-2 space-y-1">
                {message.lines.map((line, idx) => (
                  <li key={idx} className="text-xs text-slate-300 leading-tight">• {line}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col items-end gap-1">
              <button
                aria-label={t('messages.markRead')}
                onClick={() => onMarkRead(message.id, !message.read)}
                className="text-[10px] text-blue-300 hover:text-blue-100 px-2 py-1 rounded bg-blue-900/30 border border-blue-800/50 transition-colors"
              >
                {message.read ? t('messages.markUnread') : t('messages.markRead')}
              </button>
              <button
                aria-label={t('messages.hideToast')}
                onClick={(e) => { e.stopPropagation(); hideToast(message.id, { markRead: true }); }}
                className="text-slate-400 hover:text-white transition-colors"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default MessageToasts;
