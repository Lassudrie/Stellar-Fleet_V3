import { useEffect, useRef } from 'react';
import clickSoundUrl from '../../content/audio/sounds/Blip_1.ogg';

export const useButtonClickSound = () => {
  const templateRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    templateRef.current = new Audio(clickSoundUrl);
    templateRef.current.preload = 'auto';

    const handleButtonClick = (event: MouseEvent) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const targetElement = (event.target instanceof Element
        ? event.target
        : path.find(node => node instanceof Element)) as Element | undefined;
      const button = targetElement?.closest('button, [role="button"]') ?? null;

      if (!button) {
        return;
      }

      if (button instanceof HTMLButtonElement && button.disabled) {
        return;
      }

      if (button.getAttribute('aria-disabled') === 'true') {
        return;
      }

      const audioTemplate = templateRef.current;

      if (!audioTemplate) {
        return;
      }

      const instance = audioTemplate.cloneNode(true) as HTMLAudioElement;
      instance.currentTime = 0;
      instance.volume = audioTemplate.volume;

      const playResult = instance.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {});
      }
    };

    // Capture so UI stopPropagation does not silence click feedback.
    document.addEventListener('click', handleButtonClick, { capture: true });

    return () => {
      document.removeEventListener('click', handleButtonClick, { capture: true });
    };
  }, []);
};
