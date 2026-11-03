import { StrictMode, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Books, currentUser, ensureCurrency, ensureSecurity, ensureStockExtras, ensureVClass } from '@tallybook/core';
import { LoginGate, SecurityProvider } from './screens/Login.tsx';
import './index.css';
import { openDb } from './db/index.ts';
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

async function boot() {
  const rootEl = document.getElementById('root')!;
  try {
    const books = new Books(await openDb());
    await books.init();
    books.actor = () => currentUser()?.username ?? '';
    await ensureSecurity(books.db);
    await ensureCurrency(books.db);
    await ensureStockExtras(books.db);
    await ensureVClass(books.db);
    const company = await books.company();
    createRoot(rootEl).render(
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
  } catch (e) {
    rootEl.innerHTML = `<pre style="padding:16px;color:#b3261e">Could not open the company data.\n${(e as Error).message}</pre>`;
  }
}

void boot();
