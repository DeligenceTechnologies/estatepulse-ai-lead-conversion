import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';
import { MAPPING_TARGETS } from '@/google-sheets/sheet-rows';
import { OutreachChoiceDto } from '@/outreach/outreach.dto';
import { CREATABLE_TYPES } from '../airtable-fields';
import { DIRECTIONS, EXPORT_SCOPES } from '../sync-config';
import { WRITE_BACK_FIELDS } from '../write-back';

/** Airtable's id shapes. Checked before an id is ever put in a URL. */
const BASE_ID = /^app[A-Za-z0-9]{1,30}$/;
const TABLE_ID = /^tbl[A-Za-z0-9]{1,30}$/;
const FIELD_ID = /^fld[A-Za-z0-9]{1,30}$/;
const RECORD_ID = /^rec[A-Za-z0-9]{1,30}$/;

/**
 * Everything a caller may send. Validation is strict here because these values
 * reach Airtable: an id that is not an Airtable id shape is refused before it
 * is ever put in a URL.
 */

/** Which base and table to sync, under which connection. */
export class CreateAirtableSourceDto {
  @IsUUID()
  connectionId!: string;

  @Matches(BASE_ID, { message: 'baseId is not an Airtable base id' })
  baseId!: string;

  @Matches(TABLE_ID, { message: 'tableId is not an Airtable table id' })
  tableId!: string;
}

/** One Airtable field mapped to one EstatePulse lead field. */
export class AirtableColumnDto {
  /** The Airtable FIELD ID, never its name: names are neither unique nor stable. */
  @Matches(FIELD_ID, { message: 'fieldKey is not an Airtable field id' })
  fieldKey!: string;

  @IsIn(MAPPING_TARGETS as readonly string[])
  target!: string;
}

export class SaveAirtableMappingDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AirtableColumnDto)
  columns!: AirtableColumnDto[];
}

export class ImportAirtableDto {
  /**
   * The records the owner ticked to approve. Everything else is imported and
   * waits in Import Review; nothing is approved on its own.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @Matches(RECORD_ID, { each: true, message: 'approveRecordIds must be Airtable record ids' })
  approveRecordIds?: string[];

  /** How the ticked records launch; read only with OUTREACH_SCHEDULING_ENABLED, and without it they launch now. */
  @IsOptional()
  @ValidateNested()
  @Type(() => OutreachChoiceDto)
  outreach?: OutreachChoiceDto;
}

/** Which way this table syncs. */
export class SetAirtableSyncDto {
  @IsIn(DIRECTIONS as readonly string[])
  direction!: string;

  /** Which leads get written out. Read only when the direction writes; defaults to this table's own. */
  @IsOptional()
  @IsIn(EXPORT_SCOPES as readonly string[])
  exportScope?: string;

  /** What EstatePulse sends back about each lead, and where. Absent leaves the choice as it is. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AirtableWriteBackDto)
  writeBack?: AirtableWriteBackDto[];
}

/** One EstatePulse output and the Airtable column it is written to. */
export class AirtableWriteBackDto {
  @IsIn(WRITE_BACK_FIELDS.map((f) => f.key))
  key!: string;

  @Matches(FIELD_ID, { message: 'fieldId is not an Airtable field id' })
  fieldId!: string;
}

/**
 * A new Airtable column. Only a name and a type: Airtable requires an options
 * object for several types, and EstatePulse fills those in rather than asking
 * an owner to.
 */
export class CreateAirtableFieldDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsIn(CREATABLE_TYPES as readonly string[])
  type!: string;

  /** Currency only. */
  @IsOptional()
  @IsString()
  @Length(1, 10)
  currencySymbol?: string;

  /** Single/multiple select only. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  choices?: string[];

  /** Date and time only. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  timeZone?: string;
  /**
   * Start sending this EstatePulse report into the new column straight away.
   * Making the column and pointing a report at it are one intention, so they
   * travel as one request.
   */
  @IsOptional()
  @IsIn(WRITE_BACK_FIELDS.map((f) => f.key))
  sendAs?: string;
}
