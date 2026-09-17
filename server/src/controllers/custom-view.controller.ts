import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  CustomViewActiveResponseDto,
  CustomViewActiveUpdateDto,
  CustomViewCreateDto,
  CustomViewResponseDto,
  CustomViewSearchDto,
  CustomViewUpdateDto,
} from 'src/dtos/custom-view.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { CustomViewService } from 'src/services/custom-view.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.CustomViews)
@Controller('views')
export class CustomViewController {
  constructor(private service: CustomViewService) {}

  @Get()
  @Authenticated({ permission: Permission.ViewRead })
  @Endpoint({
    summary: 'Retrieve views',
    description:
      'Retrieve the views of the current user. Views with private access are only listed while private mode is unlocked.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  getCustomViews(@Auth() auth: AuthDto, @Query() dto: CustomViewSearchDto): Promise<CustomViewResponseDto[]> {
    return this.service.getAll(auth, dto);
  }

  @Post()
  @Authenticated({ permission: Permission.ViewCreate })
  @Endpoint({
    summary: 'Create a view',
    description: 'Create a view from tag rules. Requires private mode, because views can name hidden tags.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  createCustomView(@Auth() auth: AuthDto, @Body() dto: CustomViewCreateDto): Promise<CustomViewResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get('active')
  @Authenticated()
  @Endpoint({
    summary: 'Retrieve the active view',
    description:
      'Retrieve the view that applies to the current session: the view it switched to, or the default view. API keys ignore views.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  getActiveCustomView(@Auth() auth: AuthDto): Promise<CustomViewActiveResponseDto> {
    return this.service.getActive(auth);
  }

  @Put('active')
  @Authenticated()
  @Endpoint({
    summary: 'Switch the active view',
    description:
      'Switch the current session to a view, or back to the default view with null. Views with locked access require the PIN code on every switch, views with private access require private mode. A switched view falls back to the default view when private mode locks or its timeout passes.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  setActiveCustomView(
    @Auth() auth: AuthDto,
    @Body() dto: CustomViewActiveUpdateDto,
  ): Promise<CustomViewActiveResponseDto> {
    return this.service.setActive(auth, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.ViewRead })
  @Endpoint({
    summary: 'Retrieve a view',
    description: 'Retrieve a specific view by its ID.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  getCustomView(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<CustomViewResponseDto> {
    return this.service.get(auth, id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.ViewUpdate })
  @Endpoint({
    summary: 'Update a view',
    description: 'Update a view. Requires private mode.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  updateCustomView(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: CustomViewUpdateDto,
  ): Promise<CustomViewResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.ViewDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a view',
    description: 'Delete a view. Sessions on it return to the default view. Requires private mode.',
    history: new HistoryBuilder().added('v3.2.2').beta('v3.2.2'),
  })
  deleteCustomView(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }
}
