// Loom · icon set — 1.6px line icons on a 24 grid, currentColor.
// Single <Icon name size/> component. Exported to window.
const ICON_PATHS = {
  // brand woven mark — three interlacing threads
  loom: '<path d="M4 7c4 0 4 10 8 10s4-10 8-10M4 12c4 0 4 5 8 5s4-5 8-5M4 17c4 0 4-10 8-10s4 10 8 10" />',
  today: '<rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M3.5 9h17M8 3v3M16 3v3"/><circle cx="12" cy="14.5" r="2.2"/>',
  review: '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v4h-4"/>',
  cards: '<rect x="3" y="6" width="13" height="14" rx="2"/><path d="M7 3h11a2 2 0 0 1 2 2v12"/>',
  record: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  knowledge: '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M12 7.4v4.6M10.4 13.6 6.6 16M13.6 13.6 17.4 16M12 12h.01"/><circle cx="12" cy="12.6" r="0.6"/>',
  mistakes: '<path d="M10.3 4.3 2.7 17.2A2 2 0 0 0 4.4 20h15.2a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 16.5v.01"/>',
  inbox: '<path d="M4 13l2.5-7.5A2 2 0 0 1 8.4 4h7.2a2 2 0 0 1 1.9 1.5L20 13M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M4 13h5l1 2.5h4L15 13h5"/>',
  items: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  note: '<path d="M5 3.5h9l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 20V5a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M14 3.5V9h5"/>',
  graph: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="9" cy="18" r="2"/><circle cx="18" cy="17" r="2"/><path d="M7.7 7.3 7.3 16M8 6.6l8 .6M10.7 17.3 16 16.8M16.4 8.5l-6 8"/>',
  copilot: '<path d="M12 3l1.6 3.8L18 8l-3.2 2.7L15.6 15 12 12.8 8.4 15l.8-4.3L6 8l4.4-1.2Z"/><path d="M19 16.5l.7 1.6 1.8.3-1.4 1.2.4 1.8-1.5-.9-1.5.9.4-1.8-1.4-1.2 1.8-.3z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 7"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m5 9 7 7 7-7"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  flame: '<path d="M12 3c.5 3-2 4-2 6.5 0 0-2-1-2-3C6 8 4 10.5 4 14a8 8 0 0 0 16 0c0-4-3-7-5-9 .3 2.5-1 3.5-3-2Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  sparkle: '<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7Z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  link: '<path d="M9 15l6-6M10.5 6.5l1.8-1.8a4 4 0 0 1 5.7 5.7l-1.8 1.8M13.5 17.5l-1.8 1.8a4 4 0 0 1-5.7-5.7l1.8-1.8"/>',
  camera: '<rect x="3" y="6.5" width="18" height="13" rx="2.5"/><circle cx="12" cy="13" r="3.4"/><path d="M8.5 6.5 9.7 4h4.6l1.2 2.5"/>',
  text: '<path d="M5 6h14M9 6v13M7 19h4"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.5V20Z"/><path d="M14.5 8 16 9.5"/>',
  star: '<path d="M12 3.5l2.5 5.6 6.1.6-4.6 4 1.4 6L12 16.6 6.6 19.7l1.4-6-4.6-4 6.1-.6Z"/>',
  tag: '<path d="M3.5 11.5 11 4h7v7l-7.5 7.5a2 2 0 0 1-2.8 0l-4.2-4.2a2 2 0 0 1 0-2.8Z"/><circle cx="14.5" cy="7.5" r="1.3"/>',
  bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/>',
  brain: '<path d="M9 4.5A3 3 0 0 0 6 7.5 3 3 0 0 0 4.5 13 3 3 0 0 0 6 17a3 3 0 0 0 3 2.5V4.5ZM15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5A3 3 0 0 1 18 17a3 3 0 0 1-3 2.5V4.5Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17l9 5 9-5"/>',
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z"/>',
  send: '<path d="M5 12 20 4l-5 16-3.5-6.5L5 12Z"/>',
  attach: '<path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4l7-7"/>',
  dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  calendar: '<rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M3.5 9h17M8 3v3M16 3v3"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  bookmark: '<path d="M6 3.5h12V21l-6-4-6 4V3.5Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2M21 4v5h-5M21 12a9 9 0 0 1-15.5 6.2M3 20v-5h5"/>',
  wave: '<path d="M2 12c2 0 2-4 4-4s2 8 4 8 2-12 4-12 2 8 4 8 2-4 4-4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14 0 17M12 3.5c-2.5 2.5-2.5 14 0 17"/>',
  pin: '<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  hash: '<path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/>',
  quote: '<path d="M9 7c-3 0-4 2.5-4 5v5h5v-5H6.5C6.5 9 7.5 8 9 8V7ZM19 7c-3 0-4 2.5-4 5v5h5v-5h-3.5c0-2 1-3 2.5-3V7Z"/>',
  book: '<path d="M4 5.5A2 2 0 0 1 6 3.5h6V19H6a2 2 0 0 0-2 2V5.5ZM20 5.5a2 2 0 0 0-2-2h-6V19h6a2 2 0 0 1 2 2V5.5Z"/>',
};
function Icon({ name, size = 20, stroke = 1.6, className = '', style }) {
  const d = ICON_PATHS[name] || ICON_PATHS.dots;
  return (
    <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      style={style} aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />
  );
}
window.Icon = Icon;
