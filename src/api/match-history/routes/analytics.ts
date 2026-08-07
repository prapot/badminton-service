export default {
  routes: [
    {
      method: 'GET',
      path: '/match-histories/analytics',
      handler: 'match-history.analytics',
      config: {
        auth: false
      }
    },
    {
      method: 'GET',
      path: '/match-histories/partner-analytics',
      handler: 'match-history.partnerAnalytics',
      config: {
        auth: false
      }
    }
  ]
}
