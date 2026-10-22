import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AppError } from '@/common/errors/app-error';
import { ColumnMappingDto, EnableSheetDto } from '@/google-sheets/dto/sheets.dto';
import { FileImportEnabledGuard } from '@/google-sheets/import-enabled.guard';
import type { ColumnMapping } from '@/google-sheets/sheet-rows';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { OutreachChoiceDto } from '@/outreach/outreach.dto';
import { PERMISSIONS } from '@/role/permissions';
import { CommitUploadDto, PreviewUploadDto } from './dto/upload.dto';
import { FileImportService, type UploadedFileLike } from './file-import.service';

/** Hard ceiling on the request itself; the configured limit is checked with a friendlier message. */
const UPLOAD_CEILING_BYTES = 20 * 1024 * 1024;
const upload = () => FileInterceptor('file', { limits: { fileSize: UPLOAD_CEILING_BYTES, files: 1, fields: 6, fieldSize: 256 * 1024 } });

function parseJson(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION_ERROR', `Invalid ${field}`, [{ path: field, message: `The ${field} is not valid JSON` }]);
  }
}

function parseMapping(raw: string | undefined): ColumnMapping[] | null {
  if (raw === undefined) return null;
  const json = parseJson(raw, 'mapping');
  if (!Array.isArray(json) || json.length > 100) {
    throw new AppError('VALIDATION_ERROR', 'Invalid mapping', [{ path: 'mapping', message: 'The mapping must be a list of at most 100 columns' }]);
  }
  const columns = plainToInstance(ColumnMappingDto, json);
  const errors = columns.flatMap((c, i) =>
    validateSync(c).flatMap((e) => Object.values(e.constraints ?? {}).map((message) => ({ path: `mapping.${i}.${e.property}`, message }))),
  );
  if (errors.length) throw new AppError('VALIDATION_ERROR', 'Invalid mapping', errors);
  return columns;
}

function parseApproveRows(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  const dto = plainToInstance(EnableSheetDto, { approveRows: parseJson(raw, 'approveRows') });
  const errors = validateSync(dto).flatMap((e) => Object.values(e.constraints ?? {}).map((message) => ({ path: 'approveRows', message })));
  if (errors.length) throw new AppError('VALIDATION_ERROR', 'Invalid approval', errors);
  return dto.approveRows ?? [];
}

function parseOutreach(raw: string | undefined): OutreachChoiceDto | undefined {
  if (raw === undefined) return undefined;
  const dto = plainToInstance(OutreachChoiceDto, parseJson(raw, 'outreach'));
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap((e) =>
    Object.values(e.constraints ?? {}).map((message) => ({ path: `outreach.${e.property}`, message })),
  );
  if (errors.length) throw new AppError('VALIDATION_ERROR', 'Invalid outreach choice', errors);
  return dto;
}

@Controller('integrations/file-import')
@UseGuards(FileImportEnabledGuard)
export class FileImportController {
  constructor(private readonly files: FileImportService) {}

  @Get('config')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  config() {
    return this.files.limits();
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @UseInterceptors(upload())
  preview(@CurrentAuth() auth: AuthContext, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: PreviewUploadDto) {
    return this.files.preview(auth.organizationId, file, parseMapping(body.mapping), body.sheet ?? null);
  }

  @Post('batches')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @UseInterceptors(upload())
  commit(@CurrentAuth() auth: AuthContext, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: CommitUploadDto) {
    return this.files.commit(
      { organizationId: auth.organizationId, userId: auth.userId, sessionId: auth.sessionId },
      file,
      parseMapping(body.mapping) ?? [],
      body.clientToken,
      body.sheet ?? null,
      parseApproveRows(body.approveRows),
      body.onlyClean === '1',
      parseOutreach(body.outreach),
    );
  }

  @Delete('batches/:id')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.remove({ organizationId: auth.organizationId, userId: auth.userId, sessionId: auth.sessionId }, id);
  }

  @Get('history')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  async history(@CurrentAuth() auth: AuthContext) {
    return { imports: await this.files.history(auth.organizationId) };
  }
}
