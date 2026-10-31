import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeader, ApiTags } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  TakeoutExportDetailDto,
  TakeoutLargerVersionDto,
  TakeoutLargerVersionResolveDto,
  TakeoutLargerVersionSearchDto,
  TakeoutOverviewDto,
  TakeoutRunCreateDto,
  TakeoutRunDto,
  TakeoutRunFilePageDto,
  TakeoutRunFileQueryDto,
  TakeoutSettingsDto,
  TakeoutSettingsUpdateDto,
  TakeoutUploadCreateDto,
  TakeoutUploadDto,
} from 'src/dtos/takeout.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard';
import { TakeoutService } from 'src/services/takeout.service';
import { UUIDParamDto } from 'src/validation';

const history = () => new HistoryBuilder().added('v3.2.2').beta('v3.2.2');

@ApiTags(ApiTag.Takeouts)
@Controller('takeouts')
export class TakeoutController {
  constructor(private service: TakeoutService) {}

  @Get()
  @Authenticated({ permission: Permission.TakeoutRead })
  @Endpoint({
    summary: 'Retrieve takeouts',
    description:
      'Synchronize the takeout folder of the current user and return its exports, uploads, other files and the active run.',
    history: history(),
  })
  getTakeoutOverview(@Auth() auth: AuthDto): Promise<TakeoutOverviewDto> {
    return this.service.getOverview(auth);
  }

  @Post('sync')
  @Authenticated({ permission: Permission.TakeoutRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Synchronize the takeout folder',
    description: 'Look for new, changed and removed archives in the takeout folder of the current user.',
    history: history(),
  })
  syncTakeouts(@Auth() auth: AuthDto): Promise<TakeoutOverviewDto> {
    return this.service.sync(auth);
  }

  @Get('exports/:id')
  @Authenticated({ permission: Permission.TakeoutRead })
  @Endpoint({
    summary: 'Retrieve a takeout export',
    description: 'Retrieve an export with its parts, its stored analysis and its runs.',
    history: history(),
  })
  getTakeoutExport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutExportDetailDto> {
    return this.service.getExport(auth, id);
  }

  @Post('exports/:id/rescan')
  @Authenticated({ permission: Permission.TakeoutRun })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Read failed parts again',
    description:
      'Forget what the last run found in the parts that could not be read, so the next run reads them again. Nothing is read now. Not possible while a run of the export is active.',
    history: history(),
  })
  rescanTakeoutExport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutExportDetailDto> {
    return this.service.rescanExport(auth, id);
  }

  @Delete('exports/:id/archives')
  @Authenticated({ permission: Permission.TakeoutDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete the archives of a takeout export',
    description:
      'Delete the archive files of an export from the takeout folder, and the staged files of its stopped runs. Runs and their reports are kept. Not possible while a run of the export is active.',
    history: history(),
  })
  deleteTakeoutExportArchives(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteExportArchives(auth, id);
  }

  @Delete('exports/:id')
  @Authenticated({ permission: Permission.TakeoutDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Dismiss a takeout export',
    description:
      'Remove an export whose archives are gone, together with its runs, their reports and their staged files. Imported assets are kept.',
    history: history(),
  })
  deleteTakeoutExport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteExport(auth, id);
  }

  @Post('exports/:id/runs')
  @Authenticated({ permission: Permission.TakeoutRun })
  @Endpoint({
    summary: 'Start a takeout import',
    description:
      'Start importing an export. An export that is not complete needs importAnyway. A user can have one unfinished run at a time. The files staged by the previous failed or cancelled run of the export are reused; that run cannot be resumed afterwards.',
    history: history(),
  })
  createTakeoutRun(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TakeoutRunCreateDto,
  ): Promise<TakeoutRunDto> {
    return this.service.createRun(auth, id, dto);
  }

  @Get('runs/:id')
  @Authenticated({ permission: Permission.TakeoutRead })
  @Endpoint({
    summary: 'Retrieve a takeout run',
    description: 'Retrieve the status, settings and counters of a run.',
    history: history(),
  })
  getTakeoutRun(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutRunDto> {
    return this.service.getRun(auth, id);
  }

  @Post('runs/:id/cancel')
  @Authenticated({ permission: Permission.TakeoutRun })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Cancel a takeout run',
    description:
      'Cancel a running run: it stops and keeps its staged files for 7 days, so a new run does not read the archives again. On a failed run, or a cancelled run that still holds staged files, the staged files are discarded now.',
    history: history(),
  })
  cancelTakeoutRun(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutRunDto> {
    return this.service.cancelRun(auth, id);
  }

  @Post('runs/:id/pause')
  @Authenticated({ permission: Permission.TakeoutRun })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Pause a takeout run',
    description:
      'Pause a running run: reading stops at once with the archives kept open, the other steps stop at the next safe point. A paused run keeps its staged files and stays paused across a server restart until it is resumed or cancelled.',
    history: history(),
  })
  pauseTakeoutRun(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutRunDto> {
    return this.service.pauseRun(auth, id);
  }

  @Post('runs/:id/resume')
  @Authenticated({ permission: Permission.TakeoutRun })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Resume a takeout run',
    description:
      'Resume a paused run where it waits, or a failed or cancelled run from where it stopped, with its original plan. Files a cancel skipped are imported too. A run a newer run took over cannot be resumed.',
    history: history(),
  })
  resumeTakeoutRun(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutRunDto> {
    return this.service.resumeRun(auth, id);
  }

  @Get('runs/:id/files')
  @Authenticated({ permission: Permission.TakeoutRead })
  @Endpoint({
    summary: 'Retrieve the files of a takeout run',
    description: 'Retrieve one page of the per-file report of a run.',
    history: history(),
  })
  getTakeoutRunFiles(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: TakeoutRunFileQueryDto,
  ): Promise<TakeoutRunFilePageDto> {
    return this.service.getRunFiles(auth, id, dto);
  }

  @Get('runs/:id/report.csv')
  @Authenticated({ permission: Permission.TakeoutRead })
  @FileResponse()
  @Endpoint({
    summary: 'Download the report of a takeout run',
    description: 'Download the per-file report of a run as CSV.',
    history: history(),
  })
  async getTakeoutRunReport(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    try {
      const stream = await this.service.getRunReport(auth, id);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-cache, no-transform');
      res.setHeader('Content-Disposition', `attachment; filename="takeout-run-${id}.csv"`);
      stream.on('error', (error) => next(error));
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  }

  @Get('settings')
  @Authenticated({ permission: Permission.TakeoutRead })
  @Endpoint({
    summary: 'Retrieve takeout settings',
    description: 'Retrieve the import settings of the current user, with defaults for unset values.',
    history: history(),
  })
  getTakeoutSettings(@Auth() auth: AuthDto): Promise<TakeoutSettingsDto> {
    return this.service.getSettings(auth);
  }

  @Put('settings')
  @Authenticated({ permission: Permission.TakeoutRun })
  @Endpoint({
    summary: 'Update takeout settings',
    description: 'Update the import settings of the current user. Runs keep the settings they started with.',
    history: history(),
  })
  updateTakeoutSettings(@Auth() auth: AuthDto, @Body() dto: TakeoutSettingsUpdateDto): Promise<TakeoutSettingsDto> {
    return this.service.updateSettings(auth, dto);
  }

  @Post('uploads')
  @Authenticated({ permission: Permission.TakeoutUpload })
  @Endpoint({
    summary: 'Start a takeout upload',
    description:
      'Start a resumable upload of a takeout archive into the takeout folder, or return the existing upload of the same file.',
    history: history(),
  })
  createTakeoutUpload(@Auth() auth: AuthDto, @Body() dto: TakeoutUploadCreateDto): Promise<TakeoutUploadDto> {
    return this.service.createUpload(auth, dto);
  }

  @Get('uploads/:id')
  @Authenticated({ permission: Permission.TakeoutUpload })
  @Endpoint({
    summary: 'Retrieve a takeout upload',
    description: 'Retrieve an upload, including the offset where the next chunk starts.',
    history: history(),
  })
  getTakeoutUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutUploadDto> {
    return this.service.getUpload(auth, id);
  }

  @Put('uploads/:id')
  @Authenticated({ permission: Permission.TakeoutUpload })
  @ApiConsumes('application/octet-stream')
  @ApiHeader({
    name: 'Upload-Offset',
    description: 'Byte offset of this chunk; must equal the current offset of the upload',
    required: true,
    schema: { type: 'integer', minimum: 0 },
  })
  @ApiBody({ required: true, schema: { type: 'string', format: 'binary' } })
  @Endpoint({
    summary: 'Upload a takeout chunk',
    description:
      'Write the next chunk of an upload (at most 64 MiB). The archive is moved into the takeout folder when the last byte arrives.',
    history: history(),
  })
  uploadTakeoutChunk(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Headers('upload-offset') offset: string | undefined,
    @Req() req: Request,
  ): Promise<TakeoutUploadDto> {
    return this.service.writeUploadChunk(auth, id, offset, req);
  }

  @Delete('uploads/:id')
  @Authenticated({ permission: Permission.TakeoutUpload })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Cancel a takeout upload',
    description: 'Cancel an upload and delete the partial file.',
    history: history(),
  })
  deleteTakeoutUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteUpload(auth, id);
  }

  @Get('larger-versions')
  @Authenticated({ permission: Permission.TakeoutRead })
  @Endpoint({
    summary: 'Retrieve larger versions',
    description: 'Retrieve files that were imported next to a smaller version of the same photo already on the server.',
    history: history(),
  })
  getTakeoutLargerVersions(
    @Auth() auth: AuthDto,
    @Query() dto: TakeoutLargerVersionSearchDto,
  ): Promise<TakeoutLargerVersionDto[]> {
    return this.service.getLargerVersions(auth, dto);
  }

  @Post('larger-versions/:id/resolve')
  @Authenticated({ permission: Permission.TakeoutRun })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Resolve a larger version',
    description: 'Move the smaller version to the trash, or keep both versions.',
    history: history(),
  })
  resolveTakeoutLargerVersion(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TakeoutLargerVersionResolveDto,
  ): Promise<TakeoutLargerVersionDto> {
    return this.service.resolveLargerVersion(auth, id, dto);
  }
}
