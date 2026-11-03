import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  attendanceEntries,
  attendanceTypes,
  attendanceUnit,
  autofillPayroll,
  computeSalary,
  createPayrollVoucher,
  deletePayrollVoucher,
  employeeGroups,
  employees,
  fmtAmount,
  fmtDate,
  parseAmount,
  parseDate,
  parseQty,
  payHeadSide,
  payHeads,
  payrollVoucher,
  payrollVoucherTypeId,
  setAttendance,
  todayIso,
  updatePayrollVoucher,
  weekday,
  type AttendanceType,
  type Employee,
  type EmployeeGroup,
  type Ledger,
  type PayHead,
} from '@tallybook/core';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { SelectList } from './SelectList.tsx';

interface BlockLine {
  item: Opt | null;
  text: string;
  value: string;
}
interface Block {
  emp: Employee | null;
  text: string;
  lines: BlockLine[];
}
interface BlocksHandle {
  read: () => Block[];
  set: (b: Block[]) => void;
  focusFirst: () => void;
  removeLine: () => void;
  isDirty: () => boolean;
  reset: () => void;
}

const blankLine = (): BlockLine => ({ item: null, text: '', value: '' });
const blankBlock = (): Block => ({ emp: null, text: '', lines: [blankLine()] });

const EmployeeBlocks = forwardRef<
  BlocksHandle,
  {
    employeeList: Employee[];
    items: Opt[];
    itemTitle: string;
    normalize: (text: string) => string | null;
    suffix: (itemId: number | string, value: string) => string;
    suggest: (emp: Employee) => Promise<{ item: Opt; value: string }[]>;
    blockTotal?: (b: Block) => string;
    onFinish: () => void;
    onDirty: () => void;
    initial?: Block[];
    valueHeading: string;
  }
>(function EmployeeBlocks(p, handle) {
  const { toast } = useStore();
  const [blocks, setBlocks] = useState<Block[]>(p.initial?.length ? [...p.initial, blankBlock()] : [blankBlock()]);
  const ref = useRef(blocks);
  ref.current = blocks;
  const dirty = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const empOpts: Opt[] = useMemo(() => p.employeeList.map((e) => ({ id: e.id, label: e.name })), [p.employeeList]);

  const touch = () => {
    if (!dirty.current) {
      dirty.current = true;
      p.onDirty();
    }
  };
  const focus = useCallback((sel: string) => {
    setTimeout(() => {
      const el = box.current?.querySelector(`[data-cell="${sel}"]`) as HTMLInputElement | null;
      el?.focus();
      el?.select?.();
    }, 0);
  }, []);
  const patchBlock = (b: number, fn: (x: Block) => Block) => {
    touch();
    setBlocks((bs) => bs.map((x, i) => (i === b ? fn(x) : x)));
  };
  const patchLine = (b: number, j: number, q: Partial<BlockLine>) => patchBlock(b, (x) => ({ ...x, lines: x.lines.map((l, i) => (i === j ? { ...l, ...q } : l)) }));

  useImperativeHandle(
    handle,
    () => ({
      read: () => ref.current,
      set: (b) => setBlocks([...b, blankBlock()]),
      focusFirst: () => focus('e0'),
      removeLine: () =>
        setBlocks((bs) => {
          const last = bs.length - 1;
          const lines = bs[last].lines;
          if (lines.length > 1) return bs.map((x, i) => (i === last ? { ...x, lines: lines.slice(0, -1) } : x));
          return bs.length > 1 ? bs.slice(0, -1) : bs;
        }),
      isDirty: () => dirty.current,
      reset: () => {
        dirty.current = false;
        setBlocks([blankBlock()]);
        focus('e0');
      },
    }),
    [focus]
  );

  useEffect(() => {
    if (!p.initial?.length) focus('e0');
  }, [focus, p.initial]);

  const grid = 'grid grid-cols-[1fr_190px_150px] items-center';
  return (
    <div ref={box} className="flex min-h-[380px] flex-col">
      <div className={`mt-3 ${grid} border-y border-tb-line py-px font-bold`}>
        <span className="pl-1">Particulars</span>
        <span />
        <span className="pr-1 text-right">{p.valueHeading}</span>
      </div>
      <div className="flex-1 pt-2">
        {blocks.map((b, bi) => (
          <div key={bi} className="mb-1">
            <div className={grid}>
              <div className="w-[340px]">
                <PickerInput
                  className="tb-input w-full font-bold"
                  value={b.text}
                  title="Employees"
                  options={empOpts}
                  inputRef={(el) => el?.setAttribute('data-cell', `e${bi}`)}
                  onChange={(t) => patchBlock(bi, (x) => ({ ...x, text: t, emp: null }))}
                  onPick={(o) => {
                    const emp = p.employeeList.find((e) => e.id === o.id)!;
                    if (ref.current.some((x, i) => i !== bi && x.emp?.id === emp.id)) return toast('Employee is already in this voucher', 'err');
                    patchBlock(bi, (x) => ({ ...x, emp, text: emp.name }));
                    void p.suggest(emp).then((sug) => {
                      if (sug.length) patchBlock(bi, (x) => ({ ...x, lines: [...sug.map((s) => ({ item: s.item, text: s.item.label, value: s.value })), blankLine()] }));
                      focus(`i${bi}-0`);
                    });
                  }}
                  onEmptyEnter={() => (ref.current.some((x) => x.emp) ? p.onFinish() : toast('Select an employee', 'err'))}
                  onNoMatch={() => toast('Select an employee from the list', 'err')}
                  onBackspaceEmpty={() => {
                    if (bi > 0) {
                      const prev = ref.current[bi - 1];
                      focus(`v${bi - 1}-${prev.lines.length - 1}`);
                    }
                  }}
                />
              </div>
              <span />
              <span className="tb-num pr-1 font-bold">{p.blockTotal?.(b) ?? ''}</span>
            </div>
            {b.emp &&
              b.lines.map((l, j) => (
                <div key={j} className={`${grid} pl-6`}>
                  <div className="w-[320px]">
                    <PickerInput
                      className="tb-input w-full font-bold"
                      value={l.text}
                      title={p.itemTitle}
                      options={p.items}
                      inputRef={(el) => el?.setAttribute('data-cell', `i${bi}-${j}`)}
                      onChange={(t) => patchLine(bi, j, { text: t, item: null })}
                      onPick={(o) => {
                        if (b.lines.some((x, k) => k !== j && x.item?.id === o.id)) return toast(`${o.label} is already entered`, 'err');
                        patchLine(bi, j, { item: o, text: o.label });
                        if (j === b.lines.length - 1) patchBlock(bi, (x) => ({ ...x, lines: [...x.lines, blankLine()] }));
                        focus(`v${bi}-${j}`);
                      }}
                      onEmptyEnter={() => {
                        if (bi === ref.current.length - 1) setBlocks((bs) => [...bs, blankBlock()]);
                        focus(`e${bi + 1}`);
                      }}
                      onNoMatch={() => toast(`${p.itemTitle}: no match`, 'err')}
                      onBackspaceEmpty={() => (j === 0 ? focus(`e${bi}`) : focus(`v${bi}-${j - 1}`))}
                    />
                  </div>
                  <span className="pl-2 italic">{l.item ? p.suffix(l.item.id, l.value) : ''}</span>
                  <input
                    className="tb-input tb-num w-full"
                    data-cell={`v${bi}-${j}`}
                    value={l.value}
                    disabled={!l.item}
                    onChange={(e) => patchLine(bi, j, { value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        const n = p.normalize(l.value);
                        if (n === null) return toast('Enter a valid value', 'err');
                        patchLine(bi, j, { value: n });
                        focus(`i${bi}-${j + 1}`);
                      } else if (e.key === 'Backspace' && l.value === '') {
                        e.preventDefault();
                        e.stopPropagation();
                        focus(`i${bi}-${j}`);
                      }
                    }}
                  />
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
});

function VoucherShell({
  heading,
  numberText,
  dateText,
  setDateText,
  dateIso,
  dateRef,
  top,
  children,
  narration,
  setNarration,
  narrRef,
  onAccept,
  onBack,
  total,
  setDirty,
}: {
  heading: string;
  numberText: string;
  dateText: string;
  setDateText: (t: string) => void;
  dateIso: string;
  dateRef: React.RefObject<HTMLInputElement>;
  top?: React.ReactNode;
  children: React.ReactNode;
  narration: string;
  setNarration: (t: string) => void;
  narrRef: React.RefObject<HTMLInputElement>;
  onAccept: () => void;
  onBack: () => void;
  total?: string;
  setDirty: () => void;
}) {
  const { company } = useStore();
  const dialogs = useDialogs();
  return (
    <div className="-m-4 flex min-h-[calc(100vh-90px)] flex-col bg-[#fffaf0] px-2 pb-2">
      <div className="flex items-start justify-between pt-1">
        <div className="flex items-center gap-2">
          <span className="w-[120px] bg-tb-top py-px text-center font-bold text-white">{heading}</span>
          <span className="flex items-center gap-1">
            No.
            <b>{numberText}</b>
          </span>
        </div>
        <div className="text-right">
          <input
            ref={dateRef}
            className="tb-input w-28 text-right font-bold"
            value={dateText}
            onChange={(e) => {
              setDateText(e.target.value);
              setDirty();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                const iso = parseDate(dateText, company?.fy_start, dateIso);
                if (iso) {
                  setDateText(fmtDate(iso));
                  onBack();
                }
              }
            }}
          />
          <div className="pr-1">{weekday(dateIso)}</div>
        </div>
      </div>
      {top}
      {children}
      <div className="mt-3 flex items-center gap-2">
        <label>Narration:</label>
        <input
          ref={narrRef}
          className="tb-input flex-1"
          value={narration}
          onChange={(e) => {
            setNarration(e.target.value);
            setDirty();
          }}
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) onAccept();
            } else if (e.key === 'Backspace' && narration === '') {
              e.preventDefault();
              onBack();
            }
          }}
        />
        <span className="tb-num w-40 border-t border-tb-ink pr-1 text-right font-bold">{total ?? ''}</span>
      </div>
    </div>
  );
}

function useDate(initialIso?: string) {
  const { company, period } = useStore();
  const start = initialIso ?? (todayIso() >= (company?.fy_start ?? '') && todayIso() <= (company?.fy_end ?? '') ? todayIso() : period.to);
  const [dateText, setDateText] = useState(fmtDate(start));
  const iso = parseDate(dateText, company?.fy_start, start) ?? start;
  return { dateText, setDateText, iso };
}

export function PayrollVoucherScreen({ voucherId }: { voucherId?: number }) {
  const { books, company, version, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const editing = !!voucherId;
  const [heads, setHeads] = useState<PayHead[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [numberText, setNumberText] = useState('');
  const [source, setSource] = useState<Awaited<ReturnType<typeof payrollVoucher>> | null | undefined>(voucherId ? undefined : null);
  const { dateText, setDateText, iso } = useDate(source?.voucher.date);
  const [account, setAccount] = useState<Ledger | null>(null);
  const [accountText, setAccountText] = useState('');
  const [narration, setNarration] = useState('');
  const [dirty, setDirty] = useState(false);
  const blocks = useRef<BlocksHandle>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const narrRef = useRef<HTMLInputElement>(null);
  const accRef = useRef<HTMLInputElement | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    void Promise.all([payHeads(books.db), employees(books.db), books.ledgers()]).then(([h, e, l]) => {
      setHeads(h);
      setEmps(e);
      setLedgers(l);
    });
  }, [books, version]);
  useEffect(() => {
    if (voucherId) void payrollVoucher(books, voucherId).then(setSource);
  }, [books, voucherId]);
  useEffect(() => {
    if (editing) return;
    void payrollVoucherTypeId(books.db).then((id) => books.nextNumber(id)).then((n) => setNumberText(n.number));
  }, [books, editing, version]);

  const headMap = useMemo(() => new Map(heads.map((h) => [h.id, h])), [heads]);
  const items: Opt[] = useMemo(() => heads.map((h) => ({ id: h.id, label: h.name })), [heads]);
  const accountOpts: Opt[] = useMemo(() => ledgers.map((l) => ({ id: l.id, label: l.name, sub: l.group_name })), [ledgers]);

  useEffect(() => {
    if (!ledgers.length || account) return;
    if (source) {
      const l = ledgers.find((x) => x.id === source.account_ledger_id);
      if (l) (setAccount(l), setAccountText(l.name));
      setNarration(source.voucher.narration);
      setNumberText(source.voucher.number);
      setDateText(fmtDate(source.voucher.date));
    } else if (!editing) {
      const l = ledgers.find((x) => x.name.toLowerCase() === 'salary payable');
      if (l) (setAccount(l), setAccountText(l.name));
    }
  }, [ledgers, source, account, editing, setDateText]);

  const initial: Block[] | undefined = useMemo(() => {
    if (!source || !heads.length || !emps.length) return undefined;
    const byEmp = new Map<number, Block>();
    for (const l of source.lines) {
      const e = emps.find((x) => x.id === l.employee_id)!;
      const b = byEmp.get(l.employee_id) ?? { emp: e, text: e.name, lines: [] };
      b.lines.push({ item: { id: l.pay_head_id, label: l.pay_head }, text: l.pay_head, value: fmtAmount(l.amount, false) });
      byEmp.set(l.employee_id, b);
    }
    return [...byEmp.values()].map((b) => ({ ...b, lines: [...b.lines, blankLine()] }));
  }, [source, heads, emps]);

  const side = (id: number | string) => {
    const h = headMap.get(Number(id));
    return h && payHeadSide(h.ph_type) === 'ded' ? 'Cr' : 'Dr';
  };
  const blockNet = (b: Block) => {
    let net = 0;
    for (const l of b.lines) {
      const h = l.item ? headMap.get(Number(l.item.id)) : undefined;
      const v = parseAmount(l.value) ?? 0;
      if (!h) continue;
      const s = payHeadSide(h.ph_type);
      if (s === 'ded') net -= v;
      else if (s === 'earn' && h.affect_net) net += v;
    }
    return net;
  };
  const blockTotal = (b: Block) => (b.emp && blockNet(b) ? `${fmtAmount(Math.abs(blockNet(b)))} ${blockNet(b) > 0 ? 'Dr' : 'Cr'}` : '');

  const total = () => {
    const bs = blocks.current?.read() ?? [];
    const sum = bs.reduce((s, b) => s + blockNet(b), 0);
    return sum ? `${fmtAmount(Math.abs(sum))} ${sum > 0 ? 'Cr' : 'Dr'}` : '';
  };

  const save = async () => {
    if (saving.current) return;
    if (!account) return toast('Select the payroll ledger account', 'err');
    const bs = (blocks.current?.read() ?? []).filter((b) => b.emp);
    const employeesIn = bs
      .map((b) => ({ employee_id: b.emp!.id, lines: b.lines.filter((l) => l.item && parseAmount(l.value)).map((l) => ({ pay_head_id: Number(l.item!.id), amount: parseAmount(l.value)! })) }))
      .filter((b) => b.lines.length);
    if (!employeesIn.length) return toast('Enter at least one pay head amount', 'err');
    saving.current = true;
    try {
      const input = { date: iso, narration, account_ledger_id: account.id, employees: employeesIn };
      if (editing) {
        await updatePayrollVoucher(books, voucherId!, input);
        bump();
        toast('Payroll voucher altered', 'ok');
        nav.pop();
      } else {
        const v = await createPayrollVoucher(books, input);
        bump();
        toast(`Payroll voucher No. ${v.voucher.number} saved`, 'ok');
        setNarration('');
        setDirty(false);
        blocks.current?.reset();
      }
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      saving.current = false;
    }
  };

  const leave = async () => {
    if (dirty || blocks.current?.isDirty()) {
      if (!(await dialogs.confirm('Quit ?', { title: 'Quit', def: false }))) return;
    }
    nav.pop();
  };
  const remove = async () => {
    if (!editing) return;
    if (!(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await deletePayrollVoucher(books, voucherId!);
      bump();
      toast('Voucher deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const autofill = () => nav.push(<AutofillPicker onPick={(groupId) => void runAutofill(groupId)} />);
  const runAutofill = async (groupId: number | null) => {
    const list = await autofillPayroll(books.db, iso, { group_id: groupId });
    if (!list.length) return toast('No salary details found for the selected employees', 'err');
    const rows: Block[] = list.map((e) => {
      const emp = emps.find((x) => x.id === e.employee_id)!;
      return { emp, text: emp.name, lines: [...e.lines!.map((l) => ({ item: { id: l.pay_head_id, label: headMap.get(l.pay_head_id)!.name }, text: headMap.get(l.pay_head_id)!.name, value: fmtAmount(l.amount, false) })), blankLine()] };
    });
    blocks.current?.set(rows);
    setDirty(true);
    setNarration((n) => n || `Pay Period : ${fmtDate(iso.slice(0, 8) + '01')} to ${fmtDate(iso)}`);
  };

  useScreen({
    title: editing ? 'Payroll Voucher Alteration' : 'Payroll Voucher Creation',
    kind: 'voucher',
    keys: {
      'Ctrl+A': () => void save(),
      Escape: () => void leave(),
      F2: () => {
        dateRef.current?.focus();
        dateRef.current?.select();
      },
      'Ctrl+F': () => autofill(),
      'Alt+D': () => (editing ? void remove() : false),
      'Alt+R': () => blocks.current?.removeLine(),
    },
    buttons: [
      { key: 'F2', label: 'Date', run: () => dateRef.current?.focus() },
      { key: 'Ctrl+F', label: 'Autofill', run: autofill },
      { key: 'Alt+R', label: 'Remove Line', run: () => blocks.current?.removeLine() },
      ...(editing ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : []),
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
    ],
  });
  void company;
  if (source === undefined || (editing && !initial)) return null;

  return (
    <VoucherShell
      heading="Payroll"
      numberText={numberText}
      dateText={dateText}
      setDateText={setDateText}
      dateIso={iso}
      dateRef={dateRef}
      narration={narration}
      setNarration={setNarration}
      narrRef={narrRef}
      onAccept={() => void save()}
      onBack={() => (accRef.current ? (accRef.current.focus(), accRef.current.select()) : blocks.current?.focusFirst())}
      setDirty={() => setDirty(true)}
      total={total()}
      top={
        <div className="mt-3 flex items-center">
          <span className="w-24">Account</span>
          <span className="mr-2">:</span>
          <div className="w-[360px]">
            <PickerInput
              className="tb-input w-full font-bold"
              value={accountText}
              title="Ledger Accounts"
              options={accountOpts}
              inputRef={(el) => (accRef.current = el)}
              onChange={(t) => {
                setAccountText(t);
                setAccount(null);
                setDirty(true);
              }}
              onPick={(o) => {
                const l = ledgers.find((x) => x.id === o.id)!;
                setAccount(l);
                setAccountText(l.name);
                blocks.current?.focusFirst();
              }}
              onNoMatch={() => toast('Select the account from the list', 'err')}
              onCreate={(text) => window.dispatchEvent(new CustomEvent('tb:create-ledger', { detail: { text, rowIndex: -1 } }))}
            />
          </div>
        </div>
      }
    >
      <EmployeeBlocks
        key={initial ? 'loaded' : 'new'}
        ref={blocks}
        employeeList={emps}
        items={items}
        itemTitle="Pay Heads"
        valueHeading="Amount"
        initial={initial}
        normalize={(t) => {
          const p = parseAmount(t);
          return p === null ? null : p ? fmtAmount(p, false) : '';
        }}
        suffix={(id, v) => (parseAmount(v) ? side(id) : '')}
        suggest={async (emp) => (await computeSalary(books.db, emp.id, iso)).filter((l) => l.amount > 0).map((l) => ({ item: { id: l.pay_head_id, label: l.name }, value: fmtAmount(l.amount, false) }))}
        blockTotal={blockTotal}
        onFinish={() => narrRef.current?.focus()}
        onDirty={() => setDirty(true)}
      />
    </VoucherShell>
  );
}

function AutofillPicker({ onPick }: { onPick: (groupId: number | null) => void }) {
  const { books } = useStore();
  const [groups, setGroups] = useState<EmployeeGroup[]>([]);
  useEffect(() => void employeeGroups(books.db).then(setGroups), [books]);
  return (
    <SelectList
      title="Payroll Autofill"
      heading="List of Employee Groups"
      popOnSelect
      items={[{ id: 0, label: 'All Items' }, ...groups.map((g) => ({ id: g.id, label: g.name }))]}
      onSelect={(i) => onPick(Number(i.id) || null)}
    />
  );
}

export function AttendanceVoucherScreen() {
  const { books, company, version, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const [types, setTypes] = useState<AttendanceType[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const { dateText, setDateText, iso } = useDate();
  const [narration, setNarration] = useState('');
  const [dirty, setDirty] = useState(false);
  const blocks = useRef<BlocksHandle>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const narrRef = useRef<HTMLInputElement>(null);
  const isoRef = useRef(iso);
  isoRef.current = iso;

  useEffect(() => {
    void Promise.all([attendanceTypes(books.db), employees(books.db)]).then(([t, e]) => {
      setTypes(t);
      setEmps(e);
    });
  }, [books, version]);
  const typeMap = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const items: Opt[] = useMemo(() => types.map((t) => ({ id: t.id, label: t.name })), [types]);

  const save = async () => {
    const bs = (blocks.current?.read() ?? []).filter((b) => b.emp);
    let n = 0;
    try {
      for (const b of bs) {
        for (const l of b.lines) {
          if (!l.item) continue;
          const value = parseQty(l.value || '0');
          if (value === null) throw new Error(`${l.item.label}: enter a valid value`);
          await setAttendance(books.db, { employee_id: b.emp!.id, type_id: Number(l.item.id), date: isoRef.current, value });
          n += 1;
        }
      }
      if (!n) return toast('Enter at least one attendance/production value', 'err');
      bump();
      toast('Attendance voucher saved', 'ok');
      setNarration('');
      setDirty(false);
      blocks.current?.reset();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const leave = async () => {
    if (dirty || blocks.current?.isDirty()) {
      if (!(await dialogs.confirm('Quit ?', { title: 'Quit', def: false }))) return;
    }
    nav.pop();
  };
  useScreen({
    title: 'Attendance Voucher Creation',
    kind: 'voucher',
    keys: {
      'Ctrl+A': () => void save(),
      Escape: () => void leave(),
      F2: () => {
        dateRef.current?.focus();
        dateRef.current?.select();
      },
      'Alt+R': () => blocks.current?.removeLine(),
    },
    buttons: [
      { key: 'F2', label: 'Date', run: () => dateRef.current?.focus() },
      { key: 'Alt+R', label: 'Remove Line', run: () => blocks.current?.removeLine() },
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
    ],
  });
  void company;
  const unitOf = (id: number | string) => {
    const t = typeMap.get(Number(id));
    return t ? attendanceUnit(t) : '';
  };
  return (
    <VoucherShell
      heading="Attendance"
      numberText="1"
      dateText={dateText}
      setDateText={setDateText}
      dateIso={iso}
      dateRef={dateRef}
      narration={narration}
      setNarration={setNarration}
      narrRef={narrRef}
      onAccept={() => void save()}
      onBack={() => blocks.current?.focusFirst()}
      setDirty={() => setDirty(true)}
    >
      <EmployeeBlocks
        ref={blocks}
        employeeList={emps}
        items={items}
        itemTitle="Attendance/Production Types"
        valueHeading="Value"
        normalize={(t) => {
          const q = parseQty(t || '0');
          return q === null ? null : q ? String(q / 1000) : '';
        }}
        suffix={(id) => unitOf(id)}
        suggest={async (emp) => {
          const have = (await attendanceEntries(books.db, isoRef.current)).filter((r) => r.employee_id === emp.id);
          return have.flatMap((r) => {
            const t = typeMap.get(r.type_id);
            return t ? [{ item: { id: t.id, label: t.name }, value: String(r.value / 1000) }] : [];
          });
        }}
        onFinish={() => narrRef.current?.focus()}
        onDirty={() => setDirty(true)}
      />
    </VoucherShell>
  );
}
