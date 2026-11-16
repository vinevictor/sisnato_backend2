import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class EditarEmailSignatarioDto {
  @ApiProperty({
    description: 'Novo email do signatário',
    example: 'cliente@exemplo.com',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsNotEmpty({ message: 'Email é obrigatório' })
  @IsEmail({}, { message: 'Email inválido' })
  email: string;
}
