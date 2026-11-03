import { useEffect, useRef, useState } from 'react';
import { MIN_GROUP_MEMBERS, companyEntryLabel, findCompanyEntry, fmtDate, todayIso, groupMemberChoices, isGroupEntry, type CompanyEntry, type CompanyIndex } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { alterGroup, createGroupCompany, currentCompanyEntry, deleteGroup, isGroupCompanyOpen, loadCompanyIndex, shutCompany, switchCompany } from '../db/companies.ts';
import { groupConsolidation } from '../db/group.ts';
import { Frame, th } from './Reports.tsx';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function GroupCompanyForm({ alterId }: { alterId?: string }) {
  const { toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const [index, setIndex] = useState<CompanyIndex | null>(null);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [focus, setFocus] = useState<'name' | 'list'>('name');
  const [sel, setSel] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const state = useRef({ name, members, focus, sel, index });
  state.current = { name, members, focus, sel, index };

  useEffect(() => {
    void loadCompanyIndex()
      .then((i) => {
        setIndex(i);
        const cur = alterId ? findCompanyEntry(i, alterId) : undefined;
        if (cur) {
          setName(cur.name);
          setMembers(cur.members ?? []);
        }
      })
      .catch((e) => toast(errText(e), 'err'));
  }, [alterId, toast]);

  useEffect(() => {
    if (focus === 'name') nameRef.current?.focus();
  }, [focus, index]);

  const choices = index ? groupMemberChoices(index, alterId) : [];
  const choicesRef = useRef(choices);
  choicesRef.current = choices;

  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  const save = async () => {
    const s = state.current;
    try {
      if (!s.name.trim()) throw new Error('Name of the Group Company is required');
      if (s.members.length < MIN_GROUP_MEMBERS) throw new Error(`Select at least ${MIN_GROUP_MEMBERS} member companies`);
      if (alterId) {
        await alterGroup(alterId, { name: s.name, members: s.members });
        toast('Group Company altered. Reload the Group Company to see the changes.', 'ok');
        nav.pop();
        return;
      }
      const entry = await createGroupCompany(s.name, s.members);
      toast(`${entry.name} created`, 'ok');
      if (await dialogs.confirm(<>Load Group Company <b>{entry.name}</b> now ?</>, { title: 'Group Company' })) await switchCompany(entry.id);
      else nav.pop();
    } catch (e) {
      toast(errText(e), 'err');
    }
  };

  const remove = async () => {
    if (!alterId) return;
    if (!(await dialogs.confirm('Delete this Group Company? The member companies are not affected.', { title: 'Delete', def: false }))) return;
    try {
      await deleteGroup(alterId);
      toast('Group Company deleted', 'ok');
      if (currentCompanyEntry()?.id === alterId) await shutCompany();
      else nav.pop();
    } catch (e) {
      toast(errText(e), 'err');
    }
  };

  useScreen({
    title: alterId ? 'Group Company Alteration' : 'Group Company Creation',
    noPeriod: true,
    keys: {
      'Ctrl+A': () => void save(),
      ...(alterId ? { 'Alt+D': () => void remove() } : {}),
      ArrowDown: () => {
        if (state.current.focus !== 'list') return false;
        setSel((x) => Math.min(choicesRef.current.length - 1, x + 1));
      },
      ArrowUp: () => {
        if (state.current.focus !== 'list') return false;
        if (state.current.sel === 0) return setFocus('name');
        setSel((x) => Math.max(0, x - 1));
      },
      Space: () => {
        if (state.current.focus !== 'list') return false;
        const c = choicesRef.current[state.current.sel];
        if (c) toggle(c.id);
      },
      Enter: () => {
        if (state.current.focus === 'name') return setFocus('list');
        const c = choicesRef.current[state.current.sel];
        if (c && !state.current.members.includes(c.id)) return toggle(c.id);
        if (state.current.sel < choicesRef.current.length - 1) return setSel((x) => x + 1);
        void save();
      },
    },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }, ...(alterId ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : [])],
  });

  if (!index) return null;
  return (
    <div className="max-w-[640px] border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 border-b border-tb-line pb-1 text-[15px] font-semibold">{alterId ? 'Group Company Alteration' : 'Group Company Creation'}</h3>
      <div className="mb-3 grid grid-cols-[160px_1fr] items-center gap-y-1">
        <span>Name</span>
        <span className="flex">
          :&nbsp;
          <input ref={nameRef} className="flex-1 border-0 bg-transparent px-1 font-bold outline-none focus:bg-tb-sel" value={name} onChange={(e) => setName(e.target.value)} onFocus={() => setFocus('name')} />
        </span>
      </div>
      <div className="tb-spaced mb-1 border-b border-tb-line">Member Companies</div>
      {choices.length < MIN_GROUP_MEMBERS && <div className="py-2 text-tb-danger">At least {MIN_GROUP_MEMBERS} companies are needed to create a Group Company.</div>}
      <ul>
        {choices.map((c, i) => (
          <li
            key={c.id}
            className={`flex cursor-pointer justify-between px-2 ${focus === 'list' && i === sel ? 'bg-tb-sel' : ''}`}
            onMouseEnter={() => focus === 'list' && setSel(i)}
            onClick={() => {
              setFocus('list');
              setSel(i);
              toggle(c.id);
            }}
          >
            <span className={members.includes(c.id) ? 'font-bold' : ''}>
              {members.includes(c.id) ? '✓ ' : '   '}
              {companyEntryLabel(c)}
            </span>
            <span className="text-tb-muted">({c.id})</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-tb-muted">
        Space selects or removes a member. Members must have the same base currency. Ledgers and groups with the same names are combined in the consolidated reports. Ctrl+A accepts{alterId ? ', Alt+D deletes the Group Company (the members are not affected)' : ''}.
      </p>
    </div>
  );
}

export function GroupCompanyAlterList() {
  const nav = useNav();
  const { toast } = useStore();
  const [groups, setGroups] = useState<CompanyEntry[] | null>(null);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    void loadCompanyIndex()
      .then((i) => setGroups(i.companies.filter((c) => isGroupEntry(c))))
      .catch((e) => toast(errText(e), 'err'));
  }, [toast]);
  const list = groups ?? [];
  const pick = (i: number) => list[i] && nav.replace(<GroupCompanyForm alterId={list[i].id} />);
  useScreen({
    title: 'Alter Group Company',
    noPeriod: true,
    keys: { ArrowDown: () => setSel((x) => Math.min(list.length - 1, x + 1)), ArrowUp: () => setSel((x) => Math.max(0, x - 1)), Enter: () => pick(sel) },
    buttons: [],
  });
  if (!groups) return null;
  return (
    <div className="max-w-[480px] border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-2 border-b border-tb-line pb-1 text-[15px] font-semibold">List of Group Companies</h3>
      {list.length === 0 && <div className="text-tb-muted">No Group Companies</div>}
      {list.map((g, i) => (
        <div key={g.id} className={`cursor-pointer px-2 font-bold ${i === sel ? 'bg-tb-sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
          {companyEntryLabel(g)}
        </div>
      ))}
    </div>
  );
}

export function GroupMembersReport() {
  const info = groupConsolidation();
  useScreen({ title: 'Member Companies', noPeriod: true, buttons: [] });
  if (!isGroupCompanyOpen() || !info) {
    return <div className="p-6">No Group Company is loaded.</div>;
  }
  const r = info.report;
  return (
    <Frame title="Member Companies" subtitle={r.name} plain>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Name of Member</th>
            <th className={`${th} text-right`}>Ledgers</th>
            <th className={`${th} text-right`}>Stock Items</th>
            <th className={`${th} text-right`}>Vouchers</th>
          </tr>
        </thead>
        <tbody>
          {r.members.map((m) => (
            <tr key={m.id}>
              <td className="px-2 font-bold">{m.name}</td>
              <td className="px-2 text-right">{m.ledgers}</td>
              <td className="px-2 text-right">{m.stock_items}</td>
              <td className="px-2 text-right">{m.vouchers}</td>
            </tr>
          ))}
          <tr className="border-t border-tb-ink font-bold">
            <td className="px-2">Group Company</td>
            <td className="px-2 text-right">{r.ledgers}</td>
            <td className="px-2 text-right" />
            <td className="px-2 text-right">{r.vouchers}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-3 text-xs text-tb-muted">
        {r.merged_ledgers} ledger(s) with the same name in more than one member are shown combined. The data is read from the member companies as on {fmtDate(todayIso())}; vouchers cannot be entered in a Group Company.
      </p>
    </Frame>
  );
}
