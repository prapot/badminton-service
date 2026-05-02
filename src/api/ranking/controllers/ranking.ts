import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::ranking.ranking', ({ strapi }) => ({
    async upsert(ctx) {
        const requestBody = ctx.request.body || {};
        const body = requestBody.data || requestBody;
        const { user_id, ...updateData } = body;

        if (!user_id) {
            return ctx.badRequest('user_id is required');
        }

        try {
            const activeSeason = await strapi.service('api::ranking.ranking').getOrCreateCurrentSeason();

            const existingRanking = await strapi.documents('api::ranking.ranking').findFirst({
                filters: {
                    user_id: user_id,
                    season: { documentId: activeSeason.documentId }
                },
            });

            if (existingRanking) {
                const updatedRanking = await strapi.documents('api::ranking.ranking').update({
                    documentId: existingRanking.documentId,
                    data: updateData,
                    status: 'published'
                });
                return ctx.send({ data: updatedRanking });
            } else {
                const newRanking = await strapi.documents('api::ranking.ranking').create({
                    data: { ...updateData, user_id: user_id, season: activeSeason.documentId },
                    status: 'published'
                });
                return ctx.send({ data: newRanking });
            }
        } catch (err) {
            return ctx.internalServerError(err.message);
        }
    },

    async recordMatch(ctx) {
        const requestBody = ctx.request.body || {};
        const body = requestBody.data || requestBody;
        const { winners, losers, winner_score, loser_score, match_id } = body;

        if (!winners || !losers || winner_score === undefined || loser_score === undefined || match_id === undefined) {
            return ctx.badRequest('winners, losers, winner_score, loser_score, and match_id are required');
        }

        try {
            const result = await strapi.service('api::ranking.ranking').recordMatch(
                winners,
                losers,
                Number(winner_score),
                Number(loser_score),
                match_id
            );
            return ctx.send({ data: result });
        } catch (err) {
            return ctx.internalServerError(err.message);
        }
    },

    async revertMatch(ctx) {
        const requestBody = ctx.request.body || {};
        const body = requestBody.data || requestBody;
        const { match_id } = body;

        if (!match_id) {
            return ctx.badRequest('match_id is required');
        }

        try {
            const result = await strapi.service('api::ranking.ranking').revertMatch(match_id);
            return ctx.send({ data: result });
        } catch (err) {
            return ctx.internalServerError(err.message);
        }
    }
}));
