import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, RegisterDto, type AuthTokensResponse } from './dto/auth.dto';
import { Public } from '../../core/http/public.decorator';
import { CurrentUser, clientIp } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * Authentication endpoints, at /api/v1/auth per chapter 15.
 *
 * The three unauthenticated routes are marked @Public explicitly; every other
 * route in the application is protected by the global guard without needing to
 * say so.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto, @Req() request: Request): Promise<AuthTokensResponse> {
    return this.auth.register(dto, clientIp(request));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthTokensResponse> {
    return this.auth.login(dto, clientIp(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto, @Req() request: Request): Promise<AuthTokensResponse> {
    return this.auth.refresh(dto.refreshToken, clientIp(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { refreshToken?: string },
  ): Promise<void> {
    await this.auth.logout(user.userId, body?.refreshToken);
  }
}
