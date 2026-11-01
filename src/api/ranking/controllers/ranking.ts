import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::ranking.ranking', ({ strapi }) => ({
    async recalibrateSeason(ctx) {
        try {
            const result = await strapi.service('api::ranking.ranking').recalibrateSeason();
            return ctx.send({ data: result });
        } catch (err) {
            return ctx.internalServerError(err.message);
        }
    },
    async getLifetimeStats(ctx) {
        const { userId } = ctx.query;
        
        if (!userId) {
            return ctx.badRequest('userId is required');
        }
        const rankings = await strapi.db.query('api::ranking.ranking').findMany({
            where: { user_id: userId },
            orderBy: { createdAt: 'desc' }
        });
        if (!rankings || rankings.length === 0) {
            return ctx.send({ data: null });
        }
        const latestRank = rankings[0];
        
        const lifetimeStats = rankings.reduce((acc, curr) => ({
            match_played: (acc.match_played || 0) + (curr.match_played || 0),
            win: (acc.win || 0) + (curr.win || 0),
            lose: (acc.lose || 0) + (curr.lose || 0),
        }), { match_played: 0, win: 0, lose: 0 });
        return ctx.send({
            data: {
                rank: latestRank.rank,
                stars: latestRank.stars,
                brave_points: latestRank.brave_points,
                ...lifetimeStats
            }
        });
    }
}));
