import type { Group, Ledger } from '@tallybook/core';

export function ancestry(groups: Group[], id: number | null | undefined): string[] {
  const names: string[] = [];
  let g = groups.find((x) => x.id === id);
  while (g) {
    names.push(g.name);
    const pid: number | null = g.parent_id;
    g = pid ? groups.find((x) => x.id === pid) : undefined;
  }
  return names;
}

export function isUnder(groups: Group[], ledger: Ledger, roots: string[]): boolean {
  return ancestry(groups, ledger.group_id).some((n) => roots.includes(n));
}

export const BANK_CASH = ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c'];
export const PARTY_ROOTS = ['Sundry Debtors', 'Sundry Creditors'];
export const OUTPUT_SUPPLY = ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'];
export const INPUT_SUPPLY = ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses', 'Fixed Assets'];

export const GST_RATES_BP = [0, 25, 300, 500, 1200, 1800, 2800, 4000];
export const rateLabel = (bp: number) => `${bp / 100}%`;
