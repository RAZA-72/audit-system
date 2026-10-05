const axios = require('axios');

/**
 * Many sites reject requests that arrive with axios's default User-Agent
 * (or none at all) with a 403. Using a normal browser UA and accept headers
 * makes the audit fetches behave like a real visitor.
 */
const httpClient = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

module.exports = { httpClient };
