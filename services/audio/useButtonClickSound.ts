import { useEffect, useRef } from 'react';
import clickSoundUrl from '../../components/audio/sounds/Blip_1.ogg';

export const useButtonClickSound = () => {
  const templateRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    templateRef.current = new Audio(clickSoundUrl);
    templateRef.current.preload = 'auto';

    const handleButtonClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest('button');

      if (!button || button.disabled) {
        return;
      }

      const audioTemplate = templateRef.current;

      if (!audioTemplate) {
        return;
      }

      const instance = audioTemplate.cloneNode(true) as HTMLAudioElement;
      instance.currentTime = 0;

      void instance.play();
    };

    document.addEventListener('click', handleButtonClick);

    return () => {
      document.removeEventListener('click', handleButtonClick);
    };
  }, []);
};
