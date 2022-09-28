import cluster from 'node:cluster';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import Fastify from 'fastify';
import { IsNull } from 'typeorm';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import type { Config } from '@/config.js';
import type { UserProfilesRepository, UsersRepository } from '@/models/index.js';
import { DI } from '@/di-symbols.js';
import type Logger from '@/logger.js';
import { envOption } from '@/env.js';
import * as Acct from '@/misc/acct.js';
import { genIdenticon } from '@/misc/gen-identicon.js';
import { createTemp } from '@/misc/create-temp.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { ActivityPubServerService } from './ActivityPubServerService.js';
import { NodeinfoServerService } from './NodeinfoServerService.js';
import { ApiServerService } from './api/ApiServerService.js';
import { StreamingApiServerService } from './api/StreamingApiServerService.js';
import { WellKnownServerService } from './WellKnownServerService.js';
import { MediaProxyServerService } from './MediaProxyServerService.js';
import { FileServerService } from './FileServerService.js';
import { ClientServerService } from './web/ClientServerService.js';

@Injectable()
export class ServerService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		private userEntityService: UserEntityService,
		private apiServerService: ApiServerService,
		private streamingApiServerService: StreamingApiServerService,
		private activityPubServerService: ActivityPubServerService,
		private wellKnownServerService: WellKnownServerService,
		private nodeinfoServerService: NodeinfoServerService,
		private fileServerService: FileServerService,
		private mediaProxyServerService: MediaProxyServerService,
		private clientServerService: ClientServerService,
		private globalEventService: GlobalEventService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('server', 'gray', false);
	}

	public launch() {
		const fastify = Fastify({
			trustProxy: true,
			logger: !['production', 'test'].includes(process.env.NODE_ENV ?? ''),
		});

		// HSTS
		// 6months (15552000sec)
		if (this.config.url.startsWith('https') && !this.config.disableHsts) {
			fastify.addHook('onRequest', (request, reply) => {
				reply.header('strict-transport-security', 'max-age=15552000; preload');
			});
		}

		fastify.register(this.apiServerService.createServer, { prefix: '/api' });
		fastify.register(this.fileServerService.createServer, { prefix: '/files' });
		fastify.register(this.mediaProxyServerService.createServer, { prefix: '/proxy' });
		fastify.register(this.activityPubServerService.createServer);
		fastify.register(this.nodeinfoServerService.createServer);
		fastify.register(this.wellKnownServerService.createServer);

		fastify.get<{ Params: { acct: string } }>('/avatar/@:acct', async (request, reply) => {
			const { username, host } = Acct.parse(request.params.acct);
			const user = await this.usersRepository.findOne({
				where: {
					usernameLower: username.toLowerCase(),
					host: (host == null) || (host === this.config.host) ? IsNull() : host,
					isSuspended: false,
				},
				relations: ['avatar'],
			});

			if (user) {
				reply.redirect(this.userEntityService.getAvatarUrlSync(user));
			} else {
				reply.redirect('/static-assets/user-unknown.png');
			}
		});

		fastify.get<{ Params: { x: string } }>('/identicon/:x', async (request, reply) => {
			const [temp, cleanup] = await createTemp();
			await genIdenticon(request.params.x, fs.createWriteStream(temp));
			reply.header('Content-Type', 'image/png');
			return fs.createReadStream(temp).on('close', () => cleanup());
		});

		fastify.get<{ Params: { code: string } }>('/verify-email/:code', async (request, reply) => {
			const profile = await this.userProfilesRepository.findOneBy({
				emailVerifyCode: request.params.code,
			});

			if (profile != null) {
				await this.userProfilesRepository.update({ userId: profile.userId }, {
					emailVerified: true,
					emailVerifyCode: null,
				});

				this.globalEventService.publishMainStream(profile.userId, 'meUpdated', await this.userEntityService.pack(profile.userId, { id: profile.userId }, {
					detail: true,
					includeSecrets: true,
				}));

				reply.code(200);
				return 'Verify succeeded!';
			} else {
				reply.code(404);
			}
		});

		fastify.register(this.clientServerService.createServer);

		this.streamingApiServerService.attachStreamingApi(fastify.server);

		fastify.server.on('error', err => {
			switch ((err as any).code) {
				case 'EACCES':
					this.logger.error(`You do not have permission to listen on port ${this.config.port}.`);
					break;
				case 'EADDRINUSE':
					this.logger.error(`Port ${this.config.port} is already in use by another process.`);
					break;
				default:
					this.logger.error(err);
					break;
			}

			if (cluster.isWorker) {
			process.send!('listenFailed');
			} else {
			// disableClustering
				process.exit(1);
			}
		});

		fastify.server.listen(this.config.port);
	}
}
