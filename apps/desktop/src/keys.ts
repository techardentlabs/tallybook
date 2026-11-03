type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

export function keyName(e: KeyEventLike): string {
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (e.altKey && e.code) {
    if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  }
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && k.length > 1) parts.push('Shift');
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join('+');
}

export const VOUCHER_HOTKEYS: Record<string, string> = {
  F4: 'Contra',
  F5: 'Payment',
  F6: 'Receipt',
  F7: 'Journal',
  F8: 'Sales',
  F9: 'Purchase',
  'Alt+F6': 'Credit Note',
  'Alt+F5': 'Debit Note',
  'Alt+F7': 'Stock Journal',
  'Ctrl+F7': 'Physical Stock',
  'Alt+F8': 'Delivery Note',
  'Ctrl+F8': 'Sales Order',
  'Alt+F9': 'Receipt Note',
  'Ctrl+F9': 'Purchase Order',
  'Ctrl+F6': 'Rejection In',
  'Ctrl+F5': 'Rejection Out',
};

export const HOTKEY_OF_TYPE: Record<string, string> = Object.fromEntries(Object.entries(VOUCHER_HOTKEYS).map(([k, v]) => [v, k]));

export const KEYS = {
  accept: 'Ctrl+A',
  quit: 'Ctrl+Q',
  back: 'Escape',
  create: 'Alt+C',
  alter: 'Ctrl+Enter',
  date: 'F2',
  period: 'Alt+F2',
  company: 'F3',
  features: 'F11',
  configure: 'F12',
  goTo: 'Alt+G',
  export: 'Alt+E',
  import: 'Alt+O',
  print: 'Alt+P',
  deleteVoucher: 'Alt+D',
  cancelVoucher: 'Alt+X',
  duplicate: 'Alt+2',
  insert: 'Alt+I',
  addVoucher: 'Alt+A',
  removeLine: 'Alt+R',
  detailed: 'Alt+F1',
  columnar: 'Alt+C',
  basis: 'Ctrl+B',
  changeView: 'Ctrl+H',
  help: 'F1',
} as const;
