import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  CompleteUploadResponseDto,
  InitiateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { VideosService } from './videos.service';
import { StorageService } from '../storage/storage.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  @Post('uploads')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and returns presigned URLs for a ' +
      'multipart upload made directly to object storage. Video bytes never ' +
      'pass through this API.',
  })
  @ApiResponse({ status: 201, type: InitiateUploadResponseDto })
  @ApiResponse({ status: 404, description: 'CHANNEL_NOT_FOUND' })
  @ApiResponse({ status: 413, description: 'VIDEO_TOO_LARGE' })
  @ApiResponse({ status: 415, description: 'UNSUPPORTED_VIDEO_FORMAT' })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/uploads/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Finish a video upload',
    description:
      'Finalises the multipart upload and queues the video for processing.',
  })
  @ApiParam({ name: 'id', description: 'Internal video id (uuid)' })
  @ApiResponse({ status: 200, type: CompleteUploadResponseDto })
  @ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'INVALID_VIDEO_STATE' })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.videosService.completeUpload(user.sub, id, dto);
    return {
      videoId: video.id,
      publicId: video.public_id,
      status: video.status,
    };
  }

  @Delete(':id/uploads')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Abandon a video upload',
    description:
      'Aborts the multipart upload and discards the draft video.',
  })
  @ApiParam({ name: 'id', description: 'Internal video id (uuid)' })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'INVALID_VIDEO_STATE' })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, id);
  }

  @Get(':publicId')
  @Public()
  @ApiOperation({ summary: 'Get a video by its public identifier' })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND' })
  async findOne(
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findReadyByPublicId(publicId);
    const thumbnailUrl = video.thumbnail_key
      ? this.storageService.buildPublicUrl(
          this.storageService.thumbnailsBucket,
          video.thumbnail_key,
        )
      : null;
    return VideoResponseDto.fromEntity(video, thumbnailUrl);
  }

  @Get(':publicId/stream')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned URL. The client issues Range ' +
      'requests directly to object storage, which answers 206 Partial ' +
      'Content, so playback starts without downloading the whole file.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the media URL' })
  @ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND / VIDEO_NOT_READY' })
  async stream(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':publicId/download')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a presigned URL signed with an attachment ' +
      'Content-Disposition, so the browser saves the file.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the download URL' })
  @ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND / VIDEO_NOT_READY' })
  async download(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
