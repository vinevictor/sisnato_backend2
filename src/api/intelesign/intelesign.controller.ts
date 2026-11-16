import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AuthGuard } from 'src/auth/auth.guard';
import { ErrorEntity } from 'src/entities/error.entity';
import { GetInfoSolicitacaoEntity } from '../get-infos/entities/get-info-solicitacao-entity';
import { GetInfoErrorEntity } from '../get-infos/entities/get-info.error.entity';
import { CreateIntelesignDto } from './dto/create-intelesign.dto';
import { NatodocQueryDto } from './dto/natodoc-query.dto';
import { QueryDto } from './dto/query.dto';
import { CancelarIntelesignDto } from './dto/cancelar.dto';
import { ReenviarIntelesignDto } from './dto/reenviar.dto';
import { EditarEmailSignatarioDto } from './dto/editar-email.dto';
import { IntelesignAllEntity } from './entities/intelesign.entity';
import { StatusEntity } from './entities/status/status.entity';
import { IntelesignService } from './intelesign.service';

@Controller('intelesign')
export class IntelesignController {
  constructor(private readonly intelesignService: IntelesignService) {}

  private createErrorResponse(message: string, status: number) {
    return {
      error: true,
      message,
      status,
      data: null,
      total: 0,
      page: 0,
    };
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Cria um novo envelope.',
    description:
      'Rota para criar um novo envelope, recebendo um arquivo e as informações do envelope via FormData.',
  })
  @UseInterceptors(FileInterceptor('file'))
  create(
    @Body() createIntelesignDto: CreateIntelesignDto, // Idealmente usar o DTO tipado
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    try {
      return this.intelesignService.create(createIntelesignDto, file, req.user);
    } catch (error) {
      return this.createErrorResponse(error.message, error.status);
    }
  }

  @Get()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Busca todas os registros de envelopes.',
    description:
      'Rota para buscar todas os registros de envelopes, com paginação e filtros.',
  })
  @ApiOkResponse({
    description: 'Busca todas os registros de envelopes.',
    type: IntelesignAllEntity,
  })
  @ApiNotFoundResponse({
    description: 'Erro ao buscar Solicitações.',
    type: ErrorEntity,
  })
  async findAll(@Req() req: any, @Query() query: QueryDto) {
    return await this.intelesignService.findAll(query, req.user);
  }

  @Get('config')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Configuração do NatoSign para o front.',
    description:
      'Informa se a notificação por WhatsApp está ligada (INTELESIGN_WHATSAPP).',
  })
  config() {
    return this.intelesignService.config();
  }

  @Get('natodoc')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'NatoDoc: lista os envelopes das imobiliárias do usuário.',
    description:
      'Somente leitura. ADM vê todos os envelopes vinculados a alguma imobiliária; demais usuários precisam da permissão natodoc e veem apenas as imobiliárias às quais estão vinculados.',
  })
  async natodocFindAll(@Req() req: any, @Query() query: NatodocQueryDto) {
    return await this.intelesignService.natodocFindAll(query, req.user);
  }

  @Get('natodoc/:id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'NatoDoc: busca um envelope de uma imobiliária do usuário.',
  })
  async natodocFindOne(@Param('id') id: string, @Req() req: any) {
    return await this.intelesignService.natodocFindOne(+id, req.user);
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Busca um registro de envelope.',
    description:
      'Rota para buscar um registro de envelope, com paginação e filtros.',
  })
  @ApiOkResponse({
    description: 'Busca um registro de envelope.',
    type: IntelesignAllEntity,
  })
  @ApiNotFoundResponse({
    description: 'Erro ao buscar Solicitações.',
    type: ErrorEntity,
  })
  async findOne(@Param('id') id: string, @Req() req: any) {
    return await this.intelesignService.findOne(+id, req.user);
  }

  @Get('/status/:id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Busca o status de um envelope.',
    description: 'Rota para buscar o status de um envelope.',
  })
  @ApiOkResponse({
    description: 'Busca o status de um envelope.',
    type: StatusEntity,
    example: StatusEntity,
  })
  @ApiNotFoundResponse({
    description: 'Erro ao buscar o status de um envelope.',
    type: ErrorEntity,
  })
  async findOneStatus(@Param('id') id: string) {
    return await this.intelesignService.findOneStatus(+id);
  }

  @Post(':id/reenviar')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reenvia a notificação de assinatura.',
    description:
      'Reenvia pela Intellisign (email e WhatsApp, quando o signatário tem telefone). Sem signatarioId, reenvia para todos os pendentes.',
  })
  @ApiNotFoundResponse({
    description: 'Envelope ou signatário não encontrado.',
    type: ErrorEntity,
  })
  async reenviar(
    @Param('id') id: string,
    @Body() dto: ReenviarIntelesignDto,
    @Req() req: any,
  ) {
    return await this.intelesignService.reenviar(
      +id,
      req.user,
      dto.signatarioId,
    );
  }

  @Patch(':id/signatario/:signatarioId/email')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Corrige o email de um signatário (somente ADM).',
    description:
      'Altera o email na Intellisign e no SisNato, sem recriar o envelope. Só para signatário que ainda não assinou, em envelope aguardando assinatura. Tenta reenviar a notificação para o novo email.',
  })
  @ApiNotFoundResponse({
    description: 'Envelope ou signatário não encontrado.',
    type: ErrorEntity,
  })
  async editarEmail(
    @Param('id') id: string,
    @Param('signatarioId') signatarioId: string,
    @Body() dto: EditarEmailSignatarioDto,
    @Req() req: any,
  ) {
    return await this.intelesignService.editarEmailSignatario(
      +id,
      +signatarioId,
      dto.email,
      req.user,
    );
  }

  @Post(':id/cancelar')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cancela o envelope no SisNato.',
    description:
      'Marca o envelope como cancelado só no SisNato (a Intellisign não é avisada). Ele continua na listagem, identificado como cancelado, e não pode mais ser reenviado.',
  })
  @ApiNotFoundResponse({
    description: 'Envelope não encontrado.',
    type: ErrorEntity,
  })
  async cancelar(
    @Param('id') id: string,
    @Body() dto: CancelarIntelesignDto,
    @Req() req: any,
  ) {
    return await this.intelesignService.cancelar(+id, req.user, dto.motivo);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Exclui um registro de envelope.',
    description:
      'Rota para excluir um registro de envelope, com paginação e filtros.',
  })
  @ApiOkResponse({
    description: 'Exclui um registro de envelope.',
    type: IntelesignAllEntity,
  })
  @ApiNotFoundResponse({
    description: 'Erro ao buscar Solicitações.',
    type: ErrorEntity,
  })
  remove(@Param('id') id: string, @Req() req: any) {
    try {
      return this.intelesignService.remove(+id, req.user);
    } catch (error) {
      return this.createErrorResponse(error.message, error.status);
    }
  }

  @Get('/checkcpf/:cpf')
  @ApiOperation({
    summary: 'Verifica se o CPF existe no banco',
    description: 'Verifica se o CPF existe no banco',
  })
  @ApiOkResponse({
    description: 'Verifica se o CPF existe no banco',
    type: [GetInfoSolicitacaoEntity],
  })
  @ApiResponse({
    status: 400,
    description: 'Erro na requisição',
    type: GetInfoErrorEntity,
  })
  async checkCpf(@Param('cpf') cpf: string) {
    return await this.intelesignService.IsExist(cpf);
  }
}
