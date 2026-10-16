export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  const META_APP_ID = env.META_APP_ID || '';
  const META_APP_SECRET = env.META_APP_SECRET || '';
  const META_SCOPES = 'ads_read,business_management';

  // 1. Authorize Endpoint
  if (pathname === '/api/auth/meta/authorize') {
    const redirectUri = `${url.origin}/api/auth/meta/callback`;
    const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const authorizeUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(META_SCOPES)}&state=${state}&response_type=code`;

    return Response.redirect(authorizeUrl, 302);
  }

  // 2. Callback Endpoint
  if (pathname === '/api/auth/meta/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(errorDescription || error)}`, 302);
    }

    if (!code) {
      return new Response('Missing required code query parameter.', { status: 400 });
    }

    const redirectUri = `${url.origin}/api/auth/meta/callback`;

    try {
      // Exchange code for short-lived token
      const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`;
      const tokenResp = await fetch(tokenUrl);
      const tokenJson = await tokenResp.json();

      const shortLivedToken = tokenJson.access_token;
      if (!shortLivedToken) {
        return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(tokenJson.error?.message || 'Token exchange failed')}`, 302);
      }

      // Upgrade to long-lived (60 days) token
      const longLivedUrl = `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortLivedToken}`;
      const llResp = await fetch(longLivedUrl);
      const llJson = await llResp.json();
      const longLivedToken = llJson.access_token || shortLivedToken;

      // Fetch user's accessible ad accounts
      const adAccountsUrl = `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id,currency,account_status&access_token=${longLivedToken}&limit=50`;
      const adResp = await fetch(adAccountsUrl);
      const adJson = await adResp.json();

      let adAccounts = [];
      if (adJson.data && Array.isArray(adJson.data)) {
        adAccounts = adJson.data.map(acc => ({
          id: acc.id,
          name: acc.name || `Ad Account ${acc.account_id || acc.id}`,
          accountId: acc.account_id ? `act_${acc.account_id}` : acc.id,
          currency: acc.currency || 'USD'
        }));
      }

      const redirectBack = `${url.origin}/?connected=meta&token=${encodeURIComponent(longLivedToken)}&accounts=${encodeURIComponent(JSON.stringify(adAccounts))}`;
      return Response.redirect(redirectBack, 302);

    } catch (e) {
      return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(e.message)}`, 302);
    }
  }

  return new Response('Not Found', { status: 404 });
}
