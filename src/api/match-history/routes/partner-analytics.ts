export default {
  routes: [
    {
      method: 'GET',
      path: '/match-histories/partner-analytics',
      handler: 'match-history.partnerAnalytics',
      config: {
        auth: false // Since this is a custom route, adjust auth as needed. Most custom analytics in this app seem to use auth: false or rely on policies
      }
    }
  ]
}
