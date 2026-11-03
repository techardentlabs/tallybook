import { MenuCard, useMenu, type MenuItem } from '../ui/Menu.tsx';
import { useScreen } from '../registry.ts';
import { useNav } from '../nav.tsx';
import { CompanyAlter } from './Features.tsx';
import { TdsDeductorForm } from './Tds.tsx';
import { ChangePasswordScreen, ChangeUserScreen } from './Login.tsx';
import { CompanySecurityScreen, PasswordPolicyScreen, SecurityControlScreen, UserRolesScreen, UsersAndPasswordsScreen } from './Security.tsx';

export function CompanyMenu() {
  const nav = useNav();
  const items: MenuItem[] = [
    { label: 'Company', heading: true },
    { label: 'Alter', run: () => nav.push(<CompanyAlter />), hotkey: 'A' },
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
