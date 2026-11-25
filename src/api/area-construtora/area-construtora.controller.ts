import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthGuard } from 'src/auth/auth.guard';
import {
  gerarPdf,
  gerarXlsx,
  nomeArquivo,
  TipoRelatorio,
} from './area-construtora.arquivos';
import { AreaConstrutoraService } from './area-construtora.service';
import { FiltroAreaConstrutoraDto } from './dto/filtro-area-construtora.dto';

const CONTENT_TYPE = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Área restrita da construtora (CONST vê as suas; ADM escolhe qualquer uma).
 */
@Controller('area-construtora')
@ApiTags('Área da Construtora')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class AreaConstrutoraController {
  constructor(private readonly service: AreaConstrutoraService) {}

  @Get('construtoras')
  @ApiOperation({ summary: 'Construtoras que o usuário pode consultar.' })
  construtoras(@Req() req: any) {
    return this.service.construtoras(req.user);
  }

  @Get('empreendimentos')
  @ApiOperation({ summary: 'Empreendimentos da construtora (para o filtro).' })
  empreendimentos(
    @Req() req: any,
    @Query('construtoraId') construtoraId?: string,
  ) {
    return this.service.empreendimentos(req.user, construtoraId);
  }

  @Get('indicadores')
  @ApiOperation({
    summary: 'Indicadores de certificação, envelopes e por empreendimento.',
  })
  indicadores(@Req() req: any, @Query() filtro: FiltroAreaConstrutoraDto) {
    return this.service.indicadores(req.user, filtro);
  }

  @Get('relatorio/:tipo/:formato')
  @ApiOperation({
    summary:
      'Relatório de movimentação (certificacao | envelopes) em pdf | xlsx.',
  })
  async relatorio(
    @Param('tipo') tipo: string,
    @Param('formato') formato: string,
    @Query() filtro: FiltroAreaConstrutoraDto,
    @Req() req: any,
    @Res() res: Response,
  ) {
    try {
      if (
        !['certificacao', 'envelopes'].includes(tipo) ||
        !(formato in CONTENT_TYPE)
      ) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .json({ message: 'Relatório não encontrado' });
      }
      const escopo = await this.service.escopo(req.user, filtro);
      const linhas =
        tipo === 'certificacao'
          ? await this.service.movimentoCertificacao(escopo)
          : await this.service.movimentoEnvelopes(escopo);
      const tipoRel = tipo as TipoRelatorio;
      const buffer =
        formato === 'pdf'
          ? await gerarPdf(tipoRel, escopo, linhas)
          : await gerarXlsx(tipoRel, escopo, linhas);

      res.set({
        'Content-Type': CONTENT_TYPE[formato],
        'Content-Disposition': `attachment; filename="${nomeArquivo(tipoRel, escopo, formato as 'pdf' | 'xlsx')}"`,
      });
      return res.status(HttpStatus.OK).send(buffer);
    } catch (error) {
      return res.status(error.status || 500).json({
        message: error.message || 'Erro ao gerar o relatório',
      });
    }
  }
}
