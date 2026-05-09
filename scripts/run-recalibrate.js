
async function run() {
  try {
    console.log('Starting recalibration...');
    const result = await strapi.service('api::ranking.ranking').recalibrateSeason();
    console.log('Recalibration result:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Error during recalibration:', err);
    process.exit(1);
  }
}

run();
