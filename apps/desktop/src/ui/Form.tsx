import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fmtAmount, fmtDate, parseAmount, parseDate } from '@tallybook/core';
import { PickerInput, type Opt } from './PickerInput.tsx';
import { useStore } from '../store.tsx';

export type FieldKind = 'text' | 'upper' | 'date' | 'amount' | 'picker' | 'toggle';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Values = Record<string, any>;

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: Opt[];
  title?: string;
  create?: (text: string, done: (o: Opt) => void) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initial?: any;
  visible?: (v: Values) => boolean;
  note?: string;
  validate?: (v: Values) => string | null;
  maxLength?: number;
  heading?: string;
}

export interface FormHandle {
  submit: () => Values | null;
  focusKey: (key: string) => void;
  read: () => Values;
}

interface Props {
  fields: FieldDef[];
  onDone: (v: Values) => void;
  labelWidth?: number;
}

export const Form = forwardRef<FormHandle, Props>(function Form({ fields, onDone, labelWidth = 220 }, handle) {
  const { company, toast } = useStore();
  const fy = company?.fy_start;
  const [texts, setTexts] = useState<Record<string, string>>(() => {
    const t: Record<string, string> = {};
    for (const f of fields) {
      const i = f.initial;
      if (f.kind === 'picker') t[f.key] = i ? (i as Opt).label : '';
      else if (f.kind === 'date') t[f.key] = i ? fmtDate(i as string) : '';
      else if (f.kind === 'amount') t[f.key] = i ? fmtAmount(i as number) : '';
      else if (f.kind === 'toggle') t[f.key] = i ? 'Yes' : 'No';
      else t[f.key] = i ? String(i) : '';
    }
    return t;
  });
  const [picked, setPicked] = useState<Record<string, Opt | null>>(() => Object.fromEntries(fields.filter((f) => f.kind === 'picker').map((f) => [f.key, (f.initial as Opt) ?? null])));
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const stateRef = useRef({ texts, picked });
  stateRef.current = { texts, picked };

  const read = useCallback((): Values => {
    const { texts: t, picked: p } = stateRef.current;
    const v: Values = {};
    for (const f of fieldsRef.current) {
      const text = t[f.key] ?? '';
      if (f.kind === 'picker') v[f.key] = p[f.key]?.id ?? null;
      else if (f.kind === 'date') v[f.key] = parseDate(text, fy, typeof f.initial === 'string' ? f.initial : undefined);
      else if (f.kind === 'amount') v[f.key] = parseAmount(text) ?? 0;
      else if (f.kind === 'toggle') v[f.key] = text === 'Yes';
      else v[f.key] = f.kind === 'upper' ? text.trim().toUpperCase() : text.trim();
    }
    return v;
  }, [fy]);

  const visibleKeys = useCallback((): string[] => {
    const v = read();
    return fieldsRef.current.filter((f) => !f.visible || f.visible(v)).map((f) => f.key);
  }, [read]);

  const commit = useCallback(
    (key: string): boolean => {
      const f = fieldsRef.current.find((x) => x.key === key)!;
      const text = (stateRef.current.texts[key] ?? '').trim();
      const fail = (m: string) => {
        toast(m, 'err');
        return false;
      };
      if (f.kind === 'picker') {
        if (!stateRef.current.picked[key]) return f.required ? fail(`${f.label}: choose from the list`) : true;
        return true;
      }
      if (f.kind === 'date') {
        const iso = parseDate(text, fy, typeof f.initial === 'string' ? f.initial : undefined);
        if (!iso) return fail(`${f.label}: invalid date`);
        setTexts((t) => ({ ...t, [key]: fmtDate(iso) }));
        stateRef.current.texts = { ...stateRef.current.texts, [key]: fmtDate(iso) };
        return true;
      }
      if (f.kind === 'amount') {
        const p = parseAmount(text);
        if (p === null || (f.required && !p)) return fail(`${f.label}: enter a valid amount`);
        const shown = p ? fmtAmount(p) : '';
        setTexts((t) => ({ ...t, [key]: shown }));
        stateRef.current.texts = { ...stateRef.current.texts, [key]: shown };
        return true;
      }
      if (f.kind === 'toggle') return true;
      if (f.required && !text) return fail(`${f.label} is required`);
      return true;
    },
    [fy, toast]
  );

  const focusKey = useCallback((key: string) => {
    const el = refs.current[key];
    if (el) {
      el.focus();
      el.select?.();
    }
  }, []);

  const move = useCallback(
    (from: string, dir: 1 | -1) => {
      setTimeout(() => {
        const keys = visibleKeys();
        const i = keys.indexOf(from);
        const next = keys[i + dir];
        if (next) focusKey(next);
      }, 0);
    },
    [focusKey, visibleKeys]
  );

  const submit = useCallback((): Values | null => {
    for (const k of visibleKeys()) {
      if (!commit(k)) {
        focusKey(k);
        return null;
      }
    }
    const v = read();
    for (const f of fieldsRef.current) {
      if (f.visible && !f.visible(v)) continue;
      const msg = f.validate?.(v);
      if (msg) {
        toast(msg, 'err');
        focusKey(f.key);
        return null;
      }
    }
    return v;
  }, [commit, focusKey, read, toast, visibleKeys]);

  useImperativeHandle(handle, () => ({ submit, focusKey, read }), [submit, focusKey, read]);

  const advance = (key: string) => {
    if (!commit(key)) return;
    const keys = visibleKeys();
    const last = keys[keys.length - 1] === key;
    if (last) {
      const v = submit();
      if (v) onDone(v);
    } else {
      toast('');
      move(key, 1);
    }
  };

  useEffect(() => {
    const first = visibleKeys()[0];
    if (first) setTimeout(() => focusKey(first), 0);
  }, [focusKey, visibleKeys]);

  const onKey = (key: string, kind: FieldKind) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (kind === 'toggle') {
      if (/^[yY]$/.test(e.key) || e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || /^[nN]$/.test(e.key)) {
        e.preventDefault();
        setTexts((t) => {
          const cur = t[key] === 'Yes';
          const next = /^[yY]$/.test(e.key) ? true : /^[nN]$/.test(e.key) ? false : !cur;
          return { ...t, [key]: next ? 'Yes' : 'No' };
        });
        return;
      }
    }
    if (kind !== 'picker' && e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      advance(key);
    } else if (e.key === 'Backspace' && (e.currentTarget.value === '' || kind === 'toggle')) {
      e.preventDefault();
      e.stopPropagation();
      move(key, -1);
    } else if (e.key === 'ArrowUp' && kind !== 'picker') {
      e.preventDefault();
      move(key, -1);
    } else if (e.key === 'ArrowDown' && kind !== 'picker') {
      e.preventDefault();
      move(key, 1);
    }
  };

  const v = useMemo(() => read(), [read, texts, picked]);

  return (
    <div>
      {fields.map((f) => {
        if (f.visible && !f.visible(v)) return null;
        return (
          <div key={f.key}>
            {f.heading ? <div className="mb-1 mt-3 text-xs font-bold uppercase tracking-wider text-tb-muted">{f.heading}</div> : null}
            <div className="mb-1 flex items-center">
              <label className="shrink-0" style={{ width: labelWidth }}>
                {f.label}
              </label>
              {f.kind === 'picker' ? (
                <div className="flex-1">
                  <PickerInput
                    inputRef={(el) => (refs.current[f.key] = el)}
                    value={texts[f.key] ?? ''}
                    title={f.title ?? f.label}
                    options={f.options ?? []}
                    onChange={(t) => {
                      setTexts((s) => ({ ...s, [f.key]: t }));
                      setPicked((s) => ({ ...s, [f.key]: null }));
                    }}
                    onPick={(o) => {
                      setTexts((s) => ({ ...s, [f.key]: o.label }));
                      setPicked((s) => ({ ...s, [f.key]: o }));
                      stateRef.current = { texts: { ...stateRef.current.texts, [f.key]: o.label }, picked: { ...stateRef.current.picked, [f.key]: o } };
                      advance(f.key);
                    }}
                    onCreate={f.create ? (text) => f.create!(text, (o) => {
                      setTexts((s) => ({ ...s, [f.key]: o.label }));
                      setPicked((s) => ({ ...s, [f.key]: o }));
                      stateRef.current = { texts: { ...stateRef.current.texts, [f.key]: o.label }, picked: { ...stateRef.current.picked, [f.key]: o } };
                      advance(f.key);
                    }) : undefined}
                    onEmptyEnter={f.required ? undefined : () => advance(f.key)}
                    onNoMatch={() => toast(`${f.label}: no match`, 'err')}
                    onBackspaceEmpty={() => move(f.key, -1)}
                  />
                </div>
              ) : (
                <input
                  ref={(el) => {
                    refs.current[f.key] = el;
                  }}
                  className={`tb-input flex-1 ${f.kind === 'amount' ? 'tb-num' : ''}`}
                  value={texts[f.key] ?? ''}
                  readOnly={f.kind === 'toggle'}
                  maxLength={f.maxLength}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTexts((s) => ({ ...s, [f.key]: e.target.value }))}
                  onKeyDown={onKey(f.key, f.kind)}
                />
              )}
              {f.note ? <span className="ml-3 text-xs text-tb-muted">{f.note}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
});
