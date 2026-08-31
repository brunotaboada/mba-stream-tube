import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class InitiateUploadDto {
  @ApiProperty({ example: 'my-holiday.mp4', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @ApiProperty({
    example: 'video/mp4',
    description: 'Must be one of the configured allowed MIME types',
  })
  @IsString()
  @IsNotEmpty()
  contentType: string;

  @ApiProperty({
    example: 1073741824,
    description:
      'Declared size in bytes; must not exceed the configured maximum',
  })
  @IsInt()
  @Min(1)
  sizeBytes: number;

  @ApiPropertyOptional({ example: 'My holiday', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
