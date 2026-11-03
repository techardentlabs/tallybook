import { MenuCard, useMenu, type MenuItem } from '../ui/Menu.tsx';
import { useScreen } from '../registry.ts';
import { useNav } from '../nav.tsx';
import { CompanyAlter } from './Features.tsx';
import { useStore } from '../store.tsx';
import { createAnotherCompany } from '../db/companies.ts';
import { ChangeVaultScreen, CompanyListScreen, useShutCompany } from './Companies.tsx';
import { TdsDeductorForm } from './Tds.tsx';
import { ChangePasswordScreen, ChangeUserScreen } from './Login.tsx';
import { CompanySecurityScreen, PasswordPolicyScreen, SecurityControlScreen, UserRolesScreen, UsersAndPasswordsScreen } from './Security.tsx';

export function CompanyMenu() {
  const nav = useNav();
  const { toast } = useStore();
  const shut = useShutCompany();
  const items: MenuItem[] = [
    { label: 'Company', heading: true },
    { label: 'Create', run: () => void createAnotherCompany().catch((e) => toast((e as Error).message, 'err')), hotkey: 'E', hotAt: 2 },
    { label: 'Alter', run: () => nav.push(<CompanyAlter />), hotkey: 'A' },
    { label: 'Select', run: () => nav.push(<CompanyListScreen title="Select Company" />), hotkey: 'L', hotAt: 2 },
    { label: 'Shut Company', run: () => void shut(), hotkey: 'M', hotAt: 7 },
    { label: 'Change TallyVault', run: () => nav.push(<ChangeVaultScreen />), hotkey: 'V', hotAt: 12 },
    { label: 'TDS Deductor Details', run: () => nav.push(<TdsDeductorForm />), hotkey: 'T' },
    { label: 'Security', heading: true },
    { label: 'Users and Passwords', run: () => nav.push(<UsersAndPasswordsScreen />), hotkey: 'U' },
    { label: 'User Roles', run: () => nav.push(<UserRolesScreen />), hotkey: 'R' },
    { label: 'Password Policy', run: () => nav.push(<PasswordPolicyScreen />), hotkey: 'P' },
    { label: 'Security Control', run: () => nav.push(<SecurityControlScreen />), hotkey: 'S' },
    { label: 'Company Security', run: () => nav.push(<CompanySecurityScreen />), hotkey: 'C' },
    { label: 'User', heading: true },
    { label: 'Change User', run: () => nav.push(<ChangeUserScreen />), hotkey: 'H' },
    { label: 'Change Password', run: () => nav.push(<ChangePasswordScreen />), hotkey: 'W' },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Company', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Company" items={items} sel={sel} setSel={setSel} />;
}
