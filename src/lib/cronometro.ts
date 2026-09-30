import { useCallback, useEffect, useRef, useState } from "react";

export const META_MS = 90_000;

/**
 * Cronômetro de TRABALHO ATIVO do operador. Não é enfeite: é o instrumento de
 * medida do piloto. Começa na primeira interação e PARA quando o convite é
 * enviado — dali em diante quem trabalha é o cliente, no celular dele.
 */
export function useCronometro() {
  const [decorrido, setDecorrido] = useState(0);
  const [rodando, setRodando] = useState(false);
  const acumulado = useRef(0);
  const inicio = useRef<number | null>(null);
  const parado = useRef(false);

  useEffect(() => {
    if (!rodando) return;
    const id = setInterval(() => {
      if (inicio.current !== null) setDecorrido(acumulado.current + (performance.now() - inicio.current));
    }, 250);
    return () => clearInterval(id);
  }, [rodando]);

  const iniciar = useCallback(() => {
    if (parado.current || inicio.current !== null) return;
    inicio.current = performance.now();
    setRodando(true);
  }, []);

  const pausar = useCallback(() => {
    if (inicio.current === null) return;
    acumulado.current += performance.now() - inicio.current;
    inicio.current = null;
    setDecorrido(acumulado.current);
    setRodando(false);
  }, []);

  /** Para em definitivo (convite enviado / conclusão). */
  const parar = useCallback(() => {
    pausar();
    parado.current = true;
  }, [pausar]);

  const zerar = useCallback(() => {
    acumulado.current = 0;
    inicio.current = null;
    parado.current = false;
    setDecorrido(0);
    setRodando(false);
  }, []);

  return { decorrido, rodando, parado: parado.current, iniciar, pausar, parar, zerar };
}
