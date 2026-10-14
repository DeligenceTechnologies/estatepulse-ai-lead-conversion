import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Logger, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { Public } from '@/auth/decorators/public.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CALENDAR_ROUTE } from '../calendar.types';
import { CalendlyClient } from '../providers/calendly.client';
import { CalendarConnectionService } from './calendar-connection.service';
import { renderCalendlyCallbackPage, type CalendlyCallbackResult } from './calendly-callback.page';
import { ActivateCalendarDto } from './dto/activate-calendar.dto';
import { CalApiKeyDto, CalConnectDto } from './dto/cal-connect.dto';

/** Connecting the organization's calendar (Settings → Calendar). Changes need "Edit organization settings". */
@Controller(CALENDAR_ROUTE)
export class CalendarConnectionController {
  private readonly logger = new Logger(CalendarConnectionController.name);

  constructor(
    private readonly connections: CalendarConnectionService,
    private readonly calendly: CalendlyClient,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.connections.status(auth.organizationId);
  }

  @Post('calendly/authorize')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  authorizeCalendly(@CurrentAuth() auth: AuthContext) {
    return this.connections.startCalendly(auth.organizationId, auth.userId);
  }

  @Public()
  @Get('calendly/callback')
  async calendlyCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    let result: CalendlyCallbackResult;
    if (error) {
      result = { ok: false, message: errorDescription || 'Calendly access was not granted.' };
    } else if (!code || !state) {
      result = { ok: false, message: 'Calendly did not return an authorization code. Start again from Settings.' };
    } else {
      try {
        await this.connections.completeCalendly(code, state);
        result = { ok: true, message: 'You can close this window and return to EstatePulse.' };
      } catch (failure) {
        if (failure instanceof HttpException) {
          result = { ok: false, message: failure.message };
        } else {
          this.logger.error('Calendly connection failed', failure instanceof Error ? failure.stack : String(failure));
          result = { ok: false, message: 'Something went wrong while connecting Calendly.' };
        }
      }
    }

    if (!result.ok) {
      this.logger.warn(`Calendly connection failed: ${error ? `${error} ` : ''}${result.message}`);
    }

    res
      .status(HttpStatus.OK)
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Referrer-Policy', 'no-referrer')
      .setHeader('X-Frame-Options', 'DENY')
      .type('html')
      .send(renderCalendlyCallbackPage(result, this.calendly.appUrl));
  }

  @Post('cal/teams')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  calTeams(@Body() dto: CalApiKeyDto) {
    return this.connections.listCalTeams(dto.apiKey);
  }

  @Post('cal/connect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  connectCal(@CurrentAuth() auth: AuthContext, @Body() dto: CalConnectDto) {
    return this.connections.connectCal(auth.organizationId, auth.userId, dto);
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  activate(@CurrentAuth() auth: AuthContext, @Body() dto: ActivateCalendarDto) {
    return this.connections.activate(auth.organizationId, dto.provider);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  disconnect(@CurrentAuth() auth: AuthContext) {
    return this.connections.disconnect(auth.organizationId);
  }
}
