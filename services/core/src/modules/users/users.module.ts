import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { createMailTransport, InviteMailer, MAIL_TRANSPORT } from './mailer.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController, InvitationsController],
  providers: [UsersService, InvitationsService, InviteMailer, { provide: MAIL_TRANSPORT, useFactory: createMailTransport }],
  exports: [UsersService, InvitationsService],
})
export class UsersModule {}
