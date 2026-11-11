import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { verifyFileLink } from '@qos/kernel-infra';
import { InvalidObjectKeyError, ObjectNotFoundError, type ObjectStorage } from '@qos/ports';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from './access.js';
import type { ApiConfig } from './config.js';
import { CONFIG, STORAGE } from './tokens.js';

/**
 * Types a browser may render inline. Everything else, including HTML and SVG from test artifacts,
 * is sent as a download so stored content can never run as script on this origin.
 */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'application/pdf',
]);

@Controller('files')
export class FilesController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** Serves one stored object for a valid, unexpired signed link. */
  @Get('*')
  @Public() // authorized by the signed link itself
  async download(
    @Req() req: FastifyRequest,
    @Query('exp') exp: unknown,
    @Query('sig') sig: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const secret = this.config.FILE_URL_SECRET;
    if (!secret) throw new NotFoundException(); // signed links are not configured
    let key: string;
    try {
      key = decodeURIComponent(req.url.split('?')[0]!.slice('/files/'.length));
    } catch {
      throw new ForbiddenException();
    }
    // The same answer for a bad signature and an expired link: nothing to probe.
    if (verifyFileLink(secret, key, exp, sig) !== 'ok') throw new ForbiddenException();
    try {
      const ref = await this.storage.stat(key);
      if (!ref) throw new NotFoundException();
      const body = await this.storage.get(key);
      const baseType = ref.contentType.split(';')[0]!.trim().toLowerCase();
      const inline = INLINE_TYPES.has(baseType);
      const filename = key
        .split('/')
        .at(-1)!
        .replace(/[^a-z0-9._-]/g, '_');
      void reply
        .header('content-type', inline ? ref.contentType : 'application/octet-stream')
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .header('etag', `"${ref.sha256}"`)
        .send(Buffer.from(body));
    } catch (e) {
      if (e instanceof ObjectNotFoundError || e instanceof InvalidObjectKeyError)
        throw new NotFoundException();
      throw e;
    }
  }
}
