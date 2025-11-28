import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CommentAuthorDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440001' })
  id: string;

  @ApiProperty({ example: 'Jane Smith' })
  name: string;

  @ApiProperty({ example: 'jane.smith@example.com' })
  email: string;

  @ApiPropertyOptional({ example: 'PRO_DEVELOPER' })
  role?: string;
}

export class CommentResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440004' })
  id: string;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  changeId: string;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440001' })
  userId: string;

  @ApiProperty()
  user: CommentAuthorDto;

  @ApiProperty({
    example: 'Please add error handling for edge cases',
  })
  content: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440003' })
  parentId?: string;

  @ApiProperty({
    example: [
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440002',
    ],
    type: [String],
  })
  mentions: string[];

  @ApiProperty({ example: false })
  isResolved: boolean;

  @ApiProperty({ example: '2025-11-28T10:30:00Z' })
  createdAt: Date;

  @ApiProperty({ example: '2025-11-28T10:35:00Z' })
  updatedAt: Date;

  @ApiPropertyOptional({
    description: 'Nested replies to this comment',
    type: [CommentResponseDto],
  })
  replies?: CommentResponseDto[];

  @ApiPropertyOptional({
    description: 'Count of replies',
    example: 3,
  })
  replyCount?: number;
}
