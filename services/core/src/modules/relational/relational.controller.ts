import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentPrincipal, InternalOnly, type Principal, RequirePermission } from '@oe/ts-common/auth';
import { PublicApiError, PublicEnvelopeFilter, PublicEnvelopeInterceptor } from '@oe/ts-common/http';
import { internalRowsRequestSchema, parseBody, rowsRequestSchema, tableCreateSchema, tableUpdateSchema } from './dto.js';
import { MAX_ROWS, RelationalService, toTableDto } from './relational.service.js';

function tenantOf(principal: Principal): string {
  if (!principal.tenant_id) throw new ForbiddenException('operator principals cannot manage tenant relational data');
  return principal.tenant_id;
}

const pageSize = (limit?: string): number => Math.min(200, Math.max(1, Number(limit) || 50));

function tooMany(rows: unknown[]): void {
  if (rows.length > MAX_ROWS) throw new PublicApiError(1002, `at most ${MAX_ROWS} rows per request`);
}

@Controller('admin/v1')
export class RelationalController {
  constructor(private readonly relational: RelationalService) {}

  @Get('relational-tables')
  @RequirePermission('contacts:view')
  list(@CurrentPrincipal() principal: Principal, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.relational.list(tenantOf(principal), pageSize(limit), cursor);
  }

  @Post('relational-tables')
  @RequirePermission('contacts:admin')
  async create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return toTableDto(await this.relational.create(tenantOf(principal), parseBody(tableCreateSchema, body)));
  }

  @Get('relational-tables/:id')
  @RequirePermission('contacts:view')
  async get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return toTableDto(await this.relational.get(tenantOf(principal), id));
  }

  @Patch('relational-tables/:id')
  @RequirePermission('contacts:admin')
  async update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return toTableDto(await this.relational.update(tenantOf(principal), id, parseBody(tableUpdateSchema, body)));
  }

  @Delete('relational-tables/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('contacts:admin')
  async remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<void> {
    await this.relational.remove(tenantOf(principal), id);
  }

  @Get('contacts/:id/relational/:tableId')
  @RequirePermission('contacts:view')
  rowsOf(
    @CurrentPrincipal() principal: Principal,
    @Param('id') contactId: string,
    @Param('tableId') tableId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string
  ) {
    return this.relational.rowsOf(tenantOf(principal), contactId, tableId, pageSize(limit), cursor);
  }
}

@Controller('api/v3/relational')
@UseInterceptors(PublicEnvelopeInterceptor)
@UseFilters(PublicEnvelopeFilter)
export class PublicRelationalController {
  constructor(private readonly relational: RelationalService) {}

  @Put(':tableId/rows')
  @RequirePermission('contacts:edit')
  upsert(@CurrentPrincipal() principal: Principal, @Param('tableId') tableId: string, @Body() body: unknown) {
    const b = parseBody(rowsRequestSchema, body);
    tooMany(b.rows);
    return this.relational.upsertRows(tenantOf(principal), tableId, b.key_id, b.rows);
  }
}

/** C4: the importer's target for `relational:<id>` imports. */
@Controller('internal/v1/relational')
export class InternalRelationalController {
  constructor(private readonly relational: RelationalService) {}

  @Post(':tableId/rows')
  @HttpCode(HttpStatus.OK)
  @InternalOnly()
  upsert(@Param('tableId') tableId: string, @Body() body: unknown) {
    const b = parseBody(internalRowsRequestSchema, body);
    tooMany(b.rows);
    return this.relational.upsertRows(b.tenant_id, tableId, b.key_id, b.rows);
  }
}
