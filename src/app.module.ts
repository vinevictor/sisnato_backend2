import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { S3Module } from './s3/s3.module';
import { UserModule } from './api/user/user.module';
import { SolicitacaoModule } from './api/solicitacao/solicitacao.module';
import { ConstrutoraModule } from './api/construtora/construtora.module';
import { ImobiliariaModule } from './api/imobiliaria/imobiliaria.module';
import { FinanceiroModule } from './api/financeiro/financeiro.module';
import { EmpreendimentoModule } from './api/empreendimento/empreendimento.module';
import { AlertModule } from './api/alert/alert.module';
import { SuporteModule } from './api/suporte/suporte.module';
import { ChamadoModule } from './api/chamado/chamado.module';
import { RelatorioFinanceiroModule } from './api/relatorio_financeiro/relatorio_financeiro.module';
import { RelatorioNatosignModule } from './api/relatorio_natosign/relatorio_natosign.module';
import { LogModule } from './log/log.module';
import { AuthModule } from './auth/auth.module';
import { SmsModule } from './sms/sms.module';
import { BugModule } from './api/bug/bug.module';
import { ChecktelModule } from './api/checktel/checktel.module';
import { DashboardModule } from './api/dashboard/dashboard.module';
import { DiretoModule } from './api/direto/direto.module';
import { DiretoTagModule } from './api/direto-tag/direto-tag.module';
import { FileModule } from './api/file/file.module';
import { NowModule } from './api/now/now.module';
import { GetInfosModule } from './api/get-infos/get-infos.module';
import { TagModule } from './api/tag/tag.module';
import { SequelizeModule } from './sequelize/sequelize.module';
import { PdfCreateModule } from './pdf_create/pdf_create.module';
import { SystemMessageModule } from './api/system_message/system_message.module';
import { PixModule } from './api/pix/pix.module';
import { RabbitnqModule } from './rabbitnq/rabbitnq.module';
import { ErrorModule } from './error/error.module';
import { TagListModule } from './api/tag-list/tag-list.module';
import { IntelesignModule } from './api/intelesign/intelesign.module';
import { ParceirosModule } from './api/parceiros/parceiros.module';
import { MailModule } from './mail/mail.module';
import { GeoModule } from './geo/geo.module';
import { ArParceiraModule } from './ar-parceira/ar-parceira.module';
import { SolutiModule } from './soluti/soluti.module';
import { VoucherModule } from './api/voucher/voucher.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AnalyticsModule } from './api/analytics/analytics.module';
import { AgenteModule } from './api/agente/agente.module';
import { ChatModule } from './api/chat/chat.module';
import { AreaConstrutoraModule } from './api/area-construtora/area-construtora.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    AuthModule, // Mantido do primeiro trecho
    PrismaModule,
    S3Module,
    UserModule,
    SolicitacaoModule,
    ConstrutoraModule,
    ImobiliariaModule,
    FinanceiroModule,
    EmpreendimentoModule,
    AlertModule,
    SuporteModule,
    ChamadoModule,
    RelatorioFinanceiroModule,
    RelatorioNatosignModule,
    SmsModule,
    LogModule,
    BugModule,
    ChecktelModule,
    DashboardModule,
    DiretoModule,
    DiretoTagModule,
    FileModule,
    NowModule,
    GetInfosModule,
    TagModule,
    SequelizeModule,
    PdfCreateModule,
    SystemMessageModule,
    PixModule,
    RabbitnqModule,
    ErrorModule,
    TagListModule,
    IntelesignModule,
    ParceirosModule,
    MailModule,
    GeoModule,
    ArParceiraModule,
    SolutiModule,
    VoucherModule,
    AnalyticsModule,
    AgenteModule,
    ChatModule,
    AreaConstrutoraModule,
  ],
})
export class AppModule {}
