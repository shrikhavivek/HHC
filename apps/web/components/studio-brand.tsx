export function StudioBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`studio-brand${compact ? " studio-brand-compact" : ""}`}>
      <span className="studio-brand-mark" aria-hidden="true">H</span>
      <div className="studio-brand-copy">
        <strong>High Heel{compact ? <br /> : " "}Confidential</strong>
        <small>The editorial studio</small>
      </div>
    </div>
  );
}
