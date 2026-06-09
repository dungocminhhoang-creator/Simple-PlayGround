type BrandProps = {
  compact?: boolean;
};

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className={compact ? "brand brand--compact" : "brand"} aria-label="Simple Playground">
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
      </span>
      <span className="brand-copy">
        <strong>Simple</strong>
        <em>Playground</em>
      </span>
    </div>
  );
}
