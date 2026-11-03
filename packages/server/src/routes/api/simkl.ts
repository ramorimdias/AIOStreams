import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { SimklConnection, UserRepository } from '@aiostreams/core';
import { resolveConfigCredentials } from '../../utils/basic-auth.js';
import { createResponse } from '../../utils/responses.js';

const router: Router = Router();
const variantSchema = z.union([
  z.literal(''),
  z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
]);

function handle(
  action: (uuid: string, variant: string) => Promise<unknown>,
  failure: string
) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const creds = await resolveConfigCredentials(req, res, {
      allowEncrypted: false,
    });
    if (!creds) {
      res
        .status(401)
        .json(
          createResponse({
            success: false,
            detail: 'Sign in to a saved configuration first.',
          })
        );
      return;
    }
    const uuid = creds.uuid;
    const variant = variantSchema.safeParse(
      req.method === 'GET'
        ? (req.query.variant ?? '')
        : (req.body?.variant ?? '')
    );
    if (!variant.success) {
      res
        .status(400)
        .json(
          createResponse({
            success: false,
            detail: 'Invalid configuration variant.',
          })
        );
      return;
    }
    try {
      await UserRepository.verifyUser(uuid, creds.password);
    } catch {
      res
        .status(401)
        .json(
          createResponse({
            success: false,
            detail: 'Sign in to a saved configuration first.',
          })
        );
      return;
    }
    try {
      const data = await action(uuid, variant.data);
      res.status(200).json(createResponse({ success: true, data }));
    } catch {
      res.status(400).json(createResponse({ success: false, detail: failure }));
    }
  };
}

router.get(
  '/',
  handle(
    async (uuid, variant) => ({
      configured: SimklConnection.configured(),
      connected: Boolean(await SimklConnection.grantId(uuid, variant)),
    }),
    'Could not read the Simkl connection.'
  )
);
router.post(
  '/start',
  handle(
    (uuid, variant) => SimklConnection.start(uuid, variant),
    'Could not start Simkl authorization. Check the instance app registration.'
  )
);
router.post(
  '/poll',
  handle(
    (uuid, variant) => SimklConnection.poll(uuid, variant),
    'Could not complete Simkl authorization. Start a new connection.'
  )
);
router.post(
  '/disconnect',
  handle(async (uuid, variant) => {
    await SimklConnection.disconnect(uuid, variant);
    return { connected: false };
  }, 'Could not disconnect the Simkl account.')
);

export default router;
