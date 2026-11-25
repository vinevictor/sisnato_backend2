/**
 * Dias úteis com o mesmo calendário do Dashboard Global
 * (fins de semana + feriados nacionais, incluindo Carnaval, Sexta-feira
 * Santa e Corpus Christi).
 */

const cache = new Map<number, Set<string>>();

const iso = (d: Date) => d.toISOString().slice(0, 10);

function pascoa(ano: number): Date {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

function feriados(ano: number): Set<string> {
  let lista = cache.get(ano);
  if (lista) return lista;
  const p = pascoa(ano);
  const somar = (dias: number) => {
    const d = new Date(p);
    d.setUTCDate(d.getUTCDate() + dias);
    return iso(d);
  };
  lista = new Set([
    `${ano}-01-01`,
    `${ano}-04-21`,
    `${ano}-05-01`,
    `${ano}-09-07`,
    `${ano}-10-12`,
    `${ano}-11-02`,
    `${ano}-11-15`,
    `${ano}-11-20`,
    `${ano}-12-25`,
    somar(-47), // Carnaval
    somar(-2), // Sexta-feira Santa
    somar(60), // Corpus Christi
  ]);
  cache.set(ano, lista);
  return lista;
}

export function ehDiaUtil(d: Date): boolean {
  const semana = d.getUTCDay();
  if (semana === 0 || semana === 6) return false;
  return !feriados(d.getUTCFullYear()).has(iso(d));
}

/**
 * Dias úteis entre duas datas (AAAA-MM-DD): conta os dias úteis depois do
 * início até o fim, inclusive. Mesmo dia = 0; sexta → segunda = 1.
 */
export function diasUteisEntre(inicio: string, fim: string): number {
  const d = new Date(`${inicio}T00:00:00Z`);
  const limite = new Date(`${fim}T00:00:00Z`);
  let total = 0;
  while (d < limite) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (ehDiaUtil(d)) total++;
  }
  return total;
}
