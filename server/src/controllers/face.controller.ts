import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { NextFunction, Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetFaceCreateDto,
  AssetFaceDeleteDto,
  AssetFaceResponseDto,
  FaceDto,
  PersonResponseDto,
} from 'src/dtos/person.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard';
import { PersonSuggestionService } from 'src/services/person-suggestion.service';
import { PersonService } from 'src/services/person.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Faces)
@Controller('faces')
export class FaceController {
  constructor(
    private service: PersonService,
    private suggestionService: PersonSuggestionService,
  ) {}

  @Post()
  @Authenticated({ permission: Permission.FaceCreate })
  @Endpoint({
    summary: 'Create a face',
    description:
      'Create a new face that has not been discovered by facial recognition. The content of the bounding box is considered a face.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createFace(@Auth() auth: AuthDto, @Body() dto: AssetFaceCreateDto) {
    return this.service.createFace(auth, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.FaceRead })
  @Endpoint({
    summary: 'Retrieve faces for asset',
    description: 'Retrieve all faces belonging to an asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getFaces(@Auth() auth: AuthDto, @Query() dto: FaceDto): Promise<AssetFaceResponseDto[]> {
    return this.service.getFacesById(auth, dto);
  }

  @Get(':id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.FaceRead })
  @Endpoint({
    summary: 'Get face thumbnail',
    description: 'Retrieve a face of the caller cut out of its photo or video frame, as a square JPEG.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  async getFaceThumbnail(
    @Res() res: Response,
    @Next() next: NextFunction,
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ) {
    try {
      const { data, isPrivate } = await this.suggestionService.getFaceThumbnail(auth, id);
      // a face on a private asset must not stay in a cache once private mode is locked again
      res.set('Cache-Control', isPrivate ? 'private, no-cache, no-transform' : 'private, max-age=86400, no-transform');
      res.type('image/jpeg').send(data);
    } catch (error) {
      next(error);
    }
  }

  @Put(':id')
  @Authenticated({ permission: Permission.FaceUpdate })
  @Endpoint({
    summary: 'Re-assign a face to another person',
    description: 'Re-assign the face provided in the body to the person identified by the id in the path parameter.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  reassignFacesById(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: FaceDto,
  ): Promise<PersonResponseDto> {
    return this.service.reassignFacesById(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.FaceDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a face',
    description: 'Delete a face identified by the id. Optionally can be force deleted.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteFace(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: AssetFaceDeleteDto): Promise<void> {
    return this.service.deleteFace(auth, id, dto);
  }
}
