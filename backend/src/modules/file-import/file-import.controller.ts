import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { AppError, zodDetails } from '../../common/errors';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { approveRowsSchema, mappingColumnsSchema } from '../google-sheets/schemas';
import type { ColumnMapping } from '../google-sheets/sheet-rows';
import { FileImportEnabledGuard } from '../google-sheets/sheets-enabled.guard';
import { FileImportService, type UploadedFileLike } from './file-import.service';

/**
 * The upload is buffered in memory up to this much; the service then applies the
 * configured limit (FILE_IMPORT_MAX_BYTES, 5 MB by default) with its own message.
 * ponytail: memory storage; a 20 MB ceiling is far above any lead file.
 */
const UPLOAD_CEILING_BYTES = 20 * 1024 * 1024;
const upload = () => FileInterceptor('file', { limits: { fileSize: UPLOAD_CEILING_BYTES, files: 1, fields: 4, fieldSize: 256 * 1024 } });

/** Multipart fields arrive as strings; the mapping is JSON inside one of them. */
const sheetField = z.string().trim().min(1).max(255).optional();
const previewFields = z.object({
  mapping: z
    .string()
    .max(64 * 1024)
    .optional(),
  /** The worksheet of an .xlsx to read; the first one when absent. */
  sheet: sheetField,
});
const commitFields = z.object({
  mapping: z.string().max(64 * 1024),
  clientToken: z.string().uuid(),
  sheet: sheetField,
  /**
   * JSON array of row numbers to approve as they are imported (the rows the
   * owner left ticked in the preview). Absent or empty: every row waits in Import Review.
   */
  approveRows: z
    .string()
    .max(200 * 1024)
    .optional(),
  /** '1': import only the rows without any flag, approved at once; flagged rows are left out of the import entirely. */
  onlyClean: z.enum(['1']).optional(),
});

function parseApproveRows(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid approval', [{ path: 'approveRows', message: 'The rows to approve are not valid JSON' }]);
  }
  const parsed = approveRowsSchema.safeParse(json);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid approval', zodDetails(parsed.error));
  return parsed.data;
}

function parseMapping(raw: string | undefined): ColumnMapping[] | null {
  if (raw === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid mapping', [{ path: 'mapping', message: 'The mapping is not valid JSON' }]);
  }
  // Every column set to "don't import": not malformed, just a mapping with
  // nothing in it — the service explains what is missing, column by column.
  if (Array.isArray(json) && json.length === 0) return [];
  const parsed = mappingColumnsSchema.safeParse(json);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid mapping', zodDetails(parsed.error));
  return parsed.data;
}

function fields<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid upload', zodDetails(parsed.error));
  return parsed.data;
}

/**
 * Lead import from an uploaded CSV or XLSX. Owner-only, behind its own switch
 * (FILE_IMPORT_ENABLED). The queue it feeds is ImportReviewController, open
 * while this or Google Sheets is on. The organization always comes from the
 * session.
 */
@Controller('api/integrations/file-import')
@UseGuards(SessionGuard, OwnerGuard, FileImportEnabledGuard)
export class FileImportController {
  constructor(private readonly files: FileImportService) {}

  @Get('config')
  config() {
    return this.files.limits();
  }

  /** Read the file and report what an import would do. Nothing is stored. */
  @Post('preview')
  @HttpCode(200)
  @UseInterceptors(upload())
  preview(@Req() req: SessionRequest, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: unknown) {
    const f = fields(previewFields, body);
    return this.files.preview(req.auth.organizationId, file!, parseMapping(f.mapping), f.sheet ?? null);
  }

  /** Import the file under the mapping. Sending the same clientToken again returns the same batch. */
  @Post('batches')
  @HttpCode(200)
  @UseInterceptors(upload())
  commit(@Req() req: SessionRequest, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: unknown) {
    const f = fields(commitFields, body);
    return this.files.commit(
      { organizationId: req.auth.organizationId, userId: req.auth.userId, sessionId: req.sessionId },
      file!,
      parseMapping(f.mapping)!,
      f.clientToken,
      f.sheet ?? null,
      parseApproveRows(f.approveRows),
      f.onlyClean === '1',
    );
  }

  /** Rejects the upload's pending rows, keeps its approved leads, and drops it from history. */
  @Delete('batches/:id')
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.remove({ organizationId: req.auth.organizationId, userId: req.auth.userId, sessionId: req.sessionId }, id);
  }

  /** Every import — uploaded files and connected sheets — with its review counts. */
  @Get('history')
  async history(@Req() req: SessionRequest) {
    return { imports: await this.files.history(req.auth.organizationId) };
  }
}
