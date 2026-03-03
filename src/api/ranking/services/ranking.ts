/**
 * ranking service
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::ranking.ranking', ({ strapi }) => ({
    async getOrCreateCurrentSeason() {
        const now = new Date();
        const monthStr = now.toISOString().slice(0, 7); // "YYYY-MM"
        const seasonName = `Season ${monthStr}`;

        // 1. Try to find if this month's season already exists
        let currentSeason = await strapi.documents('api::season.season').findFirst({
            filters: { name: seasonName },
            status: 'published'
        });

        if (!currentSeason) {
            // New month transition!
            console.log(`[Cron/Service] Transitioning to new season: ${seasonName}`);

            // A. Deactivate all currently active seasons
            const activeSeasons = await strapi.documents('api::season.season').findMany({
                filters: { is_active: true }
            });
            for (const s of activeSeasons) {
                await strapi.documents('api::season.season').update({
                    documentId: s.documentId,
                    data: { is_active: false },
                    status: 'published'
                });
            }

            // B. Create the new season for the current month
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

            currentSeason = await strapi.documents('api::season.season').create({
                data: {
                    name: seasonName,
                    is_active: true,
                    start_date: startOfMonth.toISOString().split('T')[0],
                    end_date: endOfMonth.toISOString().split('T')[0]
                },
                status: 'published'
            });
        }
        return currentSeason;
    }
}));
