import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Public } from '@oe/ts-common/auth';
import { acceptInvitationSchema, parseBody } from './dto.js';
import { InvitationsService } from './invitations.service.js';

@Controller('admin/v1/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post(':token/accept')
  @Public()
  @HttpCode(HttpStatus.OK)
  accept(@Param('token') token: string, @Body() body: unknown) {
    const input = parseBody(acceptInvitationSchema, body);
    return this.invitations.accept(token, input);
  }
}
