import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { RelatorioFinanceiroService } from './relatorio_financeiro.service';
import { CreateRelatorioFinanceiroDto } from './dto/create-relatorio_financeiro.dto';
import { UpdateRelatorioFinanceiroDto } from './dto/update-relatorio_financeiro.dto';
import { CreateRelatorioDto } from './dto/relatorio.tdo';

@Controller('relatorio')
export class RelatorioFinanceiroController {
  constructor(private readonly relatorioFinanceiroService: RelatorioFinanceiroService) {}

  @Post()
  create(@Body() createRelatorioFinanceiroDto: CreateRelatorioFinanceiroDto) {
    return this.relatorioFinanceiroService.create(createRelatorioFinanceiroDto);
  }
  @Post('financeiro')
  CreateRelatorioFinanceiro(@Body() data: CreateRelatorioDto) {
    return this.relatorioFinanceiroService.RelatorioFinanceiro(data);
  }

  @Get()
  findAll() {
    return this.relatorioFinanceiroService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.relatorioFinanceiroService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateRelatorioFinanceiroDto: UpdateRelatorioFinanceiroDto) {
    return this.relatorioFinanceiroService.update(+id, updateRelatorioFinanceiroDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.relatorioFinanceiroService.remove(+id);
  }
}
