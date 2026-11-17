import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { CANONICAL_FIELDS, IGNORE_TARGET } from '@/ingest/processing/canonical-fields';

/**
 * A Google file id as the Picker hands it over. Same shape Google Sheets
 * validates spreadsheet ids with, so a path parameter can never be a probe.
 */
export const GOOGLE_FORM_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** What an owner may map a question to: a lead column, or explicitly nothing. */
const TARGETS = [...Object.keys(CANONICAL_FIELDS), IGNORE_TARGET, 'full_name'];

export class CreateFormSourceDto {
  @IsUUID()
  connectionId!: string;

  @Matches(GOOGLE_FORM_ID, { message: 'Not a Google Form id' })
  formId!: string;
}

export class FormMappingRowDto {
  @IsString()
  @MaxLength(255)
  sourceFieldKey!: string;

  @IsIn(TARGETS, { message: 'Unknown lead field' })
  targetField!: string;
}

export class SaveFormMappingDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => FormMappingRowDto)
  mappings!: FormMappingRowDto[];
}

export class FormSourceQueryDto {
  @IsOptional()
  @IsUUID()
  sourceId?: string;
}
