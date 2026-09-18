import { Module } from '@nestjs/common';
import { ApiClientsController } from './api-clients.controller.js';
import { ApiClientsService } from './api-clients.service.js';

export { API_CLIENT_REVOKED } from './api-clients.service.js';

/** `/admin/v1/api-clients` (FR-4). Needs the global `PrismaModule` and `NatsModule`. */
@Module({
  controllers: [ApiClientsController],
  providers: [ApiClientsService],
})
export class ApiClientsModule {}
