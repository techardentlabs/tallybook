export function KeyButton({ k, label, run, primary = false }: { k: string; label: string; run: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={run}
      className={`cursor-pointer border border-[#9db7cf] px-4 py-[2px] text-[14px] leading-5 shadow-[1px_1px_0_#c9d6e2] ${primary ? 'bg-tb-sel' : 'bg-white hover:bg-tb-sel'}`}
    >
      <u className="font-bold text-tb-top">{k}</u>: {label}
    </button>
  );
}
