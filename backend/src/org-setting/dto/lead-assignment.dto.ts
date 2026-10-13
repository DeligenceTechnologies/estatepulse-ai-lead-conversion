import { IsBoolean } from 'class-validator';

export class LeadAssignmentDto {
  @IsBoolean({ message: 'assignToMe must be true or false' })
  assignToMe!: boolean;
}
