/**
 * match-history controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::match-history.match-history', ({ strapi }) => ({
  async analytics(ctx) {
    try {
      const { userId, seasonId } = ctx.query;

      if (!userId) {
        return ctx.badRequest('userId is required');
      }

      // Build filters
      const filters: any = {
        users: {
          id: userId
        }
      };

      if (seasonId && seasonId !== 'all') {
        filters.ranking = {
          season: {
            documentId: seasonId
          }
        };
      }

      // Fetch histories from DB
      const histories = await strapi.entityService.findMany('api::match-history.match-history', {
        filters,
        sort: { createdAt: 'asc' }, // Sort oldest to newest
      });

      // Process Data
      const summaryMap = new Map();
      const detailsMap = new Map();

      if (histories && Array.isArray(histories)) {
        histories.forEach(h => {
          const date = new Date(h.createdAt);
          
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          const fullDate = `${year}-${month}-${day}`;
          const shortDate = `${day}/${month}`;
          
          const hours = String(date.getHours()).padStart(2, '0');
          const minutes = String(date.getMinutes()).padStart(2, '0');
          const timeStr = `${hours}:${minutes}`;

          // Details grouping
          if (!detailsMap.has(fullDate)) {
            detailsMap.set(fullDate, []);
          }
          detailsMap.get(fullDate).push({
            id: h.id,
            documentId: h.documentId,
            rp: h.new_rp,
            time: timeStr,
            is_win: h.is_win,
            rp_change: h.rp_change,
            fullDate
          });

          // Summary grouping (overwrites so it keeps the final RP of the day)
          summaryMap.set(fullDate, {
            date: shortDate,
            fullDate: fullDate,
            rp: h.new_rp,
            matchCount: detailsMap.get(fullDate).length
          });
        });
      }

      const summary = Array.from(summaryMap.values());
      const details = Object.fromEntries(detailsMap);

      ctx.body = {
        data: {
          summary,
          details
        }
      };
    } catch (err) {
      ctx.throw(500, err);
    }
  }
}));
