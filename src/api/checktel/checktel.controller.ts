import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { ChecktelService } from './checktel.service';
import { CreateChecktelDto } from './dto/create-checktel.dto';
import { UpdateChecktelDto } from './dto/update-checktel.dto';
import { ApiResponse } from '@nestjs/swagger';
import { Checktel } from './entities/checktel.entity';
import { ErrorChecktelEntity } from './entities/checktel.error.entity';

@Controller('checktel')
export class ChecktelController {
  constructor(private readonly checktelService: ChecktelService) {}

  @Get('/:tell')
  @ApiResponse({
    status: 200,
    description: 'Verificado com sucesso',
    type: Checktel,
  })
  @ApiResponse({
    status: 500,
    description: 'Erro interno',
    type: ErrorChecktelEntity,
  })
  async getTell(@Param('tell') tell: string) {
    return await this.checktelService.getTell(tell);
  }
}
