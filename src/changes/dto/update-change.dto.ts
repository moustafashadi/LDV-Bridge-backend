import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateChangeDto } from './create-change.dto';
import { IsEnum, IsOptional } from 'class-validator';
import { ChangeStatus } from '@prisma/client';

export class UpdateChangeDto extends PartialType(CreateChangeDto) {
  @ApiPropertyOptional({
    description: 'Change status',
    enum: ChangeStatus,
    example: ChangeStatus.PENDING,
  })
  @IsOptional()
  @IsEnum(ChangeStatus)
  status?: ChangeStatus;
}
