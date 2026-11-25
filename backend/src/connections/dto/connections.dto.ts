import { IsOptional, IsUUID, Matches } from 'class-validator';

export class ConnectionSessionDto {
  /** Re-authorize this existing connection in place instead of adding one. */
  @IsOptional()
  @IsUUID()
  reconnectId?: string;
}

/** A connection the browser just made in Nango Connect. Checked against the caller's organization server side. */
export class CompleteConnectionDto {
  @Matches(/^[A-Za-z0-9._:-]{1,255}$/)
  connectionId!: string;
}
