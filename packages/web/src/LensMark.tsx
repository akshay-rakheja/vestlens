import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/source-serif-4";
import "./landing.css";

/** The VestLens mark: a lens ring around a focus ring, crossed by a measured line. */
export function LensMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="vl-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="24" cy="24" r="12" fill="none" stroke="var(--vl-aperture)" strokeWidth="3" />
      <polyline points="9,31 18,25 25,28 39,15" fill="none" stroke="var(--vl-aperture)" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
