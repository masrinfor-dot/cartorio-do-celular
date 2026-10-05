// Marca v1: o Elo — dois celulares entrelaçados como elos de corrente.
// Elo anterior em Tinta, elo novo em Lacre.
export function Elo({ tamanho = 28, sobreEscuro = false }: { tamanho?: number; sobreEscuro?: boolean }) {
  const anterior = sobreEscuro ? "#F4F1E9" : "#2F3B9C";
  const novo = sobreEscuro ? "#E8835A" : "#B34E27";
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="3" y="7" width="13" height="21" rx="4" transform="rotate(-18 9.5 17.5)" stroke={anterior} strokeWidth="3" />
      <rect x="16" y="4" width="13" height="21" rx="4" transform="rotate(-18 22.5 14.5)" stroke={novo} strokeWidth="3" />
    </svg>
  );
}

export function Logotipo({ sobreEscuro = false }: { sobreEscuro?: boolean }) {
  return (
    <span className="flex items-center gap-2" style={{ fontFamily: "var(--font-display)" }}>
      <Elo sobreEscuro={sobreEscuro} />
      <span className="text-xl leading-none tracking-tight" style={{ fontWeight: 800 }}>
        cartório <span style={{ fontWeight: 500 }}>do</span> celular
      </span>
    </span>
  );
}
