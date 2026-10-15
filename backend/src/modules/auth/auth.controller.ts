import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { UserLinksService } from './user-links.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  SetPasswordDto,
  type AuthTokensResponse,
} from './dto/auth.dto';
import { Public } from '../../core/http/public.decorator';
import { CurrentUser, clientIp } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/**
 * Authentication endpoints, at /api/v1/auth per chapter 15.
 *
 * The unauthenticated routes are marked @Public explicitly; every other
 * route in the application is protected by the global guard without needing to
 * say so.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly links: UserLinksService,
  ) {}

  /**
   * How the register page should behave: `firstAccount` asks for a password and
   * makes an admin; otherwise sign-up is open only while mail can confirm the
   * address (ADR-072 addendum 2).
   */
  @Public()
  @Get('registration')
  async registration(): Promise<{ open: boolean; firstAccount: boolean; mailEnabled: boolean }> {
    const [firstAccount, mailEnabled] = await Promise.all([this.auth.firstAccount(), this.links.mailEnabled()]);
    return { open: firstAccount || mailEnabled, firstAccount, mailEnabled };
  }

  /**
   * Mails a reset link when the address has an account. The answer is the same
   * either way, so the form cannot reveal which addresses are registered.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: Request): Promise<{ accepted: true }> {
    await this.links.requestReset(dto.email, clientIp(request));
    return { accepted: true };
  }

  /** Sets a password from an invitation or reset link. */
  @Public()
  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  async setPassword(@Body() dto: SetPasswordDto, @Req() request: Request): Promise<{ set: true }> {
    await this.links.redeem(dto.token, dto.newPassword, clientIp(request));
    return { set: true };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto, @Req() request: Request): Promise<AuthTokensResponse | { pending: true }> {
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

  /** Change your own password. Authenticated, and proves the current one. */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
  ): Promise<{ changed: true }> {
    return this.auth.changePassword(user.userId, dto, clientIp(request));
  }
}
