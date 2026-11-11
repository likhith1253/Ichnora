export function IchnoraMark({
  size = 26,
  variant = "badge",
  className,
}: {
  size?: number;
  variant?: "badge" | "mono";
  className?: string;
}) {
  if (variant === "mono") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        <path
          d="M7.5 16.5V14C7.5 10.41 10.41 7.5 14 7.5H16.5"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <path
          d="M7.5 23.5H14.5C19.47 23.5 23.5 19.47 23.5 14.5V13.5"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <path
          d="M11.5 19.5L17.5 13.5"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <circle cx="23.5" cy="8.5" r="2.6" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className ? `ichnora-mark ${className}` : "ichnora-mark"}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path
        d="M8.5 16.5V14.25C8.5 11.074 11.074 8.5 14.25 8.5H16.5"
        stroke="var(--bg)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M8.5 22.5H14.5C18.918 22.5 22.5 18.918 22.5 14.5V13.5"
        stroke="var(--bg)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M12.25 18.75L17.5 13.5"
        stroke="var(--bg)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="22.5" cy="9" r="2.35" fill="var(--mark-accent, #7cc4b5)" />
    </svg>
  );
}

