const { createStrapi } = require('@strapi/strapi');

async function test() {
    console.log("Loading Strapi...");
    const app = createStrapi({ serveAdminPanel: false });
    await app.load();
    console.log("Strapi loaded!");
    process.exit(0);
}
test().catch(console.error);
