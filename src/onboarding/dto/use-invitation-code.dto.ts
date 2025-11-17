import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Matches } from 'class-validator';

/**
 * DTO for using an invitation code during signup
 */
export class UseInvitationCodeDto {
  @ApiProperty({
    example: 'ORG-ACME-A7X2Q',
    description: 'Invitation code provided by organization admin',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9-]+$/, {
    message: 'Invalid invitation code format',
  })
  code: string;
}
