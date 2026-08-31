import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Global because JwtAuthGuard is registered application-wide and therefore needs
 * TokenService available outside this module's own import graph.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.auth.jwtSecret,
        signOptions: { algorithm: 'HS256', issuer: 'linkederp-ai' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'linkederp-ai' },
      }),
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [AuthService, PasswordService, TokenService, JwtAuthGuard],
  exports: [TokenService, JwtAuthGuard, PasswordService],
})
export class AuthModule {}
