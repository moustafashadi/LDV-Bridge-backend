import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConnectGitHubDto {
  @ApiProperty({
    description: 'GitHub App installation ID',
    example: '12345678',
  })
  @IsString()
  @IsNotEmpty()
  installationId: string;

  @ApiPropertyOptional({
    description: 'GitHub organization name (if different from detected)',
    example: 'my-org',
  })
  @IsString()
  @IsOptional()
  organizationName?: string;
}

export class CreateRepoDto {
  @ApiProperty({
    description: 'App ID to create repository for',
  })
  @IsString()
  @IsNotEmpty()
  appId: string;

  @ApiPropertyOptional({
    description: 'Custom repository name',
  })
  @IsString()
  @IsOptional()
  repoName?: string;
}

export class CommitDto {
  @ApiProperty({
    description: 'Commit message',
  })
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiPropertyOptional({
    description: 'Branch to commit to (defaults to main)',
  })
  @IsString()
  @IsOptional()
  branch?: string;
}
