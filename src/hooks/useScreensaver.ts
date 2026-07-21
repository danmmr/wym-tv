import {useRef, useCallback} from 'react';

export const useScreensaver = (
  onScreensaverTrigger: () => void,
  timeoutMs: number = 5 * 60 * 1000, // 5 minutes
) => {
  const timerRef = useRef<NodeJS.Timeout>();

  const resetTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(onScreensaverTrigger, timeoutMs);
  }, [onScreensaverTrigger, timeoutMs]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  }, []);

  return {resetTimer, clearTimer};
};
