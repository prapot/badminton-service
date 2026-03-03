'use strict';

/**
 * Migration script to move existing rankings to a default "Season 1"
 * Run with: node scripts/migrate-seasons.js
 */

const migrate = async () => {
    // We need to load strapi to use the documents service
    const { createStrapi, compileStrapi } = require('@strapi/strapi');

    console.log('Compiling Strapi...');
    const appContext = await compileStrapi();
    const app = await createStrapi(appContext).load();

    try {
        console.log('Starting migration...');

        // 1. Create or find Season 1
        let season1 = await strapi.documents('api::season.season').findFirst({
            filters: { name: 'Season 1' }
        });

        if (!season1) {
            console.log('Creating Season 1...');
            season1 = await strapi.documents('api::season.season').create({
                data: {
                    name: 'Season 1',
                    is_active: true,
                    start_date: new Date().toISOString().split('T')[0]
                },
                status: 'published'
            });
        } else {
            console.log('Season 1 already exists. Ensuring it is active...');
            await strapi.documents('api::season.season').update({
                documentId: season1.documentId,
                data: { is_active: true },
                status: 'published'
            });
        }

        console.log(`Using Season 1 (documentId: ${season1.documentId})`);

        // 2. Link all rankings without a season to Season 1
        // Note: Using findMany with $null filter to find unlinked records
        const rankings = await strapi.documents('api::ranking.ranking').findMany({
            filters: { season: { $null: true } }
        });

        console.log(`Found ${rankings.length} rankings to migrate.`);

        for (const ranking of rankings) {
            console.log(`Migrating ranking for documentId: ${ranking.documentId}...`);
            await strapi.documents('api::ranking.ranking').update({
                documentId: ranking.documentId,
                data: { season: season1.documentId },
                status: 'published'
            });
        }

        console.log('Migration completed successfully!');
    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        await app.destroy();
        process.exit(0);
    }
};

migrate().catch((error) => {
    console.error(error);
    process.exit(1);
});
