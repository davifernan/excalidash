/**
 * The end-of-timer sound: two short sine tones, synthesized with the Web
 * Audio API rather than shipped as an audio file (NIL-578).
 *
 * That sidesteps the CC0/public-domain licensing question the ticket raised
 * entirely -- there is no third-party asset to license or attribute here,
 * and nothing is fetched from a host at runtime; it's a few oscillators.
 *
 * Browsers block audio until a user gesture has occurred in this document.
 * `primeWorkshopTimerAudio` is called from every timer control's click
 * handler (see WorkshopTimerWidget.tsx) so the AudioContext is created (and,
 * if suspended, resumed) synchronously inside that gesture -- after which
 * `playWorkshopTimerChime` can be called later, asynchronously, from a
 * socket event with no gesture of its own. A participant who only watches
 * and never touches the widget never primes it, so the room's finished
 * broadcast stays silent for them -- an explicit choice, not an oversight:
 * the alternative is a chime that plays for half the room and silently
 * fails for the other half with no way to tell which you'll get.
 */

type AudioContextCtor = typeof AudioContext;

let audioContext: AudioContext | null = null;

const resolveAudioContextCtor = (): AudioContextCtor | undefined => {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  );
};

/** Call from inside a real user gesture (click/keydown handler). Idempotent. */
export const primeWorkshopTimerAudio = (): void => {
  const Ctor = resolveAudioContextCtor();
  if (!Ctor) return;
  if (!audioContext) audioContext = new Ctor();
  if (audioContext.state === "suspended") void audioContext.resume();
};

const MUTE_STORAGE_KEY = "excalidash:workshop-timer-muted";

/** Per-viewer preference, not synced -- muting is a local decision like the widget's position. */
export const isWorkshopTimerSoundMuted = (): boolean => {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

export const setWorkshopTimerSoundMuted = (muted: boolean): void => {
  try {
    if (muted) window.localStorage.setItem(MUTE_STORAGE_KEY, "1");
    else window.localStorage.removeItem(MUTE_STORAGE_KEY);
  } catch {
    // Ignore -- private mode / disabled storage. The toggle just won't persist.
  }
};

const playTone = (ctx: AudioContext, frequency: number, startAt: number, durationSec: number) => {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.2, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSec + 0.02);
};

/**
 * A short, friendly two-note chime -- a workshop timer, not a fire alarm.
 * No-op if this viewer never primed audio with a gesture, or muted it.
 */
export const playWorkshopTimerChime = (): void => {
  if (!audioContext) return;
  if (isWorkshopTimerSoundMuted()) return;
  const ctx = audioContext;
  const now = ctx.currentTime;
  playTone(ctx, 880, now, 0.28);
  playTone(ctx, 660, now + 0.22, 0.32);
};
