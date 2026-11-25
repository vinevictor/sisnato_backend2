import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const INTEIRO = /^\d+$/;

/**
 * Filtros da Área da Construtora. Vêm pela query string, então tudo chega
 * como texto e é convertido no service.
 */
export class FiltroAreaConstrutoraDto {
  @ApiPropertyOptional({
    description: 'Obrigatório para ADM. O CONST pode escolher entre as suas.',
    example: '84',
  })
  @IsOptional()
  @Matches(INTEIRO, { message: 'construtoraId inválido' })
  construtoraId?: string;

  @ApiPropertyOptional({ example: '12' })
  @IsOptional()
  @Matches(INTEIRO, { message: 'empreendimentoId inválido' })
  empreendimentoId?: string;

  @ApiPropertyOptional({
    description: 'Início do período (AAAA-MM-DD). Padrão: dia 1 do mês atual.',
    example: '2026-11-01',
  })
  @IsOptional()
  @Matches(DATA, { message: 'inicio deve estar no formato AAAA-MM-DD' })
  inicio?: string;

  @ApiPropertyOptional({
    description: 'Fim do período (AAAA-MM-DD), incluído. Padrão: hoje.',
    example: '2026-11-25',
  })
  @IsOptional()
  @Matches(DATA, { message: 'fim deve estar no formato AAAA-MM-DD' })
  fim?: string;
}
