import type { SVGProps } from 'react';

/**
 * One icon family: 24px grid, 1.9 stroke, round joins. Every icon is
 * decorative by default (aria-hidden) — the control that holds it carries the
 * accessible name.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11.5" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <path d="M12 18v3" />
  </Svg>
);

export const MicOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 10.2V6a3 3 0 0 0-5.6-1.5" />
    <path d="M9 9v2.5a3 3 0 0 0 4.6 2.5" />
    <path d="M18.5 11.5a6.5 6.5 0 0 1-1.1 3.6M5.5 11.5A6.5 6.5 0 0 0 15 17.2" />
    <path d="M12 18v3" />
    <path d="M3.5 3.5l17 17" />
  </Svg>
);

export const CamIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="13.5" height="12" rx="3" />
    <path d="M16 10.5l4.6-2.6a.6.6 0 0 1 .9.5v7.2a.6.6 0 0 1-.9.5L16 13.5" />
  </Svg>
);

export const CamOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 6H13a3 3 0 0 1 3 3v3.5M16 16.2A3 3 0 0 1 13 18H5.5a3 3 0 0 1-3-3V9a3 3 0 0 1 2-2.8" />
    <path d="M16 10.5l4.6-2.6a.6.6 0 0 1 .9.5v7.2a.6.6 0 0 1-.4.6" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const ScreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
    <path d="M8.5 21h7M12 17v4" />
    <path d="M12 13.5V7.8M9.2 10.3 12 7.5l2.8 2.8" />
  </Svg>
);

export const ScreenStopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
    <path d="M8.5 21h7M12 17v4" />
    <rect x="9.5" y="8" width="5" height="5" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const LeaveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 13.8c-.5-.5-.6-1.3-.1-1.9C5.8 9.3 8.8 8 12 8s6.2 1.3 8.5 3.9c.5.6.4 1.4-.1 1.9l-1.6 1.5a1.3 1.3 0 0 1-1.7.1l-1.9-1.4a1.3 1.3 0 0 1-.5-1v-1.7a11 11 0 0 0-5.4 0V13a1.3 1.3 0 0 1-.5 1l-1.9 1.4a1.3 1.3 0 0 1-1.7-.1z" />
  </Svg>
);

export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 12a8 8 0 0 1-11.7 7.1L4 20.5l1.4-4.6A8 8 0 1 1 20.5 12z" />
  </Svg>
);

export const SmileIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.3 14.2a4.6 4.6 0 0 0 7.4 0" />
    <path d="M9 9.5h.01M15 9.5h.01" strokeWidth={2.6} />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" strokeWidth={3} />
  </Svg>
);

export const VolumeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z" />
    <path d="M15.8 9a4.2 4.2 0 0 1 0 6M18.5 6.5a7.8 7.8 0 0 1 0 11" />
  </Svg>
);

export const QualityIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20v-5M9.3 20v-8.5M14.7 20V8M20 20V4.5" />
  </Svg>
);

export const ClipboardIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="4.5" width="14" height="16.5" rx="2.5" />
    <path d="M9 4.5V3.8A.8.8 0 0 1 9.8 3h4.4a.8.8 0 0 1 .8.8v.7" />
    <path d="M8.5 11h7M8.5 15h4.5" />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="4" />
    <path d="M10.2 9.4v5.2a.5.5 0 0 0 .75.43l4.4-2.6a.5.5 0 0 0 0-.86l-4.4-2.6a.5.5 0 0 0-.75.43z" fill="currentColor" stroke="none" />
  </Svg>
);

export const BlurIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="9.2" r="3.6" />
    <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M3 5.5h.01M3 10h.01M3 14.5h.01M21 5.5h.01M21 10h.01M21 14.5h.01M6 3h.01M18 3h.01" strokeWidth={2.4} />
  </Svg>
);

export const KeyboardIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" strokeWidth={2.1} />
  </Svg>
);

export const ExpandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
  </Svg>
);

export const ShrinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
  </Svg>
);

export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
  </Svg>
);

export const PasskeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="7.5" r="4" />
    <path d="M2.5 20a6.5 6.5 0 0 1 10.6-5" />
    <circle cx="17.5" cy="13.5" r="2.6" />
    <path d="M17.5 16.1V21M17.5 19h2" />
  </Svg>
);

export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    <path d="M12 14.5v2.5" />
  </Svg>
);

export const ArrowLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
    <path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
  </Svg>
);

export const TicketIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a2.5 2.5 0 0 0 0-5z" />
    <path d="M14.5 5v2M14.5 11v2M14.5 17v2" />
  </Svg>
);

export const UsersIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 19.5a6.5 6.5 0 0 1 13 0" />
    <path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18.5 14.2a6.5 6.5 0 0 1 3 5.3" />
  </Svg>
);

export const TreeIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="5" rx="1.5" />
    <rect x="3" y="16" width="6" height="5" rx="1.5" />
    <rect x="15" y="16" width="6" height="5" rx="1.5" />
    <path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
  </Svg>
);

export const InboxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13.5 5.4 5.8A2 2 0 0 1 7.3 4.5h9.4a2 2 0 0 1 1.9 1.3L21 13.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5" />
  </Svg>
);

export const MailIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m4 7 8 6 8-6" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4.2M12 16.8h.01" strokeWidth={2.2} />
  </Svg>
);

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8h.01" strokeWidth={2.2} />
  </Svg>
);

export const SparkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5c.5 3.8 1.9 6.3 5.2 7.5.3.1.3.6 0 .7-3.3 1.2-4.7 3.7-5.2 7.8-.5-4.1-1.9-6.6-5.2-7.8-.3-.1-.3-.6 0-.7 3.3-1.2 4.7-3.7 5.2-7.5z" />
  </Svg>
);

export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.2 11.2 19 4.6a.6.6 0 0 1 .8.8l-6.6 14.8a.6.6 0 0 1-1.1-.1l-1.8-5.8a.6.6 0 0 0-.4-.4l-5.8-1.8a.6.6 0 0 1-.1-1.1z" />
    <path d="m10.4 13.6 3.9-3.9" />
  </Svg>
);

export const PopOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 4.5H19.5V10.5M19.5 4.5l-7 7" />
    <path d="M17.5 14v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H10" />
  </Svg>
);

export const PersonIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  </Svg>
);

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10.2 12 4l8 6.2V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19z" />
  </Svg>
);

export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2.3" />
    <circle cx="9" cy="17" r="2.3" />
  </Svg>
);

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 5 5.8v5.4c0 4.5 3 8.2 7 9.8 4-1.6 7-5.3 7-9.8V5.8z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const SignOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" />
    <path d="M10 8l-4 4 4 4M6 12h9.5" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v3.8h-3.8" />
  </Svg>
);

export const GlobeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const AudioWaveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h1.5M6.5 8.5v7M10 5v14M13.5 8v8M17 10v4M20.5 12H21" />
  </Svg>
);
