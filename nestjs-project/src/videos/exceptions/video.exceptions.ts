import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      HttpStatus.NOT_FOUND,
      'The authenticated user does not have a channel',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', HttpStatus.NOT_FOUND, 'Video not found');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_READY',
      HttpStatus.NOT_FOUND,
      'Video has not finished processing',
    );
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor(message = 'Video is not in a state that allows this operation') {
    super('INVALID_VIDEO_STATE', HttpStatus.CONFLICT, message);
  }
}

export class VideoTooLargeException extends DomainException {
  constructor(maxSizeBytes: number) {
    super(
      'VIDEO_TOO_LARGE',
      HttpStatus.PAYLOAD_TOO_LARGE,
      `Video exceeds the maximum allowed size of ${maxSizeBytes} bytes`,
    );
  }
}

export class UnsupportedVideoFormatException extends DomainException {
  constructor(allowed: string[]) {
    super(
      'UNSUPPORTED_VIDEO_FORMAT',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      `Unsupported video format. Allowed types: ${allowed.join(', ')}`,
    );
  }
}

export class VideoProbeFailedException extends DomainException {
  constructor(reason: string) {
    super(
      'VIDEO_PROBE_FAILED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Could not read the uploaded file as a video: ${reason}`,
    );
  }
}
