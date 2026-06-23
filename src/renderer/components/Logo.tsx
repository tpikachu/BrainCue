import type React from 'react';

/* The app logo (speech-bubble + "B" monogram), matching resources/icon.svg.
 * Rendered inline so it stays crisp at any size and can be wrapped with the
 * animated gradient ring (see `.logo-ring` in index.css). */

export function LogoMark({ className = '', ...rest }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7C7DF7" />
          <stop offset="0.5" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#3A2FB0" />
        </linearGradient>
        <linearGradient id="logo-spark" x1="384" y1="318" x2="640" y2="574" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#7C7DF7" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="1024" height="1024" rx="232" fill="url(#logo-bg)" />
      <rect x="0" y="0" width="1024" height="512" rx="232" fill="#FFFFFF" opacity="0.06" />
      <ellipse cx="512" cy="712" rx="262" ry="46" fill="#000000" opacity="0.18" />

      <path
        d="M326 250 H698 A104 104 0 0 1 802 354 V566 A104 104 0 0 1 698 670 H470
           L332 778 L378 670 H326 A104 104 0 0 1 222 566 V354 A104 104 0 0 1 326 250 Z"
        fill="#FFFFFF"
      />

      <g
        stroke="url(#logo-spark)"
        strokeWidth="40"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M452 350 V566" />
        <path d="M452 350 H512 C566 350 566 454 512 454 H452" />
        <path d="M452 454 H536 C594 454 594 566 536 566 H452" />
      </g>

      <path
        d="M648 356 Q658 404 698 412 Q658 420 648 468 Q638 420 598 412 Q638 404 648 356 Z"
        fill="#A5A6FB"
      />
      <path
        d="M392 522 Q399 556 428 562 Q399 568 392 602 Q385 568 356 562 Q385 556 392 522 Z"
        fill="#C7C8FD"
      />
    </svg>
  );
}

/** App logo wrapped in an animated, rotating gradient ring — for the dashboard. */
export function Logo({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <span className="logo-ring inline-flex shrink-0">
      <LogoMark className={`${className} rounded-[22%]`} />
    </span>
  );
}
