import { Module } from '@nestjs/common';
import { AreaConstrutoraController } from './area-construtora.controller';
import { AreaConstrutoraService } from './area-construtora.service';

@Module({
  controllers: [AreaConstrutoraController],
  providers: [AreaConstrutoraService],
})
export class AreaConstrutoraModule {}
