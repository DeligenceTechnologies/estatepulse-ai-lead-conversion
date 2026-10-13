import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Logger, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { Public } from '@/auth/decorators/public.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CalendarService } from './calendar.service';
import { renderCalendlyCallbackPage, type CalendlyCallbackResult } from './calendly-callback.page';
import { ActivateCalendarDto } from './dto/activate-calendar.dto';
import { AddCalendarMemberDto } from './dto/add-member.dto';
import { CalApiKeyDto, CalConnectDto } from './dto/cal-connect.dto';
import { CalendlyClient } from './providers/calendly.client';

@Controller('org-settings/calendar')
export class CalendarController {
  private readonly logger = new Logger(CalendarController.name);

  constructor(
    private readonly calendarService: CalendarService,
    private readonly calendly: CalendlyClient,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.calendarService.status(auth.organizationId);
  }

  @Get('members')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  members(@CurrentAuth() auth: AuthContext) {
    return this.calendarService.members(auth.organizationId);
  }

  @Post('members/add-agent')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ, PERMISSIONS.USER_CREATE)
  addMemberAsAgent(@CurrentAuth() auth: AuthContext, @Body() dto: AddCalendarMemberDto) {
    return this.calendarService.addMemberAsAgent(auth.organizationId, dto.externalId);
  }

  @Get('event-types')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  eventTypes(@CurrentAuth() auth: AuthContext) {
    return this.calendarService.eventTypes(auth.organizationId);
  }

  @Post('calendly/authorize')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  authorizeCalendly(@CurrentAuth() auth: AuthContext) {
    return this.calendarService.startCalendly(auth.organizationId, auth.userId);
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
        await this.calendarService.completeCalendly(code, state);
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
    return this.calendarService.listCalTeams(dto.apiKey);
  }

  @Post('cal/connect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  connectCal(@CurrentAuth() auth: AuthContext, @Body() dto: CalConnectDto) {
    return this.calendarService.connectCal(auth.organizationId, auth.userId, dto);
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  activate(@CurrentAuth() auth: AuthContext, @Body() dto: ActivateCalendarDto) {
    return this.calendarService.activate(auth.organizationId, dto.provider);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  disconnect(@CurrentAuth() auth: AuthContext) {
    return this.calendarService.disconnect(auth.organizationId);
  }
}
