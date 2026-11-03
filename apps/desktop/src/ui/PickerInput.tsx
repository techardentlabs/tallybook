import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { ListPanel } from './ListPanel.tsx';

export interface Opt {
  id: number | string;
  label: string;
  sub?: string;
}

interface Props {
  value: string;
  onChange: (text: string) => void;
  options: Opt[];
  title: string;
  onPick: (o: Opt) => void;
  onCreate?: (text: string) => void;
  onNoMatch?: (text: string) => void;
  onEmptyEnter?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  placeholder?: string;
  onFocus?: () => void;
  onBackspaceEmpty?: () => void;
  disabled?: boolean;
}

function rank(options: Opt[], text: string): Opt[] {
  const q = text.trim().toLowerCase();
  if (!q) return options;
  const starts: Opt[] = [];
  const has: Opt[] = [];
  for (const o of options) {
    const l = o.label.toLowerCase();
    if (l.startsWith(q)) starts.push(o);
    else if (l.includes(q)) has.push(o);
  }
  return [...starts, ...has];
}

export function PickerInput(p: Props) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const local = useRef<HTMLInputElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [typed, setTyped] = useState(false);
  const items = useMemo(() => (typed ? rank(p.options, p.value) : p.options).slice(0, 300), [p.options, p.value, typed]);

  useEffect(() => {
    if (typed) setSel(0);
    else {
      const i = p.options.findIndex((o) => o.label === p.value);
      setSel(i >= 0 ? i : 0);
    }
  }, [p.value, p.options, typed]);
  useLayoutEffect(() => {
    if (open && local.current) setRect(local.current.getBoundingClientRect());
  }, [open, p.value]);

  const setRef = (el: HTMLInputElement | null) => {
    local.current = el;
    if (typeof p.inputRef === 'function') p.inputRef(el);
    else if (p.inputRef) (p.inputRef as { current: HTMLInputElement | null }).current = el;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
    };
    if (e.key === 'ArrowDown') {
      stop();
      setOpen(true);
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      stop();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      stop();
      if (p.value.trim() === '' && p.onEmptyEnter) {
        setOpen(false);
        p.onEmptyEnter();
        return;
      }
      const o = items[sel];
      if (o) {
        setOpen(false);
        p.onPick(o);
      } else p.onNoMatch?.(p.value);
    } else if (e.key === 'Escape' && open) {
      stop();
      setOpen(false);
    } else if (e.altKey && e.code === 'KeyC' && p.onCreate) {
      stop();
      setOpen(false);
      p.onCreate(p.value.trim());
    } else if (e.key === 'Backspace' && p.value === '' && p.onBackspaceEmpty) {
      stop();
      p.onBackspaceEmpty();
    }
  };

  return (
    <>
      <input
        ref={setRef}
        className={p.className ?? 'tb-input w-full'}
        value={p.value}
        placeholder={p.placeholder}
        disabled={p.disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setTyped(true);
          p.onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setTyped(false);
          setOpen(true);
          p.onFocus?.();
        }}
        onBlur={() => setOpen(false)}
        onMouseDown={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open &&
        createPortal(
          <ListPanel
            title={p.title}
            create={p.onCreate ? 'Create' : undefined}
            items={items.map((o) => ({ key: o.id, label: o.label, sub: o.sub }))}
            sel={sel}
            onHover={setSel}
            onPick={(i) => {
              setOpen(false);
              p.onPick(items[i]);
            }}
          />,
          document.body
        )}
    </>
  );
}
