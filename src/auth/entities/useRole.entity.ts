import { ApiProperty, ApiResponseProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UseRole {
  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  adm?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  now?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  user?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  alert?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  direto?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  chamado?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  financeiro?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  construtora?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  lista_const?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  lista_empre?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  solicitacao?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  lista_finace?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  empreendimento?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  relatorio?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  natosign?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  natosign_cancelar?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  natosign_confirmar_cancelamento?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  natodoc?: boolean;

  @ApiResponseProperty({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  area_construtora?: boolean;
}
