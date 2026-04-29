/**
 * custom-tournament controller
 */

import { factories } from '@strapi/strapi';

export default {
  async drawNext(ctx) {
    try {
      const { id } = ctx.params;
      const { pairingMode } = ctx.request.body.data || {};
      
      const service = strapi.service('api::tournament.custom-tournament');
      if (!service) {
        throw new Error("Custom tournament service not found");
      }
      
      const result = await service.drawNext(id, pairingMode);
      
      ctx.body = { data: result };
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  }
};
