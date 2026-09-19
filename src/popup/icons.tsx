// ============ 内联 SVG 图标（与设计稿一致）============
export const Logo = ({ size = 22 }: { size?: number }) => (
  <svg className="logo" width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="1" y="1" width="22" height="22" rx="7" fill="#17A184" />
    <path d="M9.5 8.2v7.6l6.2-3.8-6.2-3.8z" fill="#fff" />
  </svg>
);

export const LogIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <rect x="2.5" y="1.5" width="11" height="13" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.2 5h5.6M5.2 8h5.6M5.2 11h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
export const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);

export const SearchIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.2" stroke="currentColor" strokeWidth="1.4" /><path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);

export const KebabIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="3" r="1.2" /><circle cx="7" cy="7" r="1.2" /><circle cx="7" cy="11" r="1.2" /></svg>
);

export const VideoThumbIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none"><rect x="2" y="4" width="16" height="12" rx="3" stroke="currentColor" strokeWidth="1.4" /><path d="M8.5 7.8v4.4l3.8-2.2-3.8-2.2z" fill="currentColor" /></svg>
);

export const AudioThumbIcon = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none"><path d="M4 12v-2a6 6 0 0112 0v2" stroke="currentColor" strokeWidth="1.4" /><rect x="3" y="11.5" width="3.4" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" /><rect x="13.6" y="11.5" width="3.4" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" /></svg>
);

export const DownloadIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1.5v7M7 8.5L4 5.7M7 8.5l3-2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" transform="rotate(180 7 7)" /><path d="M2 10.5v1a1.5 1.5 0 001.5 1.5h7a1.5 1.5 0 001.5-1.5v-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);

export const BoltIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7.8 1L3 8h3l-.8 5L10 6H7l.8-5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
);

export const ConvertIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M12 7a5 5 0 11-1.5-3.6M12 1.5v2.7H9.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" /><path d="M9.5 4.5V3A1.5 1.5 0 008 1.5H3A1.5 1.5 0 001.5 3v5A1.5 1.5 0 003 9.5h1.5" stroke="currentColor" strokeWidth="1.3" /></svg>
);

export const PreviewIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M6 2.5H3A1.5 1.5 0 001.5 4v7A1.5 1.5 0 003 12.5h7A1.5 1.5 0 0011.5 11V8M8.5 1.5h4v4M12 2L6.8 7.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const BanIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3" /><path d="M4.5 4.5l5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
);

export const LockIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><rect x="2.5" y="6" width="9" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3" /><path d="M4.5 6V4.5a2.5 2.5 0 015 0V6" stroke="currentColor" strokeWidth="1.3" /></svg>
);

export const PauseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1.5" width="2.6" height="9" rx="1" /><rect x="7.4" y="1.5" width="2.6" height="9" rx="1" /></svg>
);

export const XIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
);

export const CheckCircle = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" fill="var(--ok-soft)" /><path d="M4.3 7.2l1.9 1.9 3.5-4" stroke="var(--ok)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const FolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M1.5 3.5A1.5 1.5 0 013 2h3l1.2 1.5H11A1.5 1.5 0 0112.5 5v5A1.5 1.5 0 0111 11.5H3A1.5 1.5 0 011.5 10V3.5z" stroke="currentColor" strokeWidth="1.3" /></svg>
);

export const AlertIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ flex: 'none', marginTop: 2 }}><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.3" /><path d="M6 3.4v3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="6" cy="8.8" r=".8" fill="currentColor" /></svg>
);

export const InfoIcon = ({ size = 11 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" /><path d="M6 5.4V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="6" cy="3.4" r=".75" fill="currentColor" /></svg>
);

export const ShieldIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1.5l4.5 2v3.2c0 2.9-1.9 4.9-4.5 5.8-2.6-.9-4.5-2.9-4.5-5.8V3.5l4.5-2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M5 7l1.5 1.5L9.5 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const SearchOffIcon = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.5" /><path d="M15.8 15.8L20 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M8.5 11h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".55" /></svg>
);

export const ListIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2.5h8M2 6h8M2 9.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
);

export const ResetIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10.5 6A4.5 4.5 0 113 2.9M10.5 1.5v2.6H7.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const BackIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M7.5 1.5L3 6l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const ChevronDown = () => (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2 6.5L5 3.5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
);

export const EngIcon = () => (
  <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="1.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.2" /><path d="M5 4.2v3.6l3-1.8-3-1.8z" fill="currentColor" /></svg>
);
