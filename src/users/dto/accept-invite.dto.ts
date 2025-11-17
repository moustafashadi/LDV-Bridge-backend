import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class AcceptInviteDto {
  @ApiProperty({ 
    description: 'Invitation token from email',
    example: 'abc123xyz...'
  })
  @IsString()
  @MinLength(10)
  token: string;
}
