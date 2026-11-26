import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserPayload } from 'src/auth/entities/user.entity';
import { PrismaService } from 'src/prisma/prisma.service';
import { FiltroAreaConstrutoraDto } from './dto/filtro-area-construtora.dto';
import { diasUteisEntre } from './dias-uteis';

// Certificado emitido: mesmo critério do Dashboard/Analytics (revogado e
// distrato não entram)
const CERTIFICADO = Prisma.sql`('APROVADO', 'EMITIDO')`;
const EMITIDO = Prisma.sql`s.andamento IN ${CERTIFICADO} AND NOT s.distrato`;
// Período máximo aceito nos filtros
const MAX_DIAS = 366;
const FUSO = 'America/Sao_Paulo';

/** Converte um timestamp (UTC, sem fuso) para o dia em Brasília. */
const dia = (coluna: Prisma.Sql) =>
  Prisma.sql`((${coluna}) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date`;
/** Mesmo que `dia`, já formatado como texto para os relatórios. */
const dataHora = (coluna: Prisma.Sql) =>
  Prisma.sql`to_char((${coluna}) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')`;

export type Escopo = {
  construtoras: {
    id: number;
    fantasia: string | null;
    razaosocial: string;
    cnpj: string;
  }[];
  construtoraIds: number[];
  empreendimento: { id: number; nome: string } | null;
  inicio: string;
  fim: string;
};

export type LinhaCertificacao = {
  id: number;
  nome: string;
  cpf: string;
  construtora: string | null;
  empreendimento: string | null;
  corretor: string | null;
  financeira: string | null;
  andamento: string;
  criada_em: string | null;
  emitida_em: string | null;
  distrato_em: string | null;
};

export type LinhaEnvelope = {
  id: number;
  titulo: string;
  construtora: string | null;
  empreendimento: string | null;
  imobiliaria: string | null;
  criado_por: string | null;
  status: string;
  criado_em: string | null;
  concluido_em: string | null;
  cancelado_em: string | null;
  assinaram: number;
  signatarios: number;
  nomes: string | null;
};

const hojeBrasilia = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(new Date());

const numero = (valor: unknown) => (valor == null ? 0 : Number(valor));
const decimal = (valor: unknown) =>
  valor == null ? null : Math.round(Number(valor) * 10) / 10;

/**
 * Área restrita da construtora: indicadores e relatórios de movimentação
 * (certificação e envelopes NatoSign).
 *
 * Acesso: CONST com a permissão area_construtora vê só as construtoras ligadas
 * a ele (lidas do banco, valem sem novo login); ADM escolhe qualquer uma.
 */
@Injectable()
export class AreaConstrutoraService {
  constructor(private readonly Prisma: PrismaService) {}

  // ---------------------------------------------------------------- acesso

  private async idsPermitidos(User: UserPayload): Promise<number[] | 'todas'> {
    if (User?.hierarquia === 'ADM') return 'todas';
    if (User?.hierarquia !== 'CONST') {
      throw new HttpException(
        'A Área da Construtora é exclusiva para usuários de construtora',
        HttpStatus.FORBIDDEN,
      );
    }
    // Só o CONST com a permissão "Área da Construtora" (lida do banco,
    // vale sem novo login)
    const usuario = await this.Prisma.user.findUnique({
      where: { id: User.id },
      select: { role: true },
    });
    if (!(usuario?.role as Record<string, unknown>)?.area_construtora) {
      throw new HttpException(
        'Você não tem permissão para acessar a Área da Construtora',
        HttpStatus.FORBIDDEN,
      );
    }
    const vinculos = await this.Prisma.userConstrutora.findMany({
      where: { userId: User.id },
      select: { construtoraId: true },
    });
    if (!vinculos.length) {
      throw new HttpException(
        'Seu usuário não está vinculado a nenhuma construtora',
        HttpStatus.FORBIDDEN,
      );
    }
    return vinculos.map((v) => v.construtoraId);
  }

  private periodo(filtro: FiltroAreaConstrutoraDto) {
    const hoje = hojeBrasilia();
    const fim = filtro.fim || hoje;
    const inicio = filtro.inicio || `${fim.slice(0, 7)}-01`;
    const ini = new Date(`${inicio}T00:00:00Z`);
    const fi = new Date(`${fim}T00:00:00Z`);
    if (isNaN(ini.getTime()) || isNaN(fi.getTime())) {
      throw new HttpException('Período inválido', HttpStatus.BAD_REQUEST);
    }
    if (ini > fi) {
      throw new HttpException(
        'A data inicial deve ser anterior à final',
        HttpStatus.BAD_REQUEST,
      );
    }
    if ((fi.getTime() - ini.getTime()) / 86_400_000 > MAX_DIAS) {
      throw new HttpException(
        `O período pode ter no máximo ${MAX_DIAS} dias`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return { inicio, fim };
  }

  async escopo(
    User: UserPayload,
    filtro: FiltroAreaConstrutoraDto,
  ): Promise<Escopo> {
    const permitidas = await this.idsPermitidos(User);
    const pedida = filtro.construtoraId ? Number(filtro.construtoraId) : null;

    let ids: number[];
    if (permitidas === 'todas') {
      if (!pedida) {
        throw new HttpException(
          'Escolha a construtora',
          HttpStatus.BAD_REQUEST,
        );
      }
      ids = [pedida];
    } else if (pedida) {
      if (!permitidas.includes(pedida)) {
        throw new HttpException(
          'Você não tem acesso a esta construtora',
          HttpStatus.FORBIDDEN,
        );
      }
      ids = [pedida];
    } else {
      ids = permitidas;
    }

    const construtoras = await this.Prisma.construtora.findMany({
      where: { id: { in: ids } },
      select: { id: true, fantasia: true, razaosocial: true, cnpj: true },
      orderBy: { fantasia: 'asc' },
    });
    if (!construtoras.length) {
      throw new HttpException(
        'Construtora não encontrada',
        HttpStatus.NOT_FOUND,
      );
    }

    let empreendimento: Escopo['empreendimento'] = null;
    if (filtro.empreendimentoId) {
      empreendimento = await this.Prisma.empreendimento.findFirst({
        where: {
          id: Number(filtro.empreendimentoId),
          construtoraId: { in: ids },
        },
        select: { id: true, nome: true },
      });
      if (!empreendimento) {
        throw new HttpException(
          'Empreendimento não encontrado para esta construtora',
          HttpStatus.NOT_FOUND,
        );
      }
    }

    return {
      construtoras,
      construtoraIds: construtoras.map((c) => c.id),
      empreendimento,
      ...this.periodo(filtro),
    };
  }

  // -------------------------------------------------------------- seletores

  async construtoras(User: UserPayload) {
    const permitidas = await this.idsPermitidos(User);
    return this.Prisma.construtora.findMany({
      where:
        permitidas === 'todas' ? { status: true } : { id: { in: permitidas } },
      select: { id: true, fantasia: true, razaosocial: true, cnpj: true },
      orderBy: [{ fantasia: 'asc' }, { razaosocial: 'asc' }],
    });
  }

  async empreendimentos(User: UserPayload, construtoraId?: string) {
    const permitidas = await this.idsPermitidos(User);
    const pedida = construtoraId ? Number(construtoraId) : null;
    if (permitidas !== 'todas' && pedida && !permitidas.includes(pedida)) {
      throw new HttpException(
        'Você não tem acesso a esta construtora',
        HttpStatus.FORBIDDEN,
      );
    }
    if (permitidas === 'todas' && !pedida) return [];
    return this.Prisma.empreendimento.findMany({
      where: {
        construtoraId: pedida ? pedida : { in: permitidas as number[] },
      },
      select: {
        id: true,
        nome: true,
        cidade: true,
        estado: true,
        status: true,
      },
      orderBy: { nome: 'asc' },
    });
  }

  // ------------------------------------------------------------ indicadores

  private filtroSolicitacao(e: Escopo) {
    return Prisma.sql`s.ativo AND s."construtoraId" IN (${Prisma.join(e.construtoraIds)})
      ${e.empreendimento ? Prisma.sql`AND s."empreendimentoId" = ${e.empreendimento.id}` : Prisma.empty}`;
  }

  private filtroEnvelope(e: Escopo) {
    return Prisma.sql`e.ativo AND e.construtora_id IN (${Prisma.join(e.construtoraIds)})
      ${e.empreendimento ? Prisma.sql`AND e.empreendimento_id = ${e.empreendimento.id}` : Prisma.empty}`;
  }

  async indicadores(User: UserPayload, filtro: FiltroAreaConstrutoraDto) {
    const e = await this.escopo(User, filtro);
    const [certificacao, envelopes, serie, empreendimentos, imobiliarias] =
      await Promise.all([
        this.indicadoresCertificacao(e),
        this.indicadoresEnvelopes(e),
        this.serieMensal(e),
        this.porEmpreendimento(e),
        this.porImobiliaria(e),
      ]);
    return {
      periodo: { inicio: e.inicio, fim: e.fim },
      construtoras: e.construtoras,
      empreendimento: e.empreendimento,
      certificacao,
      envelopes,
      serie,
      empreendimentos,
      imobiliarias,
    };
  }

  private async indicadoresCertificacao(e: Escopo) {
    const { inicio, fim } = e;
    const criadaNoPeriodo = Prisma.sql`${dia(Prisma.sql`s."createdAt"`)} BETWEEN ${inicio}::date AND ${fim}::date`;
    const emitidaNoPeriodo = Prisma.sql`${EMITIDO} AND s.dt_aprovacao BETWEEN ${inicio}::date AND ${fim}::date`;

    const [resumo] = await this.Prisma.$queryRaw<any[]>`
      SELECT
        count(*) FILTER (WHERE ${criadaNoPeriodo}) AS criadas,
        count(*) FILTER (WHERE ${emitidaNoPeriodo}) AS emitidas,
        count(*) FILTER (
          WHERE s.andamento = 'REVOGADO' AND s.dt_aprovacao BETWEEN ${inicio}::date AND ${fim}::date
        ) AS revogadas,
        count(*) FILTER (
          WHERE s.distrato
            AND ${dia(Prisma.sql`s.dt_distrato`)} BETWEEN ${inicio}::date AND ${fim}::date
        ) AS distratos,
        count(*) FILTER (
          WHERE ${criadaNoPeriodo} AND NOT s.distrato
            AND (s.andamento IS NULL OR s.andamento NOT IN ('APROVADO', 'EMITIDO', 'REVOGADO', 'RECUSADA'))
        ) AS em_andamento
      FROM "Solicitacao" s
      WHERE ${this.filtroSolicitacao(e)}
    `;

    // Tempo até emitir em dias úteis (criação → data de aprovação)
    const datas = await this.Prisma.$queryRaw<
      { criada: string; emitida: string }[]
    >`
      SELECT to_char(${dia(Prisma.sql`s."createdAt"`)}, 'YYYY-MM-DD') AS criada,
        to_char(s.dt_aprovacao, 'YYYY-MM-DD') AS emitida
      FROM "Solicitacao" s
      WHERE ${this.filtroSolicitacao(e)} AND ${emitidaNoPeriodo}
        AND s.dt_aprovacao >= ${dia(Prisma.sql`s."createdAt"`)}
    `;
    const dias = datas
      .map((d) => diasUteisEntre(d.criada, d.emitida))
      .sort((a, b) => a - b);
    const meio = Math.floor(dias.length / 2);
    const tempoMedio = dias.length
      ? dias.reduce((soma, d) => soma + d, 0) / dias.length
      : null;
    const tempoMediano = !dias.length
      ? null
      : dias.length % 2
        ? dias[meio]
        : (dias[meio - 1] + dias[meio]) / 2;

    const porAndamento = await this.Prisma.$queryRaw<any[]>`
      SELECT
        CASE WHEN s.distrato THEN 'DISTRATO' ELSE coalesce(s.andamento, 'SEM ANDAMENTO') END AS andamento,
        count(*) AS total
      FROM "Solicitacao" s
      WHERE ${this.filtroSolicitacao(e)} AND ${criadaNoPeriodo}
      GROUP BY 1
      ORDER BY 2 DESC
    `;

    return {
      criadas: numero(resumo.criadas),
      emitidas: numero(resumo.emitidas),
      revogadas: numero(resumo.revogadas),
      distratos: numero(resumo.distratos),
      emAndamento: numero(resumo.em_andamento),
      // dias úteis
      tempoMedioDias: decimal(tempoMedio),
      tempoMedianoDias: decimal(tempoMediano),
      porAndamento: porAndamento.map((l) => ({
        andamento: l.andamento,
        total: numero(l.total),
      })),
    };
  }

  private async indicadoresEnvelopes(e: Escopo) {
    const { inicio, fim } = e;
    const linhas = await this.Prisma.$queryRaw<any[]>`
      WITH env AS (
        SELECT e.status_view, e."createdAt",
          (SELECT max(x.filled_at) FROM "IntelesignSignatario" x WHERE x.envelope_id = e.id) AS concluido_em
        FROM "Intelesign" e
        WHERE ${this.filtroEnvelope(e)}
          AND ${dia(Prisma.sql`e."createdAt"`)} BETWEEN ${inicio}::date AND ${fim}::date
      )
      SELECT status_view AS status,
        count(*) AS total,
        avg(extract(epoch FROM concluido_em - "createdAt") / 3600) FILTER (
          WHERE status_view = 'Concluído' AND concluido_em >= "createdAt"
        ) AS horas_medias
      FROM env
      GROUP BY 1
      ORDER BY 2 DESC
    `;

    const total = linhas.reduce((soma, l) => soma + numero(l.total), 0);
    const contar = (status: string) =>
      numero(linhas.find((l) => l.status === status)?.total);
    const concluidos = linhas.find((l) => l.status === 'Concluído');
    const horas = concluidos ? decimal(concluidos.horas_medias) : null;

    return {
      total,
      concluidos: contar('Concluído'),
      emAndamento: contar('Em andamento') + contar('Novo'),
      cancelados: contar('Cancelado'),
      expirados: contar('Expirado'),
      tempoMedioHoras: horas,
      porStatus: linhas.map((l) => ({
        status: l.status,
        total: numero(l.total),
      })),
    };
  }

  /** Últimos 12 meses até o mês do fim do período (independe do início). */
  private async serieMensal(e: Escopo) {
    const linhas = await this.Prisma.$queryRaw<any[]>`
      WITH meses AS (
        SELECT generate_series(
          date_trunc('month', ${e.fim}::date) - interval '11 months',
          date_trunc('month', ${e.fim}::date),
          interval '1 month'
        )::date AS mes
      ),
      criadas AS (
        SELECT date_trunc('month', ${dia(Prisma.sql`s."createdAt"`)})::date AS mes, count(*) AS total
        FROM "Solicitacao" s WHERE ${this.filtroSolicitacao(e)} GROUP BY 1
      ),
      emitidas AS (
        SELECT date_trunc('month', s.dt_aprovacao)::date AS mes, count(*) AS total
        FROM "Solicitacao" s
        WHERE ${this.filtroSolicitacao(e)} AND ${EMITIDO} AND s.dt_aprovacao IS NOT NULL
        GROUP BY 1
      ),
      envelopes AS (
        SELECT date_trunc('month', ${dia(Prisma.sql`e."createdAt"`)})::date AS mes, count(*) AS total
        FROM "Intelesign" e WHERE ${this.filtroEnvelope(e)} GROUP BY 1
      )
      SELECT to_char(m.mes, 'YYYY-MM') AS mes,
        coalesce(c.total, 0) AS criadas,
        coalesce(em.total, 0) AS emitidas,
        coalesce(en.total, 0) AS envelopes
      FROM meses m
      LEFT JOIN criadas c ON c.mes = m.mes
      LEFT JOIN emitidas em ON em.mes = m.mes
      LEFT JOIN envelopes en ON en.mes = m.mes
      ORDER BY m.mes
    `;
    return linhas.map((l) => ({
      mes: l.mes,
      criadas: numero(l.criadas),
      emitidas: numero(l.emitidas),
      envelopes: numero(l.envelopes),
    }));
  }

  /** Envelopes criados no período agrupados pela imobiliária vinculada. */
  private async porImobiliaria(e: Escopo) {
    const { inicio, fim } = e;
    const linhas = await this.Prisma.$queryRaw<any[]>`
      SELECT im.id,
        coalesce(im.fantasia, im.razaosocial, 'Sem imobiliária') AS nome,
        count(*) AS envelopes,
        count(*) FILTER (WHERE e.status_view = 'Concluído') AS concluidos,
        count(*) FILTER (WHERE e.status_view IN ('Em andamento', 'Novo')) AS em_andamento,
        count(*) FILTER (WHERE e.status_view IN ('Cancelado', 'Expirado')) AS cancelados
      FROM "Intelesign" e
      LEFT JOIN "Imobiliaria" im ON im.id = e.imobiliaria_id
      WHERE ${this.filtroEnvelope(e)}
        AND ${dia(Prisma.sql`e."createdAt"`)} BETWEEN ${inicio}::date AND ${fim}::date
      GROUP BY im.id, im.fantasia, im.razaosocial
      ORDER BY (im.id IS NULL), envelopes DESC, nome
    `;
    return linhas.map((l) => ({
      id: l.id as number | null,
      nome: l.nome as string,
      envelopes: numero(l.envelopes),
      concluidos: numero(l.concluidos),
      emAndamento: numero(l.em_andamento),
      cancelados: numero(l.cancelados),
    }));
  }

  private async porEmpreendimento(e: Escopo) {
    const { inicio, fim } = e;
    const linhas = await this.Prisma.$queryRaw<any[]>`
      WITH cert AS (
        SELECT s."empreendimentoId" AS id,
          count(*) FILTER (
            WHERE ${dia(Prisma.sql`s."createdAt"`)} BETWEEN ${inicio}::date AND ${fim}::date
          ) AS criadas,
          count(*) FILTER (
            WHERE ${EMITIDO} AND s.dt_aprovacao BETWEEN ${inicio}::date AND ${fim}::date
          ) AS emitidas
        FROM "Solicitacao" s
        WHERE ${this.filtroSolicitacao(e)} AND s."empreendimentoId" IS NOT NULL
        GROUP BY 1
      ),
      env AS (
        SELECT e.empreendimento_id AS id,
          count(*) AS envelopes,
          count(*) FILTER (WHERE e.status_view = 'Concluído') AS concluidos
        FROM "Intelesign" e
        WHERE ${this.filtroEnvelope(e)} AND e.empreendimento_id IS NOT NULL
          AND ${dia(Prisma.sql`e."createdAt"`)} BETWEEN ${inicio}::date AND ${fim}::date
        GROUP BY 1
      )
      SELECT emp.id, emp.nome, emp.cidade, emp.estado,
        coalesce(cert.criadas, 0) AS criadas,
        coalesce(cert.emitidas, 0) AS emitidas,
        coalesce(env.envelopes, 0) AS envelopes,
        coalesce(env.concluidos, 0) AS concluidos
      FROM "Empreendimento" emp
      LEFT JOIN cert ON cert.id = emp.id
      LEFT JOIN env ON env.id = emp.id
      WHERE coalesce(cert.criadas, 0) + coalesce(cert.emitidas, 0) + coalesce(env.envelopes, 0) > 0
      ORDER BY criadas DESC, emitidas DESC, envelopes DESC, emp.nome
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.nome,
      cidade: l.cidade,
      estado: l.estado,
      criadas: numero(l.criadas),
      emitidas: numero(l.emitidas),
      envelopes: numero(l.envelopes),
      envelopesConcluidos: numero(l.concluidos),
    }));
  }

  // ------------------------------------------------------ dados de relatório

  /**
   * Solicitações com movimento no período: criadas, emitidas ou com distrato.
   */
  async movimentoCertificacao(e: Escopo): Promise<LinhaCertificacao[]> {
    const { inicio, fim } = e;
    const linhas = await this.Prisma.$queryRaw<any[]>`
      SELECT s.id, s.nome, s.cpf,
        coalesce(c.fantasia, c.razaosocial) AS construtora,
        emp.nome AS empreendimento,
        u.nome AS corretor,
        coalesce(f.fantasia, f.razaosocial) AS financeira,
        CASE WHEN s.distrato THEN 'DISTRATO' ELSE coalesce(s.andamento, 'SEM ANDAMENTO') END AS andamento,
        ${dataHora(Prisma.sql`s."createdAt"`)} AS criada_em,
        CASE WHEN s.andamento IN ('APROVADO', 'EMITIDO', 'REVOGADO') THEN to_char(s.dt_aprovacao, 'DD/MM/YYYY') END AS emitida_em,
        CASE WHEN s.distrato THEN ${dataHora(Prisma.sql`s.dt_distrato`)} END AS distrato_em
      FROM "Solicitacao" s
      LEFT JOIN "Construtora" c ON c.id = s."construtoraId"
      LEFT JOIN "Empreendimento" emp ON emp.id = s."empreendimentoId"
      LEFT JOIN "User" u ON u.id = s."corretorId"
      LEFT JOIN "Financeiro" f ON f.id = s."financeiroId"
      WHERE ${this.filtroSolicitacao(e)}
        AND (
          ${dia(Prisma.sql`s."createdAt"`)} BETWEEN ${inicio}::date AND ${fim}::date
          OR (s.andamento IN ('APROVADO', 'EMITIDO', 'REVOGADO') AND s.dt_aprovacao BETWEEN ${inicio}::date AND ${fim}::date)
          OR (s.distrato AND ${dia(Prisma.sql`s.dt_distrato`)} BETWEEN ${inicio}::date AND ${fim}::date)
        )
      ORDER BY s."createdAt" DESC
    `;
    return linhas as LinhaCertificacao[];
  }

  /**
   * Envelopes com movimento no período: criados, concluídos ou cancelados.
   */
  async movimentoEnvelopes(e: Escopo): Promise<LinhaEnvelope[]> {
    const { inicio, fim } = e;
    const linhas = await this.Prisma.$queryRaw<any[]>`
      WITH env AS (
        SELECT e.*,
          (SELECT max(x.filled_at) FROM "IntelesignSignatario" x WHERE x.envelope_id = e.id) AS concluido
        FROM "Intelesign" e
        WHERE ${this.filtroEnvelope(e)}
      )
      SELECT env.id,
        coalesce(nullif(env.title, ''), env.original_name, '') AS titulo,
        coalesce(c.fantasia, c.razaosocial) AS construtora,
        emp.nome AS empreendimento,
        coalesce(im.fantasia, im.razaosocial) AS imobiliaria,
        u.nome AS criado_por,
        env.status_view AS status,
        ${dataHora(Prisma.sql`env."createdAt"`)} AS criado_em,
        CASE WHEN env.status_view = 'Concluído' THEN ${dataHora(Prisma.sql`env.concluido`)} END AS concluido_em,
        ${dataHora(Prisma.sql`env.cancelado_em`)} AS cancelado_em,
        (SELECT count(*) FROM "IntelesignSignatario" x WHERE x.envelope_id = env.id AND x.state = 'done')::int AS assinaram,
        (SELECT count(*) FROM "IntelesignSignatario" x WHERE x.envelope_id = env.id)::int AS signatarios,
        (SELECT string_agg(x.nome, ', ' ORDER BY x.ordem NULLS LAST, x.id)
           FROM "IntelesignSignatario" x WHERE x.envelope_id = env.id) AS nomes
      FROM env
      LEFT JOIN "Construtora" c ON c.id = env.construtora_id
      LEFT JOIN "Empreendimento" emp ON emp.id = env.empreendimento_id
      LEFT JOIN "Imobiliaria" im ON im.id = env.imobiliaria_id
      LEFT JOIN "User" u ON u.id = env.user_id
      WHERE ${dia(Prisma.sql`env."createdAt"`)} BETWEEN ${inicio}::date AND ${fim}::date
        OR (env.status_view = 'Concluído' AND ${dia(Prisma.sql`env.concluido`)} BETWEEN ${inicio}::date AND ${fim}::date)
        OR ${dia(Prisma.sql`env.cancelado_em`)} BETWEEN ${inicio}::date AND ${fim}::date
      ORDER BY env."createdAt" DESC
    `;
    return linhas as LinhaEnvelope[];
  }
}
