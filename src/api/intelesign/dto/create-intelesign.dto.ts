import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { SignatarioDto } from './sign.dto';

export class CreateIntelesignDto {
  @ApiProperty({
    description: 'Arquivo PDF',
    type: 'string',
    format: 'binary', // Importante para indicar que é um arquivo
    required: true,
  })
  file: any;

  @ApiProperty({
    description: 'Array de signatários',
    example:
      '[{"nome": "Nome do signatário", "email": "email@exemplo.com", "cpf": "12345678901234"}]',
    required: true,
    type: SignatarioDto,
  })
  @IsOptional()
  @IsNotEmpty({
    message: 'Signatários é obrigatório',
  })
  @Transform(({ value }) => JSON.parse(value))
  @Type(() => SignatarioDto)
  signatarios: SignatarioDto[];

  @ApiProperty({
    description: 'Valor do documento',
    required: false,
    default: 15.0,
    type: Number,
  })
  @Transform(({ value }) => Number(value) || 15.0)
  @Type(() => Number)
  @IsOptional()
  valor: number;

  @ApiProperty({
    description: 'ID do CCA',
    example: '1',
    required: false,
    type: () => Number,
  })
  @Transform(({ value }) => Number(value))
  @Type(() => Number)
  @IsOptional()
  cca_id: number;

  @ApiProperty({
    description: 'ID do construtora',
    example: '1',
    required: true,
    type: () => Number,
  })
  @Transform(({ value }) => Number(value))
  @Type(() => Number)
  @IsNotEmpty({
    message: 'ID do construtora é obrigatório',
  })
  const_id: number;

  @ApiProperty({
    description: 'Titulo do envelope',
    default: `SisNato - Assinatura de documento`,
    required: false,
    type: () => String,
  })
  @IsOptional()
  @Transform(({ value }) => value || `SisNato - Assinatura de documento`)
  @Type(() => String)
  @MaxLength(60, { message: 'O título deve ter no máximo 60 caracteres' })
  title: string;

  @ApiProperty({
    description: 'Subtitulo do envelope',
    default: 'Contrato de financiamento de imóvel',
    required: false,
    type: () => String,
  })
  @IsOptional()
  @Transform(({ value }) => value || 'Contrato de financiamento de imóvel')
  @Type(() => String)
  @MaxLength(60, { message: 'O assunto deve ter no máximo 60 caracteres' })
  subject: string;

  @ApiProperty({
    description: 'Mensagem do envelope',
    default:
      'Por favor, assine o documento para prosseguir com o processo de financiamento de imóvel.',
    required: false,
    type: () => String,
  })
  @IsOptional()
  @Transform(
    ({ value }) =>
      value ||
      'Por favor, assine o documento para prosseguir com o processo de financiamento de imóvel.',
  )
  @Type(() => String)
  // Limites da Intellisign: acima disso o envelope é recusado com 422
  @MaxLength(500, { message: 'A mensagem deve ter no máximo 500 caracteres' })
  message: string;

  @ApiProperty({
    description: 'Dias de expiração do envelope',
    default: 7,
    required: false,
    type: () => Number,
  })
  @Transform(({ value }) => Number(value) || 7)
  @IsOptional()
  @Type(() => Number)
  expire_at: number;

  @ApiProperty({
    description: 'Tipo de assinatura utilizada no envelope',
    default: 'qualified',
    required: false,
    enum: ['simple', 'qualified'],
    type: () => String,
  })
  @IsEnum(['simple', 'qualified'])
  @IsOptional()
  @Transform(({ value }) => value || 'qualified')
  @Type(() => String)
  type: string;

  @ApiProperty({
    description: 'ID do Empreendimento',
    example: '1',
    required: false,
    type: () => Number,
  })
  @Transform(({ value }) => (value ? Number(value) : undefined))
  @Type(() => Number)
  @IsOptional()
  empreendimento_id?: number;

  @ApiProperty({
    description:
      'ID da Imobiliária que acompanha o processo (visualiza o envelope no NatoDoc)',
    example: '1',
    required: false,
    type: () => Number,
  })
  @Transform(({ value }) => (value ? Number(value) : undefined))
  @Type(() => Number)
  @IsOptional()
  imobiliaria_id?: number;
}
