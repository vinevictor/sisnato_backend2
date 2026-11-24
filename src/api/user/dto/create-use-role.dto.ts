import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class CreateUseRoleDto {
  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Adm',
    description: 'Pode acessar a area administrador',
  })
  @IsBoolean({ message: 'adm deve ser true ou false' })
  @IsOptional()
  adm: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Now',
    description: 'Pode criar solicitacao de urgencia NoW',
  })
  @IsBoolean({ message: 'now deve ser true ou false' })
  @IsOptional()
  now?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'User',
    description: 'Pode Gerencia User',
  })
  @IsBoolean({ message: 'user deve ser true ou false' })
  @IsOptional()
  user?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Alert',
    description: 'Pode acessar a area Alert',
  })
  @IsBoolean({ message: 'alert deve ser true ou false' })
  @IsOptional()
  alert?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Direto',
    description: 'Pode acessar a area Nato Direto',
  })
  @IsBoolean({ message: 'direto deve ser true ou false' })
  @IsOptional()
  direto?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Chamado',
    description: 'Pode acessar a area Chamado',
  })
  @IsBoolean({ message: 'chamado deve ser true ou false' })
  @IsOptional()
  chamado?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Financeiro',
    description: 'Pode Gerencia CCa',
  })
  @IsBoolean({ message: 'financeiro deve ser true ou false' })
  @IsOptional()
  financeiro?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Construtora',
    description: 'Pode Gerencia Construtora',
  })
  @IsBoolean({ message: 'construtora deve ser true ou false' })
  @IsOptional()
  construtora?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Lista Construtora',
    description:
      'Pode ver cliente da Construtora no qual o user esta cadastrado',
  })
  @IsBoolean({ message: 'lista_const deve ser true ou false' })
  @IsOptional()
  lista_const?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Lista Empreendimento',
    description:
      'Pode ver cliente Empreendimento no qual o user esta cadastrado',
  })
  @IsBoolean({ message: 'lista_empre deve ser true ou false' })
  @IsOptional()
  lista_empre?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Solicitacao',
    description: 'Pode acessar a area Solicitacao',
  })
  @IsBoolean({ message: 'solicitacao deve ser true ou false' })
  @IsOptional()
  solicitacao?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Lista Financeiro',
    description: 'Pode ver cliente Financeiro no qual o user esta cadastrado',
  })
  @IsBoolean({ message: 'lista_finace deve ser true ou false' })
  @IsOptional()
  lista_finace?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Empreendimento',
    description: 'Pode Gerencia Empreendimento',
  })
  @IsBoolean({ message: 'empreendimento deve ser true ou false' })
  @IsOptional()
  empreendimento?: boolean;

  @ApiProperty({
    type: Boolean,
    required: true,
    title: 'Relatorio',
    description: 'Pode Gerencia Relatorio',
  })
  @IsBoolean({ message: 'relatorio deve ser true ou false' })
  @IsOptional()
  relatorio?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    title: 'Agente de Registro',
    description: 'Permite que o usuário atue como Agente de Registro',
  })
  @IsBoolean({ message: 'agente_registro deve ser true ou false' })
  @IsOptional()
  agente_registro?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    title: 'NatoDoc',
    description:
      'Pode acessar o NatoDoc (visualização dos envelopes das imobiliárias vinculadas)',
  })
  @IsBoolean({ message: 'natodoc deve ser true ou false' })
  @IsOptional()
  natodoc?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    title: 'Chat',
    description: 'Pode atender o webchat dos clientes',
  })
  @IsBoolean({ message: 'chat deve ser true ou false' })
  @IsOptional()
  chat?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    title: 'Cancelar NatoSign',
    description: 'Pode cancelar envelopes do NatoSign',
  })
  @IsBoolean({ message: 'natosign_cancelar deve ser true ou false' })
  @IsOptional()
  natosign_cancelar?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    title: 'Confirmar cancelamento NatoSign',
    description:
      'Recebe os pedidos de cancelamento do NatoSign e confirma (somente ADM)',
  })
  @IsBoolean({
    message: 'natosign_confirmar_cancelamento deve ser true ou false',
  })
  @IsOptional()
  natosign_confirmar_cancelamento?: boolean;
}
