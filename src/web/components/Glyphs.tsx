/** Small custom glyphs that match Telegram's visual language. */

/** Swallow (ластівка) seen from above: swept wings and a forked tail. */
const SWALLOW =
  "M48 22c3.6 0 6.3 2.9 6.3 6.4 0 1.7-.6 3.2-1.6 4.4L55.5 39C64 39.5 75 44 86 55c-10.5-2.6-21-3.6-30.2-3.2l-.9 6.6 7.9 21.1L48 67.3 33.2 79.5l7.9-21.1-.9-6.6C31 51.4 20.5 52.4 10 55c11-11 22-15.5 30.5-16l2.8-6.2a6.6 6.6 0 0 1-1.6-4.4c0-3.5 2.7-6.4 6.3-6.4z";

export function Logo({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#43b4f5" />
          <stop offset="1" stopColor="#2a8ad8" />
        </linearGradient>
      </defs>
      <circle cx="48" cy="48" r="48" fill="url(#lg)" />
      <path d={SWALLOW} fill="#fff" />
    </svg>
  );
}

export function SingleTick() {
  return (
    <svg className="tick" width="16" height="11" viewBox="0 0 16 11" aria-label="Надіслано">
      <path d="M1.5 6.2 5 9.5l8-8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DoubleTick() {
  return (
    <svg className="tick" width="19" height="11" viewBox="0 0 19 11" aria-label="Прочитано">
      <path d="M1 6.2 4.5 9.5l8-8M8.6 8.4l1.1 1.1 8-8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ClockTick() {
  return (
    <svg className="tick" width="13" height="13" viewBox="0 0 13 13" aria-label="Надсилається">
      <circle cx="6.5" cy="6.5" r="5.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 3.6v3.2l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function MoonTick() {
  return (
    <svg className="tick tick--moon" width="12" height="12" viewBox="0 0 12 12" aria-label="Чекає ранку">
      <path d="M10.6 7.6A4.9 4.9 0 0 1 4.4 1.4a4.9 4.9 0 1 0 6.2 6.2z" fill="currentColor" />
    </svg>
  );
}

/** Bubble tail; mirrored for incoming messages via CSS. */
export function Tail() {
  return (
    <svg className="bubble__tail" width="11" height="17" viewBox="0 0 11 17" aria-hidden="true">
      <path d="M0 17h11V0c0 6.5-3.6 13.4-11 17z" fill="currentColor" />
    </svg>
  );
}
