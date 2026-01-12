import { useEffect, useRef } from 'react';
import clickSoundUrl from '../../content/audio/sounds/Blip_1.ogg';

export const useButtonClickSound = () => {
  const templateRef = useRef<HTMLAudioElement | null>(null);
  const lastPointerUpRef = useRef(0);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const audioTemplate = new Audio(clickSoundUrl);
    audioTemplate.preload = 'auto';
    audioTemplate.load();
    templateRef.current = audioTemplate;

    const findButtonTarget = (event: Event): Element | null => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const targetElement = (event.target instanceof Element
        ? event.target
        : path.find(node => node instanceof Element)) as Element | undefined;
      return targetElement?.closest('button, [role="button"]') ?? null;
    };

    const isDisabledButton = (button: Element): boolean => {
      if (button instanceof HTMLButtonElement && button.disabled) {
        return true;
      }
      return button.getAttribute('aria-disabled') === 'true';
    };

    const playClickSound = (event: Event) => {
      const button = findButtonTarget(event);
      if (!button || isDisabledButton(button)) {
        return;
      }

      const currentTemplate = templateRef.current;
      if (!currentTemplate) {
        return;
      }

      const instance = currentTemplate.cloneNode(true) as HTMLAudioElement;
      const sourceUrl = currentTemplate.currentSrc || currentTemplate.src || clickSoundUrl;
      if (instance.src !== sourceUrl) {
        instance.src = sourceUrl;
      }
      instance.currentTime = 0;
      instance.volume = currentTemplate.volume;

      const playResult = instance.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {});
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      lastPointerUpRef.current = event.timeStamp;
      playClickSound(event);
    };

    const handleClick = (event: MouseEvent) => {
      const lastPointerUpAt = lastPointerUpRef.current;
      if (lastPointerUpAt > 0 && event.detail > 0 && event.timeStamp - lastPointerUpAt < 700) {
        return;
      }
      playClickSound(event);
    };

    // Capture so UI stopPropagation does not silence click feedback.
    document.addEventListener('pointerup', handlePointerUp, { capture: true });
    document.addEventListener('click', handleClick, { capture: true });

    return () => {
      document.removeEventListener('pointerup', handlePointerUp, { capture: true });
      document.removeEventListener('click', handleClick, { capture: true });
    };
  }, []);
};
