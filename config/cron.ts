export default {
    /**
     * Monthly Season Transition + Rerank
     * Runs at 00:05 on the 1st day of every month (Thai time = UTC+7, so 17:05 UTC prev day... 
     * but server runs in UTC, adjust if needed)
     * 
     * What it does:
     * 1. Deactivates all old active seasons
     * 2. Creates the new month's season (or re-activates if exists)
     * 3. Recalibrates rankings for the new season from scratch
     */
    '5 0 1 * *': async ({ strapi }) => {
        const startedAt = new Date().toISOString();
        console.log(`[Cron][${startedAt}] 🔄 Monthly season transition + rerank started...`);
        try {
            // Step 1: Transition to new season (deactivates old ones automatically)
            const newSeason = await strapi.service('api::ranking.ranking').getOrCreateCurrentSeason();
            console.log(`[Cron] ✅ Season ready: ${newSeason.name} (id: ${newSeason.id})`);

            // Step 2: Recalibrate rankings for the new season
            console.log(`[Cron] 🏸 Starting recalibration for ${newSeason.name}...`);
            const result = await strapi.service('api::ranking.ranking').recalibrateSeason();
            console.log(`[Cron] ✅ Recalibration done: ${result.count} matches re-processed for ${result.season}`);

            console.log(`[Cron] 🎉 Monthly transition completed successfully.`);
        } catch (err) {
            console.error('[Cron] ❌ Error during monthly season transition:', err);
        }
    },
};
