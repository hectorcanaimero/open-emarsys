import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { connect } from 'nats';
import { NatsConsumerExplorer } from './consumer.explorer.js';
import { NatsPublisher } from './publisher.js';
import { NATS_CONNECTION, NATS_MODULE_OPTIONS, type NatsModuleOptions } from './tokens.js';

export * from './consumer.explorer.js';
export * from './envelope.js';
export * from './on-event.decorator.js';
export * from './publisher.js';
export * from './tokens.js';

@Module({})
export class NatsModule {
  /** Registers a shared JetStream connection, `NatsPublisher` and the `@OnEvent` consumer explorer. */
  static forRoot(options: NatsModuleOptions): DynamicModule {
    return {
      module: NatsModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        { provide: NATS_MODULE_OPTIONS, useValue: options },
        {
          provide: NATS_CONNECTION,
          useFactory: (opts: NatsModuleOptions) => connect({ servers: opts.servers }),
          inject: [NATS_MODULE_OPTIONS],
        },
        NatsPublisher,
        NatsConsumerExplorer,
      ],
      exports: [NatsPublisher, NATS_CONNECTION, NATS_MODULE_OPTIONS],
    };
  }
}
