/**
 * Shared live-text sender used by cursor chat and Markdown drafts.
 *
 * The first value is sent immediately. Changes inside the interval are
 * coalesced and the last one is sent at the trailing edge, so readers always
 * converge without turning every keystroke into a socket packet.
 */
export const LIVE_TEXT_SEND_INTERVAL_MS = 150;

export type TrailingPublisher<T> = {
  publish: (value: T) => void;
  publishNow: (value: T) => void;
  dispose: () => void;
};

export const createTrailingPublisher = <T>({
  emit,
  intervalMs = LIVE_TEXT_SEND_INTERVAL_MS,
}: {
  emit: (value: T) => void;
  intervalMs?: number;
}): TrailingPublisher<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued: T;
  let hasQueued = false;

  const flush = () => {
    timer = null;
    if (!hasQueued) return;
    hasQueued = false;
    emit(queued);
    // Keep the window open. A value published while it is open lands on the
    // next trailing edge instead of creating a second leading packet.
    timer = setTimeout(flush, intervalMs);
  };

  const publish = (value: T) => {
    queued = value;
    hasQueued = true;
    if (timer === null) flush();
  };

  const publishNow = (value: T) => {
    hasQueued = false;
    queued = value;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    emit(value);
  };

  return {
    publish,
    publishNow,
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      hasQueued = false;
    },
  };
};
