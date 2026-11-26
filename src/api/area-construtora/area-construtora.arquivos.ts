import * as ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import PdfPrinter from 'pdfmake';
import { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import {
  Escopo,
  LinhaCertificacao,
  LinhaEnvelope,
} from './area-construtora.service';

export type TipoRelatorio = 'certificacao' | 'envelopes';

type Coluna<T> = {
  titulo: string;
  campo: (linha: T) => string | number;
  largura: number;
};

// O PDF fica legível até aqui; acima disso a lista completa vai só no Excel
const LIMITE_LINHAS_PDF = 1500;

const COLUNAS_CERTIFICACAO: Coluna<LinhaCertificacao>[] = [
  { titulo: 'ID', campo: (l) => l.id, largura: 8 },
  { titulo: 'Cliente', campo: (l) => l.nome, largura: 34 },
  { titulo: 'CPF', campo: (l) => l.cpf, largura: 16 },
  {
    titulo: 'Empreendimento',
    campo: (l) => l.empreendimento ?? '',
    largura: 28,
  },
  { titulo: 'Corretor', campo: (l) => l.corretor ?? '', largura: 24 },
  { titulo: 'CCA', campo: (l) => l.financeira ?? '', largura: 22 },
  { titulo: 'Andamento', campo: (l) => l.andamento, largura: 16 },
  { titulo: 'Criada em', campo: (l) => l.criada_em ?? '', largura: 17 },
  { titulo: 'Emitida em', campo: (l) => l.emitida_em ?? '', largura: 12 },
  { titulo: 'Distrato em', campo: (l) => l.distrato_em ?? '', largura: 17 },
];

const COLUNAS_ENVELOPES: Coluna<LinhaEnvelope>[] = [
  { titulo: 'ID', campo: (l) => l.id, largura: 8 },
  { titulo: 'Título', campo: (l) => l.titulo, largura: 30 },
  {
    titulo: 'Empreendimento',
    campo: (l) => l.empreendimento ?? '',
    largura: 24,
  },
  { titulo: 'Imobiliária', campo: (l) => l.imobiliaria ?? '', largura: 22 },
  { titulo: 'Criado por', campo: (l) => l.criado_por ?? '', largura: 22 },
  { titulo: 'Status', campo: (l) => l.status, largura: 14 },
  { titulo: 'Criado em', campo: (l) => l.criado_em ?? '', largura: 17 },
  { titulo: 'Concluído em', campo: (l) => l.concluido_em ?? '', largura: 17 },
  { titulo: 'Cancelado em', campo: (l) => l.cancelado_em ?? '', largura: 17 },
  {
    titulo: 'Assinaturas',
    campo: (l) => `${l.assinaram}/${l.signatarios}`,
    largura: 12,
  },
  { titulo: 'Signatários', campo: (l) => l.nomes ?? '', largura: 50 },
];

const TITULO: Record<TipoRelatorio, string> = {
  certificacao: 'Movimentação de Certificação',
  envelopes: 'Movimentação de Envelopes NatoSign',
};

const br = (data: string) => data.split('-').reverse().join('/');

const nomeConstrutoras = (e: Escopo) =>
  e.construtoras.map((c) => c.fantasia || c.razaosocial).join(', ');

/** Totais que vão no topo do PDF e na aba "Resumo" do Excel. */
function resumo(
  tipo: TipoRelatorio,
  e: Escopo,
  linhas: any[],
): [string, number][] {
  // 'DD/MM/AAAA[ HH:MI]' -> 'AAAA-MM-DD' para comparar com o período
  const noPeriodo = (data: string | null) => {
    if (!data) return false;
    const [d, m, a] = data.slice(0, 10).split('/');
    const isoData = `${a}-${m}-${d}`;
    return isoData >= e.inicio && isoData <= e.fim;
  };
  const contar = (filtro: (l: any) => boolean) => linhas.filter(filtro).length;
  if (tipo === 'certificacao') {
    const l = linhas as LinhaCertificacao[];
    return [
      ['Solicitações com movimento', l.length],
      // Revogado e distrato não contam como emitido (igual ao Dashboard)
      [
        'Emitidas no período',
        contar(
          (x) =>
            noPeriodo(x.emitida_em) &&
            ['APROVADO', 'EMITIDO'].includes(x.andamento),
        ),
      ],
      ['Distratos', contar((x) => noPeriodo(x.distrato_em))],
      [
        'Revogadas',
        contar((x) => x.andamento === 'REVOGADO' && noPeriodo(x.emitida_em)),
      ],
    ];
  }
  const l = linhas as LinhaEnvelope[];
  return [
    ['Envelopes com movimento', l.length],
    ['Concluídos', contar((x) => x.status === 'Concluído')],
    [
      'Em andamento',
      contar((x) => x.status === 'Em andamento' || x.status === 'Novo'),
    ],
    ['Cancelados', contar((x) => x.status === 'Cancelado')],
    ['Expirados', contar((x) => x.status === 'Expirado')],
  ];
}

const colunasDe = (tipo: TipoRelatorio): Coluna<any>[] =>
  tipo === 'certificacao' ? COLUNAS_CERTIFICACAO : COLUNAS_ENVELOPES;

export function nomeArquivo(
  tipo: TipoRelatorio,
  e: Escopo,
  formato: 'pdf' | 'xlsx',
) {
  const cliente = (
    e.construtoras.length === 1
      ? e.construtoras[0].fantasia || e.construtoras[0].razaosocial
      : 'construtoras'
  )
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `${tipo}-${cliente}-${e.inicio}-a-${e.fim}.${formato}`;
}

export async function gerarXlsx(
  tipo: TipoRelatorio,
  e: Escopo,
  linhas: any[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SisNato';

  const capa = workbook.addWorksheet('Resumo');
  capa.columns = [{ width: 34 }, { width: 60 }];
  capa.addRow([TITULO[tipo]]).font = { bold: true, size: 14 };
  capa.addRow([]);
  capa.addRow(['Construtora', nomeConstrutoras(e)]);
  if (e.empreendimento) capa.addRow(['Empreendimento', e.empreendimento.nome]);
  capa.addRow(['Período', `${br(e.inicio)} a ${br(e.fim)}`]);
  capa.addRow([
    'Gerado em',
    new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  ]);
  capa.addRow([]);
  for (const [rotulo, valor] of resumo(tipo, e, linhas)) {
    const row = capa.addRow([rotulo, valor]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { horizontal: 'left' };
  }

  const colunas = colunasDe(tipo);
  const aba = workbook.addWorksheet(
    tipo === 'certificacao' ? 'Solicitações' : 'Envelopes',
  );
  aba.columns = colunas.map((c) => ({ header: c.titulo, width: c.largura }));
  const cabecalho = aba.getRow(1);
  cabecalho.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cabecalho.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF023147' },
  };
  aba.views = [{ state: 'frozen', ySplit: 1 }];
  for (const linha of linhas) aba.addRow(colunas.map((c) => c.campo(linha)));
  if (linhas.length) {
    aba.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: colunas.length },
    };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const fonte = (arquivo: string) =>
  path.join(process.cwd(), 'src/pdf_create/assets/fonts', arquivo);

export async function gerarPdf(
  tipo: TipoRelatorio,
  e: Escopo,
  linhas: any[],
): Promise<Buffer> {
  const printer = new PdfPrinter({
    Roboto: {
      normal: fonte('Roboto-Regular.ttf'),
      bold: fonte('Roboto-Bold.ttf'),
      italics: fonte('Roboto-Regular.ttf'),
      bolditalics: fonte('Roboto-BoldItalic.ttf'),
    },
  });
  const imagem = (arquivo: string) =>
    'data:image/png;base64,' +
    fs
      .readFileSync(path.join(process.cwd(), 'src/pdf_create/assets', arquivo))
      .toString('base64');

  // No PDF a coluna de signatários fica de fora (não cabe); está no Excel
  const colunas = colunasDe(tipo).filter((c) => c.titulo !== 'Signatários');
  const visiveis = linhas.slice(0, LIMITE_LINHAS_PDF);
  const larguraTotal = colunas.reduce((s, c) => s + c.largura, 0);

  const totais = resumo(tipo, e, linhas);
  const conteudo: Content[] = [
    {
      columns: [
        { image: imagem('logo-interface.png'), width: 60 },
        // SisNato ao lado da Interface, centralizado na altura (60x70)
        {
          image: imagem('logo-sisnato.png'),
          width: 110,
          margin: [0, 19, 0, 0],
        },
        {
          width: '*',
          stack: [
            { text: TITULO[tipo], style: 'titulo' },
            { text: nomeConstrutoras(e), style: 'sub' },
            {
              text: [
                e.empreendimento
                  ? `Empreendimento: ${e.empreendimento.nome}   ·   `
                  : '',
                `Período: ${br(e.inicio)} a ${br(e.fim)}`,
              ].join(''),
              style: 'meta',
            },
          ],
        },
      ],
      columnGap: 18,
    },
    {
      margin: [0, 14, 0, 14],
      columns: totais.map(([rotulo, valor]) => ({
        stack: [
          { text: String(valor), style: 'numero' },
          { text: rotulo, style: 'rotulo' },
        ],
      })),
    },
    {
      table: {
        headerRows: 1,
        widths: colunas.map((c) => `${(c.largura / larguraTotal) * 100}%`),
        body: [
          colunas.map((c) => ({ text: c.titulo, style: 'th' })),
          ...visiveis.map((l) =>
            colunas.map((c) => ({ text: String(c.campo(l)), style: 'td' })),
          ),
        ],
      },
      layout: {
        fillColor: (i: number) =>
          i === 0 ? '#023147' : i % 2 === 0 ? '#F4F6F8' : null,
        hLineWidth: () => 0.3,
        vLineWidth: () => 0,
        hLineColor: () => '#D0D5DA',
        paddingTop: () => 3,
        paddingBottom: () => 3,
      },
    },
  ];
  if (!linhas.length) {
    conteudo.push({
      text: 'Nenhuma movimentação no período.',
      style: 'meta',
      margin: [0, 10, 0, 0],
    });
  }
  if (linhas.length > LIMITE_LINHAS_PDF) {
    conteudo.push({
      text: `Mostrando ${LIMITE_LINHAS_PDF} de ${linhas.length} linhas. Baixe o Excel para a lista completa.`,
      style: 'meta',
      margin: [0, 8, 0, 0],
    });
  }

  const geradoEm = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 28, 28, 34],
    content: conteudo,
    footer: (pagina, total) => ({
      columns: [
        { text: `SisNato · gerado em ${geradoEm}`, style: 'rodape' },
        { text: `${pagina}/${total}`, style: 'rodape', alignment: 'right' },
      ],
      margin: [28, 10, 28, 0],
    }),
    styles: {
      titulo: { fontSize: 15, bold: true, color: '#023147' },
      sub: { fontSize: 11, bold: true, margin: [0, 2, 0, 0] },
      meta: { fontSize: 9, color: '#555555', margin: [0, 2, 0, 0] },
      numero: { fontSize: 16, bold: true, color: '#023147' },
      rotulo: { fontSize: 8, color: '#555555' },
      th: { fontSize: 7.5, bold: true, color: '#FFFFFF' },
      td: { fontSize: 7 },
      rodape: { fontSize: 7, color: '#888888' },
    },
    defaultStyle: { font: 'Roboto' },
  };

  const pdf = printer.createPdfKitDocument(doc);
  const partes: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (p: Buffer) => partes.push(p));
    pdf.on('end', () => resolve(Buffer.concat(partes)));
    pdf.on('error', reject);
    pdf.end();
  });
}
