import { IsUUID } from 'class-validator';

export class AssignLeadDto {
  @IsUUID()
  agentId!: string;
}
