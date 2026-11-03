import { StrictMode, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Books, currentUser, type Db, ensureBanking, ensureCurrency, ensurePayroll, ensureSecurity, ensureStatutory, ensureStockExtras, ensureVClass } from '@tallybook/core';
import { LoginGate, SecurityProvider, VaultUnlock } from './screens/Login.tsx';
import './index.css';
import { openStorage } from './db/index.ts';
import { StoreProvider } from './store.tsx';
import { NavProvider } from './nav.tsx';
import { DialogProvider } from './ui/Dialogs.tsx';
import { Shell, Gateway } from './App.tsx';
import { CompanyCreate } from './screens/CompanyCreate.tsx';

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

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  const fail = (e: unknown) => root.render(<Failure error={e} />);
  try {
    const storage = await openStorage();
    if (!storage.encrypted) return await start(root, await storage.open());
    root.render(
      <StrictMode>
        <VaultUnlock
          unlock={async (password) => {
            const db = await storage.open(password);
            await start(root, db).catch(fail);
          }}
        />
      </StrictMode>
    );
  } catch (e) {
    fail(e);
  }
}

void boot();
