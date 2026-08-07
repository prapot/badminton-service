export default {
  routes: [
    {
      method: 'GET',
      path: '/match-histories/analytics',
      handler: 'match-history.analytics',
      config: {
        auth: false
      }
    }
  ]
}
