import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { BrowserSessionService } from './browser-session.service';
import { BrowserInputDto } from './browser-input.dto';

/** The in-portal Odoo Online browser (ADR-087). Access is checked in the service. */
@Controller('projects')
export class BrowserController {
  constructor(private readonly sessions: BrowserSessionService) {}

  @Get(':projectId/browser')
  status(@CurrentUser() user: AuthenticatedUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sessions.status(user, projectId);
  }

  @Post(':projectId/browser')
  @HttpCode(HttpStatus.OK)
  open(@CurrentUser() user: AuthenticatedUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sessions.open(user, projectId);
  }

  @Get(':projectId/browser/screenshot')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'no-store')
  async screenshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return new StreamableFile(await this.sessions.screenshot(user, projectId));
  }

  @Post(':projectId/browser/input')
  @HttpCode(HttpStatus.OK)
  input(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: BrowserInputDto,
  ) {
    return this.sessions.input(user, projectId, dto);
  }

  @Delete(':projectId/browser')
  @HttpCode(HttpStatus.NO_CONTENT)
  close(@CurrentUser() user: AuthenticatedUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sessions.close(user, projectId);
  }
}

@Module({
  controllers: [BrowserController],
  providers: [BrowserSessionService],
})
export class BrowserModule {}
