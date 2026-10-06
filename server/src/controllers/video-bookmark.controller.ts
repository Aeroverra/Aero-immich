import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  VideoBookmarkCreateDto,
  VideoBookmarkResponseDto,
  VideoBookmarkSearchDto,
  VideoBookmarkUpdateDto,
} from 'src/dtos/video-bookmark.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { VideoBookmarkService } from 'src/services/video-bookmark.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.VideoBookmarks)
@Controller('video-bookmarks')
export class VideoBookmarkController {
  constructor(private service: VideoBookmarkService) {}

  @Get()
  @Authenticated({ permission: Permission.VideoBookmarkRead })
  @Endpoint({
    summary: 'Retrieve video bookmarks',
    description: 'Retrieve the bookmarks the current user set on a video, ordered by position.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  getVideoBookmarks(@Auth() auth: AuthDto, @Query() dto: VideoBookmarkSearchDto): Promise<VideoBookmarkResponseDto[]> {
    return this.service.getAll(auth, dto);
  }

  @Post()
  @Authenticated({ permission: Permission.VideoBookmarkCreate })
  @Endpoint({
    summary: 'Create a video bookmark',
    description: 'Bookmark a moment in a video the current user can view. Only that user sees the bookmark.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  createVideoBookmark(@Auth() auth: AuthDto, @Body() dto: VideoBookmarkCreateDto): Promise<VideoBookmarkResponseDto> {
    return this.service.create(auth, dto);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.VideoBookmarkUpdate })
  @Endpoint({
    summary: 'Update a video bookmark',
    description: 'Change the position or the label of a bookmark.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  updateVideoBookmark(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: VideoBookmarkUpdateDto,
  ): Promise<VideoBookmarkResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.VideoBookmarkDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a video bookmark',
    description: 'Delete a bookmark.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  deleteVideoBookmark(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }
}
