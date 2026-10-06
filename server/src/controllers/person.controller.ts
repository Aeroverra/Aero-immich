import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { NextFunction, Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  PersonSuggestionAnswerDto,
  PersonSuggestionAnswersSearchDto,
  PersonSuggestionCreateDto,
  PersonSuggestionResponseDto,
  PersonSuggestionSearchDto,
  PersonSuggestionsResponseDto,
  PersonSuggestionStatisticsDto,
  PersonSuggestionStatisticsResponseDto,
} from 'src/dtos/person-suggestion.dto';
import {
  AssetFaceUpdateDto,
  MergePersonDto,
  PeopleResponseDto,
  PeopleUpdateDto,
  PersonAssetCountResponseDto,
  PersonAssetCountsDto,
  PersonCreateDto,
  PersonResponseDto,
  PersonSearchDto,
  PersonStatisticsResponseDto,
  PersonThumbnailDto,
  PersonUpdateDto,
} from 'src/dtos/person.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PersonSuggestionService } from 'src/services/person-suggestion.service';
import { PersonService } from 'src/services/person.service';
import { sendFile } from 'src/utils/file';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.People)
@Controller('people')
export class PersonController {
  constructor(
    private service: PersonService,
    private suggestionService: PersonSuggestionService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(PersonController.name);
  }

  @Get()
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get all people',
    description: 'Retrieve a list of all people.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAllPeople(@Auth() auth: AuthDto, @Query() options: PersonSearchDto): Promise<PeopleResponseDto> {
    return this.service.getAll(auth, options);
  }

  @Post()
  @Authenticated({ permission: Permission.PersonCreate })
  @Endpoint({
    summary: 'Create a person',
    description: 'Create a new person that can have multiple faces assigned to them.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createPerson(@Auth() auth: AuthDto, @Body() dto: PersonCreateDto): Promise<PersonResponseDto> {
    return this.service.create(auth, dto);
  }

  @Put()
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Update people',
    description: 'Bulk update multiple people at once.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  updatePeople(@Auth() auth: AuthDto, @Body() dto: PeopleUpdateDto): Promise<BulkIdResponseDto[]> {
    return this.service.updateAll(auth, dto);
  }

  @Delete()
  @Authenticated({ permission: Permission.PersonDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete people',
    description: 'Bulk delete a list of people at once.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deletePeople(@Auth() auth: AuthDto, @Body() dto: BulkIdsDto): Promise<void> {
    return this.service.deleteAll(auth, dto);
  }

  // the suggestion routes come before the routes with a person id, so that "suggestions" is not taken for one

  @Get('suggestions')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get person suggestions',
    description:
      'Questions to answer, most valuable first: whether an unnamed person or a face without a person is a named person, or whether two unnamed people are one.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  getPersonSuggestions(
    @Auth() auth: AuthDto,
    @Query() dto: PersonSuggestionSearchDto,
  ): Promise<PersonSuggestionsResponseDto> {
    return this.suggestionService.getAll(auth, dto);
  }

  @Post('suggestions')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Create a person suggestion',
    description:
      'Ask whether a person (or a face) is the same person as another, for example to hand over matches a tool was not sure about. An existing question about the same pair is returned instead.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  createPersonSuggestion(
    @Auth() auth: AuthDto,
    @Body() dto: PersonSuggestionCreateDto,
  ): Promise<PersonSuggestionResponseDto> {
    return this.suggestionService.create(auth, dto);
  }

  @Get('suggestions/count')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Count person suggestions',
    description: 'How many person suggestions there are to answer, optionally only those about one person.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  getPersonSuggestionStatistics(
    @Auth() auth: AuthDto,
    @Query() dto: PersonSuggestionStatisticsDto,
  ): Promise<PersonSuggestionStatisticsResponseDto> {
    return this.suggestionService.getStatistics(auth, dto);
  }

  @Get('suggestions/answers')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get answered person suggestions',
    description: 'The latest answers to person suggestions, newest first.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  getPersonSuggestionAnswers(
    @Auth() auth: AuthDto,
    @Query() dto: PersonSuggestionAnswersSearchDto,
  ): Promise<PersonSuggestionResponseDto[]> {
    return this.suggestionService.getAnswers(auth, dto);
  }

  @Post('suggestions/refresh')
  @Authenticated({ permission: Permission.PersonRead })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Look for person suggestions',
    description: 'Queue a search for new person suggestions for the current user.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  refreshPersonSuggestions(@Auth() auth: AuthDto): Promise<void> {
    return this.suggestionService.refresh(auth);
  }

  @Put('suggestions/:id')
  @Authenticated({ permission: Permission.PersonMerge })
  @Endpoint({
    summary: 'Answer a person suggestion',
    description:
      'Same merges the candidate into the target person (or moves the face to it). Different is kept for good: the pair is never asked about again, merged or matched by facial recognition. Skipped asks again later.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  answerPersonSuggestion(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PersonSuggestionAnswerDto,
  ): Promise<PersonSuggestionResponseDto> {
    return this.suggestionService.answer(auth, id, dto);
  }

  @Delete('suggestions/:id/answer')
  @Authenticated({ permission: Permission.PersonMerge })
  @Endpoint({
    summary: 'Take back the answer to a person suggestion',
    description:
      'Asks the question again. Taking back Same moves the faces the answer moved back, as long as they are still with the person.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  undoPersonSuggestionAnswer(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<PersonSuggestionResponseDto> {
    return this.suggestionService.undoAnswer(auth, id);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get a person',
    description: 'Retrieve a person by id.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getPerson(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PersonResponseDto> {
    return this.service.getById(auth, id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Update person',
    description: 'Update an individual person.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updatePerson' }),
  })
  updatePerson(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PersonUpdateDto,
  ): Promise<PersonResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.PersonUpdate })
  updatePersonV3(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PersonUpdateDto,
  ): Promise<PersonResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.PersonDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete person',
    description: 'Delete an individual person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deletePerson(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }

  @Get(':id/statistics')
  @Authenticated({ permission: Permission.PersonStatistics })
  @Endpoint({
    summary: 'Get person statistics',
    description: 'Retrieve statistics about a specific person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getPersonStatistics(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PersonStatisticsResponseDto> {
    return this.service.getStatistics(auth, id);
  }

  @Get(':id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get person thumbnail',
    description:
      'Retrieve the thumbnail file for a person. When the feature photo is hidden from the caller, a face of the person the caller may see (or a placeholder) is returned instead.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async getPersonThumbnail(
    @Res() res: Response,
    @Next() next: NextFunction,
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: PersonThumbnailDto,
  ) {
    await sendFile(res, next, () => this.service.getThumbnail(auth, id, dto), this.logger);
  }

  @Post('assets/counts')
  @Authenticated({ permission: Permission.PersonRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Count the people of assets',
    description:
      'For every person that is on any of the assets, how many of them the person is on and on how many only through a whole-asset mark (those are the ones removing the person takes them off).',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  getPersonAssetCounts(
    @Auth() auth: AuthDto,
    @Body() dto: PersonAssetCountsDto,
  ): Promise<PersonAssetCountResponseDto[]> {
    return this.service.getAssetCounts(auth, dto);
  }

  @Put(':id/assets')
  @Authenticated({ permission: Permission.FaceCreate })
  @Endpoint({
    summary: 'Add a person to assets',
    description:
      'Mark photos and videos as having a person in them without a location in the picture (close-ups, videos). Each asset gets a manual face covering the whole asset, flagged isWholeAsset. Assets the person is already on in any way (a detected face, a drawn box, an earlier mark) are reported as duplicate, other asset types as validation errors.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  addPersonToAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BulkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.addToAssets(auth, id, dto);
  }

  @Delete(':id/assets')
  @Authenticated({ permission: Permission.FaceDelete })
  @Endpoint({
    summary: 'Remove a person from assets',
    description:
      'Take a person off assets by removing their whole-asset marks. Where a face of the person is located in the picture (detected or drawn) it stays and the asset is reported as a validation error; assets without the person are reported as not found.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  removePersonFromAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BulkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.removeFromAssets(auth, id, dto);
  }

  @Put(':id/reassign')
  @Authenticated({ permission: Permission.PersonReassign })
  @Endpoint({
    summary: 'Reassign faces',
    description: 'Bulk reassign a list of faces to a different person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  reassignFaces(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetFaceUpdateDto,
  ): Promise<PersonResponseDto[]> {
    return this.service.reassignFaces(auth, id, dto);
  }

  @Post('merge')
  @Authenticated({ permission: Permission.PersonMerge })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Merge people',
    description:
      'Merge an ordered list of people together into a single person. The final name and birth date are always the first defined value, following the order. Also automatically merges people for other users in the cluster group, skipping people that would result in overriding a previously set name or birth date.',
    history: new HistoryBuilder().added('v3.2.1').stable('v3.2.1'),
  })
  mergePeople(@Auth() auth: AuthDto, @Body() dto: MergePersonDto): Promise<BulkIdResponseDto[]> {
    return this.service.mergePeople(auth, dto);
  }

  @Post(':id/merge')
  @Authenticated({ permission: Permission.PersonMerge })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Merge people',
    description: 'Merge a list of people into the person specified in the path parameter.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.1', { replacementId: 'mergePeople' }),
  })
  mergePersonLegacy(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: MergePersonDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.mergePeople(auth, { ids: [id, ...dto.ids] });
  }
}
