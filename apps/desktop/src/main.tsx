import { StrictMode, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Books,
  companyBootTarget,
  companyEntryLabel,
  companyFileFor,
  currentUser,
  findCompanyEntry,
  nextCompanyId,
  takeCompanyOpenRequest,
  type CompanyEntry,
  type CompanyIndex,
  type Db,
  ensureBanking,
  ensureCurrency,
  ensurePayroll,
  ensureSecurity,
  ensureStatutory,
  ensureStockExtras,
  ensureVClass,
} from '@tallybook/core';
import { LoginGate, SecurityProvider, VaultUnlock } from './screens/Login.tsx';
import './index.css';
import { openRegistry, type Registry } from './db/index.ts';
import { beginCompanySession, noteCompanyOpened } from './db/companies.ts';
import { StoreProvider, useStore } from './store.tsx';
import { NavProvider } from './nav.tsx';
import { DialogProvider } from './ui/Dialogs.tsx';
import { Shell, Gateway } from './App.tsx';
import { CompanyCreate } from './screens/CompanyCreate.tsx';
import { BootShell } from './screens/Companies.tsx';
import { SelectCompanyScreen } from './screens/Security.tsx';

function Slot({ top, children }: { top: boolean; children: ReactNode }) {
  const saved = useRef<HTMLElement | null>(null);
  const was = useRef(top);
  useLayoutEffect(() => {
    if (!was.current && top && saved.current && saved.current.isConnected) {
      const el = saved.current;
      setTimeout(() => el.focus(), 0);
    }
    was.current = top;
  }, [top]);
  return (
    <div
      style={{ display: top ? 'block' : 'none' }}
      onFocusCapture={(e) => {
        if (top) saved.current = e.target as HTMLElement;
      }}
    >
      {children}
    </div>
  );
}

function Failure({ error }: { error: unknown }) {
  return <pre style={{ padding: 16, color: '#b3261e' }}>{`Could not open the company data.\n${error instanceof Error ? error.message : String(error)}`}</pre>;
}

function CompanySync() {
  const { company } = useStore();
  useEffect(() => {
    if (company) void noteCompanyOpened(company).catch(() => undefined);
  }, [company?.name, company?.fy_start, company?.fy_end]);
  return null;
}

async function start(root: Root, db: Db) {
  const books = new Books(db);
  await books.init();
  books.actor = () => currentUser()?.username ?? '';
  await ensureSecurity(books.db);
  await ensureCurrency(books.db);
  await ensureStockExtras(books.db);
  await ensureVClass(books.db);
  await ensureStatutory(books.db);
  await ensureBanking(books.db);
  await ensurePayroll(books.db);
  const company = await books.company();
  root.render(
    <StrictMode>
      <StoreProvider books={books} initial={company}>
        <CompanySync />
        <DialogProvider>
          <SecurityProvider>
          <LoginGate>
          <NavProvider root={company ? <Gateway /> : <CompanyCreate />}>
            {(items) => (
              <Shell>
                {items.map((it, i) => (
                  <Slot key={it.id} top={i === items.length - 1}>
                    {it.node}
                  </Slot>
                ))}
              </Shell>
            )}
          </NavProvider>
          </LoginGate>
          </SecurityProvider>
        </DialogProvider>
      </StoreProvider>
    </StrictMode>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function launcher(root: Root, registry: Registry) {
  const fail = (e: unknown) => root.render(<Failure error={e} />);

  const select = async (status?: string) => {
    beginCompanySession(registry, null);
    const index = await registry.load();
    if (!index.companies.length) return create(index);
    root.render(
      <StrictMode>
        <BootShell status={status}>
          <NavProvider
            root={
              <SelectCompanyScreen
                index={index}
                onOpen={(c) => void open(c).catch((e) => select(errText(e)).catch(fail))}
                onCreate={() => void create(index).catch((e) => select(errText(e)).catch(fail))}
              />
            }
          >
            {(items) => items.slice(-1).map((it) => <div key={it.id}>{it.node}</div>)}
          </NavProvider>
        </BootShell>
      </StrictMode>
    );
  };

  const open = async (entry: CompanyEntry) => {
    beginCompanySession(registry, entry);
    const storage = await registry.open(entry);
    if (!storage.encrypted) return start(root, await storage.open());
    root.render(
      <StrictMode>
        <VaultUnlock
          company={companyEntryLabel(entry)}
          unlock={async (password) => {
            const db = await storage.open(password);
            await start(root, db).catch(fail);
          }}
          onCancel={() => void select().catch(fail)}
        />
      </StrictMode>
    );
  };

  const create = (index: CompanyIndex) => {
    const id = nextCompanyId(index);
    return open({ id, name: '', file: companyFileFor(id, registry.style), last_opened: null });
  };

  return { select, open, create, fail };
}

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const registry = await openRegistry();
    let index = await registry.load();
    const taken = takeCompanyOpenRequest(index);
    if (taken.request !== null) {
      index = taken.index;
      await registry.save(index);
    }
    const app = launcher(root, registry);
    const target = companyBootTarget(index, taken.request);
    if (target.kind === 'select') return await app.select();
    if (target.kind === 'create') return await app.create(index);
    const entry = findCompanyEntry(index, target.id)!;
    await app.open(entry).catch((e) => (index.companies.length > 1 ? app.select(errText(e)) : Promise.reject(e)));
  } catch (e) {
    root.render(<Failure error={e} />);
  }
}

void boot();
