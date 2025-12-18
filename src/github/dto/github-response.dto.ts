import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GitHubConnectionStatusDto {
  @ApiProperty()
  connected: boolean;

  @ApiPropertyOptional()
  installationId?: string;

  @ApiPropertyOptional()
  organizationName?: string;

  @ApiPropertyOptional()
  installationUrl?: string;
}

export class GitHubRepoDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty()
  htmlUrl: string;

  @ApiProperty()
  cloneUrl: string;

  @ApiProperty()
  defaultBranch: string;

  @ApiProperty()
  private: boolean;
}

export class GitHubCommitDto {
  @ApiProperty()
  sha: string;

  @ApiProperty()
  message: string;

  @ApiProperty()
  htmlUrl: string;

  @ApiProperty()
  author: {
    name: string;
    email: string;
    date: string;
  };
}

export class GitHubBranchDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  sha: string;

  @ApiProperty()
  protected: boolean;
}

export class GitHubPullRequestDto {
  @ApiProperty()
  number: number;

  @ApiProperty()
  title: string;

  @ApiProperty()
  htmlUrl: string;

  @ApiProperty()
  state: 'open' | 'closed' | 'merged';

  @ApiProperty()
  headBranch: string;

  @ApiProperty()
  baseBranch: string;

  @ApiPropertyOptional()
  mergedAt?: string;
}

export class FileDiffDto {
  @ApiProperty()
  filename: string;

  @ApiProperty()
  status: 'added' | 'removed' | 'modified' | 'renamed';

  @ApiProperty()
  additions: number;

  @ApiProperty()
  deletions: number;

  @ApiPropertyOptional()
  patch?: string;
}
