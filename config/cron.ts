export default {
    /**
     * Monthly Season Transition
     * Runs at 00:00 on the 1st day of every month
     */
    '0 0 1 * *': async ({ strapi }) => {
        console.log('[Cron] Running monthly season transition...');
        try {
            await strapi.service('api::ranking.ranking').getOrCreateCurrentSeason();
            console.log('[Cron] Monthly season transition completed successfully.');
        } catch (err) {
            console.error('[Cron] Error during monthly season transition:', err);
        }
    },
};
