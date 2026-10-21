import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OutreachChoiceDto } from '@/outreach/outreach.dto';
import { MAPPING_TARGETS } from '../sheet-rows';

export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,128}$/;

export class CompleteOAuthDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  code!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  state!: string;
}

export class CreateSheetSourceDto {
  @IsUUID()
  connectionId!: string;

  @Matches(SPREADSHEET_ID, { message: 'Not a Google spreadsheet id' })
  spreadsheetId!: string;

  @IsInt()
  @Min(0)
  sheetId!: number;
}

export class ColumnMappingDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fieldKey!: string;

  @IsIn(MAPPING_TARGETS)
  target!: (typeof MAPPING_TARGETS)[number];
}

export class SheetIdentityDto {
  @IsIn(['column', 'fallback'])
  mode!: 'column' | 'fallback';

  @ValidateIf((o: SheetIdentityDto) => o.mode === 'column')
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fieldKey?: string;

  @ValidateIf((o: SheetIdentityDto) => o.mode === 'fallback')
  @Equals(true, { message: 'The fallback row identity must be acknowledged' })
  acknowledged?: true;
}

export class SaveMappingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ColumnMappingDto)
  columns!: ColumnMappingDto[];

  @ValidateNested()
  @Type(() => SheetIdentityDto)
  identity!: SheetIdentityDto;
}

export class EnableSheetDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10_000)
  @Transform(({ value }) => (Array.isArray(value) ? [...new Set(value)] : value))
  @IsInt({ each: true })
  @Min(2, { each: true })
  @Max(10_001, { each: true })
  approveRows?: number[];

  /** How the ticked rows launch; read only with OUTREACH_SCHEDULING_ENABLED, and without it they launch now. */
  @IsOptional()
  @ValidateNested()
  @Type(() => OutreachChoiceDto)
  outreach?: OutreachChoiceDto;
}

export class RowIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  rowIds!: string[];
}

export class ApproveRowsDto extends RowIdsDto {
  /** Read only with OUTREACH_SCHEDULING_ENABLED; without it the leads launch now. */
  @IsOptional()
  @ValidateNested()
  @Type(() => OutreachChoiceDto)
  outreach?: OutreachChoiceDto;
}

export class ResolveChangesDto extends RowIdsDto {
  @IsIn(['apply', 'keep'])
  action!: 'apply' | 'keep';
}

export class ChangesQueryDto {
  @IsUUID()
  sourceId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ReviewQueryDto {
  @IsOptional()
  @IsIn(['pending', 'rejected'])
  state?: 'pending' | 'rejected';

  @IsOptional()
  @IsIn(['all', 'google_sheets', 'file_upload', 'hubspot'])
  source?: 'all' | 'google_sheets' | 'file_upload' | 'hubspot';

  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
