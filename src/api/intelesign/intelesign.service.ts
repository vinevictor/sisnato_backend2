import {
  HttpException,
  HttpStatus,
  Injectable,
  StreamableFile,
} from '@nestjs/common';
import fontkit from '@pdf-lib/fontkit';
import * as fs from 'fs';
import * as path from 'path';
import { degrees, PDFDocument, rgb } from 'pdf-lib';
import * as QRCode from 'qrcode';
import { UserPayload } from 'src/auth/entities/user.entity';
import { PrismaService } from 'src/prisma/prisma.service';
import { BucketDto } from 'src/s3/dto/bucket.dto';
import { S3Service } from 'src/s3/s3.service';
import { Readable } from 'stream'; // Importe Readable do módulo 'stream'
import { CreateIntelesignDto } from './dto/create-intelesign.dto';
import { NatodocQueryDto } from './dto/natodoc-query.dto';
import { converterParaPdfA } from './pdfa';
import { QueryDto, STATUS_FILTRO_MAP } from './dto/query.dto';
import { SignatarioDto } from './dto/sign.dto';

@Injectable()
export class IntelesignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  private createResponse(
    message: string,
    status: number,
    data: any | null,
    total?: number,
    page?: number,
  ) {
    return {
      error: false,
      message,
      status,
      data,
      total: total || 0,
      page: page || 0,
    };
  }

  async create(
    createIntelesignDto: CreateIntelesignDto,
    file: Express.Multer.File,
    User: UserPayload,
  ) {
    let registroId: number | undefined;
    try {
      if (!file) {
        throw new HttpException('Arquivo não enviado', 400);
      }
      // Telefone é opcional; se vier, precisa ser válido para o WhatsApp
      for (const sig of createIntelesignDto.signatarios || []) {
        if (!sig.telefone) continue;
        const telefone = this.normalizarTelefone(sig.telefone);
        if (!telefone) {
          throw new HttpException(
            `Telefone inválido para o signatário ${sig.nome}. Use DDD + número.`,
            400,
          );
        }
        sig.telefone = telefone;
      }
      if (createIntelesignDto.imobiliaria_id && User.hierarquia !== 'ADM') {
        const vinculo = await this.prisma.userImobiliaria.findUnique({
          where: {
            userId_imobiliariaId: {
              userId: User.id,
              imobiliariaId: createIntelesignDto.imobiliaria_id,
            },
          },
        });
        if (!vinculo) {
          throw new HttpException(
            'Você não está relacionado a essa imobiliária.',
            403,
          );
        }
      }
      const NomeOriginal = file.originalname;
      const Tipo = file.mimetype;
      const Ext = NomeOriginal.split('.').pop();
      const NomeArquivo = `${Date.now()}.${Ext}`;
      const fileBuffer = Buffer.isBuffer(file.buffer)
        ? file.buffer
        : Buffer.from(file.buffer);

      if (file.mimetype !== 'application/pdf') {
        const pdfDoc = await PDFDocument.load(fileBuffer);
        const newFileBuffer = await pdfDoc.save();
        const newFile: Express.Multer.File = {
          ...file,
          buffer: Buffer.isBuffer(newFileBuffer)
            ? newFileBuffer
            : Buffer.from(newFileBuffer),
          mimetype: 'application/pdf',
        };
        file = newFile;
      }

      const valorCalculado = await this.calcularValorEnvelope(
        createIntelesignDto.cca_id,
        createIntelesignDto.const_id,
        createIntelesignDto.valor,
      );

      const token = await this.refreshToken();
      const save = await this.S3Upload(
        fileBuffer,
        NomeArquivo,
        Tipo,
        'intelesign-original',
      );

      const registro = await this.createRegistro({
        original_name: NomeOriginal.normalize('NFD').replace(
          /[\u0300-\u036f]/g,
          '',
        ),
        doc_original_down: save.url_download,
        doc_original_viw: save.url_view,
        signatarios: createIntelesignDto.signatarios,
        cca_id: createIntelesignDto.cca_id,
        message: createIntelesignDto.message,
        title: createIntelesignDto.title,
        description: createIntelesignDto.subject,
        valor: valorCalculado, // <--- Valor calculado automaticamente gravado aqui
        construtora_id: createIntelesignDto.const_id,
        empreendimento_id: createIntelesignDto.empreendimento_id,
        imobiliaria_id: createIntelesignDto.imobiliaria_id,
        user_id: User.id,
        type: createIntelesignDto.type,
      });
      registroId = registro.id;

      const signatarios = createIntelesignDto.signatarios;

      const envelope = await this.CreateEnvelope(
        createIntelesignDto.title,
        createIntelesignDto.subject,
        createIntelesignDto.message,
        createIntelesignDto.expire_at,
        token,
      );
      if (!envelope.id) {
        throw new HttpException('Erro ao criar envelope', 500);
      }

      const dadosManifesto = {
        codigoValidacao: envelope.id,
        asstype: createIntelesignDto.type,
        signatarios,
        urlVerificacao: `https://app.intellisign.com/business/documents/info`,
      };

      const CreateManifesto = await this.CreateManifesto(
        file.buffer,
        dadosManifesto,
      );

      // Cartório exige PDF/A; converte antes de a Intellisign assinar
      const documentoPdfA = await converterParaPdfA(CreateManifesto);

      const upload = await this.uploadManifesto(
        envelope.id,
        documentoPdfA,
        NomeArquivo,
        token,
      );
      await this.uploadRegistro(registro.id, {
        UUID: envelope.id,
        hash: upload.sha1,
        doc_modificado_down: upload.links.download,
        doc_modificado_viw: upload.links.display,
      });

      await Promise.all(
        signatarios.map(
          async (signatario, index) =>
            await this.addSignatarios(
              signatario,
              createIntelesignDto.type,
              index,
              envelope.id,
              token,
            ),
        ),
      );

      await this.sendEnvelop(envelope.id, token);

      const retorno = {
        download: upload.links.download,
        preview: upload.links.display,
        valorCalculado, // Retorna o valor resolvido no payload
      };

      return this.createResponse('Envelope criado com sucesso', 200, retorno);
    } catch (error) {
      // Se o envelope não chegou a ser enviado (não criado na Intellisign ou
      // recusado no /send, ex.: 402), desativa o registro para não ficar
      // um rascunho órfão nas listagens
      if (registroId) {
        await this.prisma.intelesign
          .updateMany({
            where: { id: registroId },
            data: { ativo: false },
          })
          .catch(() => undefined);
      }
      const message = error.message;
      const code = error.status || error.code || 500;
      throw new HttpException(message, code);
    }
  }

  /**
   * WhatsApp é cobrado à parte pela Intellisign (402 no /send sem o serviço
   * liberado para a API); só é usado quando ligado no .env
   */
  /**
   * O manifesto é gerado no envio e já lista todos os signatários como se
   * tivessem assinado. Por isso o documento assinado (e os links que levam
   * a ele) só é liberado depois que o envelope é concluído.
   */
  private envelopeConcluido(status?: string | null) {
    return status === 'done' || status === 'completed';
  }

  private ocultarAssinadoPendente<T extends { status?: string | null }>(
    envelope: T,
  ): T {
    if (!envelope || this.envelopeConcluido(envelope.status)) return envelope;
    return {
      ...envelope,
      doc_modificado_viw: null,
      doc_modificado_down: null,
      background_sheet: null,
      public_link: null,
    };
  }

  private whatsappAtivo() {
    return process.env.INTELESIGN_WHATSAPP === 'true';
  }

  config() {
    return { whatsapp: this.whatsappAtivo() };
  }

  /**
   * Normaliza para 55 + DDD + número (só dígitos), ou null se inválido.
   */
  private normalizarTelefone(valor?: string | null): string | null {
    let digitos = (valor || '').replace(/\D/g, '');
    if (
      (digitos.length === 12 || digitos.length === 13) &&
      digitos.startsWith('55')
    ) {
      digitos = digitos.slice(2);
    }
    return digitos.length === 10 || digitos.length === 11
      ? `55${digitos}`
      : null;
  }

  async findAll(query: QueryDto, User: UserPayload) {
    console.log('🚀 ~ IntelesignService ~ findAll ~ User:', User);
    console.log('🚀 ~ IntelesignService ~ findAll ~ query:', query);
    try {
      const {
        page = 1,
        limit = 20,
        cca_id, // number[] | undefined
        id,
        nome,
        status,
        data_inicio,
        data_fim,
      } = query;

      const skip = (page - 1) * limit;
      const take = limit;
      const where: any = {};

      const ccaIdFilter = await (async (): Promise<number[] | undefined> => {
        if (cca_id) {
          if (User.hierarquia === 'ADM') {
            return cca_id;
          }

          const ccaIdsPermitidosPeloToken = User.Financeira.map(Number);

          // 1. Filtra os IDs solicitados contra os permitidos
          const ccaIdsFiltrados = cca_id.filter((idSolicitado) =>
            ccaIdsPermitidosPeloToken.includes(idSolicitado),
          );

          if (ccaIdsFiltrados.length === 0) {
            throw new HttpException(
              'Acesso negado. Você não tem permissão para os CCAs solicitados.',
              403,
            );
          }

          // 2. Valida quais são "Financeiras"
          const validationPromises = ccaIdsFiltrados.map(async (id) => {
            const IsFinanceira = await this.GetFinanceira(id);
            return IsFinanceira ? id : null;
          });

          const validatedResults = await Promise.all(validationPromises);

          // Filtra os nulos, mantendo apenas os IDs válidos
          const validFinanceiras = validatedResults.filter(
            (id) => id !== null,
          ) as number[];

          if (validFinanceiras.length === 0) {
            throw new HttpException(
              'Nenhum dos CCAs solicitados tem permissão para utilizar esse serviço',
              403,
            );
          }

          return validFinanceiras;
        }

        if (!cca_id) {
          if (User.hierarquia === 'ADM') {
            return undefined;
          }

          const validationPromises = User.Financeira.map(async (item) => {
            const id = Number(item);
            const IsFinanceira = await this.GetFinanceira(id);
            return IsFinanceira ? id : null;
          });

          const validatedResults = await Promise.all(validationPromises);
          const isFinanceira = validatedResults.filter(
            (id) => id !== null,
          ) as number[];

          if (isFinanceira.length === 0) {
            throw new HttpException(
              'Acesso negado. Nenhum CCA válido encontrado para o usuário.',
              403,
            );
          }

          return isFinanceira;
        }

        return undefined;
      })();

      if (ccaIdFilter) {
        where.cca_id = {
          in: ccaIdFilter,
        };
      }

      if (id) {
        where.id = Number(id);
      }
      // Substitua o bloco do "if (nome)" por:
      if (nome) {
        where.OR = [
          {
            title: {
              contains: nome,
              mode: 'insensitive', // ignora maiúsculas/minúsculas no Postgres
            },
          },
          {
            signatarios: {
              some: {
                nome: {
                  contains: nome,
                  mode: 'insensitive',
                },
              },
            },
          },
        ];
      }
      if (status === 'canceled') {
        where.cancelado_em = { not: null };
      } else if (status) {
        // O filtro recebe um status "de tela" e o banco guarda o state bruto
        // retornado pela Intellisign (ex.: 'completed', 'new', 'expired')
        where.status = { in: STATUS_FILTRO_MAP[status] ?? [status] };
        // Cancelado sai dos demais filtros, mesmo com state ativo na Intellisign
        where.cancelado_em = null;
      }
      // Datas filtram pela criação do envelope, considerando o dia inteiro
      // no fuso de Brasília (o front envia apenas 'YYYY-MM-DD')
      if (data_inicio || data_fim) {
        where.createdAt = {
          ...(data_inicio && {
            gte: new Date(`${data_inicio}T00:00:00.000-03:00`),
          }),
          ...(data_fim && {
            lte: new Date(`${data_fim}T23:59:59.999-03:00`),
          }),
        };
      }
      where.ativo = true;

      const [dados, count] = await Promise.all([
        this.prisma.intelesign.findMany({
          where,
          skip,
          take,
          include: {
            cca: true,
            signatarios: { orderBy: [{ ordem: 'asc' }, { id: 'asc' }] },
            contrutora: true,
            empreendimento: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        }),
        this.prisma.intelesign.count({ where }),
      ]);

      await Promise.allSettled(
        dados
          .filter((item) => item.UUID)
          .map(async (item) => {
            try {
              await this.findOneStatus(item.id);
            } catch (err) {
              console.warn(
                `[findAll] Não foi possível atualizar o status do envelope ID ${item.id}:`,
                err.message,
              );
            }
          }),
      );

      const dadosAtualizados = await this.prisma.intelesign.findMany({
        where,
        skip,
        take,
        include: {
          cca: true,
          // Mesma ordem em que a Intellisign notifica (routing_order)
          signatarios: { orderBy: [{ ordem: 'asc' }, { id: 'asc' }] },
          contrutora: true,
          imobiliaria: { select: { id: true, fantasia: true } },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return this.createResponse(
        'Dados buscados com sucesso',
        200,
        (dadosAtualizados || []).map((e) => this.ocultarAssinadoPendente(e)),
        count,
        page,
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Erro ao buscar dados',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async findOne(id: number, User: UserPayload) {
    try {
      await this.findOneStatus(id);
      const where: any = {};
      if (User.hierarquia !== 'ADM') {
        const validatedFinanceiras = User.Financeira.map(async (item) => {
          const itemId = Number(item);
          const IsFinanceira = await this.GetFinanceira(Number(item));
          return IsFinanceira ? itemId : null;
        });
        const validatedResults = await Promise.all(validatedFinanceiras);

        const Financeiras = validatedResults.filter(
          (id) => id !== null,
        ) as number[];

        if (Financeiras.length === 0) {
          throw new HttpException(
            'Acesso negado. Nenhuma financeira válida encontrada para o usuário.',
            403,
          );
        }
        where.cca_id = {
          in: Financeiras,
        };
      }

      where.id = Number(id);
      where.ativo = true;
      const envelope = await this.prisma.intelesign.findUnique({
        where,
        include: {
          cca: true,
          // Mesma ordem em que a Intellisign notifica (routing_order)
          signatarios: { orderBy: [{ ordem: 'asc' }, { id: 'asc' }] },
          contrutora: true,
          imobiliaria: { select: { id: true, fantasia: true } },
          empreendimento: true,
        },
      });
      // O front usa para saber se o celular do signatário recebe WhatsApp
      return (
        envelope && {
          ...this.ocultarAssinadoPendente(envelope),
          whatsapp: this.whatsappAtivo(),
        }
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Erro ao buscar dados',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Campos expostos no NatoDoc: apenas o necessário para a imobiliária
   * acompanhar o processo (sem valores cobrados e sem CPF dos signatários).
   */
  private readonly natodocSelect = {
    id: true,
    title: true,
    description: true,
    status: true,
    status_view: true,
    cancelado_em: true,
    motivo_cancelamento: true,
    type: true,
    original_name: true,
    createdAt: true,
    updatedAt: true,
    doc_original_viw: true,
    doc_original_down: true,
    doc_modificado_viw: true,
    doc_modificado_down: true,
    contrutora: { select: { id: true, fantasia: true } },
    empreendimento: { select: { id: true, nome: true } },
    imobiliaria: { select: { id: true, fantasia: true } },
    signatarios: {
      orderBy: [{ ordem: 'asc' as const }, { id: 'asc' as const }],
      select: {
        id: true,
        nome: true,
        email: true,
        qualificacao: true,
        state: true,
        filled_at: true,
      },
    },
  };

  /**
   * Resolve o acesso ao NatoDoc a partir do banco (e não do JWT), para que
   * alterações de permissão/vínculo valham sem precisar de novo login.
   * Retorna `null` em imobiliariaIds quando o usuário é ADM (vê todas).
   */
  private async natodocAcesso(
    User: UserPayload,
  ): Promise<{ imobiliariaIds: number[] | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: User.id },
      select: {
        hierarquia: true,
        role: true,
        imobiliarias: { select: { imobiliariaId: true } },
      },
    });
    if (!user) {
      throw new HttpException('Usuário não encontrado', 404);
    }
    if (user.hierarquia === 'ADM') {
      return { imobiliariaIds: null };
    }
    const role = (user.role ?? {}) as Record<string, unknown>;
    if (!role.natodoc) {
      throw new HttpException('Acesso negado ao NatoDoc', 403);
    }
    return {
      imobiliariaIds: user.imobiliarias.map((i) => i.imobiliariaId),
    };
  }

  async natodocFindAll(query: NatodocQueryDto, User: UserPayload) {
    try {
      const { page = 1, limit = 20, imobiliaria_id, nome, status } = query;
      const { imobiliariaIds } = await this.natodocAcesso(User);

      if (imobiliariaIds && imobiliariaIds.length === 0) {
        return this.createResponse(
          'Nenhuma imobiliária vinculada',
          200,
          [],
          0,
          page,
        );
      }

      const where: any = { ativo: true };

      if (imobiliaria_id) {
        if (imobiliariaIds && !imobiliariaIds.includes(imobiliaria_id)) {
          throw new HttpException(
            'Acesso negado. Você não está vinculado a essa imobiliária.',
            403,
          );
        }
        where.imobiliaria_id = imobiliaria_id;
      } else {
        where.imobiliaria_id = imobiliariaIds
          ? { in: imobiliariaIds }
          : { not: null };
      }

      if (nome) {
        where.OR = [
          { title: { contains: nome, mode: 'insensitive' } },
          {
            signatarios: {
              some: { nome: { contains: nome, mode: 'insensitive' } },
            },
          },
        ];
      }
      if (status) {
        where.status = status;
      }

      const skip = (page - 1) * limit;

      // Sincroniza o status da página atual com a Intellisign antes de listar
      const pagina = await this.prisma.intelesign.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true },
      });
      await Promise.allSettled(
        pagina
          .filter((item) => item.status !== 'done')
          .map((item) => this.findOneStatus(item.id)),
      );

      const [dados, count] = await Promise.all([
        this.prisma.intelesign.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: this.natodocSelect,
        }),
        this.prisma.intelesign.count({ where }),
      ]);

      return this.createResponse(
        'Dados buscados com sucesso',
        200,
        dados.map((e) => this.ocultarAssinadoPendente(e)),
        count,
        page,
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Erro ao buscar dados',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async natodocFindOne(id: number, User: UserPayload) {
    try {
      const { imobiliariaIds } = await this.natodocAcesso(User);

      const where: any = {
        id,
        ativo: true,
        imobiliaria_id: imobiliariaIds ? { in: imobiliariaIds } : { not: null },
      };

      const existe = await this.prisma.intelesign.findFirst({
        where,
        select: { id: true, status: true },
      });
      if (!existe) {
        throw new HttpException('Envelope não encontrado', 404);
      }
      if (existe.status !== 'done') {
        await this.findOneStatus(id).catch(() => undefined);
      }

      const envelope = await this.prisma.intelesign.findFirst({
        where,
        select: this.natodocSelect,
      });
      return this.createResponse(
        'Dados buscados com sucesso',
        200,
        envelope && this.ocultarAssinadoPendente(envelope),
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Erro ao buscar dados',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async findOneStatus(id: number) {
    try {
      // Busca o envelope
      const envelope = await this.prisma.executeWithRetry(() =>
        this.prisma.intelesign.findUnique({
          where: { id },
          include: {
            signatarios: true,
          },
        }),
      );

      if (!envelope) {
        throw new HttpException('Envelope não encontrado', 404);
      }

      if (!envelope.UUID) {
        throw new HttpException(
          'Envelope sem UUID: não foi criado na Intellisign',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      // Obtém o token e busca o status na API externa
      const token = await this.refreshToken();

      const status = await this.GetStatus(envelope.UUID, token);

      // Prepara as atualizações em lote
      const updatePromises = [];

      // Atualiza status dos signatários
      for (const recipient of status.recipients || []) {
        const recipientData = this.extractRecipientData(recipient);

        // Busca o signatário pelo UUID primeiro (mais eficiente)
        let signatario = await this.prisma.executeWithRetry(() =>
          this.prisma.intelesignSignatario.findFirst({
            where: { UUID: recipientData.uuid, envelope_id: envelope.id },
          }),
        );
        // Se não encontrou pelo UUID, tenta buscar por CPF e email
        if (!signatario) {
          const testsignatario = await this.prisma.executeWithRetry(() =>
            this.prisma.intelesignSignatario.findFirst({
              where: {
                cpf: recipientData.cpf,
                email: recipientData.email,
                envelope_id: envelope.id,
              },
            }),
          );

          if (testsignatario) {
            await this.prisma.executeWithRetry(() =>
              this.prisma.intelesignSignatario.update({
                where: { id: testsignatario.id },
                data: {
                  state: recipientData.state,
                  filled_at: recipientData.assinado,
                  ...(recipientData.uuid && { UUID: recipientData.uuid }),
                  ...(recipientData.ordem && { ordem: recipientData.ordem }),
                },
              }),
            );

            signatario = testsignatario;
          }
        }

        // Se encontrou o signatário, prepara a atualização
        if (signatario) {
          await this.prisma.executeWithRetry(() =>
            this.prisma.intelesignSignatario.update({
              where: { id: signatario.id },
              data: {
                state: recipientData.state,
                filled_at: recipientData.assinado,
                ...(recipientData.uuid && { UUID: recipientData.uuid }),
                ...(recipientData.ordem && { ordem: recipientData.ordem }),
              },
            }),
          );
        }
      }

      let StatusName: string;
      switch (status.state) {
        case 'done':
          StatusName = 'Concluído';
          break;
        case 'completed':
          StatusName = 'Concluído';
          break;
        case 'pending':
          StatusName = 'Pendente';
          break;
        case 'draft':
          StatusName = 'Rascunho';
          break;
        case 'new':
          StatusName = 'Novo';
          break;
        case 'draft':
          StatusName = 'Rascunho';
          break;
        case 'signing':
          StatusName = 'Assinando';
          break;
        case 'rejected':
          StatusName = 'Rejeitado';
          break;
        case 'failed':
          StatusName = 'Falhou';
          break;
        case 'expired':
          StatusName = 'Expirado';
          break;
        default:
          StatusName = 'Em andamento';
          break;
      }
      const linksDownloads = status.documents[0].links;
      // Adiciona a atualização do status do envelope
      updatePromises.push(
        this.prisma.executeWithRetry(() =>
          this.prisma.intelesign.update({
            where: { id },
            data: {
              status: status.state,
              // Cancelamento é só do SisNato: a Intellisign não sabe dele
              status_view: envelope.cancelado_em ? 'Cancelado' : StatusName,
              doc_modificado_down: linksDownloads?.download || null,
              doc_modificado_viw: linksDownloads?.display || null,
              background_sheet: linksDownloads?.background_sheet || null,
              public_link: status?.public_completed_link || null,
            },
          }),
        ),
      );

      // Executa todas as atualizações em paralelo
      await Promise.all(updatePromises);

      // Antes da conclusão não devolve os links do documento assinado
      const resposta = this.envelopeConcluido(status.state)
        ? status
        : {
            ...status,
            public_completed_link: null,
            documents: (status.documents || []).map((d: any) => ({
              ...d,
              links: null,
            })),
          };
      return this.createResponse(
        'Envelope encontrado com sucesso',
        200,
        resposta,
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Erro ao buscar dados',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Extrai dados do destinatário da resposta da API
   */
  private extractRecipientData(recipient: any) {
    const data = {
      uuid: recipient.id || null,
      state: recipient.state || null,
      // Preenche a ordem também em envelopes criados antes da coluna existir
      ordem: Number(recipient.routing_order) || null,
      email: null as string | null,
      assinado: null as string | null,
      cpf: null as string | null,
    };

    for (const addressee of recipient.addressees || []) {
      if (addressee.via === 'email') {
        data.email = addressee.value;
      }
      // A assinatura pode ter vindo de qualquer canal (email ou WhatsApp)
      if (addressee.ran_action_at && !data.assinado) {
        data.assinado = addressee.ran_action_at;
      }

      for (const identifier of addressee.identifiers || []) {
        if (identifier.code === 'CPF') {
          data.cpf = identifier.value.replace(/\D/g, '');
        }
      }
    }

    return data;
  }

  remove(id: number, User: UserPayload) {
    try {
      const where: any = {};
      if (User.hierarquia !== 'ADM') {
        const isFinanceira = [];
        User.Financeira.forEach(async (item) => {
          const IsFinanceira = await this.GetFinanceira(Number(item));
          if (IsFinanceira) {
            isFinanceira.push(Number(item));
          }
        });
        if (isFinanceira.length === 0) {
          throw new HttpException('Acesso negado', 403);
        }
        where.cca_id = {
          in: isFinanceira,
        };
      }
      where.id = Number(id); // converte para número se necessário
      return this.prisma.intelesign.update({
        where,
        data: { ativo: false },
      });
    } catch (error) {
      throw new HttpException(
        error.message || 'Erro ao buscar dados',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  //===================================== libs =====================================

  async refreshToken() {
    try {
      const data = await this.GetTokenData();
      // console.log(
      //   '🚀 ~ IntelesignService ~ refreshToken ~ ativo:',
      //   this.isTimestampExpired(Number(data.expires_in)),
      // );
      if (!this.isTimestampExpired(Number(data.expires_in))) {
        return data.access_token;
      }
      const Client_Id = process.env.INTELLISING_CLIENTE_ID;
      const Client_Secret = process.env.INTELLISING_CLIENTE_SECRET;
      const response = await fetch('https://api.intellisign.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: Client_Id,
          client_secret: Client_Secret,
          scope: '*',
        }),
      });
      const responseData = await response.json();
      if (!response.ok) {
        const message = responseData.message;
        const code = responseData.code;
        throw new HttpException(message, code);
      }
      await this.prisma.appToken.update({
        where: {
          id: 1,
        },
        data: {
          access_token: responseData.access_token,
          expires_in: responseData.expires_in,
        },
      });
      return responseData.access_token;
    } catch (error) {
      const message = error.message;
      const code = error.code;
      throw new HttpException(message, code);
    }
  }

  async GetTokenData() {
    const response = await this.prisma.appToken.findUnique({
      where: {
        id: 1,
      },
    });
    return response;
  }

  isTimestampExpired(timestamp: number) {
    const now = Math.floor(Date.now() / 1000);
    return now > timestamp;
  }

  async S3Upload(
    file: Buffer,
    NomeArquivo: string,
    minetype: string,
    setor: BucketDto,
  ) {
    try {
      console.log(`[S3Upload] Iniciando upload: ${NomeArquivo} para ${setor}`);

      await this.s3.uploadFile(setor, NomeArquivo, minetype, file);

      console.log('[S3Upload] Sucesso no upload.');

      return {
        url_view: `${process.env.LOCAL_URL}/file/${setor}/${NomeArquivo}`,
        url_download: `${process.env.LOCAL_URL}/file/download/${setor}/${NomeArquivo}`,
      };
    } catch (error) {
      console.error('🚨 ERRO NO S3 UPLOAD 🚨');

      // Verifica se é um erro do SDK da AWS com resposta oculta
      if (error.$response) {
        console.error('--- Resposta Bruta do S3 ---');
        console.error('Status Code:', error.$response.statusCode);
        console.error('Body:', error.$response.body); // Aqui veremos o texto que começa com 'e'
        console.error('----------------------------');
      } else {
        console.error('Erro genérico:', error);
      }

      const message = error.message || 'Erro no upload S3';
      // Garante que o código é um número válido para o HttpException
      const code = typeof error.code === 'number' ? error.code : 500;

      throw new HttpException(`Falha S3: ${message}`, code);
    }
  }

  async createRegistro(data: {
    original_name: string;
    doc_original_down: string;
    doc_original_viw: string;
    signatarios: SignatarioDto[];
    cca_id?: number; // Adicione o '?' para indicar que é opcional
    message: string;
    title: string;
    description: string;
    valor: number;
    construtora_id: number;
    empreendimento_id?: number;
    imobiliaria_id?: number;
    user_id: number;
    type: string;
  }) {
    const registro = await this.prisma.intelesign.create({
      data: {
        original_name: data.original_name,
        doc_original_down: data.doc_original_down,
        doc_original_viw: data.doc_original_viw,
        message: data.message,
        title: data.title,
        description: data.description,
        valor: data.valor,
        construtora_id: data.construtora_id,
        ...(data.cca_id && { cca_id: data.cca_id }),
        ...(data.empreendimento_id && {
          empreendimento_id: data.empreendimento_id,
        }),
        ...(data.imobiliaria_id && {
          imobiliaria_id: data.imobiliaria_id,
        }),
        user_id: data.user_id,
        type: data.type,
      },
    });

    await Promise.all(
      data.signatarios.map((sig: SignatarioDto, index: number) =>
        this.prisma.intelesignSignatario.create({
          data: {
            // Mesmo routing_order enviado em addSignatarios
            ordem: index + 1,
            nome: sig.nome,
            email: sig.email,
            cpf: sig.cpf,
            telefone: sig.telefone || null,
            qualificacao: sig.qualificacao || null,
            envelope_id: registro.id,
          },
        }),
      ),
    );

    return registro;
  }

  async uploadRegistro(
    id: number,
    data: {
      UUID: string;
      hash: string;
      doc_modificado_down: string;
      doc_modificado_viw: string;
    },
  ) {
    const upload = await this.prisma.intelesign.update({
      where: {
        id: id,
      },
      data: {
        UUID: data.UUID,
        hash: data.hash,
        doc_modificado_down: data.doc_modificado_down,
        doc_modificado_viw: data.doc_modificado_viw,
      },
    });
    return upload;
  }

  async CreateEnvelope(
    title: string,
    subject: string,
    message: string,
    expireIn: number,
    token: string,
  ) {
    try {
      const url = 'https://api.intellisign.com/v1/envelopes';

      const expireDate = new Date();
      expireDate.setDate(expireDate.getDate() + expireIn);

      const Body = {
        title: title,
        subject: subject,
        message: message,
        // A Intellisign retorna 500 com ISO 8601 (com "T"/"Z"); aceita apenas "YYYY-MM-DD HH:mm:ss" (UTC)
        expire_at: expireDate.toISOString().slice(0, 19).replace('T', ' '),
        action_reminder_frequency: 24,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(Body),
      });

      // --- ALTERAÇÃO DE SEGURANÇA ---
      const responseText = await response.text(); // Lê como texto primeiro
      let data;

      try {
        data = JSON.parse(responseText); // Tenta converter para JSON
      } catch (e) {
        // Se falhar, é porque a API retornou erro em texto (ex: "error: ...")
        console.error('API retornou formato inválido:', responseText);
        throw new Error(`Erro API (Não-JSON): ${responseText}`);
      }

      if (!response.ok) {
        // Se a resposta for JSON mas com status de erro (400, 401, etc)
        const errorMessage = data.message || JSON.stringify(data);
        throw new Error(
          `Erro API Intelesign (${response.status}): ${errorMessage}`,
        );
      }
      // ------------------------------

      return data;
    } catch (error) {
      console.error('Erro ao criar envelope:', error);
      throw new Error(`Erro ao criar envelope: ${error.message}`);
    }
  }

  private LAYOUT = {
    // Margens
    MARGIN: 50,
    MARGIN_TOP: 60,

    // Cores
    COLORS: {
      BLACK: rgb(0, 0, 0),
      WHITE: rgb(1, 1, 1),
      GRAY: rgb(0.3, 0.3, 0.3),
      LIGHT_GRAY: rgb(0.4, 0.4, 0.4),
      BLUE: rgb(0, 0, 1),
      GREEN: rgb(0, 0.7, 0),
      DARK_GREEN: rgb(0, 0.5, 0),
      YELLOW: rgb(1, 1, 0.4),
    },

    // Tamanhos de fonte
    FONT_SIZES: {
      TITLE: 20,
      SUBTITLE: 10,
      NORMAL: 12,
      SMALL: 10,
    },

    // Tamanhos de elementos
    ELEMENTS: {
      QR_CODE_SIZE: 90,
      CHECKBOX_SIZE: 16,
      LINE_HEIGHT: 18,
      SPACING: 20,
      SMALL_SPACING: 10,
    },
  };

  /**
   * Desenha a assinatura do sistema em todas as páginas do PDF
   * @param pdfDoc Documento PDF
   * @param assinaturaImage Imagem da assinatura
   */
  private async drawAssinaturaSistema(
    pdfDoc: PDFDocument,
    assinaturaImage: any,
  ) {
    try {
      const pages = pdfDoc.getPages();
      const dataAtual = new Date();
      const dataFormatada = dataAtual.toLocaleDateString('pt-BR');
      const horaFormatada = dataAtual.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const textoAssinatura = `Documento assinado no assinador Intellisign em parceria com Sisnato, documento gerado em ${dataFormatada} às ${horaFormatada}`;

      // Carrega a fonte para o texto
      const { robotoRegular } = await this.loadFonts(pdfDoc);

      for (const page of pages) {
        try {
          const margin = 20;
          const textWidth = robotoRegular.widthOfTextAtSize(textoAssinatura, 8);
          const pageHeight = page.getHeight();
          const pageWidth = page.getWidth();

          // Configurações de rotação e posicionamento
          const rotation = degrees(90); // Rotação de 90 graus
          const x = page.getWidth() - margin; // Posição X no canto direito
          const y = margin * 2; // Posição Y ajustada para o canto inferior

          // Tamanho da fonte reduzido
          const fontSize = 6;
          const lineHeight = fontSize * 1.2; // Espaçamento entre linhas

          // Ajusta o ponto de origem para a rotação
          const originX = x;
          const originY = y;

          // Desenha a imagem da assinatura (se disponível) e o texto
          if (assinaturaImage) {
            // Reduz o tamanho da logo para ficar proporcional ao texto
            const imgDims = assinaturaImage.scale(0.2);
            const imgHeight = imgDims.height * 0.6;

            // Desenha a imagem rotacionada
            page.drawImage(assinaturaImage, {
              x: originX,
              y: originY + 10, // Ajuste fino na posição Y da logo
              width: imgDims.width * 0.8,
              height: imgHeight,
              rotate: rotation,
            });

            // Desenha o texto rotacionado ao lado da imagem
            page.drawText(textoAssinatura, {
              x: originX - 4,
              y: originY + imgDims.width - 10, // Ajusta o espaçamento entre a logo e o texto
              size: fontSize + 1,
              font: robotoRegular,
              color: rgb(0.3, 0.3, 0.3),
              rotate: rotation,
            });
          } else {
            // Apenas o texto se a imagem não estiver disponível
            page.drawText(textoAssinatura, {
              x: originX,
              y: originY,
              size: fontSize,
              font: robotoRegular,
              color: rgb(0.3, 0.3, 0.3),
              rotate: rotation,
            });
          }
        } catch (error) {
          console.error('Erro ao desenhar assinatura na página:', error);
        }
      }
    } catch (error) {
      console.error('Erro no processo de desenho da assinatura:', error);
    }
  }

  async CreateManifesto(
    file: Buffer,
    dadosManifesto: {
      codigoValidacao: string;
      asstype: string;
      signatarios: {
        nome: string;
        email: string;
        cpf: string;
        qualificacao?: string;
      }[];
      urlVerificacao: string;
      logoPath?: string;
    },
  ) {
    try {
      // 1. Configuração inicial do documento
      const pdfDoc = await PDFDocument.load(file);
      pdfDoc.registerFontkit(fontkit);

      // 2. Configuração da página
      const page = pdfDoc.addPage();
      const { width, height } = page.getSize();

      // 3. Carregamento de fontes
      const { robotoRegular, robotoBold } = await this.loadFonts(pdfDoc);

      // 4. Função auxiliar para desenhar texto
      const drawText = this.createTextDrawer(page, robotoRegular, robotoBold);

      // 5. Posicionamento inicial
      let yPosition = height - this.LAYOUT.MARGIN_TOP;

      // 6. Geração do QR Code
      const qrCodeImage = await this.generateQRCode(pdfDoc, dadosManifesto);

      // 7. Desenha o cabeçalho com logo e QR Code
      yPosition = await this.drawHeader(
        page,
        drawText,
        qrCodeImage,
        dadosManifesto,
        yPosition,
        width,
        robotoRegular,
        robotoBold,
        pdfDoc,
      );

      // 8. Desenha o código de validação
      yPosition = this.drawValidationCode(
        page,
        drawText,
        dadosManifesto.codigoValidacao,
        yPosition,
        width,
        robotoRegular,
        robotoBold,
      );

      // 9. Desenha a lista de signatários
      yPosition = await this.drawSignatories(
        page,
        drawText,
        dadosManifesto.signatarios || [],
        yPosition,
        pdfDoc,
      );

      // 10. Desenha as instruções de verificação
      this.drawVerificationInstructions(
        page,
        drawText,
        dadosManifesto,
        yPosition,
        robotoRegular,
      );

      // 11. Adiciona a assinatura do sistema em todas as páginas
      try {
        let assinaturaImage = null;
        const assinaturaPath = path.resolve(
          process.cwd(),
          'src/api/intelesign/public/assinatura.png',
        );

        if (fs.existsSync(assinaturaPath)) {
          const assinaturaBytes = await fs.promises.readFile(assinaturaPath);
          assinaturaImage = await pdfDoc.embedPng(assinaturaBytes);
        }

        await this.drawAssinaturaSistema(pdfDoc, assinaturaImage);
      } catch (error) {
        console.error('Erro ao adicionar assinatura do sistema:', error);
        // Não interrompe o fluxo em caso de erro na assinatura
      }

      // 12. Salva e retorna o PDF
      const pdfBytes = await pdfDoc.save();
      return Buffer.from(pdfBytes);
    } catch (error) {
      console.error('Erro ao criar envelope:', error);
      throw new Error(`Erro ao criar envelope: ${error.message}`);
    }
  }

  async loadFonts(pdfDoc: PDFDocument) {
    try {
      const fontsPath = path.join(process.cwd(), 'src/pdf_create/assets/fonts');

      const [robotoRegular, robotoBold] = await Promise.all([
        pdfDoc.embedFont(
          await fs.promises.readFile(
            path.join(fontsPath, 'Roboto-Regular.ttf'),
          ),
        ),
        pdfDoc.embedFont(
          await fs.promises.readFile(path.join(fontsPath, 'Roboto-Bold.ttf')),
        ),
      ]);

      return { robotoRegular, robotoBold };
    } catch (error) {
      console.error('Erro ao carregar fontes Roboto:', error);
      throw new Error('Não foi possível carregar as fontes Roboto necessárias');
    }
  }

  createTextDrawer(page: any, regularFont: any, boldFont: any) {
    return (
      text: string,
      x: number,
      y: number,
      size: number,
      options: {
        bold?: boolean;
        color?: any;
        maxWidth?: number;
        italic?: boolean;
      } = {},
    ) => {
      if (!text) return;

      const {
        bold = false,
        color = this.LAYOUT.COLORS.BLACK,
        maxWidth,
      } = options;
      const font = bold ? boldFont : regularFont;

      try {
        if (maxWidth) {
          // Implementar quebra de linha se necessário
          page.drawText(text, { x, y, size, font, color, maxWidth });
        } else {
          page.drawText(text, { x, y, size, font, color });
        }
      } catch (error) {
        console.error('Erro ao desenhar texto:', { text, error });
      }
    };
  }

  async generateQRCode(
    pdfDoc: PDFDocument,
    data: {
      codigoValidacao: string;
      asstype: string;
      signatarios: {
        nome: string;
        email: string;
        cpf: string;
      }[];
      urlVerificacao: string;
      logoPath?: string;
    },
  ) {
    try {
      const urlVerificacao = data.urlVerificacao || '';
      const codigoValidacao = data.codigoValidacao || 'N/A';

      const qrCodeDataUrl = await QRCode.toDataURL(
        `${urlVerificacao}/${codigoValidacao}`,
        { width: 300, margin: 1 }, // Maior resolução para melhor qualidade
      );

      const qrCodeBytes = Buffer.from(qrCodeDataUrl.split(',')[1], 'base64');
      return await pdfDoc.embedPng(qrCodeBytes);
    } catch (error) {
      console.error('Erro ao gerar QR Code:', error);
      throw new Error('Falha ao gerar o QR Code');
    }
  }

  async drawHeader(
    page: any,
    drawText: Function,
    qrCodeImage: any,
    data: {
      codigoValidacao: string;
      asstype: string;
      signatarios: {
        nome: string;
        email: string;
        cpf: string;
      }[];
      urlVerificacao: string;
      logoPath?: string;
    },
    yPosition: number,
    pageWidth: number,
    robotoRegular: any,
    robotoBold: any,
    pdfDoc: any,
  ) {
    const { MARGIN, ELEMENTS, COLORS, FONT_SIZES } = this.LAYOUT;
    const headerTop = yPosition;
    const qrCodeSize = ELEMENTS.QR_CODE_SIZE;

    try {
      // 1. Desenha o logo à esquerda
      const logoPath =
        data.logoPath ||
        path.resolve(
          process.cwd(),
          'src/api/intelesign/public/Logo_Sisnato_013.png',
        );

      if (fs.existsSync(logoPath)) {
        const logoBytes = await fs.promises.readFile(logoPath);
        const logoImage = await pdfDoc.embedPng(logoBytes);

        // Ajusta o tamanho mantendo a proporção
        const logoAspectRatio = logoImage.width / logoImage.height;
        const logoHeight = qrCodeSize;
        const logoWidth = qrCodeSize * logoAspectRatio;

        page.drawImage(logoImage, {
          x: MARGIN,
          y: headerTop - logoHeight,
          width: logoWidth,
          height: logoHeight,
        });
      }
    } catch (error) {
      console.error('Erro ao carregar o logo:', error);
      drawText('LOGO NÃO CARREGADO', MARGIN, headerTop - 20, 10, {
        color: COLORS.BLACK,
        bold: true,
      });
    }
    // 2. Desenha o QR Code à direita
    page.drawImage(qrCodeImage, {
      x: pageWidth - MARGIN - qrCodeSize,
      y: headerTop - qrCodeSize,
      width: qrCodeSize,
      height: qrCodeSize,
    });

    // O ícone da ICP Brasil foi movido para aparecer antes do nome de cada signatário

    // 3. Título centralizado
    const title = 'Manifesto de\nAssinatura Digital';
    let currentY = headerTop - qrCodeSize - 30;

    // Usamos a fonte em negrito para calcular a largura
    const titleFont = robotoBold;

    title.split('\n').forEach((line) => {
      const textWidth = titleFont.widthOfTextAtSize(line, FONT_SIZES.TITLE);
      drawText(line, (pageWidth - textWidth) / 2, currentY, FONT_SIZES.TITLE, {
        bold: true,
      });
      currentY -= FONT_SIZES.TITLE + 5;
    });

    // 4. Subtítulo
    const subtitle = 'Documento assinado digitalmente com validade jurídica';
    const subtitleFont = robotoRegular;
    const subtitleWidth = subtitleFont.widthOfTextAtSize(
      subtitle,
      FONT_SIZES.SUBTITLE,
    );

    drawText(
      subtitle,
      (pageWidth - subtitleWidth) / 2,
      currentY - 15,
      FONT_SIZES.SUBTITLE,
      { color: COLORS.GRAY },
    );

    return currentY - 50; // Retorna a nova posição Y
  }

  drawValidationCode(
    page: any,
    drawText: Function,
    codigoValidacao: string,
    yPosition: number,
    pageWidth: number,
    robotoRegular: any,
    robotoBold: any,
  ) {
    const { MARGIN, COLORS, FONT_SIZES } = this.LAYOUT;

    // Texto do código
    const label = 'Código de validação: ';
    const labelWidth = robotoRegular.widthOfTextAtSize(
      label,
      FONT_SIZES.NORMAL,
    );
    const codeWidth = robotoBold.widthOfTextAtSize(
      codigoValidacao,
      FONT_SIZES.NORMAL,
    );

    const startX = (pageWidth - (labelWidth + codeWidth)) / 2;

    // Desenha o texto do label
    drawText(label, startX, yPosition, FONT_SIZES.NORMAL, {
      color: COLORS.LIGHT_GRAY,
    });

    // Desenha o fundo amarelo para o código
    const codeX = startX + labelWidth;
    const padding = 4;

    page.drawRectangle({
      x: codeX - padding / 2,
      y: yPosition - 4,
      width: codeWidth + padding,
      height: 18,
      color: COLORS.YELLOW,
      borderColor: COLORS.BLACK,
      borderWidth: 0.5,
    });

    // Desenha o código em negrito
    drawText(codigoValidacao, codeX, yPosition, FONT_SIZES.NORMAL, {
      bold: true,
    });

    // Linha separadora
    yPosition -= 40;
    page.drawLine({
      start: { x: MARGIN, y: yPosition },
      end: { x: pageWidth - MARGIN, y: yPosition },
      thickness: 0.5,
      color: COLORS.BLACK,
    });

    return yPosition - 30;
  }

  async drawSignatories(
    page: any,
    drawText: Function,
    signatarios: {
      nome: string; // Nome do signatário
      email: string; // Email do signatário
      cpf: string; // CPF do signatário
      qualificacao?: string; // Papel no contrato (ex.: Testemunha)
    }[],
    yPosition: number,
    pdfDoc?: any, // Adicionando parâmetro opcional para o PDFDoc
  ) {
    const { MARGIN, COLORS, FONT_SIZES, ELEMENTS } = this.LAYOUT;
    const ICON_SIZE = 16; // Tamanho do ícone da ICP Brasil
    const SPACING = 4; // Espaçamento entre elementos

    // Carrega as imagens necessárias
    let icpLogoImage = null;
    let checkMarkImage = null;

    if (pdfDoc) {
      try {
        // Carrega o logo da ICP Brasil
        const icpLogoPath = path.resolve(
          process.cwd(),
          'src/api/intelesign/public/icp-brasil.png',
        );

        // Carrega a imagem do check
        const checkMarkPath = path.resolve(
          process.cwd(),
          'src/api/intelesign/public/check-mark.png',
        );

        if (fs.existsSync(icpLogoPath)) {
          const icpLogoBytes = await fs.promises.readFile(icpLogoPath);
          icpLogoImage = await pdfDoc.embedPng(icpLogoBytes);
        }

        if (fs.existsSync(checkMarkPath)) {
          const checkMarkBytes = await fs.promises.readFile(checkMarkPath);
          checkMarkImage = await pdfDoc.embedPng(checkMarkBytes);
        }
      } catch (error) {
        console.error('Erro ao carregar imagens:', error);
      }
    }

    // Texto explicativo
    const textoExplicativo =
      'Documento assinado digitalmente com o uso de Certificado Digital ICP Brasil, o assinador IntelliSign, pelos seguintes signatários:';

    // Quebra o texto em várias linhas se necessário - simplificado
    const maxWidth = page.getSize().width - 2 * MARGIN;
    const lines = [];
    const words = textoExplicativo.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      // Estimativa simples: aproximadamente 6 pixels por caractere
      if (testLine.length * 6 <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          lines.push(word);
        }
      }
    }
    if (currentLine) lines.push(currentLine);

    // Desenha o texto explicativo
    lines.forEach((line) => {
      drawText(line, MARGIN, yPosition, FONT_SIZES.NORMAL);
      yPosition -= ELEMENTS.LINE_HEIGHT;
    });

    yPosition -= 10;

    // Desenha a lista de signatários
    signatarios.forEach((signatario) => {
      // Desenha o ícone de check
      if (checkMarkImage) {
        // Ajusta o tamanho do ícone para caber dentro do checkbox
        const checkSize = ELEMENTS.CHECKBOX_SIZE * 0.9; // 80% do tamanho do checkbox
        const checkX = MARGIN + (ELEMENTS.CHECKBOX_SIZE - checkSize) / 2;
        const checkY = yPosition - 2 + (ELEMENTS.CHECKBOX_SIZE - checkSize) / 2;

        page.drawImage(checkMarkImage, {
          x: checkX,
          y: checkY,
          width: checkSize,
          height: checkSize,
        });
      } else {
        // Fallback para texto caso a imagem não carregue
        drawText('✓', MARGIN + 5, yPosition + 3, 12, {
          color: COLORS.WHITE,
          bold: true,
        });
      }

      // Posição inicial para o ícone e texto do signatário
      let currentX = MARGIN + ELEMENTS.CHECKBOX_SIZE + SPACING;

      // Desenha o logo da ICP Brasil
      if (icpLogoImage) {
        // Calcula as dimensões mantendo a proporção
        const logoHeight = ICON_SIZE;
        const logoWidth =
          (icpLogoImage.width / icpLogoImage.height) * logoHeight;

        // Desenha o logo
        page.drawImage(icpLogoImage, {
          x: currentX,
          y: yPosition - 1,
          width: logoWidth,
          height: logoHeight,
        });

        // Ajusta a posição X para o texto do signatário
        currentX += logoWidth + SPACING;
      } else {
        // Fallback: desenha um retângulo com o texto "ICP" se o logo não estiver disponível
        page.drawRectangle({
          x: currentX,
          y: yPosition - 1,
          width: ICON_SIZE * 1.5,
          height: ICON_SIZE,
          color: rgb(0.9, 0.9, 0.9),
          borderColor: COLORS.BLACK,
          borderWidth: 0.5,
        });

        drawText('ICP', currentX + 4, yPosition + 3, 8, {
          color: COLORS.BLACK,
          bold: true,
        });

        currentX += ICON_SIZE * 1.5 + SPACING;
      }

      // Nome e CPF do signatário
      const nome = signatario.nome || 'Nome não informado';
      const cpf = signatario.cpf
        ? this.formatCPF(signatario.cpf)
        : 'CPF não informado';
      const signatarioTexto = `${nome} - ${cpf}`;

      drawText(signatarioTexto, currentX, yPosition, FONT_SIZES.NORMAL);

      // Qualificação logo abaixo do nome (testemunha, representante da SPE...)
      if (signatario.qualificacao) {
        yPosition -= 14;
        drawText(
          `Qualificação: ${signatario.qualificacao}`,
          currentX,
          yPosition,
          FONT_SIZES.SMALL,
          { color: COLORS.GRAY },
        );
      }

      yPosition -= 25;
    });

    // Linha separadora
    yPosition -= 20;
    page.drawLine({
      start: { x: MARGIN, y: yPosition },
      end: { x: page.getWidth() - MARGIN, y: yPosition },
      thickness: 0.5,
      color: COLORS.BLACK,
    });

    return yPosition - 30;
  }

  drawVerificationInstructions(
    page: any,
    drawText: Function,
    data: {
      codigoValidacao: string;
      asstype: string;
      signatarios: {
        nome: string;
        email: string;
        cpf: string;
      }[];
      urlVerificacao: string;
      logoPath?: string;
    },
    yPosition: number,
    font: any,
  ) {
    const { MARGIN, COLORS, FONT_SIZES } = this.LAYOUT;
    const pageWidth = page.getWidth();

    // Primeira linha das instruções
    const instrucao1 = 'Para verificar as assinaturas acesse: ';
    const urlVerificacao = data.urlVerificacao || '';

    // Desenha o texto da instrução
    drawText(instrucao1, MARGIN, yPosition, FONT_SIZES.NORMAL);

    // Desenha a URL em azul - com quebra de linha se necessário
    const textWidth = font.widthOfTextAtSize(instrucao1, FONT_SIZES.NORMAL);
    const maxWidth = page.getSize().width - MARGIN * 2 - textWidth;

    // Função para quebrar texto em várias linhas
    const breakText = (text: string, maxWidth: number): string[] => {
      const words = text.split('/');
      const lines: string[] = [];
      let currentLine = '';

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const testLine = currentLine ? `${currentLine}/${word}` : word;
        const testWidth = font.widthOfTextAtSize(testLine, FONT_SIZES.NORMAL);

        if (testWidth <= maxWidth || currentLine === '') {
          currentLine = testLine;
        } else {
          lines.push(currentLine);
          currentLine = word;
        }

        // Se for o último item, adiciona a linha atual
        if (i === words.length - 1 && currentLine) {
          lines.push(currentLine);
        }
      }

      return lines.length > 0 ? lines : [text];
    };

    // Quebra a URL em várias linhas se necessário
    const urlLines = breakText(urlVerificacao, maxWidth);

    // Desenha cada linha da URL
    urlLines.forEach((line, index) => {
      const lineY = yPosition - index * (FONT_SIZES.NORMAL + 5);
      const lineX = index === 0 ? MARGIN + textWidth : MARGIN + 20; // Indenta as linhas seguintes mais à esquerda

      // Desenha o texto do link em azul
      drawText(line, lineX, lineY, FONT_SIZES.NORMAL, {
        color: COLORS.BLUE,
        underline: true,
      });

      // Adiciona link clicável (será visível em visualizadores de PDF que suportam)
      try {
        const textWidth = font.widthOfTextAtSize(line, FONT_SIZES.NORMAL);
        page.drawRectangle({
          x: lineX,
          y: lineY - 1,
          width: textWidth,
          height: 14,
          borderWidth: 0,
          color: COLORS.WHITE,
          opacity: 0,
          link: page.doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [lineX, lineY - 12, lineX + textWidth, lineY + 2],
            Border: [0, 0, 0],
            A: {
              Type: 'Action',
              S: 'URI',
              URI: line.startsWith('http') ? line : `http://${line}`,
            },
          }),
        });
      } catch (error) {
        console.warn('Erro ao adicionar link clicável:', error);
      }
    });
    // Ajusta a posição Y baseado no número de linhas da URL
    yPosition -= urlLines.length * (FONT_SIZES.NORMAL + 5) + 15;

    // Segunda linha das instruções
    const instrucao2 = 'Ou escaneie o QR Code acima com seu dispositivo móvel.';
    drawText(instrucao2, MARGIN, yPosition, FONT_SIZES.NORMAL);

    yPosition -= 25;

    // Link direto - também com quebra de linha se necessário
    const linkDireto = `${urlVerificacao}${data.codigoValidacao || ''}`;
    const linkLabel = 'Link direto: ';
    drawText(linkLabel, MARGIN, yPosition, FONT_SIZES.NORMAL);

    const labelWidth = font.widthOfTextAtSize(linkLabel, FONT_SIZES.NORMAL);
    const maxLinkWidth = page.getSize().width - MARGIN * 2 - labelWidth;

    // Quebra o link direto em várias linhas se necessário
    const linkLines = breakText(linkDireto, maxLinkWidth);

    // Desenha cada linha do link direto
    linkLines.forEach((line, index) => {
      const lineY = yPosition - index * (FONT_SIZES.NORMAL + 5);
      const lineX = index === 0 ? MARGIN + labelWidth : MARGIN + 20; // Indenta as linhas seguintes mais à esquerda

      // Desenha o texto do link em azul
      drawText(line, lineX, lineY, FONT_SIZES.NORMAL, {
        color: COLORS.BLUE,
        underline: true,
      });

      // Adiciona link clicável (será visível em visualizadores de PDF que suportam)
      try {
        const textWidth = font.widthOfTextAtSize(line, FONT_SIZES.NORMAL);
        page.drawRectangle({
          x: lineX,
          y: lineY - 1,
          width: textWidth,
          height: 14,
          borderWidth: 0,
          color: COLORS.WHITE,
          opacity: 0,
          link: page.doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [lineX, lineY - 12, lineX + textWidth, lineY + 2],
            Border: [0, 0, 0],
            A: {
              Type: 'Action',
              S: 'URI',
              URI: line.startsWith('http') ? line : `http://${line}`,
            },
          }),
        });
      } catch (error) {
        console.warn('Erro ao adicionar link clicável:', error);
      }
    });

    // Ajusta a posição Y baseado no número de linhas do link direto
    yPosition -= linkLines.length * (FONT_SIZES.NORMAL + 5) + 15;

    // Adiciona texto condicional para assinatura não qualificada
    if (data.asstype !== 'qualified') {
      yPosition -= 20; // Espaçamento adicional
      const notaAssinatura = 'Documento com validação e assinatura simples';
      drawText(notaAssinatura, MARGIN, yPosition, FONT_SIZES.NORMAL, {
        color: COLORS.GRAY,
        italic: true,
      });
    }
  }

  formatCPF(cpf: string): string {
    if (!cpf) return '';

    // Remove caracteres não numéricos
    const cleaned = cpf.replace(/\D/g, '');

    // Formata como 000.000.000-00
    return cleaned
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }

  async uploadManifesto(
    envelopeId: string,
    file: Buffer<ArrayBuffer>,
    nomeArquivo: string,
    token: string,
  ) {
    try {
      const url = `https://api.intellisign.com/v1/envelopes/${envelopeId}/documents`;

      const blob = new Blob([file], { type: 'application/pdf' });
      const formData = new FormData();
      formData.append('file', blob, nomeArquivo);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      // --- TRATAMENTO SEGURO ---
      const responseText = await response.text();

      if (!response.ok) {
        console.error('Resposta de erro da API:', {
          status: response.status,
          body: responseText,
        });

        // Tenta extrair mensagem JSON se possível, senão usa o texto
        try {
          const jsonErr = JSON.parse(responseText);
          throw new Error(jsonErr.message || JSON.stringify(jsonErr));
        } catch (e) {
          throw new Error(
            `API retornou erro ${response.status}: ${responseText}`,
          );
        }
      }

      return JSON.parse(responseText); // Aqui já sabemos que é seguro ou falhará no try/catch pai
      // ------------------------
    } catch (error) {
      console.error('Erro ao upload manifesto:', error);
      throw new Error(`Erro ao upload manifesto: ${error.message}`);
    }
  }

  // Tipos de assinatura suportados pela API do InteliSign
  private readonly TIPOS_ASSINATURA = {
    SIMPLE: 'simple',
    QUALIFIED: 'qualified',
  } as const;

  // Interface para o objeto Signatário
  private signatario: {
    email: string;
    nome: string;
    cpf: string;
  };

  /**
   * Adiciona um signatário a um envelope existente no InteliSign
   * @param signatario Dados do signatário
   * @param tipoAssinatura Tipo de assinatura a ser utilizada
   * @param index Índice do signatário na ordem de roteamento
   * @param envelopeId ID do envelope no InteliSign
   * @param token Token de autenticação
   * @returns Dados do signatário adicionado
   */
  async addSignatarios(
    signatario: { email: string; nome: string; cpf: string; telefone?: string },
    tipoAssinatura: string, // Aceita string genérica para maior flexibilidade
    index: number,
    envelopeId: string,
    token: string,
  ): Promise<any> {
    // Validações iniciais
    if (!signatario) {
      throw new Error('Nenhum signatário fornecido');
    }

    if (!signatario.email || !signatario.nome || !signatario.cpf) {
      throw new Error(
        'Dados do signatário incompletos. É necessário informar email, nome e CPF.',
      );
    }

    if (typeof index !== 'number' || index < 0) {
      throw new Error('Índice do signatário inválido');
    }

    if (!envelopeId) {
      throw new Error('ID do envelope não fornecido');
    }

    if (!token) {
      throw new Error('Token de autenticação não fornecido');
    }

    try {
      // Formata o CPF (remove caracteres não numéricos)
      const cpfFormatado = signatario.cpf.replace(/\D/g, '');

      // Valida o formato do email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(signatario.email)) {
        throw new Error('Formato de email inválido');
      }

      // Valida o formato do CPF (apenas verifica se tem 11 dígitos)
      if (cpfFormatado.length !== 11) {
        throw new Error('CPF deve conter 11 dígitos');
      }

      // Obtém o tipo de assinatura, usando 'simple' como padrão se não for encontrado
      const tipoAssinaturaValido = Object.values(
        this.TIPOS_ASSINATURA,
      ).includes(tipoAssinatura as any)
        ? tipoAssinatura
        : this.TIPOS_ASSINATURA.SIMPLE;

      // Cada endereçado é um canal de notificação; todos exigem o CPF
      const enderecado = (via: 'email' | 'whatsapp', value: string) => ({
        via,
        value,
        name: signatario.nome.trim(),
        identifiers: [{ code: 'CPF', is_required: true, value: cpfFormatado }],
      });
      const telefone = this.whatsappAtivo()
        ? this.normalizarTelefone(signatario.telefone)
        : null;
      const montarCorpo = (comWhatsapp: boolean) => ({
        type: 'signer',
        signature_type: tipoAssinaturaValido,
        routing_order: index + 1,
        addressees: [
          enderecado('email', signatario.email.trim()),
          // WhatsApp usa o telefone no padrão E164 (+55...)
          ...(comWhatsapp ? [enderecado('whatsapp', `+${telefone}`)] : []),
        ],
      });

      const url = `https://api.intellisign.com/v1/envelopes/${envelopeId}/recipients`;
      const enviar = async (comWhatsapp: boolean) => {
        const corpo = montarCorpo(comWhatsapp);
        console.log(
          `[IntelesignService] Adicionando signatário ao envelope ${envelopeId}`,
          {
            email: signatario.email,
            whatsapp: comWhatsapp,
            tipoAssinatura: corpo.signature_type,
            routingOrder: corpo.routing_order,
          },
        );
        const resposta = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(corpo),
        });
        return { resposta, dados: await resposta.json(), corpo };
      };

      let {
        resposta: response,
        dados: responseData,
        corpo: requestBody,
      } = await enviar(!!telefone);

      // Se a conta não aceitar WhatsApp (ou o número for recusado), não
      // perde o envelope: cadastra de novo só com o email
      if (!response.ok && telefone) {
        console.warn(
          '[IntelesignService] Intellisign recusou o WhatsApp; tentando só com email',
          { status: response.status, data: JSON.stringify(responseData) },
        );
        ({
          resposta: response,
          dados: responseData,
          corpo: requestBody,
        } = await enviar(false));
      }

      if (!response.ok) {
        console.error('Erro na resposta da API do InteliSign:', {
          status: response.status,
          statusText: response.statusText,
          data: JSON.stringify(responseData),
          requestBody: JSON.stringify(requestBody),
        });

        throw new Error(
          responseData.message ||
            `Erro ao adicionar signatário: ${response.status} ${response.statusText}`,
        );
      }

      console.log(`[IntelesignService] Signatário adicionado com sucesso`, {
        envelopeId,
        recipientId: responseData.id,
        email: signatario.email,
      });

      try {
        // Filtra pelo envelope: o mesmo CPF pode estar em outros envelopes
        const signatarioExistente =
          await this.prisma.intelesignSignatario.findFirst({
            where: { cpf: cpfFormatado, Intelesign: { UUID: envelopeId } },
          });

        if (signatarioExistente) {
          await this.prisma.intelesignSignatario.update({
            where: { id: signatarioExistente.id },
            data: { UUID: responseData.id },
          });

          console.log(
            `[IntelesignService] Signatário atualizado no banco de dados`,
            {
              id: signatarioExistente.id,
              UUID: responseData.id,
            },
          );
        } else {
          console.warn(
            '[IntelesignService] Signatário não encontrado no banco de dados para atualização',
            {
              cpf: cpfFormatado,
            },
          );
        }
      } catch (dbError) {
        console.error(
          '[IntelesignService] Erro ao atualizar signatário no banco de dados:',
          dbError,
        );
      }

      return responseData;
    } catch (error) {
      console.error('[IntelesignService] Erro ao adicionar signatário:', {
        error: error.message,
        stack: error.stack,
        signatario: {
          email: signatario?.email,
          nome: signatario?.nome,
          cpf: signatario?.cpf,
        },
        envelopeId,
        tipoAssinatura,
      });

      throw new Error(`Falha ao adicionar signatário: ${error.message}`);
    }
  }

  async sendEnvelop(envelopeId: string, token: string) {
    try {
      const url = `https://api.intellisign.com/v1/envelopes/${envelopeId}/send`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Erro ao enviar envelope: ${data.message}`);
      }
      return data;
    } catch (error) {
      console.error('Erro ao enviar envelope:', error);
      throw new Error(`Erro ao enviar envelope: ${error.message}`);
    }
  }

  /** Último reenvio por envelope/signatário, para evitar disparos repetidos */
  private readonly ultimoReenvio = new Map<string, number>();
  private readonly INTERVALO_REENVIO_MS = 60 * 1000;

  /**
   * Reenvia a notificação de assinatura pela Intellisign (email e, quando o
   * signatário tem telefone, WhatsApp). Sem signatarioId, reenvia para todos
   * os pendentes do envelope.
   */
  /**
   * Marca o envelope como cancelado só no SisNato. A Intellisign não é
   * avisada, então os links de assinatura continuam válidos lá.
   */
  async cancelar(id: number, User: UserPayload, motivo?: string) {
    if (User.hierarquia !== 'ADM') {
      // Lê do banco (e não do JWT) para a permissão valer sem novo login
      const usuario = await this.prisma.user.findUnique({
        where: { id: User.id },
        select: { role: true },
      });
      if (!(usuario?.role as Record<string, unknown>)?.natosign_cancelar) {
        throw new HttpException(
          'Você não tem permissão para cancelar envelopes',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    const where: any = { id, ativo: true };
    if (User.hierarquia !== 'ADM') {
      // Mesma regra de acesso do detalhe: só CCAs que são financeiras
      const ids = User.Financeira.map(Number);
      const financeiras = (
        await Promise.all(
          ids.map(async (cca) =>
            (await this.GetFinanceira(cca)) ? cca : null,
          ),
        )
      ).filter((cca) => cca !== null);
      if (financeiras.length === 0) {
        throw new HttpException('Acesso negado', HttpStatus.FORBIDDEN);
      }
      where.cca_id = { in: financeiras };
    }

    const envelope = await this.prisma.intelesign.findFirst({
      where,
      select: { id: true, cancelado_em: true },
    });
    if (!envelope) {
      throw new HttpException('Envelope não encontrado', HttpStatus.NOT_FOUND);
    }
    if (envelope.cancelado_em) {
      throw new HttpException(
        'Envelope já está cancelado',
        HttpStatus.BAD_REQUEST,
      );
    }

    const atualizado = await this.prisma.intelesign.update({
      where: { id: envelope.id },
      data: {
        cancelado_em: new Date(),
        cancelado_por: User.nome,
        motivo_cancelamento: motivo?.trim() || null,
        status_view: 'Cancelado',
      },
      select: {
        id: true,
        cancelado_em: true,
        cancelado_por: true,
        motivo_cancelamento: true,
      },
    });
    return this.createResponse('Envelope cancelado', 200, atualizado);
  }

  async reenviar(id: number, User: UserPayload, signatarioId?: number) {
    // findOne aplica a mesma regra de acesso do detalhe e sincroniza o status
    const envelope = await this.findOne(id, User);
    if (!envelope) {
      throw new HttpException('Envelope não encontrado', 404);
    }
    if (!envelope.UUID) {
      throw new HttpException(
        'Envelope sem UUID: não foi criado na Intellisign',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (envelope.cancelado_em) {
      throw new HttpException(
        'Envelope cancelado não pode ser reenviado',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Rascunho (draft/new) ainda não foi enviado; finalizados não têm pendentes
    const semReenvio = [
      'draft',
      'new',
      'done',
      'completed',
      'rejected',
      'failed',
      'expired',
    ];
    if (semReenvio.includes(envelope.status)) {
      throw new HttpException(
        'Envelope não está aguardando assinatura',
        HttpStatus.BAD_REQUEST,
      );
    }

    let url = `https://api.intellisign.com/v1/envelopes/${envelope.UUID}/renotify`;
    let destino = 'todos os signatários pendentes';
    if (signatarioId) {
      const signatario = envelope.signatarios.find(
        (s) => s.id === signatarioId,
      );
      if (!signatario) {
        throw new HttpException('Signatário não encontrado', 404);
      }
      if (signatario.state === 'done' || signatario.filled_at) {
        throw new HttpException(
          'Este signatário já assinou',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!signatario.UUID) {
        throw new HttpException(
          'Signatário ainda sem identificação na Intellisign. Sincronize o status e tente novamente.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      url = `https://api.intellisign.com/v1/envelopes/${envelope.UUID}/recipients/${signatario.UUID}/notify`;
      destino = signatario.nome;
    }

    const chave = `${id}:${signatarioId ?? 'todos'}`;
    const ultimo = this.ultimoReenvio.get(chave) ?? 0;
    if (Date.now() - ultimo < this.INTERVALO_REENVIO_MS) {
      throw new HttpException(
        'Notificação reenviada há pouco. Aguarde 1 minuto.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const token = await this.refreshToken();
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const dados = await response.json().catch(() => ({}));
      console.error('[IntelesignService] Erro ao reenviar notificação', {
        envelope: envelope.UUID,
        signatarioId,
        status: response.status,
        dados: JSON.stringify(dados),
      });
      if (response.status === 400 || response.status === 412) {
        throw new HttpException(
          dados?.message ||
            'A Intellisign não reenviou: o envelope ou o signatário não está aguardando assinatura.',
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        dados?.message || 'Erro ao reenviar notificação na Intellisign',
        HttpStatus.BAD_GATEWAY,
      );
    }

    this.ultimoReenvio.set(chave, Date.now());
    return this.createResponse(`Notificação reenviada para ${destino}`, 200, {
      envelopeId: envelope.id,
      signatarioId: signatarioId ?? null,
    });
  }

  /**
   * Corrige o email de um signatário que ainda não assinou (somente ADM).
   * A Intellisign aceita PATCH no destinatário mesmo com o envelope enviado;
   * o corpo substitui a lista de endereçados inteira, então os demais canais
   * (WhatsApp) e o CPF são reenviados como estão lá.
   */
  async editarEmailSignatario(
    id: number,
    signatarioId: number,
    email: string,
    User: UserPayload,
  ) {
    if (User.hierarquia !== 'ADM') {
      throw new HttpException(
        'Somente administradores podem editar o email do signatário',
        HttpStatus.FORBIDDEN,
      );
    }
    // findOne sincroniza o status antes de validar
    const envelope = await this.findOne(id, User);
    if (!envelope) {
      throw new HttpException('Envelope não encontrado', 404);
    }
    if (!envelope.UUID) {
      throw new HttpException(
        'Envelope sem UUID: não foi criado na Intellisign',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (envelope.cancelado_em) {
      throw new HttpException(
        'Envelope cancelado não pode ser alterado',
        HttpStatus.BAD_REQUEST,
      );
    }
    const finalizados = ['done', 'completed', 'rejected', 'failed', 'expired'];
    if (finalizados.includes(envelope.status)) {
      throw new HttpException(
        'Envelope não está aguardando assinatura',
        HttpStatus.BAD_REQUEST,
      );
    }
    const signatario = envelope.signatarios.find((s) => s.id === signatarioId);
    if (!signatario) {
      throw new HttpException('Signatário não encontrado', 404);
    }
    if (signatario.state === 'done' || signatario.filled_at) {
      throw new HttpException(
        'Este signatário já assinou',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!signatario.UUID) {
      throw new HttpException(
        'Signatário ainda sem identificação na Intellisign. Sincronize o status e tente novamente.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (signatario.email.trim().toLowerCase() === email) {
      throw new HttpException(
        'O novo email é igual ao atual',
        HttpStatus.BAD_REQUEST,
      );
    }

    const token = await this.refreshToken();
    const status = await this.GetStatus(envelope.UUID, token);
    const recipient = (status.recipients || []).find(
      (r: any) => r.id === signatario.UUID,
    );
    if (!recipient) {
      throw new HttpException(
        'Signatário não encontrado na Intellisign',
        HttpStatus.NOT_FOUND,
      );
    }
    const cpf = signatario.cpf.replace(/\D/g, '');
    const addressees = (recipient.addressees || []).map((a: any) => ({
      via: a.via,
      value: a.via === 'email' ? email : a.value,
      name: a.name || signatario.nome.trim(),
      identifiers: (a.identifiers || []).map((i: any) => ({
        code: i.code,
        is_required: i.is_required ?? true,
        // A Intellisign devolve o CPF formatado; o cadastro usa só dígitos
        value: i.code === 'CPF' ? cpf : i.value,
      })),
    }));
    if (!addressees.some((a: any) => a.via === 'email')) {
      addressees.unshift({
        via: 'email',
        value: email,
        name: signatario.nome.trim(),
        identifiers: [{ code: 'CPF', is_required: true, value: cpf }],
      });
    }

    const url = `https://api.intellisign.com/v1/envelopes/${envelope.UUID}/recipients/${signatario.UUID}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ addressees }),
    });
    const dados = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[IntelesignService] Erro ao editar email do signatário', {
        envelope: envelope.UUID,
        signatarioId,
        status: response.status,
        dados: JSON.stringify(dados),
      });
      throw new HttpException(
        dados?.message || 'A Intellisign não aceitou a alteração do email',
        response.status === 422 || response.status === 400
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.BAD_GATEWAY,
      );
    }

    await this.prisma.intelesignSignatario.update({
      where: { id: signatario.id },
      data: { email },
    });
    console.log('[IntelesignService] Email do signatário alterado', {
      envelope: envelope.UUID,
      signatarioId,
      de: signatario.email,
      para: email,
      por: User.id,
    });

    // Só quem está na vez de assinar recebe o link agora; os demais são
    // notificados pela Intellisign quando chegar a ordem deles
    let notificado = false;
    let aviso: string | null = null;
    if (recipient.state === 'waiting' || recipient.state === 'signing') {
      const notify = await fetch(`${url}/notify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      notificado = notify.ok;
      if (!notify.ok) {
        const erro = await notify.json().catch(() => ({}));
        aviso =
          erro?.message ||
          'Não foi possível reenviar a notificação agora. Use "Reenviar" em alguns minutos.';
      }
    } else {
      aviso =
        'O signatário ainda não está na vez de assinar; receberá o email quando chegar a ordem dele.';
    }

    return this.createResponse(
      notificado
        ? `Email alterado e notificação enviada para ${email}`
        : `Email alterado para ${email}`,
      200,
      { signatarioId, email, notificado, aviso },
    );
  }

  async GetFinanceira(id: number): Promise<boolean> {
    const financeira = await this.prisma.financeiro.findUnique({
      where: {
        id: id,
        Intelesign_status: true,
      },
    });
    return !!financeira;
  }

  async GetStatus(uuid: string, token: string) {
    try {
      const url = `https://api.intellisign.com/v1/envelopes/${uuid}?extended=true`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const responseText = await response.text();
      let data: any;

      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(
          `[GetStatus] API Intellisign retornou resposta não-JSON (Status ${response.status}) para o envelope ${uuid}:`,
          responseText.slice(0, 200),
        );
        throw new HttpException(
          `API Intellisign indisponível ou retornou erro HTML (${response.status})`,
          HttpStatus.BAD_GATEWAY,
        );
      }

      if (!response.ok) {
        const errorMsg = data?.message || JSON.stringify(data);
        throw new Error(
          `Erro API Intellisign (${response.status}): ${errorMsg}`,
        );
      }

      return data;
    } catch (error) {
      console.error('Erro ao buscar status:', error.message);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Erro ao buscar status: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async IsExist(cpf: string) {
    try {
      const Exist = await this.prisma.solicitacao.findMany({
        where: {
          cpf: cpf,
          OR: [
            {
              andamento: {
                notIn: ['APROVADO', 'EMITIDO', 'REVOGADO'],
              },
            },
            { ativo: true },
          ],
        },
      });
      if (!Exist) {
        return this.createResponse('CPF nao encontrado', 200, null);
      }
      return this.createResponse('CPF encontrado', 200, Exist);
    } catch (error) {
      const message = error.message ? error.message : 'Erro Desconhecido';
      const retorno = {
        message,
      };
      throw new HttpException(retorno, 500);
    }
  }

  async download(id: string): Promise<StreamableFile> {
    try {
      const token = await this.refreshToken();
      // Removido '?extended=true' pois geralmente não é necessário para download de arquivo e pode adicionar latência.
      const url = `https://api.intellisign.com/v1/envelopes/${id}/download`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(`Erro ao baixar arquivo: ${JSON.stringify(data)}`);
      }
      // Cria um StreamableFile diretamente do corpo da resposta (ReadableStream)
      const fileStream = Readable.fromWeb(response.body as any);
      return new StreamableFile(fileStream);
    } catch (error) {
      console.error('Erro ao baixar arquivo:', error);
      throw new Error(`Erro ao baixar arquivo: ${error.message}`);
    }
  }

  /**
   * Método auxiliar para calcular o valor do envelope com base na hierarquia
   * Financeira (CCA) > Construtora > Valor Padrão (5.0)
   */
  private async calcularValorEnvelope(
    financeiroId?: number,
    construtoraId?: number,
    valorDto?: number,
  ): Promise<number> {
    // 1. Prioridade: Financeira (CCA)
    if (financeiroId) {
      const financeira = await this.prisma.financeiro.findUnique({
        where: { id: Number(financeiroId) },
        select: { Intelesign_status: true, Intelesign_price: true },
      });

      if (
        financeira &&
        financeira.Intelesign_status &&
        financeira.Intelesign_price &&
        financeira.Intelesign_price > 0
      ) {
        console.log(
          `[Intelesign] Valor definido pela Financeira (ID ${financeiroId}): R$ ${financeira.Intelesign_price}`,
        );
        return financeira.Intelesign_price;
      }
    }

    // 2. Segunda Prioridade: Construtora
    if (construtoraId) {
      const construtora = await this.prisma.construtora.findUnique({
        where: { id: Number(construtoraId) },
        select: { Intelesign_status: true, Intelesign_price: true },
      });

      if (
        construtora &&
        construtora.Intelesign_status &&
        construtora.Intelesign_price &&
        construtora.Intelesign_price > 0
      ) {
        console.log(
          `[Intelesign] Valor definido pela Construtora (ID ${construtoraId}): R$ ${construtora.Intelesign_price}`,
        );
        return construtora.Intelesign_price;
      }
    }

    // 3. Fallback: Valor vindo do DTO (se preenchido e > 0) ou Padrão de R$ 5,00
    const valorFinal = valorDto && valorDto > 0 ? valorDto : 5.0;
    console.log(`[Intelesign] Valor fallback aplicado: R$ ${valorFinal}`);
    return valorFinal;
  }
}
