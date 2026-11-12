import type { ReactNode } from "react";
import { LensMark } from "./LensMark";

/** The widgets' lock (packages/widgets ViewControls), drawn small beside "Read-only". */
export function ReadOnlyLock() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
      <path d="M2.6 5.2V3.6a2.4 2.4 0 0 1 4.8 0v1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="0.8" y="5.2" width="8.4" height="6.2" rx="1.6" fill="currentColor" />
    </svg>
  );
}

/**
 * The signed-in pages' header, framed like the public one (.vl-topbar): the mark and name on the left; "Read-only"
 * and the page's quiet text buttons (children) on the right.
 */
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar vl-topbar app-topbar">
      <a className="brand vl-brand" href="/" aria-label="VestLens home"><LensMark size={30} /><span>VestLens</span></a>
      <div className="topbar-actions">
        <span className="read-only-label"><ReadOnlyLock /> Read-only</span>
        {children}
      </div>
    </header>
  );
}
